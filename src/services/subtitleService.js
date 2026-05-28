import { config } from '../config.js';
import { getCache, setCache } from '../cache/redis.js';
import {
  getOpenSubtitlesRuntimeStatus,
  isOpenSubtitlesConfigured,
  openSubtitlesProvider,
  resolveDownloadLink,
} from '../providers/openSubtitles.js';
import { getSubdlRuntimeStatus, isSubdlConfigured, subdlProvider } from '../providers/subdl.js';
import { getSubSourceRuntimeStatus, isSubSourceConfigured, subSourceProvider } from '../providers/subsource.js';
import { retry } from '../utils/retry.js';
import { CircuitBreaker } from '../utils/circuitBreaker.js';
import { httpError } from '../utils/httpError.js';
import { scoreSubtitle } from '../utils/scoring.js';
import { isUsableExternalValue } from '../utils/values.js';
import { isArabicLanguage } from '../utils/language.js';
import { buildEncodingProxyToken } from '../utils/encodingProxy.js';
import { createDeepSeekFallbackSubtitle, getAiRuntimeStatus } from '../ai/deepseek.js';

const inflight = new Map();
const EMPTY_RESULTS = Object.freeze([]);

const breakers = {
  openSubtitles: new CircuitBreaker(config.providers.breakerLimit, config.providers.breakerResetMs),
  subdl: new CircuitBreaker(config.providers.breakerLimit, config.providers.breakerResetMs),
  subsource: new CircuitBreaker(config.providers.breakerLimit, config.providers.breakerResetMs),
};

const WHITESPACE_RE = /\s+/g;

function normalizeQuery(value) {
  return String(value || '')
    .trim()
    .replace(WHITESPACE_RE, ' ')
    .slice(0, 200);
}

const IMDB_RE = /^tt\d+$/i;

function normalizeImdbId(value) {
  const raw = String(value || '').trim().toLowerCase();
  return IMDB_RE.test(raw) ? raw : '';
}

function cleanExtra(extra = {}) {
  const output = {};

  for (const [key, value] of Object.entries(extra || {})) {
    if (isUsableExternalValue(value)) output[key] = String(value).trim().slice(0, 300);
  }

  return output;
}

function normalizeSearch(input) {
  if (typeof input === 'string') {
    return { query: normalizeQuery(input), imdbId: '', imdbNumeric: '', type: 'movie', season: null, episode: null, extra: {} };
  }

  const imdbId = normalizeImdbId(input?.imdbId);
  const query = normalizeQuery(input?.query || imdbId || input?.raw);
  const season = Number.parseInt(input?.season, 10);
  const episode = Number.parseInt(input?.episode, 10);

  return {
    query,
    imdbId,
    imdbNumeric: input?.imdbNumeric || imdbId.replace(/^tt/i, ''),
    type: input?.type || 'movie',
    season: Number.isFinite(season) ? season : null,
    episode: Number.isFinite(episode) ? episode : null,
    extra: cleanExtra(input?.extra),
  };
}

function cacheKeyFor(search) {
  return `${config.cache.keyPrefix}:${search.type}:${search.imdbId || ''}:${search.season ?? ''}:${search.episode ?? ''}:${search.query.toLowerCase()}:${search.extra?.filename || ''}:${search.extra?.videoHash || ''}`;
}

let cachedProviders = null;

function createProviders() {
  if (cachedProviders) return cachedProviders;

  const providers = [];

  if (isOpenSubtitlesConfigured()) {
    providers.push({
      name: 'openSubtitles',
      displayName: 'OpenSubtitles',
      fn: openSubtitlesProvider,
    });
  }

  if (isSubdlConfigured()) {
    providers.push({
      name: 'subdl',
      displayName: 'SubDL',
      fn: subdlProvider,
    });
  }

  if (isSubSourceConfigured()) {
    providers.push({
      name: 'subsource',
      displayName: 'SubSource',
      fn: subSourceProvider,
    });
  }

  cachedProviders = providers;
  return providers;
}

