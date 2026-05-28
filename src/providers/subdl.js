import { Agent, request } from 'undici';
import { config } from '../config.js';
import { firstUsableValue, isUsableExternalValue, normalizeDownloadUrl } from '../utils/values.js';
import { isArabicLanguage } from '../utils/language.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 10,
  pipelining: 1,
});

function isEnabled() {
  return config.providers.enabled.includes('subdl');
}

const LANG_MAP = { ar: 'ar', ara: 'ar', arabic: 'ar', en: 'en', eng: 'en', english: 'en' };

function mapLanguage(lang) {
  const value = String(lang || '').toLowerCase();
  return LANG_MAP[value] || String(lang || 'ar').toLowerCase();
}

const cachedLanguageStr = config.providers.searchLanguages.map(mapLanguage).join(',');
const SUBDL_MAX_SUBS_PER_PAGE = 30;

function buildQueryString(search) {
  const params = new URLSearchParams();
  params.set('api_key', config.subdl.apiKey);
  params.set('languages', cachedLanguageStr);
  params.set('subs_per_page', String(Math.min(config.providers.maxProviderItems, SUBDL_MAX_SUBS_PER_PAGE)));
  params.set('releases', '1');
  // v1.7.1: hi يعكس إعداد المستخدم — افتراضيًا نطلب hi لتنوع النتائج،
  // والاستبعاد يتم في طبقة scoring لاحقًا للحفاظ على المرونة.
  params.set('hi', '1');
  params.set('unpack', '1');
  params.set('type', search?.type === 'series' ? 'tv' : 'movie');

  if (search?.imdbId) params.set('imdb_id', search.imdbId);
  else if (search?.query) params.set('film_name', search.query);

  if (search?.type === 'series' && search?.season) params.set('season_number', String(search.season));
  if (search?.type === 'series' && search?.episode) params.set('episode_number', String(search.episode));
  if (isUsableExternalValue(search?.extra?.filename)) params.set('file_name', search.extra.filename);
  if (isUsableExternalValue(search?.extra?.year)) params.set('year', search.extra.year);

  return params.toString();
}

function matchesEpisode(item, search) {
  if (!search?.season && !search?.episode) return true;
  const season = item.season ?? item.season_number;
  const episode = item.episode ?? item.episode_number;
  if (search.season && Number(season) !== Number(search.season)) return false;
  if (search.episode && Number(episode) !== Number(search.episode)) return false;
  return true;
}

function makeResult(item, parent, search) {
  const download = normalizeDownloadUrl(
    firstUsableValue(item, ['url', 'download_url', 'downloadLink', 'link', 'zip_url']),
    config.subdl.downloadBaseUrl
  );

  if (!download) return null;

  const file = firstUsableValue(item, ['release_name', 'release', 'file_name', 'filename', 'name']);
  const language = firstUsableValue(item, ['language', 'lang', 'language_code'], firstUsableValue(parent, ['language', 'lang', 'language_code'], ''));

  return {
    source: 'SubDL',
    title: file || firstUsableValue(parent, ['release_name', 'name', 'title'], 'SubDL subtitle'),
    language,
    file,
    download,
    _file_id: firstUsableValue(item, ['file_n_id', 'id', 'subtitle_id', 'sub_id', 'sd_id', 'file_id'], firstUsableValue(parent, ['id', 'subtitle_id', 'sub_id', 'sd_id', 'file_id'], null)),
    _downloads: item.downloads ?? item.download_count ?? item.downloadCount ?? parent?.downloads ?? parent?.download_count ?? 0,
    _rating: item.rating ?? parent?.rating ?? 0,
    _trusted: true,
    _hearing_impaired: Boolean(item.hi || item.hearing_impaired || item.hearingImpaired || parent?.hi || parent?.hearing_impaired),
    _imdb_id: search?.imdbId || '',
    _season: item.season ?? parent?.season ?? search?.season,
    _episode: item.episode ?? parent?.episode ?? search?.episode,
  };
}

export function isSubdlConfigured() {
  return Boolean(isEnabled() && config.subdl.apiKey);
}

export function getSubdlRuntimeStatus() {
  return {
    enabled: isEnabled(),
    configured: isSubdlConfigured(),
  };
}

export async function subdlProvider(search) {
  if (!isSubdlConfigured()) throw new Error('SUBDL_API_KEY is not set or SubDL is disabled');

  const qs = buildQueryString(search);
  const { statusCode, body } = await request(`${config.subdl.baseUrl}?${qs}`, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    dispatcher: agent,
    headersTimeout: config.providers.timeoutMs,
    bodyTimeout: config.providers.timeoutMs,
  });

  const text = await body.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { status: false, error: text?.slice(0, 300) || 'Invalid JSON response from SubDL' };
  }

  if (statusCode >= 400 || data?.status === false) {
    throw new Error(data?.error || `SubDL request failed with status ${statusCode}`);
  }

  const items = data?.subtitles;
  if (!items || !items.length) return [];

  const limit = Math.min(items.length, config.providers.maxProviderItems);
  const results = [];

  for (let i = 0; i < limit && results.length < config.providers.maxProviderItems; i++) {
    const item = items[i];
    const unpackFiles = Array.isArray(item.unpack_files) ? item.unpack_files : [];

    // Prefer unpacked raw files for accurate Arabic display and AI fallback.
    for (let j = 0; j < unpackFiles.length && results.length < config.providers.maxProviderItems; j++) {
      const unpacked = unpackFiles[j];
      if (!matchesEpisode(unpacked, search)) continue;
      const result = makeResult(unpacked, item, search);
      if (result) results.push(result);
    }

    // v1.7.4-fix: encoding proxy الآن يدعم استخراج SRT من ZIP.
    // نضيف الكل بدون فلترة أرشيفات.
    if (!unpackFiles.length) {
      const result = makeResult(item, null, search);
      if (result) results.push(result);
    } else if (unpackFiles.length) {
      // عندما unpack_files موجود لكن item نفسه عربي مباشرة (نادر) ولا يكرر:
      const result = makeResult(item, null, search);
      if (result && isArabicLanguage(result.language)
          && !results.some(r => r.file === result.file && r.language === result.language)) {
        results.push(result);
      }
    }
  }

  return results;
}
