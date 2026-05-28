// =============================================================================
// subtitleProcessor.js — Arabic subtitle processor (v1.7.1)
//
// المسؤولية:
//   1. استكشاف الترميز (UTF-8 / UTF-16 / Windows-1256 / ISO-8859-6)
//   2. إعادة الترميز إلى UTF-8 نظيف
//   3. تنظيف SRT (BOM, RTL marks سيئة, HTML/SDH/font tags)
//   4. تحويل VTT → SRT
//   5. إخراج SRT صالح للعرض على PS5 / TV / Android بدون رموز غريبة
//
// لا يعتمد على أي مكتبة خارجية — يستخدم Node TextDecoder المدمج فقط.
// =============================================================================

const UTF8_BOM = [0xEF, 0xBB, 0xBF];
const UTF16_LE_BOM = [0xFF, 0xFE];
const UTF16_BE_BOM = [0xFE, 0xFF];

// مدى الحروف العربية في Unicode + علامات RTL غير المرغوبة
const ARABIC_RANGE_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

// أحرف RTL/LTR التحكمية: قد تظهر كـ "?" على بعض الأجهزة
// LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI, ZWJ, ZWNJ
const BIDI_CONTROL_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u200C\u200D]/g;

// HTML / font tags تظهر كنص خام على PS5 أحيانًا
const HTML_TAG_RE = /<\/?(?:b|i|u|font|span|c|br)\b[^>]*>/gi;

// position tags من تحويل ASS/SSA
const ASS_POSITION_RE = /\{\\[^}]*\}/g;

// SDH brackets: [SIGHS], (CROWD CHEERING), ♪ MUSIC ♪
const SDH_BRACKETS_RE = /\s*[\[\(][^\]\)]*[\]\)]\s*/g;
const SDH_MUSIC_RE = /\s*♪[^♪\n]*♪?\s*/g;

// VTT cue settings (line:..., position:..., align:...) — يلتقط فقط نفس السطر
const VTT_CUE_SETTINGS_RE = /^(\d{1,2}:\d{2}:\d{2}[.,]\d{3}[ \t]+-->[ \t]+\d{1,2}:\d{2}:\d{2}[.,]\d{3})[ \t]+[^\n]*$/gm;

// =============================================================================
// 1) كشف الترميز
// =============================================================================

/**
 * يفحص أول ~4KB من البَفر ويحاول تخمين الترميز.
 * يعطي أولوية لـ BOM > UTF-8 valid > Windows-1256 (Arabic heuristic) > UTF-8 fallback.
 */
export function detectEncoding(bytes) {
  if (!bytes || bytes.length === 0) return 'utf-8';

  // BOM check
  if (bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    return 'utf-8';
  }
  if (bytes.length >= 2) {
    if (bytes[0] === UTF16_LE_BOM[0] && bytes[1] === UTF16_LE_BOM[1]) return 'utf-16le';
    if (bytes[0] === UTF16_BE_BOM[0] && bytes[1] === UTF16_BE_BOM[1]) return 'utf-16be';
  }

  // عَيّنة من أول 4KB للفحص (التحقق الكامل مكلف)
  const sample = bytes.length > 4096 ? bytes.subarray(0, 4096) : bytes;

  // محاولة فك UTF-8 صارمة
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    // ليس UTF-8 صحيح
  }

  // إذا فيه بايتات في المدى 0x80+ بدون أنماط UTF-8 صحيحة، نميّز بين:
  //   - ISO-8859-6: الحروف العربية في 0xC1-0xDA فقط، النطاق 0x80-0xBF شبه فارغ
  //   - Windows-1256: يستخدم كامل المدى 0x80-0xFF (حروف عربية + فرنسية + رموز)
  let arabicNarrow = 0;   // 0xC1-0xDA (مشترك بين ISO-8859-6 و Windows-1256)
  let arabicWide = 0;     // 0xDB-0xFE (موجود في Windows-1256 فقط)
  let midRange = 0;       // 0x80-0xBF (مملوء في Windows-1256، شبه فارغ في ISO-8859-6)
  let totalHigh = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b >= 0x80) {
      totalHigh++;
      if (b >= 0xC1 && b <= 0xDA) arabicNarrow++;
      else if (b >= 0xDB && b <= 0xFE) arabicWide++;
      else if (b >= 0x80 && b <= 0xBF) midRange++;
    }
  }

  if (totalHigh > 10) {
    const arabicTotal = arabicNarrow + arabicWide;
    // لو أكثر من 60% من البايتات العالية عربية
    if (arabicTotal / totalHigh > 0.6) {
      // تمييز ISO-8859-6 من Windows-1256:
      // ISO-8859-6 لا يستخدم 0x80-0xBF تقريبًا ولا 0xDB-0xFE
      // Windows-1256 يستخدم كل المدى بما فيه 0x80-0xBF و 0xDB-0xFE
      if (arabicWide === 0 && midRange <= 2) {
        return 'iso-8859-6';
      }
      return 'windows-1256';
    }
    // حالة مختلطة: كثير من 0x80-0xBF مع بعض العربي → غالبًا Windows-1256
    if (midRange > 5 && arabicTotal > 0 && (midRange + arabicTotal) / totalHigh > 0.5) {
      return 'windows-1256';
    }
  }

  // الاحتياط: UTF-8 lenient (يستبدل البايتات الخاطئة بـ U+FFFD)
  return 'utf-8';
}

