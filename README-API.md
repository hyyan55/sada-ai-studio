# صَدَى — Full-stack Render Web Service

الموقع والواجهة الأمامية وواجهات الذكاء الاصطناعي تعمل كلها من **خدمة Render Web Service واحدة**.

## Render configuration

أنشئ خدمة Web Service واحدة للمستودع `hyyan55/sada-ai-studio`:

- Name: `sada-ai-studio` (أو اسم تختاره)
- Branch: `main`
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

الخدمة نفسها تعرض:
- `/` — موقع صَدَى الكامل.
- `/health` — فحص صحة الخدمة.
- `POST /api/transcribe` — تفريغ الصوت وتوقيتات الكلمات.
- `POST /api/split-scenes` — تقسيم النص المعتمد إلى مشاهد دلالية.

الواجهة تستخدم مسارات API نسبية من نفس النطاق؛ لا تحتاج إلى Static Site أو API Service منفصلة أو إعداد CORS.

## Environment variables

أنشئ المفاتيح من حساباتك ثم أضفها في Render → Web Service → Environment:

- [Google AI Studio](https://aistudio.google.com/app/apikey) → `GEMINI_API_KEY`
- [Groq Console](https://console.groq.com/keys) → `GROQ_API_KEY`
- `GROQ_MODEL` اختياري؛ الافتراضي `whisper-large-v3-turbo`

لا ترسل المفاتيح في المحادثة ولا تضعها في GitHub أو ملفات الواجهة. لا تحتاج إلى `ALLOWED_ORIGINS` لأن الواجهة والـ API من نفس النطاق.

## Workflow

1. يرفع المستخدم الصوت بعد التحقق من قابلية تشغيله.
2. يحاول الخادم التفريغ عبر Gemini 3.5 Transcribe أولاً، مع توقيت الكلمات، ثم Groq Whisper تلقائياً عند فشل Gemini.
3. يراجع المستخدم النص ويصححه.
4. عند ضغط «اعتماد النص وتقسيمه إلى مشاهد»، يحاول الخادم استخدام Gemini Flash لتقسيمه دلالياً دون حذف الكلمات أو إعادة صياغتها. إذا تعذّر التحليل، يستخدم تقسيمًا محلياً احتياطياً.
5. يراجع المستخدم المشاهد وتوقيتها قبل التصميم والتصدير.

## Limits and privacy

- حجم الملف الأقصى: 24MB.
- مدة الملف القصوى: 30 دقيقة.
- Gemini 3.5 Transcribe مع توقيت الكلمات: حتى 15 دقيقة؛ التسجيلات الأطول تنتقل إلى Groq.
- Groq Whisper يدعم توقيت الكلمات عبر `verbose_json`.
- الملفات التي ترفع إلى Gemini تُحذف من Files API بعد انتهاء الطلب، مع محاولة حذفها حتى عند الفشل.
- الطلبات محدودة بمعدل 12 طلباً لكل 15 دقيقة لكل عنوان IP.
- خطط الاستخدام المجانية وحدودها تتغير حسب حساب المزوّد؛ راجع شروط الخصوصية قبل رفع محتوى حساس.
