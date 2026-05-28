import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Agent, request } from 'undici';
import { config } from '../config.js';
import { getCache, setCache } from '../cache/redis.js';
import { httpError } from '../utils/httpError.js';
import { normalizeLanguage } from '../utils/language.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 4,
  pipelining: 1,
});

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const ZIP_MAGIC_0 = 0x50;
const ZIP_MAGIC_1 = 0x4b;
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8');
}

function getSigningSecret() {
  return config.ai.linkSecret || config.deepseek.apiKey || `${config.app.id}:${config.app.version}`;
}

function signPayload(payload) {
  return createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

function safeCompare(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function isAiUsable() {
  return Boolean(
    config.ai.enabled &&
    config.ai.provider === 'deepseek' &&
    config.deepseek.apiKey &&
    config.ai.dailyTokenLimit > 0 &&
    config.ai.dailyRequestLimit > 0
  );
}

function isArabic(item) {
  const lang = normalizeLanguage(item?.language);
  return lang.code2 === 'ar' || lang.code3 === 'ara' || lang.name.toLowerCase() === 'arabic';
}

function isAllowedSourceLanguage(item) {
  const lang = normalizeLanguage(item?.language);
  const allowed = new Set(config.ai.sourceLanguages.map(value => String(value).toLowerCase()));
  return allowed.has(lang.raw.toLowerCase()) || allowed.has(lang.code2) || allowed.has(lang.code3) || allowed.has(lang.name.toLowerCase());
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

export function createDeepSeekFallbackSubtitle(results, search) {
  if (!isAiUsable()) return null;
  if (config.ai.fallbackOnly === false) return null;
  if (config.ai.requireNoArabic && results.some(isArabic)) return null;

  const source = results.find(item => item?.download && isHttpUrl(item.download) && isAllowedSourceLanguage(item));
  if (!source) return null;

  const expiresAt = Date.now() + config.ai.linkTtlSeconds * 1000;
  const payload = base64UrlEncode(JSON.stringify({
    v: 1,
    exp: expiresAt,
    url: source.download,
    title: source.title || search?.query || search?.imdbId || 'subtitle',
    file: source.file || source.title || 'subtitle.srt',
    source: source.source || 'unknown',
    lang: source.language || 'en',
    imdbId: search?.imdbId || '',
    season: search?.season ?? null,
    episode: search?.episode ?? null,
  }));
  const signature = signPayload(payload);

  return {
    source: 'DeepSeek',
    title: source.title || 'DeepSeek Arabic fallback',
    language: 'ar',
    file: `${source.file || 'subtitle'}.deepseek-ar.srt`,
    download: `/ai/deepseek/${payload}.${signature}.srt`,
  };
}

function parseSignedToken(token) {
  const clean = String(token || '').replace(/\.srt$/i, '');
  const dot = clean.lastIndexOf('.');
  if (dot < 1) throw httpError(400, 'Invalid AI translation token');

  const payload = clean.slice(0, dot);
  const signature = clean.slice(dot + 1);
  const expected = signPayload(payload);

  if (!safeCompare(signature, expected)) throw httpError(403, 'Invalid AI translation signature');

  let data;
  try {
    data = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw httpError(400, 'Invalid AI translation payload');
  }

  if (!data?.url || !isHttpUrl(data.url)) throw httpError(400, 'Invalid AI subtitle source URL');
  if (!data?.exp || Date.now() > Number(data.exp)) throw httpError(410, 'AI translation link expired');

  return data;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function secondsUntilTomorrow() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000));
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.6);
}

async function readDailyUsage() {
  const usage = await getCache(`${config.cache.keyPrefix}:ai-usage:${todayKey()}`);
  return usage && typeof usage === 'object' ? usage : { tokens: 0, requests: 0 };
}

async function writeDailyUsage(usage) {
  await setCache(`${config.cache.keyPrefix}:ai-usage:${todayKey()}`, usage, secondsUntilTomorrow());
}

function assertBudgetAvailable(usage, estimatedTokens) {
  if (config.ai.dailyRequestLimit <= 0 || config.ai.dailyTokenLimit <= 0) {
    throw httpError(429, 'AI translation budget is locked. Set AI_DAILY_TOKEN_LIMIT and AI_DAILY_REQUEST_LIMIT above zero to allow usage.');
  }

  if (usage.requests + 1 > config.ai.dailyRequestLimit) {
    throw httpError(429, 'AI daily request limit reached.');
  }

  if (usage.tokens + estimatedTokens > config.ai.dailyTokenLimit) {
    throw httpError(429, 'AI daily token limit would be exceeded.');
  }
}

