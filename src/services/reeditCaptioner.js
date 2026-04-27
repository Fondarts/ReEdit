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
import { chatCompletion, loadLlmSettings, LLM_BACKENDS, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'

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

  // When the dispatcher will route to Claude, we don't need to pre-
  // pick a model — the Anthropic backend knows which model to call
  // from the LLM settings. Returning a synthetic "anthropic" label
  // here lets the progress UI show something meaningful without
  // forcing the LM Studio model list call (which errors out when
  // LM Studio is closed).
  const settings = loadLlmSettings()
  if (settings.backend === LLM_BACKENDS.ANTHROPIC) {
    if (!settings.anthropicApiKey) {
      throw new Error('Claude API is selected but no API key is set. Open LLM Settings to paste one.')
    }
    return settings.anthropicModel || 'claude-sonnet-4-6'
  }
  if (settings.backend === LLM_BACKENDS.GEMINI) {
    // Same synthetic-label trick as the Anthropic branch: we don't
    // need to round-trip LM Studio's /models endpoint (it may not even
    // be running) when Gemini will handle the call from its own
    // settings-driven model id.
    if (!settings.geminiApiKey) {
      throw new Error('Gemini API is selected but no API key is set. Open LLM Settings to paste one.')
    }
    return resolveGeminiModelForTask(settings, LLM_TASKS.ANALYSIS)
  }

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

  // Route through the unified dispatcher (LM Studio OR Claude) using
  // the same LLM settings the Proposal view edits. preferVision
  // nudges the LM Studio path toward a loaded VL model when multiple
  // chat models are available; no effect on the Anthropic path where
  // Sonnet/Opus/Haiku all accept image content natively.
  const response = await chatCompletion({
    messages,
    temperature,
    maxTokens,
    preferVision: true,
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
    model: response?.model || model,
  }
}

/**
 * Caption a list of scenes sequentially. Sequential is intentional: LM
 * Studio runs a single model instance, so parallel requests just queue
 * behind each other and add HTTP overhead. `onProgress` fires after
 * every scene with { index, total, scene, captioned, error? }.
 *
 * When the Gemini backend is active, this function delegates to the
 * native-video analyzer (reeditVideoAnalyzer.analyzeScenesVideo) so the
 * shot log ends up with real motion / audio fields instead of a frame-
 * only read. The view layer stays unchanged — `structured` still holds
 * the captioner-shape fields that the table chips render from; the
 * richer analyzer output is attached as `videoAnalysis` for any future
 * consumer (proposer, retrieval, brief matching) that wants it.
 *
 * `sourceVideoPath` and `projectDir` are only required for the Gemini
 * path — LM Studio / Claude still read the per-scene thumbnail and
 * don't care about the source file.
 */
export async function captionScenes(scenes, {
  modelId,
  onProgress,
  signal,
  sourceVideoPath,
  projectDir,
} = {}) {
  const settings = loadLlmSettings()
  if (settings.backend === LLM_BACKENDS.GEMINI) {
    // Dynamic import keeps the Gemini code out of the LM-Studio-only
    // startup path, and also breaks what would otherwise be a cycle
    // between reeditCaptioner and reeditVideoAnalyzer (the analyzer
    // imports extractJson from here).
    const { analyzeScenesVideo } = await import('./reeditVideoAnalyzer')
    if (!sourceVideoPath || !projectDir) {
      throw new Error(
        'Gemini video analysis needs sourceVideoPath + projectDir. Re-run captioning from the Analysis view, which passes them in.'
      )
    }
    const model = modelId || resolveGeminiModelForTask(settings, LLM_TASKS.ANALYSIS)
    const { scenes: analyzedScenes } = await analyzeScenesVideo(scenes, {
      sourceVideoPath,
      projectDir,
      modelOverride: model,
      signal,
      onProgress: ({ index, total, scene, analyzed, error, skipped }) => {
        // Adapt the analyzer's progress shape to captionScenes' shape
        // so the existing AnalysisView progress UI keeps working.
        onProgress?.({
          index,
          total,
          scene,
          captioned: analyzed ? toCaptionerShape(analyzed, model) : null,
          skipped,
          error,
        })
      },
    })
    // Remap each scene to the captioner-compatible shape that the rest
    // of the app (AnalysisView chips, proposer prompt builder) reads.
    // Expose videoAnalysisError as captionError too so the shot log
    // can distinguish "never ran" (no caption, no error) from "ran and
    // failed" (error message available for the tooltip).
    const results = analyzedScenes.map((s) => {
      if (!s?.videoAnalysis) {
        if (s?.videoAnalysisError) {
          return { ...s, captionError: s.videoAnalysisError }
        }
        return s
      }
      const compat = toCaptionerShape(s.videoAnalysis, model)
      return {
        ...s,
        caption: s.videoAnalysis.visual || s.caption || null,
        structured: compat,
        captionError: null,
      }
    })
    return { model, scenes: results }
  }

  // Defer picking the model until we know at least one scene actually
  // needs a caption — avoids a spurious "no vision model" error when
  // the user has marked every scene excluded and just wants to keep
  // existing captions intact.
  let model = modelId || null
  const results = []
  for (let i = 0; i < scenes.length; i++) {
    if (signal?.aborted) {
      const err = new Error('Captioning cancelled.')
      err.code = 'aborted'
      throw err
    }
    const scene = scenes[i]
    // Skip excluded scenes — the user has flagged them out of the
    // pipeline, so re-captioning would just waste model tokens and
    // overwrite whatever they had before toggling it off.
    if (scene?.excluded) {
      results.push(scene)
      onProgress?.({ index: i, total: scenes.length, scene, skipped: true })
      continue
    }
    if (!model) model = await pickVisionModelId()
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

// Text-only prompt for the LM Studio / Claude path of analyzeOverallAd.
// The per-shot captions are the closest proxy we have to "the model
// watched the ad" when we can't actually feed it the video. We show the
// captions in order with timecodes so the model can reason about the
// narrative arc without needing to see frames.
const OVERALL_TEXT_SYSTEM_PROMPT = `You are a senior creative strategist reviewing an advertisement. You are given a sequential shot log — one entry per cut — and must infer the ad's high-level read from it. Return ONLY a JSON object, no prose, no markdown fences.`

function buildShotLogSummary(scenes) {
  const lines = []
  for (const s of scenes || []) {
    if (s?.excluded) continue
    const tc = typeof s.tcIn === 'number' ? `${s.tcIn.toFixed(1)}s` : '—'
    const visual = s?.videoAnalysis?.visual || s?.structured?.visual || s?.caption || '(no caption)'
    const audio = s?.videoAnalysis?.audio
    const vo = audio?.voiceover_transcript ? ` · VO: "${audio.voiceover_transcript}"` : ''
    const music = audio?.music ? ` · Music: ${audio.music}` : ''
    lines.push(`Shot ${s.index} @ ${tc}: ${visual}${vo}${music}`)
  }
  return lines.join('\n')
}

const OVERALL_TEXT_USER_PROMPT_TEMPLATE = (shotLog) => `Here is the per-shot description of the ad, in order:

${shotLog}

Return a JSON object with exactly these fields:

{
  "concept": "1-2 sentences describing the creative concept / central idea driving the ad.",
  "message": "1 sentence capturing the single takeaway the viewer should walk away with.",
  "mood": "3-6 words summarising the emotional register.",
  "target_audience": "1 sentence describing who this is speaking to.",
  "brand_role": "1 sentence on how the brand / product appears in the ad.",
  "narrative_arc": "1-2 sentences summarising the beat structure (setup → turn → payoff)."
}

Rules:
- If you truly cannot determine a field from what the shot log contains, use null.
- Return the JSON object only.`

/**
 * High-level "did the model understand the ad" pass. Returns
 * { concept, message, mood, target_audience, brand_role, narrative_arc,
 * rawText, model }. Dispatches to the Gemini-native video analyzer when
 * Gemini is the selected backend (most accurate — model actually watches
 * the ad) and to a text-only summary from the existing per-shot captions
 * otherwise. Callers should run `captionScenes` first; without captions,
 * the text-only path has nothing meaningful to summarise.
 */
export async function analyzeOverallAd(scenes, {
  sourceVideoPath,
  modelOverride,
  temperature = 0.3,
} = {}) {
  const settings = loadLlmSettings()

  if (settings.backend === LLM_BACKENDS.GEMINI) {
    if (!sourceVideoPath) {
      throw new Error('Overall analysis (Gemini) needs the source video path.')
    }
    const { analyzeOverallVideo } = await import('./reeditVideoAnalyzer')
    return await analyzeOverallVideo({ sourceVideoPath, modelOverride, temperature })
  }

  // Text-only fallback for LM Studio / Claude. Shot log is required —
  // we don't pretend to infer ad intent from scene count alone.
  const captioned = (scenes || []).filter((s) => !s?.excluded && (s?.caption || s?.videoAnalysis?.visual || s?.structured?.visual))
  if (captioned.length === 0) {
    throw new Error('No captioned shots available. Run "Caption all" first, then retry.')
  }
  const shotLog = buildShotLogSummary(scenes)
  const messages = [
    { role: 'system', content: OVERALL_TEXT_SYSTEM_PROMPT },
    { role: 'user', content: OVERALL_TEXT_USER_PROMPT_TEMPLATE(shotLog) },
  ]
  const response = await chatCompletion({
    messages,
    temperature,
    maxTokens: 1500,
  })
  const rawText = response?.choices?.[0]?.message?.content || ''
  if (!rawText) throw new Error('LLM returned an empty response for the overall analysis.')
  const parsed = extractJson(rawText) || {}
  return {
    concept: parsed.concept || null,
    message: parsed.message || null,
    mood: parsed.mood || null,
    target_audience: parsed.target_audience || null,
    brand_role: parsed.brand_role || null,
    narrative_arc: parsed.narrative_arc || null,
    rawText,
    model: response?.model || 'unknown',
  }
}

// Map the richer video-analysis schema back to the five fields
// AnalysisView's chip row renders. The extra fields (camera_movement,
// audio, tempo_cue, etc.) are still available on scene.videoAnalysis
// for any consumer that wants them — the proposer prompt builder is
// the obvious next user.
function toCaptionerShape(a, model) {
  if (!a) return null
  return {
    visual: a.visual || null,
    brand: a.brand || null,
    emotion: a.emotion || null,
    framing: a.framing || null,
    movement: a.movement || null,
    // Audio is no longer null when Gemini ran — pass through whatever
    // the analyzer returned so the proposer can read VO/music later.
    audio: a.audio ?? null,
    rawText: a.rawText || '',
    model: a.model || model,
  }
}
