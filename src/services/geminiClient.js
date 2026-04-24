/**
 * Google Gemini API client — text chat, native-video analysis, and
 * multimodal embeddings. Mirrors the shape of anthropicClient.js so the
 * unified dispatcher in reeditLlmClient.js can treat Gemini as just
 * another backend (OpenAI-shape messages in, OpenAI-shape response out).
 *
 * Three reasons Gemini sits alongside Claude/LM Studio instead of
 * replacing them:
 *   1. Gemini 2.5 accepts video input natively (up to 120s per clip
 *      through Embedding 2; Flash can take longer clips via Files API).
 *      That's what makes per-shot analysis with real camera/object
 *      motion feasible without stitching frames ourselves.
 *   2. Gemini Embedding 2 is multimodal: the same model that embeds the
 *      shot video also embeds the copy/brief, so shot retrieval against
 *      a written brief works in one vector space.
 *   3. Pricing/latency profile is different from Claude — useful to
 *      A/B against Pegasus (Twelve Labs) and Claude on the same 10
 *      shots before picking the default.
 *
 * The key lives in localStorage for MVP parity with the Claude flow;
 * moving both to Electron safeStorage is a TODO we'll hit together.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// Inline base64 request bodies are capped at 20 MB total by the Gemini
// API. We pad a little for JSON overhead so a single shot's video can
// always be sent inline without bumping into the ceiling; anything
// larger has to go through the Files API path (uploadFile below).
const INLINE_BYTE_LIMIT = 18 * 1024 * 1024

function joinSystem(messages) {
  // Gemini puts the system prompt on a dedicated `systemInstruction`
  // field rather than as a role inside `contents`. Walk the messages,
  // collect any system entries, and hand back the user/assistant
  // remainder so convertContents can focus on just those.
  const system = []
  const remainder = []
  for (const msg of messages || []) {
    if (msg?.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content || []).map((c) => c?.text || '').join('\n')
      if (text) system.push(text)
      continue
    }
    remainder.push(msg)
  }
  return { system: system.join('\n\n'), messages: remainder }
}

function dataUrlToInline(url) {
  // Accepts `data:<mime>;base64,<payload>` (what readFileAsDataUrl
  // returns) and yields the shape Gemini's inlineData expects. Bare
  // https URLs are passed through as fileUri since Gemini can fetch
  // public URLs directly — the renderer won't usually hit that path
  // but leaving it working keeps the client useful outside the app.
  if (!url) return null
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    return { inlineData: { mimeType: match[1], data: match[2] } }
  }
  return { fileData: { mimeType: 'application/octet-stream', fileUri: url } }
}

function convertContents(messages) {
  // OpenAI → Gemini content block translation. Gemini uses `parts` with
  // either `text`, `inlineData` (base64), or `fileData` (uri from the
  // Files API). Roles are `user` / `model` — assistant maps to model.
  const contents = []
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    if (typeof msg.content === 'string') {
      contents.push({ role, parts: [{ text: msg.content }] })
      continue
    }
    const parts = []
    for (const c of msg.content || []) {
      if (!c) continue
      if (c.type === 'text') {
        parts.push({ text: c.text || '' })
        continue
      }
      if (c.type === 'image_url') {
        const url = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url
        const inline = dataUrlToInline(url)
        if (inline) parts.push(inline)
        continue
      }
      if (c.type === 'video_url') {
        const url = typeof c.video_url === 'string' ? c.video_url : c.video_url?.url
        const inline = dataUrlToInline(url)
        if (inline) parts.push(inline)
        continue
      }
      if (c.type === 'input_audio') {
        // Native audio input — Gemini Embedding 2 / Gemini 2.5 accept
        // raw audio without transcription. Caller passes the same
        // data URL shape as images for consistency.
        const url = typeof c.audio_url === 'string' ? c.audio_url : c.audio_url?.url
        const inline = dataUrlToInline(url)
        if (inline) parts.push(inline)
        continue
      }
      if (c.inlineData || c.fileData) {
        // Gemini-native parts are passed straight through so callers
        // that already built the shape (e.g. after uploadFile) don't
        // have to round-trip through a fake image_url.
        parts.push(c)
        continue
      }
    }
    if (parts.length) contents.push({ role, parts })
  }
  return contents
}

// On a paid tier we don't want to back off on 429 — quotas shouldn't
// hit in normal use and sleeping 30-60s per shot is worse than surfacing
// the error. Still retry transient 5xx and network glitches once with a
// short delay; those happen independent of plan and a one-shot retry
// almost always clears them without blowing up the run.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504])
const MAX_RETRIES = 1
const RETRY_DELAY_MS = 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function postJson(url, body) {
  let lastErr = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (networkErr) {
      lastErr = networkErr
      if (attempt === MAX_RETRIES) throw networkErr
      await sleep(RETRY_DELAY_MS)
      continue
    }
    if (res.ok) return await res.json()

    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody?.error?.message || JSON.stringify(errBody)
    } catch {
      try { detail = await res.text() } catch { /* ignore */ }
    }
    const err = new Error(`Gemini API ${res.status}: ${detail || res.statusText}`)
    err.status = res.status

    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) {
      throw err
    }
    lastErr = err
    await sleep(RETRY_DELAY_MS)
  }
  throw lastErr || new Error('Gemini API request failed after retries.')
}

