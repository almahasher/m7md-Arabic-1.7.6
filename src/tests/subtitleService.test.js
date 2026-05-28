import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const fakeCache = new Map();

mock.module('../cache/redis.js', {
  namedExports: {
    getCache: async (key) => fakeCache.get(key) ?? null,
    setCache: async (key, value) => { fakeCache.set(key, value); },
  },
});

mock.module('../providers/openSubtitles.js', {
  namedExports: {
    getOpenSubtitlesRuntimeStatus: () => ({ enabled: true, configured: true, tokenReady: false }),
    isOpenSubtitlesConfigured: () => true,
    openSubtitlesProvider: async (search) => String(search?.query || search).includes('only-ai-arabic') ? [
      { source: 'OpenSubtitles', title: 'Movie', language: 'en', file: 'Movie.English.srt', download: '', _file_id: 10, _downloads: 9000, _rating: 9, _trusted: true },
      { source: 'OpenSubtitles', title: 'Movie', language: 'ar', file: 'Movie.AI.Arabic.srt', download: '', _file_id: 11, _downloads: 9999, _rating: 10, _trusted: false, _ai_translated: true },
    ] : [
      { source: 'OpenSubtitles', title: 'Movie', language: 'en', file: 'Movie.1080p.WEBRip.srt', download: '', _file_id: 1, _downloads: 5000, _rating: 8, _trusted: true  },
      { source: 'OpenSubtitles', title: 'Movie', language: 'ar', file: 'Movie.1080p.WEBRip.Arabic.srt', download: '', _file_id: 2, _downloads: 100,  _rating: 5, _trusted: false },
      { source: 'OpenSubtitles', title: 'Movie', language: 'fr', file: 'Movie.French.srt', download: '', _file_id: 3, _downloads: 200,  _rating: 6, _trusted: false },
      { source: 'OpenSubtitles', title: 'Movie', language: 'ar', file: 'Movie.AI.Arabic.srt', download: '', _file_id: 4, _downloads: 9999, _rating: 10, _trusted: false, _ai_translated: true },
    ],
    resolveDownloadLink: async (id) => `https://example.com/dl/${id}`,
  },
});

mock.module('../providers/subdl.js', {
  namedExports: {
    getSubdlRuntimeStatus: () => ({ enabled: true, configured: true }),
    isSubdlConfigured: () => true,
    subdlProvider: async (search) => String(search?.query || search).includes('only-ai-arabic') ? [] : [
      { source: 'SubDL', title: 'Movie', language: 'ar', file: 'Movie.Arabic.WEBRip.srt', download: 'https://dl.subdl.com/x.zip', _file_id: null, _downloads: 300, _rating: 7, _trusted: true },
      { source: 'SubDL', title: 'Movie', language: 'de', file: 'Movie.German.srt', download: 'https://dl.subdl.com/y.zip', _file_id: null, _downloads: 50,  _rating: 4, _trusted: false },
      { source: 'SubDL', title: 'Movie', language: 'ar', file: 'Movie.HI.Arabic.srt', download: 'https://dl.subdl.com/hi.srt', _file_id: null, _downloads: 9000, _rating: 9, _trusted: true, _hearing_impaired: true },
    ],
  },
});

mock.module('../providers/subsource.js', {
  namedExports: {
    getSubSourceRuntimeStatus: () => ({ enabled: true, configured: true }),
    isSubSourceConfigured: () => true,
    subSourceProvider: async (search) => String(search?.query || search).includes('only-ai-arabic') ? [] : [
      { source: 'SubSource', title: 'Movie', language: 'arabic', file: 'Movie.2160p.WEB-DL.Arabic.srt', download: '/downloads/subsource/abc123', _file_id: 'abc123', _downloads: 900, _rating: 0, _trusted: true, _hearing_impaired: false },
    ],
    proxySubSourceDownload: async () => null,
  },
});

const { searchSubtitles, getProvidersStatus } = await import('../services/subtitleService.js');

beforeEach(() => fakeCache.clear());

describe('searchSubtitles', () => {
  it('يُعيد النتائج العربية فقط افتراضيًا', async () => {
    const results = await searchSubtitles('movie');
    assert.equal(results.length, 4);
    assert.ok(results.every(r => ['ar', 'arabic'].includes(String(r.language).toLowerCase())));
  });

  it('العربية تأتي أولاً', async () => {
    const results = await searchSubtitles('movie');
    assert.ok(['ar', 'arabic'].includes(String(results[0].language).toLowerCase()));
  });

  it('يستفيد من اسم الملف القادم من Stremio في الترتيب', async () => {
    const results = await searchSubtitles({
      query: 'movie',
      type: 'movie',
      extra: { filename: 'Movie.2160p.WEB-DL.mkv' },
    });

    assert.equal(results[0].source, 'SubSource');
  });

  it('يستبعد الترجمات الآلية/AI افتراضيًا عندما توجد عربية بشرية بديلة', async () => {
    const results = await searchSubtitles('movie-ai-filter');
    assert.ok(!results.some(r => String(r.file || '').includes('AI.Arabic')));
  });

  it('لا يخفي العربية بالكامل عندما لا توجد إلا ترجمة عربية AI', async () => {
    const results = await searchSubtitles('only-ai-arabic');
    assert.ok(results.some(r => String(r.file || '').includes('AI.Arabic')));
    assert.ok(results.every(r => ['ar', 'arabic'].includes(String(r.language).toLowerCase())));
  });

  it('لا توجد حقول داخلية في النتيجة', async () => {
    const results = await searchSubtitles('movie');
    for (const r of results) {
      assert.ok(!('_score' in r), '_score يجب أن يُحذف');
      assert.ok(!('_file_id' in r), '_file_id يجب أن يُحذف');
      assert.ok(!('_downloads' in r), '_downloads يجب أن يُحذف');
      assert.ok(!('_rating' in r), '_rating يجب أن يُحذف');
      assert.ok(!('_trusted' in r), '_trusted يجب أن يُحذف');
      assert.ok(!('_hearing_impaired' in r), '_hearing_impaired يجب أن يُحذف');
    }
  });

  it('يُعيد من الـ cache في المرة الثانية', async () => {
    await searchSubtitles('movie');
    const cached = await searchSubtitles('movie');
    assert.ok(Array.isArray(cached));
    assert.equal(cached.length, 4);
  });

  it('OpenSubtitles: رابط التحميل مُحلول بعد الترتيب', async () => {
    const results = await searchSubtitles('movie');
    const os = results.find(r => r.source === 'OpenSubtitles');
    if (os) {
      // v1.7.1: download الآن يُلَفّ بـ /proxy/encoding/ — هذا يثبت أن
      // encoding proxy active وأن OpenSubtitles لم يُستثنَ من المعالجة.
      assert.match(os.download, /^\/proxy\/encoding\/.+\.srt$/);
    }
  });

  it('حالة المزودين تشمل SubSource', () => {
    const status = getProvidersStatus();
    assert.equal(status.subsource.configured, true);
  });
});
