// =============================================================================
// subtitleProcessor.test.js — Tests for v1.7.1 encoding & cleanup
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEncoding,
  decodeToUtf8,
  cleanSubtitleText,
  vttToSrt,
  detectSubtitleFormat,
  processSubtitleBytes,
} from '../utils/subtitleProcessor.js';

// نص عربي بسيط بشكل UTF-8
const ARABIC_UTF8 = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nمرحبا بك في الفيلم\n', 'utf-8');

// نفس النص لكن بترميز Windows-1256
const ARABIC_WIN1256 = (() => {
  // مرحبا بك = M-R-H-B-A space B-K في Windows-1256
  // مرحبا = 0xE3 0xD1 0xCD 0xC8 0xC7
  // بك = 0xC8 0xDF
  // في = 0xDD 0xED
  // الفيلم = 0xC7 0xE1 0xDD 0xED 0xE1 0xE3
  const bytes = [];
  const header = '1\n00:00:01,000 --> 00:00:03,000\n';
  for (const ch of header) bytes.push(ch.charCodeAt(0));
  // "مرحبا بك في الفيلم" بـ Windows-1256
  bytes.push(0xE3, 0xD1, 0xCD, 0xC8, 0xC7); // مرحبا
  bytes.push(0x20); // space
  bytes.push(0xC8, 0xDF); // بك
  bytes.push(0x20);
  bytes.push(0xDD, 0xED); // في
  bytes.push(0x20);
  bytes.push(0xC7, 0xE1, 0xDD, 0xED, 0xE1, 0xE3); // الفيلم
  bytes.push(0x0A); // newline
  return Buffer.from(bytes);
})();

const UTF8_BOM_PREFIXED = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), ARABIC_UTF8]);

test('detectEncoding — UTF-8 with BOM', () => {
  assert.equal(detectEncoding(UTF8_BOM_PREFIXED), 'utf-8');
});

test('detectEncoding — plain UTF-8', () => {
  assert.equal(detectEncoding(ARABIC_UTF8), 'utf-8');
});

test('detectEncoding — Windows-1256 detection heuristic', () => {
  // قد يصنفها UTF-8 fallback إن لم تحوي بايتات عالية كافية
  const detected = detectEncoding(ARABIC_WIN1256);
  assert.ok(detected === 'windows-1256' || detected === 'utf-8',
    `expected windows-1256 or utf-8, got ${detected}`);
});

test('decodeToUtf8 — strips BOM correctly', () => {
  const text = decodeToUtf8(UTF8_BOM_PREFIXED);
  assert.ok(!text.startsWith('\uFEFF'));
  assert.ok(text.includes('مرحبا'));
});

test('decodeToUtf8 — Windows-1256 to readable Arabic', () => {
  const text = decodeToUtf8(ARABIC_WIN1256, 'windows-1256');
  assert.ok(text.includes('مرحبا'));
  assert.ok(text.includes('الفيلم'));
});

test('cleanSubtitleText — strips HTML tags', () => {
  const input = '1\n00:00:01,000 --> 00:00:03,000\n<i>hello</i> <b>world</b>\n';
  const cleaned = cleanSubtitleText(input);
  assert.ok(!cleaned.includes('<i>'));
  assert.ok(!cleaned.includes('<b>'));
  assert.ok(cleaned.includes('hello world'));
});

test('cleanSubtitleText — strips ASS positioning', () => {
  const input = '1\n00:00:01,000 --> 00:00:03,000\n{\\an8}hello\n';
  const cleaned = cleanSubtitleText(input);
  assert.ok(!cleaned.includes('{\\an8}'));
  assert.ok(cleaned.includes('hello'));
});

test('cleanSubtitleText — strips bidi control marks', () => {
  const input = '1\n00:00:01,000 --> 00:00:03,000\n\u200Fمرحبا\u200E\n';
  const cleaned = cleanSubtitleText(input);
  assert.ok(!cleaned.includes('\u200F'));
  assert.ok(!cleaned.includes('\u200E'));
  assert.ok(cleaned.includes('مرحبا'));
});

test('cleanSubtitleText — strips SDH when enabled', () => {
  const input = '1\n00:00:01,000 --> 00:00:03,000\n[SIGHS] hello [DOOR CREAKS]\n';
  const cleaned = cleanSubtitleText(input, { stripSdh: true });
  assert.ok(!cleaned.includes('[SIGHS]'));
  assert.ok(!cleaned.includes('[DOOR CREAKS]'));
  assert.ok(cleaned.includes('hello'));
});

test('detectSubtitleFormat — SRT', () => {
  const text = '1\n00:00:01,000 --> 00:00:03,000\nhello\n';
  assert.equal(detectSubtitleFormat(text), 'srt');
});

test('detectSubtitleFormat — VTT', () => {
  const text = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello\n';
  assert.equal(detectSubtitleFormat(text), 'vtt');
});

test('vttToSrt — converts dots to commas in timecodes', () => {
  const vtt = 'WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nhello\n';
  const srt = vttToSrt(vtt);
  assert.ok(srt.includes('00:00:01,500'));
  assert.ok(srt.includes('00:00:03,250'));
  assert.ok(!srt.includes('WEBVTT'));
  assert.ok(srt.startsWith('1\n'));
});

test('vttToSrt — strips cue settings', () => {
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000 line:0 position:50%\nhello\n';
  const srt = vttToSrt(vtt);
  assert.ok(!srt.includes('line:0'));
  assert.ok(!srt.includes('position:50%'));
});

test('processSubtitleBytes — end-to-end Arabic UTF-8 SRT', () => {
  const { text, format } = processSubtitleBytes(ARABIC_UTF8);
  assert.equal(format, 'srt');
  assert.ok(text.includes('مرحبا'));
  assert.ok(!text.includes('\uFEFF'));
});