async function callProvider(provider, search) {
  const breaker = breakers[provider.name];

  if (!breaker.canExecute()) {
    throw new Error(`[${provider.displayName}] circuit is open`);
  }

  try {
    const result = await retry(
      () => provider.fn(search),
      config.providers.retries,
      config.providers.retryBaseMs
    );

    breaker.success();
    return result;
  } catch (err) {
    breaker.fail();
    throw err;
  }
}

function dedupe(items) {
  const seen = new Set();
  const output = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const stableId = item.download || item._file_id || item._download_path || item.file || item.title || '';
    if (!stableId) continue;
    const key = `${item.source}|${String(item.language || '').toLowerCase()}|${String(stableId).toLowerCase()}`;

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }

  return output;
}

const preferredLangs = config.providers.preferredLanguages;

function applyConfiguredQualityFilters(items) {
  if (!items.length) return EMPTY_RESULTS;

  const filtered = items.filter(item => {
    if (config.providers.excludeHearingImpaired && item._hearing_impaired) return false;
    if (config.providers.excludeMachineTranslated && (item._machine_translated || item._ai_translated)) return false;
    return true;
  });

  if (!filtered.length) return items;

  // v1.7.2: fail-open للعربية. لا نسمح لفلاتر الجودة بإخفاء كل النتائج العربية.
  // الجودة تُدار بالترتيب والعقوبات، أما الإخفاء الكامل فهو فقط عند PROVIDER_STRICT_QUALITY_FILTERS=true.
  if (!config.providers.strictQualityFilters && config.providers.outputArabicOnly) {
    const hadArabic = items.some(item => isArabicLanguage(item.language));
    const stillHasArabic = filtered.some(item => isArabicLanguage(item.language));
    if (hadArabic && !stillHasArabic) return items;
  }

  return filtered;
}

function rankAll(items, search) {
  if (!items.length) return EMPTY_RESULTS;

  const filtered = applyConfiguredQualityFilters(items);
  if (!filtered.length) return EMPTY_RESULTS;

  const clean = dedupe(filtered);
  if (!clean.length) return EMPTY_RESULTS;

  for (let i = 0; i < clean.length; i++) {
    clean[i]._score = scoreSubtitle(clean[i], search, preferredLangs);
  }

  clean.sort((a, b) => b._score - a._score);
  return clean;
}

const INTERNAL_KEYS = new Set([
  '_file_id', '_downloads', '_rating', '_trusted', '_score',
  '_hearing_impaired', '_imdb_id', '_season', '_episode', '_moviehash', '_download_path',
  '_subsourceId', '_machine_translated', '_ai_translated', '_fps', '_hd',
]);

function stripInternals(items) {
  const output = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.download) continue;

    const result = {};
    for (const key in item) {
      if (!INTERNAL_KEYS.has(key)) result[key] = item[key];
    }
    output.push(result);
  }

  return output;
}

/**
 * v1.7.1: يلفّ كل ترجمة عبر /proxy/encoding/<token>.srt قبل stripInternals.
 *
 * هذا يضمن أن كل ترجمة (SubDL HTTP / OpenSubtitles HTTP / SubSource API) تمر
 * بنفس pipeline الترميز الذكي بدلاً من تسريب SubSource عبر مسار raw.
 *
 * للترجمات التي download فيها يبدأ بـ /downloads/subsource/ — نستبدلها بتوكن
 * encoding-proxy موقّع يحمل subtitleId و src='subsource'، فيستدعي البروكسي
 * SubSource API بـ X-API-Key مباشرة.
 */
