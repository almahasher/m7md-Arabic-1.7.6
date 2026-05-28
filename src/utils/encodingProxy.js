// =============================================================================
// encodingProxy.js — Smart Arabic encoding proxy (v1.7.1)
//
// يستقبل توكنًا موقعًا، يجلب الملف الأصلي من المزود، يكتشف ترميزه،
// يحوّله إلى UTF-8 SRT نظيف، ثم يرسله للمشغل.
//
// الفائدة: لا حاجة لتفعيل Stremio encoding proxy المحلي على PS5 / TV
// — إعادة الترميز تتم خادميًا وتُسلَّم جاهزة.
// =============================================================================

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync, inflateSync, brotliDecompressSync, inflateRawSync } from 'node:zlib';
import { Agent, request } from 'undici';
import { config } from '../config.js';
import { getCache, setCache } from '../cache/redis.js';
import { httpError } from './httpError.js';
import { processSubtitleBytes } from './subtitleProcessor.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 8,
  pipelining: 1,
});

const ZIP_MAGIC = [0x50, 0x4B];
const GZIP_MAGIC = [0x1F, 0x8B];
const MAX_REDIRECTS = 4;
const PROCESSOR_CACHE_VERSION = 'subtitle-processor:v2';

function getSecret() {
  return config.encodingProxy.secret || `${config.app.id}:${config.app.version}:encoding-proxy`;
}

function sign(payload) {
  return createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

function safeCompare(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

/**
 * يُنشئ توكنًا موقّعًا يمكن وضعه في URL الترجمة.
 * صالح لمدة config.encodingProxy.linkTtlSeconds.
 *
 * @param {string} url — رابط المصدر (HTTP/HTTPS) أو معرّف upstream (مثل subsource:12345)
 * @param {Object} opts
 *   - stripSdh, stripMusicNotes: تنظيف اختياري
 *   - source: 'subsource' | 'subdl' | 'opensubtitles' | null
 *     لو 'subsource'، البروكسي سيستدعي SubSource API بـ auth header بدل HTTP GET مباشر.
 */
export function buildEncodingProxyToken(url, opts = {}) {
  if (!url) return '';
  // لـ subsource نسمح بمعرّف غير HTTP (subtitle id)
  if (opts.source !== 'subsource' && !isHttpUrl(url)) return '';

  const ttl = config.encodingProxy?.linkTtlSeconds || 86400;
  const payload = base64UrlEncode(JSON.stringify({
    v: 2, // رفع الإصدار لأن الـ schema تغيّر (أضفنا source)
    exp: Date.now() + ttl * 1000,
    url,
    src: opts.source || null,
    stripSdh: Boolean(opts.stripSdh),
    stripMusicNotes: Boolean(opts.stripMusicNotes),
  }));
  const signature = sign(payload);

  return `${payload}.${signature}`;
}

function parseToken(token) {
  const clean = String(token || '').replace(/\.srt$/i, '');
  const dot = clean.lastIndexOf('.');
  if (dot < 1) throw httpError(400, 'Invalid encoding-proxy token');

  const payload = clean.slice(0, dot);
  const signature = clean.slice(dot + 1);
  const expected = sign(payload);

  if (!safeCompare(signature, expected)) throw httpError(403, 'Invalid encoding-proxy signature');

  let data;
  try {
    data = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw httpError(400, 'Invalid encoding-proxy payload');
  }

  // دعم schema v1 (قديم: HTTP URL فقط) و v2 (HTTP URL أو معرّف upstream)
  const isSubsource = data?.src === 'subsource';
  if (!data?.url) throw httpError(400, 'Missing source in token');
  if (!isSubsource && !isHttpUrl(data.url)) throw httpError(400, 'Invalid source URL in token');
  if (!data?.exp || Date.now() > Number(data.exp)) throw httpError(410, 'Encoding-proxy link expired');

  return data;
}

async function requestSubtitleUrl(url) {
  return request(url, {
    method: 'GET',
    headers: {
      'Accept': 'text/plain,text/vtt,application/x-subrip,application/octet-stream,*/*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br, identity',
      'User-Agent': config.app.userAgent,
    },
    dispatcher: agent,
    headersTimeout: config.providers.timeoutMs * 2, // تنزيل ملف قد يكون أبطأ من JSON
    bodyTimeout: config.providers.timeoutMs * 2,
  });
}

async function fetchBytes(url) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await requestSubtitleUrl(currentUrl);
    const { statusCode, headers, body } = response;

    if (statusCode >= 300 && statusCode < 400) {
      const location = headers['location'];
      await body.dump();
      if (!location) throw httpError(statusCode, `Subtitle redirect missing Location header (${statusCode})`);
      currentUrl = /^https?:\/\//i.test(location)
        ? location
        : new URL(location, currentUrl).toString();
      continue;
    }

    if (statusCode >= 400) {
      await body.dump();
      throw httpError(statusCode, `Subtitle fetch failed with status ${statusCode}`);
    }

    return processResponse(response);
  }

  throw httpError(508, 'Too many subtitle redirects');
}

async function processResponse({ headers, body }) {
  let bytes = Buffer.from(await body.arrayBuffer());

  // فك ضغط HTTP لو الخادم سلّم ضغطًا بالرغم من Accept-Encoding
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('gzip')) bytes = gunzipSync(bytes);
    else if (enc.includes('deflate')) bytes = inflateSync(bytes);
    else if (enc.includes('br')) bytes = brotliDecompressSync(bytes);
  } catch {
    // الخادم يكذب أحيانًا — تجاهل
  }

  // فك ضغط GZIP داخل المحتوى نفسه (بعض مصادر OpenSubtitles ترسل gz)
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
    try { bytes = gunzipSync(bytes); } catch {}
  }

  // ZIP: نستخرج أول ملف SRT/VTT من الأرشيف بدلاً من الرفض
  if (bytes.length >= 2 && bytes[0] === ZIP_MAGIC[0] && bytes[1] === ZIP_MAGIC[1]) {
    const extracted = extractFirstSubtitleFromZip(bytes);
    if (extracted) return extracted;
    throw httpError(415, 'ZIP archive does not contain any SRT/VTT subtitle files.');
  }

  return bytes;
}

