import { Agent, request } from 'undici';
import { config } from '../config.js';
import { isUsableExternalValue } from '../utils/values.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10,
  pipelining: 1,
});

const DEFAULT_TOKEN_TTL_MS = 11 * 60 * 60 * 1000;
let runtimeBaseUrl = config.openSubtitles.baseUrl;
let tokenState = {
  token: config.openSubtitles.token,
  expiresAt: config.openSubtitles.token ? Date.now() + DEFAULT_TOKEN_TTL_MS : 0,
  source: config.openSubtitles.token ? 'env' : 'none',
};

function isEnabled() {
  return config.providers.enabled.includes('opensubtitles');
}

function hasAutoLoginCredentials() {
  return Boolean(config.openSubtitles.apiKey && config.openSubtitles.username && config.openSubtitles.password);
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return config.openSubtitles.baseUrl;
  const raw = String(baseUrl).trim().replace(/\/+$/, '');
  if (!raw) return config.openSubtitles.baseUrl;
  if (/\/api\/v1$/i.test(raw)) return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const host = raw.replace(/^https?:\/\//i, '');
  return `https://${host}/api/v1`;
}

function parseJwtExpiryMs(token) {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    const json = JSON.parse(decoded);
    return json.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

const baseHeaders = {
  'Api-Key': config.openSubtitles.apiKey,
  'User-Agent': config.app.userAgent,
  'Accept': 'application/json',
};

const jsonHeaders = {
  ...baseHeaders,
  'Content-Type': 'application/json',
};

let cachedBearerToken = '';
let cachedBearerHeaders = null;

function getHeaders(extra = {}, token = tokenState.token) {
  if (!token) {
    if (extra === jsonHeaders) return jsonHeaders;
    if (!extra || Object.keys(extra).length === 0) return baseHeaders;
  } else if (!extra || Object.keys(extra).length === 0) {
    if (cachedBearerToken !== token) {
      cachedBearerToken = token;
      cachedBearerHeaders = { ...baseHeaders, 'Authorization': `Bearer ${token}` };
    }
    return cachedBearerHeaders;
  }

  const headers = { ...baseHeaders, ...extra };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url, options = {}) {
  const { statusCode, body } = await request(url, {
    ...options,
    dispatcher: agent,
    headersTimeout: config.providers.timeoutMs,
    bodyTimeout: config.providers.timeoutMs,
  });

  const text = await body.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text?.slice(0, 300) || 'Invalid JSON response from OpenSubtitles' };
  }
  if (statusCode >= 400) {
    const err = new Error(data?.message || data?.error || `OpenSubtitles request failed with status ${statusCode}`);
    err.status = statusCode;
    throw err;
  }
  return { status: statusCode, data };
}

async function loginOpenSubtitles(force = false) {
  if (!config.openSubtitles.apiKey) return '';

  if (!force && tokenState.token && Date.now() < tokenState.expiresAt - 60_000) {
    return tokenState.token;
  }

  if (!hasAutoLoginCredentials()) return tokenState.token || '';

  const { data } = await fetchJson(`${config.openSubtitles.baseUrl}/login`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      username: config.openSubtitles.username,
      password: config.openSubtitles.password,
    }),
  });

  const token = data?.token || '';
  if (!token) throw new Error('OpenSubtitles login did not return a token');

  runtimeBaseUrl = normalizeBaseUrl(data?.base_url);
  tokenState = {
    token,
    expiresAt: parseJwtExpiryMs(token) || Date.now() + DEFAULT_TOKEN_TTL_MS,
    source: 'auto',
  };

  return token;
}

const cachedLanguageStr = config.providers.searchLanguages
  .map(lang => String(lang).trim().toLowerCase())
  .filter(Boolean)
  .join(',');

