/**
 * project:re-edit — per-scene VLM captioner.
 *
 * Talks to LM Studio (the existing local integration) using the
 * OpenAI-compatible /v1/chat/completions endpoint with multimodal
 * messages. Expects a vision-capable model to be loaded in LM Studio
 * (Qwen2.5-VL, LLaVA, MiniCPM-V, etc.) — we surface an actionable
 * error if the chosen model refuses the image payload.
 *
 * Output schema per scene, mirroring the Sundogs shot-log (page 13 of
 * the brief). Audio is intentionally null here because a still frame
 * can't describe it; a future pass will fill it from ASR/stem analysis.
 *
 *   { visual, brand, emotion, framing, movement, audio: null, rawText, model }
 *
 * Keep the prompt tight: asking for prose + JSON in the same response
 * makes most vision-GGUF models waver. We ask for JSON only and treat
 * the `visual` field as the prose caption.
 */

import lmstudio from './lmstudio'

const SYSTEM_PROMPT = `You annotate single frames from advertisements for a shot log. You return ONLY a JSON object, no commentary, no markdown fences.`

const USER_PROMPT = `Study this frame and return a JSON object with exactly these fields:

{
  "visual": "1-2 sentence factual description of what's on screen: subject, action, setting.",
  "brand": "Brand presence. One of: 'Logo visible', 'Product visible', 'Text/logo on-screen', 'Driver/face visible', 'None'.",
  "emotion": "One-word emotional register (e.g. triumphant, tense, calm, focused, aggressive, playful, serious, awe, freedom, technical).",
  "framing": "Shot type. One of: 'ECU', 'Close-up', 'Medium', 'Wide', 'Aerial'.",
  "movement": "Perceived motion level. One of: 'High', 'Moderate', 'Slow', 'Static'."
}

If a field can't be determined from the frame, use "Unknown".
Return the JSON object only.`

// Strip common LLM wrappers (```json fences, "Here is the JSON:" prefixes)
// before handing the string to JSON.parse. We also scan for the outermost
// {...} in case the model still wrote extra prose.
export function extractJson(text) {
  if (!text) return null
  let s = String(text).trim()
  // Strip code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  // If model returned prose around the JSON, find the outermost braces.
  if (!s.startsWith('{')) {
    const first = s.indexOf('{')
    const last = s.lastIndexOf('}')
    if (first >= 0 && last > first) s = s.slice(first, last + 1)
  }
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Go through the main process IPC instead of fetching the
// comfystudio:// URL directly: that protocol is registered via
// `protocol.handle()` without `supportFetchAPI`, so fetch() in the
// renderer throws a generic "Failed to fetch". `<img>` tags still work
// (they use the resource loader, not fetch), which is why thumbnails
// render in the table just fine. The IPC round-trip is cheap for
// per-scene JPEG thumbnails (~30KB each).
async function thumbnailToDataUrl(thumbnailPath) {
  if (!thumbnailPath) throw new Error('Scene has no thumbnail to caption.')
  const res = await window.electronAPI?.readFileAsDataUrl?.(thumbnailPath, 'image/jpeg')
  if (!res?.success) {
    throw new Error(res?.error || `Could not read thumbnail at ${thumbnailPath}.`)
  }
  return res.dataUrl
}

// Pick a vision-capable model from whatever LM Studio has listed. We
// prefer loaded vision models; fall back to any loaded model so the user
// gets a clear "model doesn't support images" error instead of a silent
// no-op. Model IDs in LM Studio aren't standardized, so we match on
// the usual substrings that ship on vision-capable GGUFs.
const VISION_HINTS = ['-vl', 'vl-', 'vision', 'llava', 'minicpm-v', 'qwen2.5-vl', 'qwen3-vl', 'qwen2-vl', 'internvl', 'pixtral']

function isVisionModel(m) {
  const name = String(m?.id || m?.model || '').toLowerCase()
  return VISION_HINTS.some((h) => name.includes(h))
}

function isLoaded(m) {
  // LM Studio surfaces different shapes across v0/v1. Be permissive.
  if (m?.state === 'loaded') return true
  if (m?.loaded === true) return true
  // v1 list endpoint returns only loaded models by default in some builds,
  // so treat absence of state info as "loaded".
  return m?.state === undefined && m?.loaded === undefined
}

// Embedding / classification / speech models surface in the same model
// list as chat-capable ones but will 400 the moment we POST a chat
// completion. Filter them out up-front so we can show a precise
// "download a vision model" message instead of a mysterious server
// error mid-run.
function isChatCandidate(m) {
  const type = String(m?.type || '').toLowerCase()
  if (type.includes('embed')) return false
  if (type.includes('rerank')) return false
  if (type.includes('speech') || type.includes('audio')) return false
  return true
}

export async function pickVisionModelId(explicit) {
  if (explicit) return explicit
  const models = await lmstudio.listModels()
  const chatCapable = models.filter(isChatCandidate)
  const loaded = chatCapable.filter(isLoaded)
  const loadedVision = loaded.find(isVisionModel)
  if (loadedVision) return loadedVision.id || loadedVision.model
  const anyVision = chatCapable.find(isVisionModel)
  if (anyVision) return anyVision.id || anyVision.model
  const anyLoadedChat = loaded[0]
  if (anyLoadedChat) return anyLoadedChat.id || anyLoadedChat.model
  const anyChat = chatCapable[0]
  if (anyChat) return anyChat.id || anyChat.model
  throw new Error(
    'No chat-capable model available in LM Studio. Download and load a vision model (Qwen2.5-VL-7B-Instruct-GGUF recommended) from the Discover tab, then retry.'
  )
}

export async function captionScene(scene, { modelId, temperature = 0.2, maxTokens = 400 } = {}) {
  if (!scene?.thumbnail) throw new Error(`Scene ${scene?.id || '?'} has no thumbnail.`)
  const model = modelId || await pickVisionModelId()
  const dataUrl = await thumbnailToDataUrl(scene.thumbnail)

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: USER_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ]

  const response = await lmstudio.chatCompletion(model, messages, {
    temperature,
    max_tokens: maxTokens,
  })

  const rawText = response?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(rawText)

  return {
    visual: parsed?.visual || null,
    brand: parsed?.brand || null,
    emotion: parsed?.emotion || null,
    framing: parsed?.framing || null,
    movement: parsed?.movement || null,
    audio: null,
    rawText,
    model,
  }
}

/**
 * Caption a list of scenes sequentially. Sequential is intentional: LM
 * Studio runs a single model instance, so parallel requests just queue
 * behind each other and add HTTP overhead. `onProgress` fires after
 * every scene with { index, total, scene, captioned, error? }.
 */
export async function captionScenes(scenes, { modelId, onProgress, signal } = {}) {
  const model = modelId || await pickVisionModelId()
  const results = []
  for (let i = 0; i < scenes.length; i++) {
    if (signal?.aborted) {
      const err = new Error('Captioning cancelled.')
      err.code = 'aborted'
      throw err
    }
    const scene = scenes[i]
    try {
      const captioned = await captionScene(scene, { modelId: model })
      results.push({ ...scene, caption: captioned.visual, structured: captioned })
      onProgress?.({ index: i, total: scenes.length, scene, captioned })
    } catch (err) {
      results.push({ ...scene, caption: null, structured: null, captionError: err?.message || String(err) })
      onProgress?.({ index: i, total: scenes.length, scene, error: err })
    }
  }
  return { model, scenes: results }
}