// =============================================================================
// استخراج ملف ترجمة من ZIP بدون مكتبات خارجية
// =============================================================================

const SUBTITLE_EXTENSIONS = /\.(srt|vtt|ass|ssa|sub)$/i;
const LOCAL_FILE_HEADER_SIG = 0x04034b50;

/**
 * يقرأ uint16/uint32 little-endian من Buffer.
 */
function readU16LE(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readU32LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

/**
 * يبحث في ZIP عن أول ملف ترجمة (SRT/VTT) ويستخرجه.
 * يدعم method 0 (stored) و method 8 (deflated).
 */
function extractFirstSubtitleFromZip(zipBytes) {
  let offset = 0;

  // نمر على Local File Headers حتى نجد ملف ترجمة
  while (offset + 30 <= zipBytes.length) {
    const sig = readU32LE(zipBytes, offset);
    if (sig !== LOCAL_FILE_HEADER_SIG) break;

    const method = readU16LE(zipBytes, offset + 8);
    const compressedSize = readU32LE(zipBytes, offset + 18);
    const uncompressedSize = readU32LE(zipBytes, offset + 22);
    const fileNameLen = readU16LE(zipBytes, offset + 26);
    const extraLen = readU16LE(zipBytes, offset + 28);
    const fileNameStart = offset + 30;
    const fileName = zipBytes.subarray(fileNameStart, fileNameStart + fileNameLen).toString('utf8');
    const dataStart = fileNameStart + fileNameLen + extraLen;

    // تخطّي المجلدات
    if (!fileName.endsWith('/') && SUBTITLE_EXTENSIONS.test(fileName)) {
      const compressedData = zipBytes.subarray(dataStart, dataStart + compressedSize);

      try {
        if (method === 0) {
          // Stored: الملف غير مضغوط
          return Buffer.from(compressedData);
        } else if (method === 8) {
          // Deflated: نفك بـ inflateRawSync (بدون zlib header)
          return inflateRawSync(compressedData);
        }
      } catch {
        // فشل الاستخراج — نجرب الملف التالي
      }
    }

    // انتقل للملف التالي
    offset = dataStart + compressedSize;
  }

  return null;
}

/**
 * جلب ترجمة من SubSource بـ API key (لأنها تتطلب auth header، لا تعمل بـ GET مباشر).
 *
 * @param {string} subtitleId — معرّف الترجمة في SubSource
 */
async function fetchFromSubSource(subtitleId) {
  if (!config.subsource.apiKey) {
    throw httpError(503, 'SubSource API key not configured');
  }

  const url = `${config.subsource.baseUrl}/api/v1/subtitles/${encodeURIComponent(String(subtitleId))}/download`;
  const { statusCode, headers, body } = await request(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/x-subrip,text/plain,application/octet-stream,*/*;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br, identity',
      'User-Agent': config.app.userAgent,
      'X-API-Key': config.subsource.apiKey,
    },
    dispatcher: agent,
    headersTimeout: config.providers.timeoutMs * 2,
    bodyTimeout: config.providers.timeoutMs * 2,
  });

  if (statusCode >= 400) {
    await body.dump();
    throw httpError(statusCode, `SubSource subtitle download failed with status ${statusCode}`);
  }

  return processResponse({ headers, body });
}

/**
 * يفك التوكن، يجلب الملف (HTTP مباشر أو SubSource بـ auth)، يحوّله، ويعيد SRT جاهز.
 * مع كاش على hash من الـ source identifier.
 */
export async function resolveProxiedSubtitle(token) {
  const data = parseToken(token);
  const isSubsource = data.src === 'subsource';

  const processingOptions = {
    stripSdh: Boolean(data.stripSdh),
    stripMusicNotes: Boolean(data.stripMusicNotes),
    stripHtml: true,
    stripBidiControls: true,
    stripAssPosition: true,
  };

  // مفتاح الكاش يتضمن المصدر وخيارات التنظيف حتى لا يعيد نسخة قديمة عند تغيير SDH/music.
  const cacheIdentifier = isSubsource ? `subsource:${data.url}` : data.url;
  const cacheInput = JSON.stringify({
    source: cacheIdentifier,
    processor: PROCESSOR_CACHE_VERSION,
    options: processingOptions,
  });
  const cacheKey = `${config.cache.keyPrefix}:enc-proxy:${createHash('sha256').update(cacheInput).digest('hex').slice(0, 32)}`;
  const cached = await getCache(cacheKey);
  if (cached?.text) return { text: cached.text, cache: 'hit', encoding: cached.encoding, format: cached.format };

  const bytes = isSubsource
    ? await fetchFromSubSource(data.url)
    : await fetchBytes(data.url);

  const { text, encoding, format } = processSubtitleBytes(bytes, processingOptions);

  if (!text || text.length < 20) {
    throw httpError(422, 'Subtitle file appears empty or invalid after processing');
  }

  const ttl = config.encodingProxy?.cacheTtlSeconds || 86400;
  await setCache(cacheKey, { text, encoding, format }, ttl);

  return { text, cache: 'miss', encoding, format };
}
