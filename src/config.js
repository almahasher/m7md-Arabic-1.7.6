// =============================================================================
// config.js — Centralized config (v1.7.6)
// =============================================================================

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

const RELEASE_VERSION = '1.7.6';
const RELEASE_ID = 'community.stremio-enterprise-subtitles-v176';
const RELEASE_NAME = `m7md Arabic ${RELEASE_VERSION}`;
const RELEASE_USER_AGENT = `m7mdArabicSubtitles/${RELEASE_VERSION}`;
const RELEASE_CACHE_SALT = `release:${RELEASE_VERSION}`;


function toInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function csv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cachePrefix(value) {
  const base = String(value || 'subtitles').trim().replace(/:+$/, '') || 'subtitles';
  // نضيف salt ثابتًا من رقم الإصدار حتى لا يظل Railway/Redis عالقًا على كاش إصدار قديم.
  return `${base}:${RELEASE_CACHE_SALT}`;
}

export const config = Object.freeze({
  app: {
    // هوية الـ manifest مقفلة على الإصدار الحالي عمدًا لتجاوز متغيرات Railway القديمة وكاش Stremio.
    // إذا احتجت تخصيصها لاحقًا، فعّل ADDON_USE_ENV_IDENTITY=true صراحةً.
    id: toBool(process.env.ADDON_USE_ENV_IDENTITY, false) && process.env.ADDON_ID ? process.env.ADDON_ID : RELEASE_ID,
    name: toBool(process.env.ADDON_USE_ENV_IDENTITY, false) && process.env.ADDON_NAME ? process.env.ADDON_NAME : RELEASE_NAME,
    version: RELEASE_VERSION,
    description: process.env.ADDON_DESCRIPTION || 'Arabic-first subtitles for Stremio with server-side encoding normalization and DeepSeek fallback.',
    userAgent: RELEASE_USER_AGENT,
    publicBaseUrl: cleanBaseUrl(
      process.env.PUBLIC_BASE_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    ),
    subtitleDisplayName: process.env.SUBTITLE_DISPLAY_NAME || 'm7md Arabic',
  },

  // ── Smart Encoding Proxy على مستوى الـ addon ───────────
  encodingProxy: {
    // الافتراضي true: الـ addon يتولى تحويل كل ترجمة إلى UTF-8 SRT نظيف.
    // أفضل تجربة على PS5 / Android TV / Sony Bravia.
    enabled: toBool(process.env.ENCODING_PROXY_ENABLED, true),
    cacheTtlSeconds: toInt(process.env.ENCODING_PROXY_CACHE_TTL, 86400, 300, 2592000),
    linkTtlSeconds: toInt(process.env.ENCODING_PROXY_LINK_TTL, 86400 * 7, 300, 2592000),
    stripSdhDefault: toBool(process.env.ENCODING_PROXY_STRIP_SDH, false),
    stripMusicNotes: toBool(process.env.ENCODING_PROXY_STRIP_MUSIC, false),
    secret: process.env.ENCODING_PROXY_SECRET || process.env.AI_LINK_SECRET || '',
  },

  // ── Stremio legacy encoding proxy (محلي) — معطّل افتراضيًا ────────────
  stremio: {
    // فعّلها فقط إذا أردت توجيه الترجمات إلى Stremio's local server بدل الـ addon.
    encodingProxy: toBool(process.env.STREMIO_ENCODING_PROXY, false),
    encodingProxyBaseUrl: cleanBaseUrl(process.env.STREMIO_ENCODING_PROXY_BASE_URL || 'http://127.0.0.1:11470'),
  },

  server: {
    port: toInt(process.env.PORT, 3000, 1, 65535),
    nodeEnv: process.env.NODE_ENV || 'development',
    isProd: process.env.NODE_ENV === 'production',
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? csv(process.env.ALLOWED_ORIGINS)
      : '*',
    trustProxy: toBool(process.env.TRUST_PROXY, true),
  },

  providers: {
    enabled: csv(process.env.SUBTITLE_PROVIDERS, ['opensubtitles', 'subdl', 'subsource'])
      .map(provider => provider.toLowerCase()),
    searchLanguages: csv(process.env.PROVIDER_SEARCH_LANGUAGES, ['ar', 'en']),
    outputArabicOnly: toBool(process.env.PROVIDER_OUTPUT_ARABIC_ONLY, true),
    excludeHearingImpaired: toBool(process.env.PROVIDER_EXCLUDE_HEARING_IMPAIRED, false),
    excludeMachineTranslated: toBool(process.env.PROVIDER_EXCLUDE_MACHINE_TRANSLATED, true),
    strictQualityFilters: toBool(process.env.PROVIDER_STRICT_QUALITY_FILTERS, false),
    timeoutMs: toInt(process.env.PROVIDER_TIMEOUT_MS, 4500, 500, 15000),
    retries: toInt(process.env.PROVIDER_RETRIES, 2, 1, 5),
    retryBaseMs: toInt(process.env.PROVIDER_RETRY_BASE_MS, 250, 0, 3000),
    breakerLimit: toInt(process.env.CIRCUIT_BREAKER_LIMIT, 4, 1, 20),
    breakerResetMs: toInt(process.env.CIRCUIT_BREAKER_RESET_MS, 30000, 1000, 300000),
    topN: toInt(process.env.TOP_N, 5, 1, 20),
    preferredLanguages: csv(process.env.PREFERRED_LANGUAGES, ['ar', 'ara', 'arabic']),
    maxProviderItems: toInt(process.env.MAX_PROVIDER_ITEMS, 60, 5, 200),
  },

  openSubtitles: {
    apiKey: process.env.OPENSUBTITLES_API_KEY || '',
    token: process.env.OPENSUBTITLES_TOKEN || '',
    username: process.env.OPENSUBTITLES_USERNAME || '',
    password: process.env.OPENSUBTITLES_PASSWORD || '',
    baseUrl: cleanBaseUrl(process.env.OPENSUBTITLES_BASE_URL || 'https://api.opensubtitles.com/api/v1'),
    // ميزات جودة لنتائج OpenSubtitles
    orderBy: process.env.OPENSUBTITLES_ORDER_BY || 'download_count',  // language|download_count|new|rating
    orderDirection: process.env.OPENSUBTITLES_ORDER_DIRECTION || 'desc',
    trustedOnly: toBool(process.env.OPENSUBTITLES_TRUSTED_ONLY, false),
  },

  subdl: {
    apiKey: process.env.SUBDL_API_KEY || '',
    baseUrl: cleanBaseUrl(process.env.SUBDL_BASE_URL || 'https://api.subdl.com/api/v1/subtitles'),
    downloadBaseUrl: cleanBaseUrl(process.env.SUBDL_DOWNLOAD_BASE_URL || 'https://dl.subdl.com'),
  },

  subsource: {
    apiKey: process.env.SUBSOURCE_API_KEY || '',
    baseUrl: cleanBaseUrl(process.env.SUBSOURCE_BASE_URL || 'https://api.subsource.net'),
  },

  ai: {
    enabled: toBool(process.env.ENABLE_AI_TRANSLATION, false),
    fallbackOnly: toBool(process.env.AI_FALLBACK_ONLY, true),
    requireNoArabic: toBool(process.env.AI_ONLY_WHEN_NO_ARABIC, true),
    requireExplicitSelection: toBool(process.env.AI_REQUIRE_EXPLICIT_SELECTION, true),
    provider: process.env.AI_PROVIDER || 'deepseek',
    targetLanguage: process.env.AI_TARGET_LANGUAGE || 'Arabic',
    sourceLanguages: csv(process.env.AI_SOURCE_LANGUAGES, ['en', 'eng', 'english']),
    displayName: process.env.AI_SUBTITLE_DISPLAY_NAME || process.env.SUBTITLE_DISPLAY_NAME || 'm7md Arabic',
    cacheTtlSeconds: toInt(process.env.AI_CACHE_TTL, 2592000, 3600, 7776000),
    linkTtlSeconds: toInt(process.env.AI_LINK_TTL, 21600, 300, 86400),
    maxSourceBytes: toInt(process.env.AI_MAX_SOURCE_BYTES, 180000, 1000, 500000),
    maxInputChars: toInt(process.env.AI_MAX_INPUT_CHARS, 90000, 1000, 250000),
    maxOutputTokens: toInt(process.env.AI_MAX_OUTPUT_TOKENS, 12000, 256, 32000),
    dailyTokenLimit: toInt(process.env.AI_DAILY_TOKEN_LIMIT, 0, 0, 10000000),
    dailyRequestLimit: toInt(process.env.AI_DAILY_REQUEST_LIMIT, 0, 0, 10000),
    timeoutMs: toInt(process.env.AI_TIMEOUT_MS, 45000, 5000, 120000),
    linkSecret: process.env.AI_LINK_SECRET || '',
  },

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: cleanBaseUrl(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  },

  cache: {
    ttlSeconds: toInt(process.env.CACHE_TTL, 3600, 30, 86400),
    redisUrl: process.env.REDIS_URL || '',
    memoryMaxItems: toInt(process.env.MEMORY_CACHE_MAX_ITEMS, 500, 50, 10000),
    keyPrefix: cachePrefix(process.env.CACHE_KEY_PREFIX || 'subtitles'),
  },

  rateLimit: {
    windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
    max: toInt(process.env.RATE_LIMIT_MAX, 120, 1, 10000),
  },
});
