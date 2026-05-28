import { languagePriority } from './language.js';

const TOKEN_SPLIT_RE = /[ ._\-[\]()+]+/;
const QUALITY_TAGS = ['2160p', '1080p', '720p', '4k', 'uhd', 'web-dl', 'webdl', 'webrip', 'bluray', 'brrip', 'hdrip', 'nf', 'amzn', 'dsnp', 'hmax', 'max', 'x265', 'x264', 'h265', 'h264'];
const CAM_RE = /\b(cam|ts|telesync|hdcam)\b/i;
const SPAM_RE = /\b(ad|spam|translated by|subtitle by)\b|www\.|opensubtitles\.(org|com)/i;

const tokenCache = new Map();
const MAX_TOKEN_CACHE = 2000;

function tokenize(value) {
  const cached = tokenCache.get(value);
  if (cached) return cached;
  const tokens = value.split(TOKEN_SPLIT_RE).filter(t => t.length > 2);
  if (tokenCache.size < MAX_TOKEN_CACHE) tokenCache.set(value, tokens);
  return tokens;
}

function normalizeImdb(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.startsWith('tt') ? raw : `tt${raw}`;
}

const DOWNLOAD_TIERS = [
  [10000, 1600],
  [5000, 1300],
  [1000, 1000],
  [100, 650],
  [10, 300],
];

const preferredScoreCache = new Map();

function preferredLanguageScore(value, preferredLanguages) {
  const key = `${value}|${preferredLanguages.join(',')}`;
  const cached = preferredScoreCache.get(key);
  if (cached !== undefined) return cached;

  const score = languagePriority(value, preferredLanguages) * 50;
  if (preferredScoreCache.size < MAX_TOKEN_CACHE) preferredScoreCache.set(key, score);
  return score;
}

export function scoreSubtitle(item, context = {}, preferredLanguages = []) {
  const fileName = String(item.file || item.title || '').toLowerCase();
  const requestedFile = String(context.extra?.filename || context.filename || '').toLowerCase();
  const langScore = preferredLanguageScore(item.language, preferredLanguages);
  const downloads = Number(item._downloads || item.downloads || item.downloadsCount || 0) || 0;
  const rawRating = item._rating || item.rating || 0;
  const rating = Math.min(Math.max(Number(rawRating) || 0, 0), 10);

  let score = langScore;

  if (item.download || item._file_id || item._download_path) score += 1000;
  else score -= 5000;

  if (item._trusted) score += 1500;
  if (item.source === 'SubDL') score += 250;
  if (item.source === 'SubSource') score += 200;

  // v1.7.1: عقوبات على الترجمات الآلية / المُولّدة بالذكاء الاصطناعي من OpenSubtitles
  // هدفها رفع الترجمات البشرية إلى الأعلى دون استبعاد الآلية كليًا.
  if (item._machine_translated) score -= 1200;
  if (item._ai_translated) score -= 800;
  if (item._hearing_impaired) score -= 250;
  if (item._hd) score += 150;

  for (let i = 0; i < DOWNLOAD_TIERS.length; i++) {
    if (downloads > DOWNLOAD_TIERS[i][0]) {
      score += DOWNLOAD_TIERS[i][1];
      break;
    }
  }

  score += rating * 250;

  if (item._imdb_id && context.imdbId && normalizeImdb(item._imdb_id) === normalizeImdb(context.imdbId)) score += 2500;
  if (item._moviehash && context.extra?.videoHash && String(item._moviehash) === String(context.extra.videoHash)) score += 3000;

  const ctxSeason = context.season;
  const ctxEpisode = context.episode;
  if (ctxSeason && item._season) {
    score += Number(item._season) === Number(ctxSeason) ? 700 : -10000;
  }
  if (ctxEpisode && item._episode) {
    score += Number(item._episode) === Number(ctxEpisode) ? 800 : -10000;
  }

  if (requestedFile && fileName) {
    const tokens = tokenize(requestedFile);
    let matched = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (fileName.includes(tokens[i])) matched++;
    }
    score += Math.min(4400, matched * 1100);

    for (let i = 0; i < QUALITY_TAGS.length; i++) {
      if (requestedFile.includes(QUALITY_TAGS[i]) && fileName.includes(QUALITY_TAGS[i])) score += 800;
    }
  }

  if (CAM_RE.test(fileName)) score -= 1800;
  if (SPAM_RE.test(fileName)) score -= 900;

  return score;
}
