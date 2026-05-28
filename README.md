# m7md Arabic — v1.7.6

إضافة Stremio وBackend خفيف لجلب الترجمات العربية بدقة عالية من **SubDL** و **OpenSubtitles** و **SubSource**، مع **معالجة ترميز ذكية على الخادم** تضمن عرض العربية صحيحة على PS5 و Android TV و Sony Bravia بدون رموز غريبة.

> الوضع الافتراضي لا يستخدم AI ولا يستهلك أي توكن، ويعرض الترجمات بصيغة UTF-8 SRT نظيفة جاهزة للعرض.

## ماذا تغيّر في v1.7.6؟

### 🎯 الميزة الكبرى: Smart Encoding Proxy خادمي

كل ترجمة الآن تمر عبر `/proxy/encoding/<signed-token>.srt` على الـ addon نفسه:

1. يجلب الترجمة من المصدر الأصلي (SubDL، OpenSubtitles، SubSource).
2. **يكتشف الترميز تلقائيًا** (UTF-8 BOM / UTF-16 / Windows-1256 / UTF-8 lenient).
3. **يحوّله إلى UTF-8** نظيف خالٍ من BOM وعلامات RTL/LTR التحكمية.
4. **ينظّف SRT/VTT** من `<i>`, `<font>`, `{\an8}`, وكتل WEBVTT الزائدة.
5. يحوّل **VTT → SRT** تلقائيًا مع تصحيح التايم (نقطة → فاصلة).
6. **كاش** على hash من URL لمدة 24 ساعة افتراضيًا.

هذا يحل مشكلة الترجمة العربية المعكوسة أو ظهور المربعات `□□□` على PS5 و TV بدون الحاجة لتفعيل Stremio's local encoding proxy.

### 🛡 جودة بحث محسّنة في OpenSubtitles

بارامترات OpenSubtitles الرسمية الجديدة:

- `order_by=download_count&order_direction=desc` لجلب الأكثر تنزيلًا أولًا.
- `PROVIDER_STRICT_QUALITY_FILTERS=false` افتراضيًا: يجلب نتائج AI/machine ثم يعاقبها في الترتيب؛ لا يخفي العربية بالكامل عند ندرة النتائج.
- `trusted_sources=only` (اختياري) لجلب الترجمات من الرافعين الموثوقين فقط.
- `hearing_impaired=exclude` (اختياري) لاستبعاد ترجمات الصم والبكم.

### 🌍 كشف لغة موسّع

- يدعم الآن لهجات بلدية: `ar-SA`, `ar-EG`, `ar-AE`, `ar-LB`, `ar-SY`, `ar-IQ`, `ar-JO`, `ar-MA`, `ar-DZ`, `ar-TN`, `ar-LY`, `ar-YE`, `ar-QA`, `ar-KW`, `ar-BH`, `ar-OM`, `ar-PS`, `ar-SD`.
- يكشف العربية من Unicode range داخل اسم الملف (U+0600..U+06FF).
- `lang: "ara"` (ISO 639-2) — كما يتطلب Stremio SDK الرسمي لعرض اسم اللغة على Android.

### 📊 Scoring محسّن

- عقوبة `-1200` للترجمات `machine_translated` و `-800` للـ `ai_translated`.
- مكافأة `+150` لترجمات HD.
- باقي قواعد الترتيب من v1.6 محفوظة (IMDB match, season/episode, filename tokens).

### ⚙️ تحديثات بنيوية

- نموذج DeepSeek الافتراضي: `deepseek-v4-flash`، مع تعطيل التفكير لترجمة SRT/VTT المباشرة.
- مفتاح كاش encoding proxy أصبح يتضمن خيارات التنظيف مثل SDH/music حتى لا تعود نسخة كاش قديمة عند تغيير الإعداد.
- فلترة عامة للترجمات الآلية/AI وترجمات الصم والبكم عند تفعيل إعدادات الاستبعاد، وليس فقط على مستوى OpenSubtitles.
- معالجة أقوى لاستجابات JSON غير الصالحة من المزودين، وتتبّع redirect متعدد في encoding proxy.
- `CACHE_KEY_PREFIX` رُفع إلى `subtitles:v1.7.6` (ينشئ كاش جديدًا، الكاش القديم لن يتعارض).
- اختبارات جديدة: 13 اختبار لـ `subtitleProcessor` و 10 اختبارات لـ `language`.

