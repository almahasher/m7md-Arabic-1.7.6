import { Agent, request } from 'undici';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { firstUsableValue, isUsableExternalValue } from '../utils/values.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10,
  pipelining: 1,
});

function isEnabled() {
  return config.providers.enabled.includes('subsource');
}

const cachedApiHeaders = {
  'Accept': 'application/json',
  'X-API-Key': config.subsource.apiKey,
};

const LANG_MAP = { ar: 'arabic', ara: 'arabic', arabic: 'arabic', en: 'english', eng: 'english', english: 'english' };

function languageName(lang) {
  const value = String(lang || '').toLowerCase();
  return LANG_MAP[value] || value || 'arabic';
}

function unwrapArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.response)) return data.response;
  return [];
}

function normalizeMovie(item) {
  return {
    id: firstUsableValue(item, ['id', 'movieId', 'movie_id']),
    imdbId: firstUsableValue(item, ['imdb', 'imdbId', 'imdb_id']),
    title: firstUsableValue(item, ['title', 'name', 'movieName', 'movie_name']),
  };
}

function typeName(search) {
  return search?.type === 'series' || search?.season ? 'series' : 'movie';
}

function localDownloadPath(subtitleId) {
  return `/downloads/subsource/${encodeURIComponent(String(subtitleId))}`;
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
    data = { error: text?.slice(0, 300) || 'Invalid JSON response from SubSource' };
  }
  return { status: statusCode, data };
}

async function searchMovieId(search) {
  const params = new URLSearchParams();
  params.set('searchType', search.imdbId ? 'imdb' : 'text');
  if (search.imdbId) params.set('imdb', search.imdbId);
  if (!search.imdbId && search.query) params.set('q', search.query);
  if (isUsableExternalValue(search.extra?.filename)) params.set('q', search.extra.filename);
  params.set('type', typeName(search));
  if (search.season) params.set('season', String(search.season));

  const { data } = await fetchJson(`${config.subsource.baseUrl}/api/v1/movies/search?${params.toString()}`, {
    method: 'GET',
    headers: cachedApiHeaders,
  });

  const movies = unwrapArray(data).map(normalizeMovie).filter(movie => movie.id);
  if (!movies.length) return null;

  const numeric = String(search.imdbNumeric || '').replace(/^tt/i, '');
  const exact = movies.find(movie => String(movie.imdbId || '').replace(/^tt/i, '') === numeric);
  return exact?.id || movies[0].id;
}

function mapSubSourceSubtitle(item, search, lang) {
  const subtitleId = firstUsableValue(item, ['id', 'subtitleId', 'subtitle_id'], 'unknown');
  const file = firstUsableValue(item, ['releaseInfo', 'release_info', 'release', 'fileName', 'filename', 'name', 'title']);
  const dlPath = localDownloadPath(subtitleId);

  return {
    source: 'SubSource',
    title: file || 'SubSource subtitle',
    language: firstUsableValue(item, ['language', 'lang'], lang),
    file,
    download: dlPath,
    _file_id: subtitleId,
    _subsourceId: String(subtitleId), // v1.7.1: للاستخدام مع encoding proxy
    _downloads: item.downloads ?? item.downloadCount ?? item.download_count ?? 0,
    _rating: item.rating ?? 0,
    _trusted: true,
    _hearing_impaired: Boolean(item.hearingImpaired || item.hearing_impaired),
    _imdb_id: search.imdbId || '',
    _season: search.season,
    _episode: search.episode,
    _download_path: dlPath,
  };
}

export function isSubSourceConfigured() {
  return Boolean(isEnabled() && config.subsource.apiKey);
}

export function getSubSourceRuntimeStatus() {
  return {
    enabled: isEnabled(),
    configured: isSubSourceConfigured(),
  };
}

export async function subSourceProvider(search) {
  if (!isSubSourceConfigured()) throw new Error('SUBSOURCE_API_KEY is not set or SubSource is disabled');

  const movieId = await searchMovieId(search);
  if (!movieId) return [];

  const settled = await Promise.allSettled(
    config.providers.searchLanguages.map(async langInput => {
      const lang = languageName(langInput);
      const params = new URLSearchParams();
      params.set('movieId', String(movieId));
      params.set('language', lang);
      params.set('limit', String(config.providers.maxProviderItems));
      params.set('sort', 'downloads');

      const { data } = await fetchJson(`${config.subsource.baseUrl}/api/v1/subtitles?${params.toString()}`, {
        method: 'GET',
        headers: cachedApiHeaders,
      });

      return unwrapArray(data).map(item => mapSubSourceSubtitle(item, search, lang));
    })
  );

  const results = [];

  for (let i = 0; i < settled.length && results.length < config.providers.maxProviderItems; i++) {
    const result = settled[i];
    if (result.status !== 'fulfilled') continue;

    const items = result.value;
    for (let j = 0; j < items.length && results.length < config.providers.maxProviderItems; j++) {
      results.push(items[j]);
    }
  }

  return results;
}

export async function proxySubSourceDownload(subtitleId) {
  if (!isSubSourceConfigured()) {
    const err = new Error('SubSource is not configured');
    err.status = 503;
    throw err;
  }

  if (!isUsableExternalValue(subtitleId)) {
    const err = new Error('Invalid SubSource subtitle id');
    err.status = 400;
    throw err;
  }

  const { statusCode, headers, body } = await request(
    `${config.subsource.baseUrl}/api/v1/subtitles/${encodeURIComponent(String(subtitleId))}/download`,
    {
      method: 'GET',
      headers: cachedApiHeaders,
      dispatcher: agent,
      headersTimeout: config.providers.timeoutMs,
      bodyTimeout: config.providers.timeoutMs,
    }
  );

  if (statusCode >= 400) {
    await body.dump();
    const err = new Error(`SubSource download failed with status ${statusCode}`);
    err.status = statusCode;
    throw err;
  }

  return {
    statusCode,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
    body,
  };
}
