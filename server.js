import express from "express";
import multer from "multer";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 10000;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const GEMINI_MAX_DURATION = 15 * 60;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000, limit: 12,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "تم تجاوز عدد المحاولات مؤقتاً. انتظر قليلاً ثم أعد المحاولة." }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const allowed = new Set([
      "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
      "audio/aac", "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac",
      "audio/m4a", "video/mp4", "application/octet-stream"
    ]);
    cb(null, allowed.has(file.mimetype));
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true, service: "sada-transcription-api",
  providers: { gemini: Boolean(process.env.GEMINI_API_KEY), groq: Boolean(process.env.GROQ_API_KEY) }
}));

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
    const start = offsetSeconds(w.startOffset ?? w.start_offset ?? w.start);
    const end = offsetSeconds(w.endOffset ?? w.end_offset ?? w.end);
    return { word, start, end };
  }).filter(w => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);
}
function chunksFromWords(words) {
  return words.map(w => ({ text: w.word, timestamp: [w.start, w.end] }));
}
function interactionData(payload) {
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  let text = String(payload.output_text || "").trim();
  const words = [];
  const textParts = [];
  for (const step of steps) for (const item of (step.content || [])) {
    if (typeof item.text === "string") textParts.push(item.text);
    for (const a of (item.annotations || [])) {
      if (a.type === "word_info") words.push({ word: a.text, start_offset: a.start_offset, end_offset: a.end_offset });
    }
  }
  if (!text) text = textParts.join("").trim();
  return { text, words: normalizeWords(words) };
}
async function uploadGeminiFile(file) {
  const key = process.env.GEMINI_API_KEY;
  const mimeType = file.mimetype === "application/octet-stream"
    ? (file.originalname?.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg")
    : file.mimetype;
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.buffer.length),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify({ file: { display_name: (file.originalname || "sada-audio").slice(0, 100) } }),
    signal: AbortSignal.timeout(30000)
  });
  if (!start.ok) throw new Error("Gemini file upload initialization failed (" + start.status + ")");
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL");
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Length": String(file.buffer.length), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: file.buffer,
    signal: AbortSignal.timeout(120000)
  });
  const body = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok || !body.file?.uri || !body.file?.name) throw new Error("Gemini audio upload failed (" + uploaded.status + ")");
  return { uri: body.file.uri, name: body.file.name, mimeType };
}
async function deleteGeminiFile(name) {
  if (!name || !process.env.GEMINI_API_KEY) return;
  try {
    await fetch("https://generativelanguage.googleapis.com/v1beta/" + name, {
      method: "DELETE", headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(10000)
    });
  } catch {}
}
async function callGemini(file, duration) {
  if (!process.env.GEMINI_API_KEY) throw new Error("Gemini key is not configured");
  if (duration > GEMINI_MAX_DURATION) throw new Error("Gemini word timestamps support up to 15 minutes; use Groq fallback");
  const uploaded = await uploadGeminiFile(file);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.5-transcribe",
        input: [{ type: "audio", uri: uploaded.uri, mime_type: uploaded.mimeType }],
        generation_config: {
          transcription_config: {
            mode: { type: "verbatim", timestamp_granularities: ["word"] }
          }
        }
      }),
      signal: AbortSignal.timeout(240000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Gemini transcription failed (" + response.status + ")");
    if (body.status && body.status !== "completed") throw new Error("Gemini transcription did not complete");
    const result = interactionData(body);
    if (!result.text) throw new Error("Gemini returned an empty transcript");
    if (!result.words.length) throw new Error("Gemini returned no word timestamps");
    return { ...result, provider: "gemini" };
  } finally {
    await deleteGeminiFile(uploaded.name);
  }
}
async function callGroq(file) {
  if (!process.env.GROQ_API_KEY) throw new Error("Groq key is not configured");
  const form = new FormData();
  const mimeType = file.mimetype === "application/octet-stream"
    ? (file.originalname?.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg")
    : file.mimetype;
  form.append("file", new Blob([file.buffer], { type: mimeType }), file.originalname || "sada-audio");
  form.append("model", process.env.GROQ_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: "Bearer " + process.env.GROQ_API_KEY },
    body: form, signal: AbortSignal.timeout(240000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Groq transcription failed (" + response.status + ")");
  const words = normalizeWords(body.words || []);
  const text = String(body.text || "").trim();
  if (!text || !words.length) throw new Error("Groq returned no transcript or word timestamps");
  return { text, words, provider: "groq" };
}

function parseModelJson(text) {
  const cleaned = String(text || "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  return JSON.parse(cleaned);
}
function alignTranscriptWords(transcript, sourceWords) {
  const tokens = String(transcript || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !sourceWords.length) return [];
  if (tokens.length === sourceWords.length) {
    return tokens.map((word, i) => ({
      word, start: sourceWords[i].start, end: sourceWords[i].end,
      estimated: word !== sourceWords[i].word
    }));
  }
  const first = sourceWords[0].start, last = sourceWords[sourceWords.length - 1].end;
  const span = Math.max(0.1, last - first);
  return tokens.map((word, i) => {
    const a = Math.floor(i * sourceWords.length / tokens.length);
    const b = Math.min(sourceWords.length - 1, Math.floor((i + 1) * sourceWords.length / tokens.length));
    return {
      word,
      start: sourceWords[a].start,
      end: Math.max(sourceWords[a].start + 0.04, sourceWords[b].end),
      estimated: true
    };
  }).map(w => ({ ...w, start: Math.max(first, Math.min(last, w.start)), end: Math.max(w.start + 0.04, Math.min(last + 0.04, w.end)) }));
}
function makeSceneResponse(words, ranges) {
  const scenes = [];
  let cursor = 0;
  const valid = (Array.isArray(ranges) ? ranges : []).map(r => ({
    startWord: Math.max(0, Math.floor(Number(r.startWord))),
    endWord: Math.min(words.length - 1, Math.floor(Number(r.endWord)))
  })).filter(r => Number.isFinite(r.startWord) && Number.isFinite(r.endWord) && r.endWord >= r.startWord)
    .sort((a, b) => a.startWord - b.startWord);
  for (const range of valid) {
    if (range.startWord > cursor) scenes.push({ startWord: cursor, endWord: range.startWord - 1 });
    const startWord = Math.max(cursor, range.startWord);
    if (range.endWord >= startWord) scenes.push({ startWord, endWord: range.endWord });
    cursor = Math.max(cursor, range.endWord + 1);
  }
  if (cursor < words.length) scenes.push({ startWord: cursor, endWord: words.length - 1 });
  const normalized = scenes.filter(s => s.endWord >= s.startWord).map((s, i) => {
    const part = words.slice(s.startWord, s.endWord + 1);
    return {
      id: "scene-" + (i + 1),
      text: part.map(w => w.word).join(" "),
      start: part[0].start,
      end: part[part.length - 1].end,
      words: part.map(w => ({ w: w.word, s: w.start, e: w.end, estimated: Boolean(w.estimated) }))
    };
  });
  return normalized;
}
function fallbackRanges(words) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const gap = i < words.length - 1 ? words[i + 1].start - words[i].end : 0;
    const punctuation = /[.!؟?؛،…]$/.test(words[i].word);
    const length = i - start + 1;
    if ((punctuation && length >= 4) || gap >= 0.85 || length >= 16 || i === words.length - 1) {
      ranges.push({ startWord: start, endWord: i });
      start = i + 1;
    }
  }
  if (start < words.length) ranges.push({ startWord: start, endWord: words.length - 1 });
  return ranges;
}

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يصل ملف صوتي صالح. تحقق من الصيغة والحجم." });
  const duration = Number(req.body.duration) || 0;
  if (duration > 1800) return res.status(413).json({ error: "مدة الملف تتجاوز 30 دقيقة." });
  let geminiError;
  try {
    const result = await callGemini(req.file, duration);
    return res.json({ provider: result.provider, text: result.text, words: result.words, chunks: chunksFromWords(result.words) });
  } catch (error) { geminiError = error; }
  try {
    const result = await callGroq(req.file);
    return res.json({
      provider: result.provider, fallback: true, text: result.text,
      words: result.words, chunks: chunksFromWords(result.words)
    });
  } catch (groqError) {
    console.error("Transcription providers unavailable:", {
      gemini: geminiError?.message || "unknown", groq: groqError?.message || "unknown"
    });
    const missingKeys = !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY;
    return res.status(502).json({
      error: missingKeys
        ? "لم تُضف مفاتيح خدمات التفريغ إلى Environment في Render بعد."
        : "تعذّر التفريغ عبر المحركين. تحقق من المفاتيح وحدود الاستخدام ثم أعد المحاولة."
    });
  }
});

