// =============================================================================
// language.js — Language detection & normalization (v1.7.1)
//
// تحسينات v1.7.1:
//  - دعم لهجات عربية متعددة (ar-SA, ar-EG, ar-AE...)
//  - تطبيع أوسع لاسم اللغة من المزودين
//  - prioritization محسّن للعربية
//
// قاعدة Stremio: lang يجب أن يكون ISO 639-2 (3 أحرف) ليُعرض الاسم تلقائيًا.
// الكود الصحيح للعربية: "ara" (وليس "ar").
// =============================================================================

const LANGUAGE_ALIASES = new Map([
  // العربية + متغيرات بلدانها
  ['ar', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ara', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['arabic', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-sa', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-eg', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-ae', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-lb', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-sy', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-iq', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-jo', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-ma', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-dz', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-tn', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-ly', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-ye', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-qa', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-kw', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-bh', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-om', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-ps', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['ar-sd', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['العربية', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['عربي', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],
  ['عربية', { code2: 'ar', code3: 'ara', name: 'Arabic', priority: 100 }],

  // الإنجليزية
  ['en', { code2: 'en', code3: 'eng', name: 'English', priority: 50 }],
  ['eng', { code2: 'en', code3: 'eng', name: 'English', priority: 50 }],
  ['english', { code2: 'en', code3: 'eng', name: 'English', priority: 50 }],
  ['en-us', { code2: 'en', code3: 'eng', name: 'English', priority: 50 }],
  ['en-gb', { code2: 'en', code3: 'eng', name: 'English', priority: 50 }],

  // الفرنسية
  ['fr', { code2: 'fr', code3: 'fre', name: 'French', priority: 10 }],
  ['fre', { code2: 'fr', code3: 'fre', name: 'French', priority: 10 }],
  ['fra', { code2: 'fr', code3: 'fre', name: 'French', priority: 10 }],
  ['french', { code2: 'fr', code3: 'fre', name: 'French', priority: 10 }],

  // الإسبانية
  ['es', { code2: 'es', code3: 'spa', name: 'Spanish', priority: 10 }],
  ['spa', { code2: 'es', code3: 'spa', name: 'Spanish', priority: 10 }],
  ['spanish', { code2: 'es', code3: 'spa', name: 'Spanish', priority: 10 }],
]);

const ARABIC_KEYWORDS_RE = /(^|[\s._()[\]\-])(ar|ara|arabic|arab|عربي|العربية|عربية)([\s._()[\]\-]|$)/i;
const ENGLISH_KEYWORDS_RE = /(^|[\s._()[\]\-])(en|eng|english)([\s._()[\]\-]|$)/i;

const LOCALE_SEPARATOR_RE = /[-_]/;
const EXTRA_LABEL_RE = /\s*\((forced|sdh|hi|cc|hearing impaired|full|machine|ai)\)\s*$/i;

function canonicalKey(value) {
  const raw = String(value || '').trim();
  const lowered = raw.toLowerCase().replace(EXTRA_LABEL_RE, '').trim();

  if (LANGUAGE_ALIASES.has(lowered)) return lowered;

  const [base] = lowered.split(LOCALE_SEPARATOR_RE);
  if (LANGUAGE_ALIASES.has(base)) return base;

  if (ARABIC_KEYWORDS_RE.test(lowered) || lowered.includes('arabic') || /[\u0600-\u06FF]/.test(lowered)) {
    return 'ar';
  }
  if (ENGLISH_KEYWORDS_RE.test(lowered) || lowered.includes('english')) return 'en';

  return lowered;
}

const normalizeCache = new Map();
const MAX_CACHE = 2000;

export function normalizeLanguage(value) {
  const raw = String(value || '').trim();
  const cached = normalizeCache.get(raw);
  if (cached) return cached;

  const key = canonicalKey(raw);
  const mapped = LANGUAGE_ALIASES.get(key);

  let result;
  if (mapped) {
    result = { ...mapped, raw };
  } else if (key.length === 2 || key.length === 3) {
    result = { code2: key, code3: key, name: raw || key, priority: 0, raw };
  } else {
    result = { code2: key || 'und', code3: key || 'und', name: raw || 'Unknown', priority: 0, raw };
  }

  if (normalizeCache.size < MAX_CACHE) normalizeCache.set(raw, result);
  return result;
}

export function isArabicLanguage(value) {
  const normalized = normalizeLanguage(value);
  return normalized.code2 === 'ar' || normalized.code3 === 'ara' || normalized.name.toLowerCase() === 'arabic';
}

export function isEnglishLanguage(value) {
  const normalized = normalizeLanguage(value);
  return normalized.code2 === 'en' || normalized.code3 === 'eng' || normalized.name.toLowerCase() === 'english';
}

const priorityCache = new Map();

export function languagePriority(value, preferredLanguages = []) {
  const cacheKey = `${value}|${preferredLanguages.join(',')}`;
  const cached = priorityCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const normalized = normalizeLanguage(value);
  const keys = new Set([
    normalized.raw.toLowerCase(),
    normalized.code2.toLowerCase(),
    normalized.code3.toLowerCase(),
    normalized.name.toLowerCase(),
  ]);

  const preferredIndex = preferredLanguages.findIndex(lang => {
    const preferred = normalizeLanguage(lang);
    return keys.has(String(lang).toLowerCase())
      || keys.has(preferred.code2)
      || keys.has(preferred.code3)
      || keys.has(preferred.name.toLowerCase());
  });
  const result = preferredIndex >= 0 ? 1000 - preferredIndex * 100 : normalized.priority;

  if (priorityCache.size < MAX_CACHE) priorityCache.set(cacheKey, result);
  return result;
}
