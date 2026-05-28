const FALSEY_EXTERNAL_VALUES = new Set(['', '-1', 'undefined', 'null', '0', 'nan']);

export function isUsableExternalValue(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  if (!text) return false;
  return !FALSEY_EXTERNAL_VALUES.has(text.toLowerCase());
}

export function firstUsableValue(item, keys, fallback = '') {
  for (const key of keys) {
    const value = item?.[key];
    if (isUsableExternalValue(value)) return value;
  }
  return fallback;
}

export function normalizeDownloadUrl(value, baseUrl = '') {
  if (!isUsableExternalValue(value)) return '';
  const url = String(value).trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  const normalizedBase = String(baseUrl).replace(/\/+$/, '');
  const normalizedPath = url.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}