app.post("/api/split-scenes", express.json({ limit: "2mb" }), async (req, res) => {
  const transcript = String(req.body?.transcript || "").trim();
  const sourceWords = normalizeWords(req.body?.words || []);
  if (!transcript || !sourceWords.length) return res.status(400).json({ error: "اعتمد النص بعد التفريغ وتأكد من وجود توقيتات الكلمات." });
  if (transcript.length > 30000 || sourceWords.length > 6000) return res.status(413).json({ error: "النص طويل جداً لتقسيمه في طلب واحد." });
  const words = alignTranscriptWords(transcript, sourceWords);
  let ranges = null;
  let provider = "local";
  if (process.env.GEMINI_API_KEY) {
    const wordList = words.map((w, i) => i + ": " + w.word).join("\n");
    const prompt = [
      "أنت محرر Reels محترف. قسّم النص العربي التالي إلى مشاهد متتابعة مناسبة جداً للمعنى والإيقاع.",
      "قواعد إلزامية: لا تحذف أو تضف أو تعيد صياغة أي كلمة. لا تغيّر الترتيب. كل كلمة تنتمي إلى مشهد واحد فقط. اجعل المشهد غالباً 5 إلى 14 كلمة، وقد يكون أقصر أو أطول عند اكتمال المعنى. لا تقطع تركيباً نحوياً أو فكرة في منتصفها. استعمل الوقفات وعلامات الترقيم كإشارات مساعدة لا كقاعدة وحيدة.",
      "أعد JSON فقط بالشكل: { \"scenes\": [{ \"startWord\": 0, \"endWord\": 9 }] } حيث الفهارس تبدأ من الصفر وشاملة.",
      "الكلمات المفهرسة:",
      wordList
    ].join("\n\n");
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        }),
        signal: AbortSignal.timeout(60000)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("Gemini scene segmentation failed (" + response.status + ")");
      const output = body.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
      const parsed = parseModelJson(output);
      if (Array.isArray(parsed.scenes) && parsed.scenes.length) {
        ranges = parsed.scenes; provider = "gemini";
      }
    } catch (error) {
      console.warn("AI scene segmentation unavailable; using local fallback:", error.message);
    }
  }
  if (!ranges) ranges = fallbackRanges(words);
  const scenes = makeSceneResponse(words, ranges);
  if (!scenes.length) return res.status(502).json({ error: "تعذّر بناء المشاهد من التوقيتات." });
  return res.json({ provider, scenes, estimatedWords: words.filter(w => w.estimated).length });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "حجم الملف أكبر من الحد المسموح (24MB)." });
  }
  if (err.message === "Origin not allowed") return res.status(403).json({ error: "هذا النطاق غير مسموح له باستخدام الخدمة." });
  console.error("API error:", err.message);
  return res.status(400).json({ error: "تعذّر استقبال الطلب. تحقق من البيانات ثم أعد المحاولة." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Sada API listening on port " + PORT);
});
