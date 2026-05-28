import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { searchSubtitles } from '../../services/subtitleService.js';
import { proxySubSourceDownload } from '../../providers/subsource.js';
import { translateDeepSeekSubtitle } from '../../ai/deepseek.js';
import { resolveProxiedSubtitle } from '../../utils/encodingProxy.js';
import { httpError } from '../../utils/httpError.js';
import { buildStremioSubtitleSearch, getBaseUrl, parseExtra, toStremioSubtitles } from '../../utils/stremio.js';

const router = express.Router();
const EMPTY_SUBTITLES_BUF = Buffer.from('{"subtitles":[]}');
const QUERY_PARAM_KEYS = new Set(['q', 'type']);

function validateQuery(query) {
  if (!query || query.length < 2) {
    throw httpError(400, 'Query must be at least 2 characters');
  }

  if (query.length > 200) {
    throw httpError(400, 'Query is too long');
  }
}

function mergeExtras(routeExtra, queryExtra) {
  const output = { ...routeExtra };

  for (const key in queryExtra || {}) {
    if (QUERY_PARAM_KEYS.has(key)) continue;
    const value = queryExtra[key];
    output[key] = Array.isArray(value) ? value[0] : value;
  }

  return output;
}

function toPublicResults(results, baseUrl) {
  const output = new Array(results.length);

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    output[i] = {
      ...item,
      download: item.download?.startsWith('/') ? `${baseUrl}${item.download}` : item.download,
    };
  }

  return output;
}

router.get('/api/subtitles', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    validateQuery(query);

    const extra = mergeExtras(null, req.query);

    const results = await searchSubtitles({
      query,
      type: req.query.type || 'movie',
      extra,
    });

    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=300');
    res.json({
      success: true,
      count: results.length,
      results: toPublicResults(results, getBaseUrl(req)),
    });
  } catch (err) {
    next(err);
  }
});

async function stremioHandler(req, res, next) {
  try {
    const routeExtra = parseExtra(req.params.extra);
    const extra = mergeExtras(routeExtra, req.query);
    const search = buildStremioSubtitleSearch({
      type: req.params.type,
      id: req.params.id,
      extra,
    });

    const results = await searchSubtitles(search);
    res.setHeader('Cache-Control', 'public, max-age=1800, stale-while-revalidate=300');
    res.json({ subtitles: toStremioSubtitles(results, getBaseUrl(req)) });
  } catch (err) {
    if (err.status === 503) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, max-age=0');
      return res.end(EMPTY_SUBTITLES_BUF);
    }
    next(err);
  }
}

router.get('/subtitles/:type/:id.json', stremioHandler);
router.get('/subtitles/:type/:id/:extra.json', stremioHandler);
// توافق إضافي: بعض أمثلة/عملاء Stremio القديمة تستخدم /subtitle مفردة.
router.get('/subtitle/:type/:id.json', stremioHandler);
router.get('/subtitle/:type/:id/:extra.json', stremioHandler);


router.get('/ai/deepseek/:token.srt', async (req, res, next) => {
  try {
    const result = await translateDeepSeekSubtitle(req.params.token);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Cache-Control', result.cache === 'hit' ? 'public, max-age=86400' : 'private, max-age=0, no-cache');
    res.end(result.text);
  } catch (err) {
    next(err);
  }
});

// v1.7.1: Smart encoding proxy.
// يستقبل رابطًا موقّعًا، يجلب الترجمة من مصدرها، يحوّلها إلى UTF-8 SRT نظيف،
// ثم يسلّمها للمشغل. هذا يحل مشكلة الترجمات العربية المُرمَّزة بـ Windows-1256
// على PS5 و Android TV و Sony Bravia بدون الحاجة لـ Stremio's local proxy.
router.get('/proxy/encoding/:token.srt', async (req, res, next) => {
  try {
    const result = await resolveProxiedSubtitle(req.params.token);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Cache-Control', result.cache === 'hit'
      ? 'public, max-age=604800, immutable'
      : 'public, max-age=86400');
    res.setHeader('X-Source-Encoding', result.encoding || 'utf-8');
    res.setHeader('X-Source-Format', result.format || 'srt');
    res.end(result.text);
  } catch (err) {
    next(err);
  }
});

router.get('/downloads/subsource/:subtitleId', async (req, res, next) => {
  try {
    const upstream = await proxySubSourceDownload(req.params.subtitleId);
    const contentType = upstream.headers['content-type'] || 'application/octet-stream';
    const contentDisposition = upstream.headers['content-disposition'];

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);

    const nodeStream = upstream.body.readable
      ? Readable.fromWeb(upstream.body)
      : upstream.body;

    await pipeline(nodeStream, res);
  } catch (err) {
    next(err);
  }
});

export default router;