async function fetchSourceSubtitle(url) {
  const { statusCode, headers, body } = await request(url, {
    method: 'GET',
    headers: {
      'Accept': 'text/plain,text/vtt,application/x-subrip,*/*;q=0.5',
      'Accept-Encoding': 'identity,gzip',
      'User-Agent': config.app.userAgent,
    },
    dispatcher: agent,
    headersTimeout: config.ai.timeoutMs,
    bodyTimeout: config.ai.timeoutMs,
  });

  if (statusCode >= 400) {
    await body.dump();
    throw httpError(statusCode, `Source subtitle download failed with status ${statusCode}`);
  }

  const contentLength = Number(headers['content-length'] || 0);
  if (contentLength > config.ai.maxSourceBytes) {
    await body.dump();
    throw httpError(413, 'Source subtitle is larger than AI_MAX_SOURCE_BYTES.');
  }

  let bytes = Buffer.from(await body.arrayBuffer());
  if (bytes.length > config.ai.maxSourceBytes) {
    throw httpError(413, 'Source subtitle is larger than AI_MAX_SOURCE_BYTES.');
  }

  if (bytes[0] === ZIP_MAGIC_0 && bytes[1] === ZIP_MAGIC_1) {
    throw httpError(415, 'ZIP subtitles are blocked for AI translation to prevent unexpected token usage. Use a direct SRT/VTT source.');
  }

  if (bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1) {
    bytes = gunzipSync(bytes);
    if (bytes.length > config.ai.maxSourceBytes) {
      throw httpError(413, 'Decompressed subtitle is larger than AI_MAX_SOURCE_BYTES.');
    }
  }

  const text = TEXT_DECODER.decode(bytes).replace(/^\uFEFF/, '').trim();
  if (!text) throw httpError(422, 'Source subtitle is empty.');
  if (text.length > config.ai.maxInputChars) {
    throw httpError(413, 'Source subtitle exceeds AI_MAX_INPUT_CHARS.');
  }

  return text;
}

function buildPrompt(subtitleText) {
  return [
    {
      role: 'system',
      content: [
        'You are a professional subtitle translator for Arabic viewers.',
        `Translate subtitles to ${config.ai.targetLanguage}.`,
        'Use natural Modern Standard Arabic with clear conversational phrasing when appropriate.',
        'Preserve SRT/VTT cue numbering, timestamps, cue settings, speaker labels, HTML tags, ASS/SSA tags, and line breaks as much as possible.',
        'Do not add explanations, comments, markdown, introductions, or notes.',
        'Return only the translated subtitle file content as UTF-8 text.',
        'Keep proper names, brands, filenames, and technical tags unless a natural Arabic translation is clearly needed.',
      ].join(' '),
    },
    {
      role: 'user',
      content: subtitleText,
    },
  ];
}

function stripMarkdownFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:srt|vtt|text)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function hasSubtitleTiming(value) {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(String(value || ''));
}

async function callDeepSeek(subtitleText) {
  const payload = {
    model: config.deepseek.model,
    messages: buildPrompt(subtitleText),
    stream: false,
    thinking: { type: 'disabled' },
    temperature: 0.1,
    max_tokens: config.ai.maxOutputTokens,
  };

  const { statusCode, body } = await request(`${config.deepseek.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.deepseek.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
    dispatcher: agent,
    headersTimeout: config.ai.timeoutMs,
    bodyTimeout: config.ai.timeoutMs,
  });

  const text = await body.text();
  const data = text ? JSON.parse(text) : {};

  if (statusCode >= 400) {
    throw httpError(statusCode, data?.error?.message || `DeepSeek request failed with status ${statusCode}`);
  }

  const translated = stripMarkdownFence(data?.choices?.[0]?.message?.content);
  if (!translated) throw httpError(502, 'DeepSeek returned an empty translation.');
  if (hasSubtitleTiming(subtitleText) && !hasSubtitleTiming(translated)) {
    throw httpError(502, 'DeepSeek translation did not preserve subtitle timing.');
  }

  return {
    text: translated,
    usedTokens: Number(data?.usage?.total_tokens || 0) || estimateTokens(subtitleText) + estimateTokens(translated),
  };
}

export async function translateDeepSeekSubtitle(token) {
  if (!isAiUsable()) {
    throw httpError(503, 'DeepSeek AI translation is disabled or budget-locked.');
  }

  const payload = parseSignedToken(token);
  const sourceText = await fetchSourceSubtitle(payload.url);
  const contentHash = sha256(`${config.deepseek.model}:${payload.url}:${sourceText}`);
  const cacheKey = `${config.cache.keyPrefix}:ai-translation:${contentHash}`;
  const cached = await getCache(cacheKey);
  if (cached?.text) return { text: cached.text, cache: 'hit' };

  const estimated = estimateTokens(sourceText) + config.ai.maxOutputTokens;
  const usage = await readDailyUsage();
  assertBudgetAvailable(usage, estimated);

  const translated = await callDeepSeek(sourceText);

  await setCache(cacheKey, { text: translated.text, model: config.deepseek.model }, config.ai.cacheTtlSeconds);
  await writeDailyUsage({
    requests: usage.requests + 1,
    tokens: usage.tokens + translated.usedTokens,
    updatedAt: new Date().toISOString(),
  });

  return { text: translated.text, cache: 'miss' };
}

export function getAiRuntimeStatus() {
  const configured = Boolean(config.deepseek.apiKey);
  const budgetOpen = config.ai.dailyTokenLimit > 0 && config.ai.dailyRequestLimit > 0;

  return {
    enabled: config.ai.enabled,
    provider: config.ai.provider,
    configured,
    model: config.deepseek.model,
    fallbackOnly: config.ai.fallbackOnly,
    requireNoArabic: config.ai.requireNoArabic,
    strictBudget: true,
    budgetOpen,
    dailyTokenLimit: config.ai.dailyTokenLimit,
    dailyRequestLimit: config.ai.dailyRequestLimit,
    maxInputChars: config.ai.maxInputChars,
    maxOutputTokens: config.ai.maxOutputTokens,
    cacheTtlSeconds: config.ai.cacheTtlSeconds,
  };
}