function buildParams(search) {
  const params = new URLSearchParams();

  if (cachedLanguageStr) params.set('languages', cachedLanguageStr);

  if (search?.imdbNumeric) params.set('imdb_id', search.imdbNumeric);
  else params.set('query', search?.query || String(search));

  if (search?.type === 'series' && search?.season) params.set('season_number', String(search.season));
  if (search?.type === 'series' && search?.episode) params.set('episode_number', String(search.episode));

  if (isUsableExternalValue(search?.extra?.videoHash)) params.set('moviehash', search.extra.videoHash);
  if (isUsableExternalValue(search?.extra?.filename)) params.set('query', search.extra.filename);

  // v1.7.2: لا نستبعد machine/AI من طلب OpenSubtitles إلا عند strict mode.
  // السبب: كثير من العربية مصنّفة آلية/AI، واستبعادها من الـ API يجعل Stremio يرى صفر نتائج.
  // الافتراضي الآن يجلبها ثم يترك scoring/filtering يفضّل البشرية بدون إخفاء العربية.
  if (config.openSubtitles.orderBy) params.set('order_by', config.openSubtitles.orderBy);
  if (config.openSubtitles.orderDirection) params.set('order_direction', config.openSubtitles.orderDirection);
  if (config.openSubtitles.trustedOnly) params.set('trusted_sources', 'only');
  if (config.providers.strictQualityFilters && config.providers.excludeMachineTranslated) {
    params.set('machine_translated', 'exclude');
    params.set('ai_translated', 'exclude');
  } else {
    params.set('machine_translated', 'include');
    params.set('ai_translated', 'include');
  }
  if (config.providers.strictQualityFilters && config.providers.excludeHearingImpaired) {
    params.set('hearing_impaired', 'exclude');
  }

  return params.toString();
}

function normalizeImdb(value) {
  if (!value) return '';
  return `tt${String(value).replace(/^tt/i, '')}`.toLowerCase();
}

export function isOpenSubtitlesConfigured() {
  return Boolean(isEnabled() && config.openSubtitles.apiKey);
}

export function getOpenSubtitlesRuntimeStatus() {
  return {
    enabled: isEnabled(),
    configured: isOpenSubtitlesConfigured(),
    staticToken: Boolean(config.openSubtitles.token),
    autoLoginReady: hasAutoLoginCredentials(),
    tokenReady: Boolean(tokenState.token || hasAutoLoginCredentials()),
    tokenSource: tokenState.source,
  };
}

export async function openSubtitlesProvider(search) {
  if (!isOpenSubtitlesConfigured()) throw new Error('OPENSUBTITLES_API_KEY is not set or OpenSubtitles is disabled');

  const token = await loginOpenSubtitles().catch(() => '');
  const qs = buildParams(search);
  const { data } = await fetchJson(`${runtimeBaseUrl}/subtitles?${qs}`, {
    method: 'GET',
    headers: getHeaders({}, token),
  });

  const items = data?.data;
  if (!items) return [];
  const limit = Math.min(items.length, config.providers.maxProviderItems);
  const results = [];

  for (let i = 0; i < limit; i++) {
    const item = items[i];
    const attributes = item.attributes || {};
    const feature = attributes.feature_details || {};
    const file = Array.isArray(attributes.files) ? attributes.files[0] || {} : {};
    const fileId = file.file_id ?? null;
    if (!fileId) continue;

    results.push({
      source: 'OpenSubtitles',
      title: feature.movie_name || attributes.release || attributes.filename || '',
      language: attributes.language || '',
      file: file.file_name || attributes.release || attributes.filename || '',
      download: '',
      _file_id: fileId,
      _downloads: attributes.download_count ?? 0,
      _rating: attributes.ratings ?? 0,
      _trusted: Boolean(attributes.from_trusted),
      _hearing_impaired: Boolean(attributes.hearing_impaired),
      _machine_translated: Boolean(attributes.machine_translated),
      _ai_translated: Boolean(attributes.ai_translated),
      _fps: Number(attributes.fps) || null,
      _hd: Boolean(attributes.hd),
      _imdb_id: normalizeImdb(feature.imdb_id),
      _season: feature.season_number,
      _episode: feature.episode_number,
    });
  }

  return results;
}

async function requestDownloadLink(fileId, token = '') {
  const { data } = await fetchJson(`${runtimeBaseUrl}/download`, {
    method: 'POST',
    headers: getHeaders({ 'Content-Type': 'application/json' }, token),
    body: JSON.stringify({ file_id: fileId }),
  });

  return data?.link || '';
}

export async function resolveDownloadLink(fileId) {
  if (!fileId || !isOpenSubtitlesConfigured()) return '';

  let token = await loginOpenSubtitles().catch(() => '');

  try {
    return await requestDownloadLink(fileId, token);
  } catch (err) {
    if (err?.status === 401 && hasAutoLoginCredentials()) {
      token = await loginOpenSubtitles(true);
      return requestDownloadLink(fileId, token);
    }
    return '';
  }
}