// Gemini's safety classifiers sometimes fire on ad footage (action,
// skate crashes, fast motion read as "violence"). We're analyzing
// client footage for a creative tool, not moderating user-generated
// content — set every threshold to BLOCK_NONE so the model actually
// describes the shot instead of refusing silently.
const SAFETY_SETTINGS_PERMISSIVE = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]

export async function geminiChatCompletion({
  apiKey,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 4000,
  responseMimeType,
  // Gemini 2.5 (Flash and Pro) enable internal reasoning by default and
  // that "thinking" burns output tokens before any visible response
  // starts. For a structured-JSON task like the shot analyzer we don't
  // want reasoning tokens — they just eat our maxOutputTokens budget
  // and leave an empty `content` when the budget is tight. Default to
  // disabled; callers that genuinely want reasoning can pass a budget.
  thinkingBudget = 0,
}) {
  if (!apiKey) throw new Error('Missing Gemini API key — open Settings → LLM to paste one.')
  if (!model) throw new Error('Missing Gemini model id.')

  const { system, messages: rest } = joinSystem(messages)
  const contents = convertContents(rest)
  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
    safetySettings: SAFETY_SETTINGS_PERMISSIVE,
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  // Asking for JSON responses from Gemini is a hard-mode toggle, not a
  // prompt hint — the field below makes the model refuse to emit prose
  // around the object, which the captioner/analyzer paths rely on.
  if (responseMimeType) body.generationConfig.responseMimeType = responseMimeType
  // thinkingConfig on 2.5 / 3.x models: Flash accepts budget=0
  // (disabled); Pro and Ultra reject it with "Budget 0 is invalid.
  // This model only works in thinking mode." Detect thinking-only
  // models and drop the thinkingConfig entirely so the API picks its
  // default dynamic budget. Anything non-zero is honoured as-is for
  // every model.
  const isThinkingOnlyModel = /\b(pro|ultra)\b/i.test(model)
  if (thinkingBudget !== undefined) {
    if (isThinkingOnlyModel && thinkingBudget === 0) {
      // Skip thinkingConfig entirely — Pro / Ultra default to dynamic
      // thinking, which is the only mode they support.
    } else {
      body.generationConfig.thinkingConfig = { thinkingBudget }
    }
  }

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await postJson(url, body)

  const textContent = (data?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .map((p) => p?.text || '')
    .join('')

  // Surface enough diagnostic state that the analyzer can produce a
  // specific error instead of the generic "empty response" fallback
  // when something blocks or truncates the output. Callers that just
  // want the text keep reading `choices[0].message.content`.
  const finishReason = data?.candidates?.[0]?.finishReason || null
  const blockReason = data?.promptFeedback?.blockReason || null

  return {
    choices: [{
      message: { role: 'assistant', content: textContent },
      finish_reason: finishReason || 'stop',
    }],
    model,
    usage: data?.usageMetadata,
    finishReason,
    blockReason,
    safetyRatings: data?.candidates?.[0]?.safetyRatings || null,
  }
}

/**
 * Embed a single content block (text, image, video, audio, or a mix of
 * those in `parts`). Returns a plain Float32-ish JS array so callers
 * can push it straight into a vector store. Matryoshka dimensions are
 * supported: default 3072, drop to 1536 / 768 for storage / latency.
 */
export async function geminiEmbedContent({
  apiKey,
  model = 'gemini-embedding-001',
  parts,
  outputDimensionality,
  taskType,
}) {
  if (!apiKey) throw new Error('Missing Gemini API key — open Settings → LLM to paste one.')
  if (!parts || !parts.length) throw new Error('geminiEmbedContent requires at least one part.')

  const body = {
    model: `models/${model}`,
    content: { parts },
  }
  if (outputDimensionality) body.outputDimensionality = outputDimensionality
  // RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY matters for asymmetric setups
  // (shots indexed as documents, briefs embedded as queries). Callers
  // that don't care can leave it unset and both sides will be embedded
  // symmetrically.
  if (taskType) body.taskType = taskType

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`
  const data = await postJson(url, body)
  const values = data?.embedding?.values || data?.embedding?.value
  if (!Array.isArray(values)) {
    throw new Error('Gemini embedding response had no values — check model id + quota.')
  }
  return { values, model }
}

/**
 * Shorthand: embed a single string of text. Most callers in the
 * retrieval path only need this overload.
 */
export async function geminiEmbedText({ apiKey, model, text, outputDimensionality, taskType }) {
  return await geminiEmbedContent({
    apiKey,
    model,
    parts: [{ text }],
    outputDimensionality,
    taskType,
  })
}

/**
 * Embed a media asset passed as a data URL (what readFileAsDataUrl
 * returns). For clips, the Gemini Embedding 2 limit is 120 s per item —
 * the caller has to chunk longer content by shot before getting here.
 */
export async function geminiEmbedMedia({ apiKey, model, dataUrl, outputDimensionality, taskType }) {
  const inline = dataUrlToInline(dataUrl)
  if (!inline) throw new Error('geminiEmbedMedia expected a data URL payload.')
  return await geminiEmbedContent({
    apiKey,
    model,
    parts: [inline],
    outputDimensionality,
    taskType,
  })
}

/**
 * Upload a file (video, audio, image, pdf) to the Gemini Files API.
 * Required when the binary payload is larger than INLINE_BYTE_LIMIT —
 * otherwise inline base64 is cheaper (one HTTP round trip instead of
 * two). Returns `{ uri, mimeType }` which the caller can drop into a
 * message as `{ fileData: { fileUri: uri, mimeType } }`.
 *
 * The upload flow is Google's resumable protocol compressed to one
 * call: `X-Goog-Upload-Protocol: raw` + `Content-Length` in the same
 * POST. Works for everything up to 2 GB per file.
 */
export async function geminiUploadFile({ apiKey, bytes, mimeType, displayName }) {
  if (!apiKey) throw new Error('Missing Gemini API key.')
  if (!bytes) throw new Error('geminiUploadFile requires a Uint8Array / ArrayBuffer body.')
  const buffer = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  const url = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': displayName || 'upload',
      'Content-Type': mimeType || 'application/octet-stream',
      'Content-Length': String(buffer.byteLength),
    },
    body: buffer,
  })
  if (!res.ok) {
    let detail = ''
    try { detail = JSON.stringify(await res.json()) } catch { try { detail = await res.text() } catch { /* */ } }
    throw new Error(`Gemini file upload ${res.status}: ${detail || res.statusText}`)
  }
  const data = await res.json()
  const file = data?.file || data
  return {
    uri: file?.uri,
    name: file?.name,
    mimeType: file?.mimeType || mimeType,
    sizeBytes: file?.sizeBytes,
    state: file?.state,
  }
}

export { INLINE_BYTE_LIMIT }

// Updated alongside the Anthropic list. 2.5 Flash is the default
// workhorse for per-shot video analysis (cheap, native video);
// 2.5 Pro for creative reasoning that mixes brief + shots. 3.0 Pro
// and 3.0 Ultra are the latest generation — use them when the proposal
// quality matters more than cost. If an id isn't enabled on your
// project the API returns a clear 404; switch to a lower-tier model
// in Settings until Google enables it.
// Embedding 2 is preview-only as of March 2026 — kept separate because
// it's only used by the embedding calls, never by chatCompletion.
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', blurb: 'Default for per-shot video analysis. Fast + native video.' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', blurb: 'Strongest reasoning in the 2.5 line. Runs in thinking mode by default.' },
  { id: 'gemini-3-pro', label: 'Gemini 3 Pro', blurb: 'Latest generation. Best narrative + creative reasoning. Requires project access.' },
  { id: 'gemini-3-ultra', label: 'Gemini 3 Ultra', blurb: 'Top-tier. Use only when final-cut quality justifies the cost.' },
]

export const GEMINI_EMBEDDING_MODELS = [
  { id: 'gemini-embedding-001', label: 'Gemini Embedding 001', blurb: 'Text-only, GA.' },
  { id: 'gemini-embedding-2', label: 'Gemini Embedding 2 (preview)', blurb: 'Multimodal (text/image/video/audio/pdf). Preview — model id may change.' },
]