// =============================================================================
// 2) فك الترميز إلى UTF-8 string
// =============================================================================

/**
 * يفك بايتات بأي ترميز معروف إلى نص UTF-8 نظيف. يحذف BOM إن وُجد.
 */
export function decodeToUtf8(bytes, hintEncoding = null) {
  const encoding = hintEncoding || detectEncoding(bytes);

  // إزالة BOM يدويًا قبل الفك (TextDecoder يحذفه افتراضيًا في UTF-8 مع ignoreBOM=false)
  let working = bytes;
  if (encoding === 'utf-8' && bytes.length >= 3
      && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    working = bytes.subarray(3);
  }

  // ISO-8859-6 غير مدعوم في TextDecoder في بعض إصدارات Node — نفك يدويًا
  if (encoding === 'iso-8859-6') {
    return decodeIso8859_6(working).replace(/^\uFEFF/, '');
  }

  let decoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: false, ignoreBOM: true });
  } catch {
    // Node TextDecoder يدعم windows-1256 افتراضيًا من v18+
    decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  }

  return decoder.decode(working).replace(/^\uFEFF/, '');
}

// =============================================================================
// جدول ISO-8859-6 → Unicode (الحروف العربية)
// =============================================================================

const ISO_8859_6_MAP = new Map([
  [0xA0, 0x00A0], // NO-BREAK SPACE
  [0xA4, 0x00A4], // CURRENCY SIGN
  [0xAC, 0x060C], // ARABIC COMMA
  [0xAD, 0x00AD], // SOFT HYPHEN
  [0xBB, 0x061B], // ARABIC SEMICOLON
  [0xBF, 0x061F], // ARABIC QUESTION MARK
  [0xC1, 0x0621], // HAMZA
  [0xC2, 0x0622], // ALEF WITH MADDA
  [0xC3, 0x0623], // ALEF WITH HAMZA ABOVE
  [0xC4, 0x0624], // WAW WITH HAMZA
  [0xC5, 0x0625], // ALEF WITH HAMZA BELOW
  [0xC6, 0x0626], // YEH WITH HAMZA
  [0xC7, 0x0627], // ALEF
  [0xC8, 0x0628], // BEH
  [0xC9, 0x0629], // TEH MARBUTA
  [0xCA, 0x062A], // TEH
  [0xCB, 0x062B], // THEH
  [0xCC, 0x062C], // JEEM
  [0xCD, 0x062D], // HAH
  [0xCE, 0x062E], // KHAH
  [0xCF, 0x062F], // DAL
  [0xD0, 0x0630], // THAL
  [0xD1, 0x0631], // REH
  [0xD2, 0x0632], // ZAIN
  [0xD3, 0x0633], // SEEN
  [0xD4, 0x0634], // SHEEN
  [0xD5, 0x0635], // SAD
  [0xD6, 0x0636], // DAD
  [0xD7, 0x0637], // TAH
  [0xD8, 0x0638], // ZAH
  [0xD9, 0x0639], // AIN
  [0xDA, 0x063A], // GHAIN
  [0xE0, 0x0640], // TATWEEL
  [0xE1, 0x0641], // FEH
  [0xE2, 0x0642], // QAF
  [0xE3, 0x0643], // KAF
  [0xE4, 0x0644], // LAM
  [0xE5, 0x0645], // MEEM
  [0xE6, 0x0646], // NOON
  [0xE7, 0x0647], // HEH
  [0xE8, 0x0648], // WAW
  [0xE9, 0x0649], // ALEF MAKSURA
  [0xEA, 0x064A], // YEH
  [0xEB, 0x064B], // FATHATAN
  [0xEC, 0x064C], // DAMMATAN
  [0xED, 0x064D], // KASRATAN
  [0xEE, 0x064E], // FATHA
  [0xEF, 0x064F], // DAMMA
  [0xF0, 0x0650], // KASRA
  [0xF1, 0x0651], // SHADDA
  [0xF2, 0x0652], // SUKUN
]);

function decodeIso8859_6(bytes) {
  const chars = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      chars.push(String.fromCharCode(b));
    } else {
      const mapped = ISO_8859_6_MAP.get(b);
      chars.push(mapped ? String.fromCharCode(mapped) : '\uFFFD');
    }
  }
  return chars.join('');
}

