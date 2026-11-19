import express from "express";
import multer from "multer";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 10000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const GEMINI_INLINE_LIMIT = 14 * 1024 * 1024;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map(v => v.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "تم تجاوز عدد المحاولات مؤقتاً. انتظر قليلاً ثم أعد المحاولة." }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const allowed = new Set([
      "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
      "audio/aac", "audio/ogg", "audio/webm", "audio/flac", "audio/m4a",
      "application/octet-stream"
    ]);
    cb(null, allowed.has(file.mimetype));
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "sada-transcription-api" }));

function durationSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function offsetSeconds(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const s = value.trim();
  if (/^\d+(\.\d+)?s$/i.test(s)) return Number(s.slice(0, -1));
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (m) return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number("0." + (m[4] || "0"));
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function normalizeWords(words) {
  return (Array.isArray(words) ? words : []).map(w => {
    const word = String(w.word || w.text || "").trim();
    const start = offsetSeconds(w.start_offset ?? w.start);
    const end = offsetSeconds(w.end_offset ?? w.end);
    return { word, start, end };
  }).filter(w => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a,b) => a.start - b.start);
}
function chunksFromWords(words) {
  return words.map(w => ({ text: w.word, timestamp: [w.start, w.end] }));
}
function extractGemini(payload) {
  const parts = (payload.candidates || []).flatMap(c => c.content?.parts || []);
  let transcript = "";
  let words = [];
  for (const part of parts) {
    const a = part.audioTranscription || part.audio_transcription;
    if (a) {
      transcript += (a.text || "") + " ";
      if (Array.isArray(a.words)) words.push(...a.words);
    }
    if (typeof part.text === "string") transcript += part.text + " ";
  }
  if (!transcript.trim() && typeof payload.text === "string") transcript = payload.text;
  return { text: transcript.trim(), words: normalizeWords(words) };
}
async function callGemini(file) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Gemini key is not configured");
  if (file.buffer.length > GEMINI_INLINE_LIMIT) throw new Error("Audio exceeds Gemini inline limit");
  const mimeType = file.mimetype === "application/octet-stream" ? "audio/mpeg" : file.mimetype;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType, data: file.buffer.toString("base64") } }] }],
      config: { audioTranscriptionConfig: { wordTimestamp: true } }
    }),
    signal: AbortSignal.timeout(180000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Gemini request failed (" + response.status + ")");
  const result = extractGemini(body);
  if (!result.text) throw new Error("Gemini returned an empty transcript");
  return { ...result, provider: "gemini" };
}
async function callGroq(file) {
  if (!process.env.GROQ_API_KEY) throw new Error("Groq key is not configured");
  const form = new FormData();
  const mimeType = file.mimetype === "application/octet-stream" ? "audio/mpeg" : file.mimetype;
  form.append("file", new Blob([file.buffer], { type: mimeType }), file.originalname || "audio.mp3");
  form.append("model", process.env.GROQ_MODEL || "whisper-large-v3-turbo");
  form.append("language", "ar");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.GROQ_API_KEY },
    body: form,
    signal: AbortSignal.timeout(180000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Groq request failed (" + response.status + ")");
  const words = normalizeWords(body.words || []);
  const text = String(body.text || "").trim();
  if (!text) throw new Error("Groq returned an empty transcript");
  return { text, words, provider: "groq" };
}

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يصل ملف صوتي صالح. تحقق من الصيغة والحجم." });
  const duration = durationSeconds(req.body.duration);
  if (duration > 1800) return res.status(413).json({ error: "مدة الملف تتجاوز 30 دقيقة." });

  let primaryError;
  try {
    const result = await callGemini(req.file);
    return res.json({ provider: result.provider, text: result.text, words: result.words, chunks: chunksFromWords(result.words) });
  } catch (error) {
    primaryError = error;
  }

  try {
    const result = await callGroq(req.file);
    return res.json({
      provider: result.provider,
      fallback: true,
      text: result.text,
      words: result.words,
      chunks: chunksFromWords(result.words)
    });
  } catch (_fallbackError) {
    console.error("Transcription providers unavailable:", {
      gemini: primaryError?.message || "unknown",
      groq: "failed"
    });
    const missingKeys = !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY;
    return res.status(502).json({
      error: missingKeys
        ? "لم تُضف مفاتيح خدمات التفريغ إلى Environment في Render بعد."
        : "تعذّر التفريغ عبر المحركين حالياً. أعد المحاولة لاحقاً أو استخدم التفريغ اليدوي."
    });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "حجم الملف أكبر من الحد المسموح (24MB)." });
  }
  if (err.message === "Origin not allowed") return res.status(403).json({ error: "هذا النطاق غير مسموح له باستخدام الخدمة." });
  console.error("API error:", err.message);
  return res.status(400).json({ error: "تعذّر استقبال الملف. تحقق من صيغته وحجمه ثم أعد المحاولة." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sada transcription API listening on port " + PORT);
});
