// =============================================================================
// language.test.js — Arabic language detection tests (v1.7.1)
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, isArabicLanguage, languagePriority } from '../utils/language.js';

test('Arabic — ar code', () => {
  const n = normalizeLanguage('ar');
  assert.equal(n.code2, 'ar');
  assert.equal(n.code3, 'ara'); // ISO 639-2 — مطلب Stremio
  assert.equal(n.name, 'Arabic');
});

test('Arabic — ara code', () => {
  assert.equal(normalizeLanguage('ara').code3, 'ara');
});

test('Arabic — Arabic word', () => {
  assert.equal(normalizeLanguage('Arabic').code3, 'ara');
});

test('Arabic — Arabic name in Arabic script', () => {
  assert.equal(normalizeLanguage('العربية').code3, 'ara');
  assert.equal(normalizeLanguage('عربي').code3, 'ara');
});

test('Arabic — locale variants (v1.7.1)', () => {
  assert.equal(normalizeLanguage('ar-SA').code3, 'ara');
  assert.equal(normalizeLanguage('ar-EG').code3, 'ara');
  assert.equal(normalizeLanguage('ar-AE').code3, 'ara');
  assert.equal(normalizeLanguage('ar-LB').code3, 'ara');
});

test('Arabic — labels like (forced) or (sdh)', () => {
  assert.equal(normalizeLanguage('ar (forced)').code3, 'ara');
  assert.equal(normalizeLanguage('Arabic (SDH)').code3, 'ara');
});

test('isArabicLanguage — positive cases', () => {
  assert.ok(isArabicLanguage('ar'));
  assert.ok(isArabicLanguage('ara'));
  assert.ok(isArabicLanguage('Arabic'));
  assert.ok(isArabicLanguage('ar-SA'));
  assert.ok(isArabicLanguage('العربية'));
});

test('isArabicLanguage — negative cases', () => {
  assert.ok(!isArabicLanguage('en'));
  assert.ok(!isArabicLanguage('English'));
  assert.ok(!isArabicLanguage(''));
  assert.ok(!isArabicLanguage(null));
});

test('languagePriority — Arabic wins over English with preferred=[ar]', () => {
  const arPriority = languagePriority('ar', ['ar', 'en']);
  const enPriority = languagePriority('en', ['ar', 'en']);
  assert.ok(arPriority > enPriority);
});