// =============================================================================
// 3) تنظيف نص SRT
// =============================================================================

/**
 * يزيل HTML tags, ASS positioning, SDH brackets, RTL/LTR control marks.
 * يحافظ على timecodes والترقيم.
 */
export function cleanSubtitleText(text, options = {}) {
  const {
    stripHtml = true,
    stripAssPosition = true,
    stripSdh = false,        // افتراضيًا نتركها — قد يحتاجها بعض المستخدمين
    stripMusicNotes = false,
    stripBidiControls = true, // علامات RTL خفية تسبب مشاكل على PS5
  } = options;

  let out = String(text || '');

  if (stripBidiControls) {
    out = out.replace(BIDI_CONTROL_RE, '');
  }
  if (stripHtml) {
    out = out.replace(HTML_TAG_RE, '');
  }
  if (stripAssPosition) {
    out = out.replace(ASS_POSITION_RE, '');
  }
  if (stripMusicNotes) {
    out = out.replace(SDH_MUSIC_RE, ' ');
  }
  if (stripSdh) {
    out = out.replace(SDH_BRACKETS_RE, ' ');
  }

  // طي الأسطر الفارغة المتكررة (لكن نحافظ على فاصل cue الواحد)
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // تطبيع أسطر فارغة أكثر من اثنين متتاليين
  out = out.replace(/\n{3,}/g, '\n\n');

  // إزالة سطور فارغة أو فيها مسافات فقط داخل الـ cue
  out = out.replace(/[ \t]+\n/g, '\n');

  return out.trim();
}

// =============================================================================
// 4) تحويل VTT → SRT
// =============================================================================

const VTT_HEADER_RE = /^WEBVTT[^\n]*\n+/;
const VTT_NOTE_BLOCK_RE = /^NOTE[^\n]*(?:\n(?!\n).*)*\n*/gm;
const VTT_STYLE_BLOCK_RE = /^STYLE[^\n]*(?:\n(?!\n).*)*\n*/gm;

/**
 * تحويل VTT بسيط إلى SRT: يحوّل النقطة في timecode إلى فاصلة،
 * ويزيل cue settings الإضافية، ويرقّم الـ cues.
 */
export function vttToSrt(vttText) {
  let text = String(vttText || '');

  // إزالة هيدر WEBVTT
  text = text.replace(VTT_HEADER_RE, '');
  // إزالة كتل NOTE و STYLE
  text = text.replace(VTT_NOTE_BLOCK_RE, '');
  text = text.replace(VTT_STYLE_BLOCK_RE, '');
  // نقطة → فاصلة في timecodes (يجب أن يسبق قص cue settings)
  text = text.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
  // إزالة cue settings من سطر التايم
  text = text.replace(VTT_CUE_SETTINGS_RE, '$1');

  // تقسيم لكتل cue وإعادة ترقيمها
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const cues = [];
  let index = 1;

  for (const block of blocks) {
    const lines = block.split('\n');
    // أزل سطر ID الاختياري في VTT لو لم يكن رقمًا
    let timeLineIdx = lines.findIndex(l => /-->/.test(l));
    if (timeLineIdx < 0) continue;
    const timeLine = lines[timeLineIdx];
    const content = lines.slice(timeLineIdx + 1).join('\n').trim();
    if (!content) continue;

    cues.push(`${index}\n${timeLine}\n${content}`);
    index++;
  }

  return cues.join('\n\n') + '\n';
}

// =============================================================================
// 5) كشف الصيغة
// =============================================================================

export function detectSubtitleFormat(text) {
  const head = String(text || '').slice(0, 500);
  if (/^WEBVTT/i.test(head.trim())) return 'vtt';
  if (/\d+\s*\n\d{2}:\d{2}:\d{2}[,]\d{3}\s+-->/m.test(head)) return 'srt';
  if (/\d{2}:\d{2}:\d{2}[.]\d{3}\s+-->/m.test(head)) return 'vtt-no-header';
  if (/^\[Script Info\]/im.test(head)) return 'ass';
  return 'unknown';
}

// =============================================================================
// 6) خط المعالجة الكامل
// =============================================================================

/**
 * pipeline كاملة: بايتات → UTF-8 SRT نظيف وجاهز للعرض.
 *
 * @param {Buffer|Uint8Array} bytes — محتوى الملف الخام من المزود
 * @param {Object} options — { stripSdh, stripMusicNotes, stripHtml }
 * @returns {{ text: string, encoding: string, format: string }}
 */
export function processSubtitleBytes(bytes, options = {}) {
  const encoding = detectEncoding(bytes);
  let text = decodeToUtf8(bytes, encoding);
  const format = detectSubtitleFormat(text);

  if (format === 'vtt' || format === 'vtt-no-header') {
    text = vttToSrt(text);
  }

  text = cleanSubtitleText(text, options);

  return { text, encoding, format };
}
