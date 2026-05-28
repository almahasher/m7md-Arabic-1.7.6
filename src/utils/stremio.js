// =============================================================================
// stremio.js — Stremio manifest + URL builder (v1.7.6)
//
// تحسينات v1.7.1:
//  - encoding proxy على مستوى الـ addon (default) لجلب SRT نظيف UTF-8
//  - دعم Stremio legacy proxy المحلي كبديل
//  - lang code يلتزم بـ ISO 639-2 (ara) كما يتطلب Stremio
// =============================================================================

import { config } from '../config.js';
import { normalizeLanguage } from './language.js';
import { firstUsableValue, isUsableExternalValue } from './values.js';

export function getBaseUrl(req) {
  if (config.app.publicBaseUrl) return config.app.publicBaseUrl;

  const rawProto = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http';
  const protocol = String(rawProto).split(',')[0].trim() || 'http';
  const rawHost = req?.headers?.['x-forwarded-host'] || req?.headers?.host || req?.get?.('host') || '';
  const host = String(rawHost).split(',')[0].trim();

  if (!host) return `http://127.0.0.1:${config.server.port}`;
  return `${protocol}://${host}`.replace(/\/+$/, '');
}

export function createManifest() {
  return {
    id: config.app.id,
    version: config.app.version,
    name: config.app.name,
    description: config.app.description,
    resources: [
      // لا نقيّد idPrefixes هنا لأن Stremio قد يرسل id كـ OpenSubtitles hash
      // بينما IMDb يأتي داخل extraArgs مثل videoId. إبقاؤها مفتوحة يحسّن الاستدعاء.
      { name: 'subtitles', types: ['movie', 'series'] },
    ],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}


const IMDB_RE = /^tt\d+$/i;
const EXTRA_VIDEO_ID_KEYS = [
  'videoId', 'videoID', 'video_id', 'imdbId', 'imdbID', 'imdb_id', 'imdb', 'metaId', 'meta_id', 'id',
];
const EXTRA_HASH_KEYS = ['videoHash', 'moviehash', 'movieHash', 'hash', 'opensubtitles_hash'];

function normalizeImdbId(value) {
  const parsed = parseStremioId(value);
  return parsed.imdbId ? parsed : { imdbId: '', season: null, episode: null };
}

function firstVideoId(extra = {}) {
  for (const key of EXTRA_VIDEO_ID_KEYS) {
    const value = firstUsableValue(extra, [key], '');
    if (!value) continue;
    const parsed = normalizeImdbId(value);
    if (parsed.imdbId) return parsed;
  }
  return { imdbId: '', season: null, episode: null };
}

function firstVideoHash(rawId, extra = {}) {
  const explicitHash = firstUsableValue(extra, EXTRA_HASH_KEYS, '');
  if (explicitHash) return String(explicitHash).trim();

  const raw = String(rawId || '').trim();
  if (!isUsableExternalValue(raw)) return '';
  if (IMDB_RE.test(raw)) return '';
  if (raw.includes(':')) return '';
  return raw;
}

/**
 * يبني طلب بحث صحيح من طلب Stremio للترجمات.
 *
 * نقطة مهمة في بروتوكول Stremio: في مورد subtitles قد يكون :id هو
 * هاش ملف الفيديو، بينما رقم IMDb يأتي داخل extraArgs باسم videoId.
 * لذلك لا يجوز افتراض أن req.params.id دائمًا tt....
 */
export function buildStremioSubtitleSearch({ type = 'movie', id = '', extra = {} } = {}) {
  const parsedId = parseStremioId(id);
  const parsedVideoId = firstVideoId(extra);
  const extraWithHash = { ...extra };
  const routeHash = firstVideoHash(parsedId.raw, extraWithHash);

  if (routeHash && !firstUsableValue(extraWithHash, EXTRA_HASH_KEYS, '')) {
    extraWithHash.videoHash = routeHash;
  }

  const seasonFromExtra = parsedId.season === null
    ? Number.parseInt(firstUsableValue(extraWithHash, ['season', 'season_number'], ''), 10)
    : null;
  const episodeFromExtra = parsedId.episode === null
    ? Number.parseInt(firstUsableValue(extraWithHash, ['episode', 'episode_number'], ''), 10)
    : null;

  const imdbId = parsedId.imdbId || parsedVideoId.imdbId;
  const season = parsedId.season
    ?? parsedVideoId.season
    ?? (Number.isFinite(seasonFromExtra) ? seasonFromExtra : null);
  const episode = parsedId.episode
    ?? parsedVideoId.episode
    ?? (Number.isFinite(episodeFromExtra) ? episodeFromExtra : null);

  return {
    raw: parsedId.raw,
    imdbId,
    imdbNumeric: imdbId ? imdbId.replace(/^tt/i, '') : '',
    type,
    query: imdbId || parsedId.raw,
    season,
    episode,
    extra: extraWithHash,
  };
}

export function parseStremioId(id = '') {
  const clean = decodeURIComponent(String(id).replace(/\.json$/i, '').trim());
  const [imdbPart, seasonPart, episodePart] = clean.split(':');
  const imdbId = imdbPart?.match(/^tt\d+$/i) ? imdbPart.toLowerCase() : '';
  const season = Number.parseInt(seasonPart, 10);
  const episode = Number.parseInt(episodePart, 10);

  return {
    raw: clean,
    imdbId,
    imdbNumeric: imdbId ? imdbId.replace(/^tt/i, '') : '',
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
  };
}

function safeDecode(value = '') {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch {
    return String(value || '');
  }
}

export function parseExtra(extra = '') {
  const clean = String(extra || '').replace(/\.json$/i, '');
  const output = {};

  for (const part of clean.split('&')) {
    if (!part) continue;
    const [rawKey, ...rest] = part.split('=');
    if (!rawKey || !rest.length) continue;
    output[safeDecode(rawKey)] = safeDecode(rest.join('='));
  }

  return output;
}

function absoluteUrl(url, baseUrl = '') {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(url).replace(/^\/+/, '')}`;
}

// v1.7.1: download يأتي من subtitleService إما:
//   1. /proxy/encoding/<token>.srt  (الحالة الافتراضية — encoding proxy مفعّل)
//   2. /ai/deepseek/<token>.srt     (AI fallback — UTF-8 جاهز من DeepSeek)
//   3. /downloads/subsource/<id>    (encoding proxy معطّل، fallback raw)
//   4. https://...                  (encoding proxy معطّل، رابط مباشر)
//
// Stremio's local proxy (legacy): يُلفّ الأنواع 3 و 4 فقط، لأن 1 و 2 يخرجان UTF-8 جاهزًا.
function useStremioLocalProxy(url) {
  if (!config.stremio.encodingProxy) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\/ai\/deepseek\//i.test(url)) return false;
  if (/\/proxy\/encoding\//i.test(url)) return false;
  if (/\.(rar|7z)(\?|#|$)/i.test(url)) return false;
  return /\.(srt|vtt|ass|ssa|sub|zip)(\?|#|$)/i.test(url) || !/\.[a-z0-9]{2,5}(\?|#|$)/i.test(url);
}

/**
 * يُحوّل URL للشكل المناسب لـ Stremio.
 * subtitleService تتولى لف الترجمات بـ encoding proxy بالفعل،
 * لذا هنا فقط نتعامل مع legacy Stremio local proxy لو فُعّل.
 */
function stremioSubtitleUrl(url) {
  if (useStremioLocalProxy(url)) {
    return `${config.stremio.encodingProxyBaseUrl}/subtitles.vtt?from=${encodeURIComponent(url)}`;
  }
  return url;
}

export function toStremioSubtitles(results, baseUrl = '') {
  const subtitles = [];

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item.download) continue;

    const lang = normalizeLanguage(item.language);
    const absolute = absoluteUrl(item.download, baseUrl);
    const url = stremioSubtitleUrl(absolute);

    const source = String(item.source || 'subtitle').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const stable = String(item.id || item.file || item.title || subtitles.length)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 80);

    subtitles.push({
      id: `${source}:${lang.code3}:${stable || subtitles.length}`,
      lang: lang.code3, // ISO 639-2 — مطلب Stremio لعرض اسم اللغة صحيحًا
      url,
      name: config.app.subtitleDisplayName,
    });
  }

  return subtitles;
}