function wrapWithEncodingProxy(items) {
  if (!config.encodingProxy.enabled) return items;

  const opts = {
    stripSdh: config.encodingProxy.stripSdhDefault,
    stripMusicNotes: config.encodingProxy.stripMusicNotes,
  };

  for (const item of items) {
    if (!item.download) continue;

    // حالة 1: SubSource — يحتاج auth header
    if (item.source === 'SubSource' && item._subsourceId) {
      const token = buildEncodingProxyToken(item._subsourceId, { ...opts, source: 'subsource' });
      if (token) {
        item.download = `/proxy/encoding/${token}.srt`;
        continue;
      }
    }

    // حالة 2: HTTP/HTTPS مباشر (SubDL، OpenSubtitles بعد resolveDownloadLink)
    if (/^https?:\/\//i.test(item.download)) {
      const token = buildEncodingProxyToken(item.download, opts);
      if (token) {
        item.download = `/proxy/encoding/${token}.srt`;
      }
    }
    // وإلا: نتركه كما هو (مثلاً روابط AI DeepSeek التي تبدأ بـ /ai/deepseek/)
  }

  return items;
}

async function resolveLinks(items) {
  return Promise.all(
    items.map(async item => {
      if (item.download) return item;
      if (item.source === 'OpenSubtitles' && item._file_id) {
        item.download = await resolveDownloadLink(item._file_id);
        return item;
      }
      return item;
    })
  );
}

function selectPublicItems(items) {
  const publicItems = config.providers.outputArabicOnly
    ? items.filter(item => isArabicLanguage(item.language))
    : items;
  return publicItems.slice(0, config.providers.topN);
}

async function runSearch(search) {
  const key = cacheKeyFor(search);

  const cached = await getCache(key);
  if (cached) return cached;

  const providers = createProviders();

  if (!providers.length) {
    throw httpError(503, 'No subtitle providers are configured. Add SUBDL_API_KEY, OPENSUBTITLES_API_KEY, or SUBSOURCE_API_KEY.');
  }

  const settled = await Promise.allSettled(
    providers.map(provider => callProvider(provider, search))
  );

  const fulfilled = [];
  let rejectedCount = 0;
  const errors = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') fulfilled.push(result.value);
    else {
      rejectedCount++;
      errors.push(result.reason?.message || 'Unknown error');
    }
  }

  if (!fulfilled.length && rejectedCount) {
    throw httpError(503, 'All subtitle providers failed.', errors);
  }

  const merged = [];
  for (let i = 0; i < fulfilled.length; i++) {
    const items = fulfilled[i];
    for (let j = 0; j < items.length; j++) merged.push(items[j]);
  }

  const ranked = rankAll(merged, search);
  const publicCandidates = selectPublicItems(ranked);
  const aiCandidates = ranked.slice(0, Math.max(config.providers.topN, 8));
  const withLinks = await resolveLinks([...publicCandidates, ...aiCandidates]);
  const publicSet = new Set(publicCandidates);
  const seenPublic = new Set();
  const resolvedPublic = [];
  for (const item of withLinks) {
    if (!publicSet.has(item) || seenPublic.has(item)) continue;
    seenPublic.add(item);
    resolvedPublic.push(item);
  }

  // v1.7.1: AI candidates يحتاجون URL أصلي (لأن DeepSeek يجلبه ويترجمه نصيًا).
  // لذا نُولّد publicAllForAi قبل lifting الـ encoding proxy.
  const publicAllForAi = stripInternals(withLinks);
  const aiFallback = createDeepSeekFallbackSubtitle(publicAllForAi, search);

  // الترجمات العامة التي ستُسلَّم للمستخدم تمر عبر encoding proxy.
  wrapWithEncodingProxy(resolvedPublic);
  const final = stripInternals(resolvedPublic);

  if (aiFallback) final.push(aiFallback);

  await setCache(key, final);
  return final;
}

export async function searchSubtitles(input) {
  const search = normalizeSearch(input);
  const key = cacheKeyFor(search);

  if (inflight.has(key)) return inflight.get(key);

  const promise = runSearch(search).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function getBreakersStatus() {
  return {
    openSubtitles: breakers.openSubtitles.getStatus(),
    subdl: breakers.subdl.getStatus(),
    subsource: breakers.subsource.getStatus(),
  };
}

export function getProvidersStatus() {
  return {
    openSubtitles: getOpenSubtitlesRuntimeStatus(),
    subdl: getSubdlRuntimeStatus(),
    subsource: getSubSourceRuntimeStatus(),
    ai: getAiRuntimeStatus(),
  };
}
