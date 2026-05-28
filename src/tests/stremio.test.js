import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStremioSubtitleSearch, createManifest, parseExtra, parseStremioId, toStremioSubtitles } from '../utils/stremio.js';
import { isUsableExternalValue } from '../utils/values.js';

describe('stremio helpers', () => {
  it('يفك معرفات المسلسلات بصيغة tt:s:e', () => {
    const parsed = parseStremioId('tt0944947:1:2');
    assert.equal(parsed.imdbId, 'tt0944947');
    assert.equal(parsed.season, 1);
    assert.equal(parsed.episode, 2);
  });

  it('يفك extra parameters بدون قص القيم التي تحتوي =', () => {
    const parsed = parseExtra('filename=a=b.mkv&videoHash=-1');
    assert.equal(parsed.filename, 'a=b.mkv');
    assert.equal(parsed.videoHash, '-1');
  });

  it('يفك extra parameters المشفرة بدون كسر & داخل اسم الملف', () => {
    const parsed = parseExtra('filename=Movie%20A%26B%201080p.mkv&videoSize=123');
    assert.equal(parsed.filename, 'Movie A&B 1080p.mkv');
    assert.equal(parsed.videoSize, '123');
  });

  it('يتجاهل القيم الوهمية القادمة من Stremio', () => {
    assert.equal(isUsableExternalValue('-1'), false);
    assert.equal(isUsableExternalValue('undefined'), false);
    assert.equal(isUsableExternalValue('Movie.mkv'), true);
  });



  it('يعلن مورد subtitles بصيغة object بدون idPrefixes حتى لا يمنع طلبات hash', () => {
    const manifest = createManifest();
    assert.deepEqual(manifest.resources, [
      { name: 'subtitles', types: ['movie', 'series'] },
    ]);
  });

  it('يحوّل روابط التحميل المحلية إلى روابط كاملة', () => {
    const subtitles = toStremioSubtitles([
      { source: 'SubSource', language: 'arabic', file: 'x.srt', download: '/downloads/subsource/1' },
    ], 'https://example.com');

    assert.equal(subtitles[0].url, 'https://example.com/downloads/subsource/1');
    assert.equal(subtitles[0].lang, 'ara');
    assert.equal(subtitles[0].name, 'm7md Arabic');
  });

  it('يبني بحث Stremio صحيحًا عندما يكون id هاش الفيديو و IMDb داخل videoId', () => {
    const search = buildStremioSubtitleSearch({
      type: 'movie',
      id: '8f14e45fceea167a',
      extra: { videoId: 'tt1375666', filename: 'Inception.2010.1080p.mkv' },
    });

    assert.equal(search.imdbId, 'tt1375666');
    assert.equal(search.query, 'tt1375666');
    assert.equal(search.extra.videoHash, '8f14e45fceea167a');
    assert.equal(search.extra.filename, 'Inception.2010.1080p.mkv');
  });

  it('يدعم حلقات المسلسلات عندما يكون videoId داخل extraArgs', () => {
    const search = buildStremioSubtitleSearch({
      type: 'series',
      id: 'abcdef1234567890',
      extra: { videoId: 'tt0944947:1:2' },
    });

    assert.equal(search.imdbId, 'tt0944947');
    assert.equal(search.season, 1);
    assert.equal(search.episode, 2);
    assert.equal(search.extra.videoHash, 'abcdef1234567890');
  });

});