## طريقة العمل

1. يبحث المشروع عن ترجمة عربية في جميع المزودين المُكوَّنين بالتوازي.
2. يدمج النتائج ويرتّبها حسب اللغة، تطابق IMDb، الموسم/الحلقة، اسم الملف، الجودة، التحميلات، الثقة، واستبعاد الترجمات الآلية.
3. لكل رابط ترجمة، يولّد توكنًا موقّعًا HMAC ويسلّم `https://your-addon.com/proxy/encoding/<token>.srt`. في الإنتاج يُفضّل ضبط `ENCODING_PROXY_SECRET` بقيمة عشوائية طويلة.
4. عند فتح المستخدم للترجمة في Stremio، البروكسي يجلب الملف، يحوّل ترميزه، ينظّفه، ويعيده UTF-8 SRT.
5. إذا لم تتوفر عربية وAI مفعّل بميزانية، يولّد رابط ترجمة DeepSeek (لا يُستهلك حتى يفتحه المستخدم).

## البنية

```text
src/
├── ai/
│   └── deepseek.js
├── api/
│   ├── middleware/
│   └── routes/
│       └── subtitles.js          (+ route: /proxy/encoding/:token.srt)
├── cache/
│   └── redis.js
├── providers/
│   ├── openSubtitles.js          (+ order_by, machine_translated, trusted_sources)
│   ├── subdl.js
│   └── subsource.js
├── services/
│   └── subtitleService.js
├── tests/
│   ├── circuitBreaker.test.js
│   ├── language.test.js          (جديد)
│   ├── retry.test.js
│   ├── stremio.test.js
│   ├── subtitleProcessor.test.js (جديد)
│   └── subtitleService.test.js
├── utils/
│   ├── circuitBreaker.js
│   ├── encodingProxy.js          (جديد — proxy ترميز خادمي مع توقيع HMAC)
│   ├── httpError.js
│   ├── language.js               (+ لهجات عربية موسّعة)
│   ├── retry.js
│   ├── scoring.js                (+ عقوبات machine/ai translated)
│   ├── startup.js
│   ├── stremio.js                (+ يولّد روابط /proxy/encoding/)
│   ├── subtitleProcessor.js      (جديد — كشف ترميز + تنظيف SRT/VTT)
│   └── values.js
├── cluster.js
├── config.js                     (+ encodingProxy + خيارات OpenSubtitles)
└── server.js
```

## التشغيل المحلي

```bash
git clone <repo>
cd stremio-enterprise-subtitles
npm install
cp .env.example .env
# عبئ مفاتيح API في .env
npm start
```

ثم في Stremio:
```
http://127.0.0.1:3000/manifest.json
```

## نقاط النهاية

| المسار | الوصف |
|---|---|
| `GET /manifest.json` | Stremio addon manifest |
| `GET /health` | حالة الخدمة والمزودين |
| `GET /subtitles/:type/:id.json` | Stremio subtitles endpoint |
| `GET /subtitles/:type/:id/:extra.json` | مع extras |
| `GET /api/subtitles?q=...` | بحث برمجي عام |
| `GET /proxy/encoding/:token.srt` | **جديد** — proxy ترميز ذكي |
| `GET /ai/deepseek/:token.srt` | DeepSeek translation (إن مفعّل) |
| `GET /downloads/subsource/:subtitleId` | SubSource download proxy |

## اختبارات

```bash
npm test
```

يجب أن ترى:
```
# tests 43
# pass 43
# fail 0
```

## ترخيص الاستخدام

استخدام شخصي وتجريبي. مزودو الترجمات لهم شروط استخدام خاصة — راجعها قبل النشر التجاري.
