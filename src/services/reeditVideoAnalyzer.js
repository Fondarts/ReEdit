/**
 * project:re-edit — per-shot VIDEO analyzer (Gemini 2.5).
 *
 * This is the complement to reeditCaptioner.js. Captioner looks at a
 * single JPEG thumbnail; this one feeds the entire shot clip (video +
 * audio) to Gemini, so the output covers things a still frame can't
 * describe: camera movement, object/subject motion, edit pacing inside
 * the shot, and audio (VO, music, SFX).
 *
 * Pipeline per scene:
 *   1. Materialise an MP4 of the shot via analysis:extractSceneClip
 *      (stream-copy, cached under `.reedit/clips/<id>.mp4` the same way
 *      reeditEdlToTimeline does it).
 *   2. Read it back as a data URL through the main-process IPC (the
 *      comfystudio:// protocol isn't fetch-able from the renderer).
 *   3. Send video + structured prompt to Gemini 2.5 Flash with
 *      responseMimeType='application/json' so the model can't decorate
 *      the output with prose / markdown fences.
 *   4. Optionally embed the same clip with Gemini Embedding 2 for
 *      retrieval later (brief ↔ shots, "find shots like this", etc.).
 *
 * The output schema is a superset of reeditCaptioner's (same visual /
 * brand / emotion / framing / movement fields) plus the new video-only
 * fields. Downstream consumers that only read captioner fields keep
 * working; new consumers can read the extras.
 */

import {
  geminiChatCompletion,
  geminiEmbedMedia,
  INLINE_BYTE_LIMIT,
} from './geminiClient'
import { loadLlmSettings, LLM_BACKENDS } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'

const SYSTEM_PROMPT = `You are a shot analyst for ad re-edit pipelines. You watch one short video clip (a single shot or cut) and return ONLY a JSON object with the fields the user asks for. No prose, no markdown fences, no preamble.`

const USER_PROMPT = `Watch this clip end-to-end, including audio if present. Return a JSON object with exactly these fields:

{
  "visual": "2-4 sentence rich description of what happens across the shot: subject (who/what, appearance, clothing, notable features), setting (location, environment, time of day, weather, lighting character), action (what the subject is doing across the shot, blocking, gaze), and a note on mood/tone conveyed by the image. Prose, no bullet points.",
  "camera_movement": "One of: 'static', 'handheld', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'push_in', 'pull_out', 'dolly', 'truck', 'crane', 'whip', 'rolling', 'aerial', 'unknown'.",
  "camera_movement_intensity": "One of: 'none', 'subtle', 'moderate', 'aggressive'.",
  "subject_motion": "One of: 'none', 'slow', 'moderate', 'fast', 'explosive'.",
  "subject_motion_direction": "Free text — where the main subject moves within the frame (e.g. 'left-to-right', 'toward camera', 'orbits around axis', 'stationary').",
  "objects": ["list of prominent objects/entities in the shot, concise nouns"],
  "framing": "Shot type. One of: 'ECU', 'Close-up', 'Medium', 'Wide', 'Aerial'.",
  "brand": "One of: 'Logo visible', 'Product visible', 'Text/logo on-screen', 'Driver/face visible', 'None'.",
  "emotion": "One-word emotional register (e.g. triumphant, tense, calm, focused, aggressive, playful, serious, awe, freedom, technical).",
  "movement": "Overall perceived motion level (camera + subject combined). One of: 'High', 'Moderate', 'Slow', 'Static'.",
  "audio": {
    "has_voiceover": true_or_false,
    "voiceover_transcript": "VERBATIM transcript of all spoken voiceover / dialogue in the clip, word-for-word, including pauses indicated by ellipses. If no VO, null.",
    "music": "describe music if any: style/genre, instrumentation, tempo, mood (e.g. 'uplifting orchestral build, strings and soft piano, mid tempo'). Null if none.",
    "sfx": ["list of notable sound effects with short descriptive phrases, e.g. 'whoosh of car passing', 'skateboard wheels on concrete', 'distant crowd cheer'. Empty array if none."],
    "ambient": "short description of ambient sound bed (wind, crowd, room tone, traffic hum, etc.), else null"
  },
  "graphics": {
    "has_text_on_screen": true_or_false,
    "text_content": "VERBATIM text overlayed on screen (titles, captions, subtitles, chyrons, UI text) as it appears, preserving line breaks with \\\\n. Null if no text.",
    "text_role": "One of: 'title', 'tagline', 'caption', 'subtitle', 'lower_third', 'legal_disclaimer', 'url', 'logo_wordmark', 'none'.",
    "has_logo": true_or_false,
    "logo_description": "Describe any logos / brand marks visible: brand name if recognisable, position (e.g. 'bottom-right corner', 'center'), size relative to frame. Null if no logo.",
    "other_graphics": "Any other graphic elements not covered above (animated shapes, lower thirds without text, icons, badges, product shots with overlayed info). Null if none.",
    "bboxes": [
      {
        "box_2d": [ymin, xmin, ymax, xmax],
        "role": "title | tagline | caption | subtitle | lower_third | legal_disclaimer | url | logo_wordmark | logo_symbol | icon | other",
        "label": "Verbatim text inside this box, or a short description for logos/icons. Keep it under 80 chars."
      }
    ],
    "removal_hint": {
      "mask_strategy": "Best single strategy to isolate the graphic pixels for inpainting. One of: 'luma_bright' (white/near-white text or logos against a darker background), 'luma_dark' (black or very dark graphics on a brighter background), 'color' (graphic is a distinctive single color like neon green, red, yellow, etc.), 'mixed' (graphic combines multiple strategies, e.g. a colored logo + white wordmark), 'unsure' (can't tell).",
      "text_color_family": "Dominant color of the graphic. One of: 'white', 'black', 'yellow', 'orange', 'red', 'magenta', 'pink', 'purple', 'blue', 'cyan', 'green', 'gray', 'multi'. Null if no text/logo.",
      "text_is_bright": true_or_false,
      "luma_threshold_hint": "If mask_strategy is 'luma_bright', suggest a grayscale threshold 0-255 where pixels above this value are likely the graphic (typical range 170-230, with 195 being a safe default). If 'luma_dark', suggest a threshold below which pixels are likely the graphic (typical 30-80). Null for color / mixed.",
      "hsv_range_hint": "If mask_strategy is 'color', suggest OpenCV-convention HSV ranges (H: 0-180, S: 0-255, V: 0-255) covering the graphic color: { \\\"lower\\\": [H, S, V], \\\"upper\\\": [H, S, V] }. Null otherwise.",
      "coverage_estimate_pct": "Rough estimate of the % of screen area the graphic covers on average, integer 0-100. Used as a sanity check for the generated mask.",
      "position": "Where the graphic sits in the frame. One of: 'bottom', 'top', 'center', 'lower_third', 'upper_third', 'corner_top_left', 'corner_top_right', 'corner_bottom_left', 'corner_bottom_right', 'full_frame', 'scattered'.",
      "animated": "true if the graphic moves / changes across the shot (scroll, fade, kinetic typography), false if static overlay."
    }
  },
  "cut_type": "Shot boundary character. One of: 'hard_cut', 'match_cut', 'fade', 'dissolve', 'whip_pan', 'motion_blur', 'unknown'.",
  "tempo_cue": "One of: 'slow', 'mid', 'fast', 'frenetic'."
}

Rules:
- If a field can't be determined from the clip, use null (for strings) or an empty array (for lists).
- For 'audio', if there's no audio track at all, set the whole object to null.
- For 'graphics', if the shot has NO text and NO logo and NO overlay graphics, set the whole object to null. Otherwise fill individual sub-fields — don't omit the object just because one sub-field is absent.
- For 'graphics.bboxes':
  - Return ONE entry per distinct on-screen graphic element (each caption line, each logo, each icon) using its TIGHTEST bounding box as seen across the clip.
  - box_2d is [ymin, xmin, ymax, xmax] normalised to 0-1000 on each axis — (0,0) is top-left, (1000,1000) is bottom-right, ymax > ymin, xmax > xmin.
  - Be GENEROUS on box_2d — include a small padding (2-3% of the frame) around each graphic so letter outlines and anti-aliased edges sit inside. Prefer over-cover to missing pixels.
  - Include EVERY graphic visible at any point in the clip, including small legal disclaimers, URLs, tiny chyrons, on-product logos. Do not skip items that feel unimportant.
  - If the same graphic element moves across the shot, return the UNION (the bbox that contains all its positions).
  - If there are no overlayed graphics at all, set bboxes to [].
- Return the JSON object only.`

// Stream-copied sub-clips land next to the project under `.reedit/clips`
// — same convention the EDL → timeline path uses, so ffmpeg's path
// length / permission edge cases get exercised by the same code.
function sceneClipPath(projectDir, scene) {
  const dir = (projectDir || '').replace(/\\/g, '/')
  return `${dir}/.reedit/clips/${scene.id}.mp4`
}

async function ensureSceneClip({ sourceVideoPath, projectDir, scene }) {
  const outputPath = sceneClipPath(projectDir, scene)
  const res = await window.electronAPI?.extractSceneClip?.({
    videoPath: sourceVideoPath,
    tcIn: Number(scene.tcIn) || 0,
    tcOut: Number(scene.tcOut) || (Number(scene.tcIn) + 0.5),
    outputPath,
  })
  if (!res?.success) {
    throw new Error(res?.error || `Could not extract clip for scene ${scene.id}.`)
  }
  return res.path || outputPath
}

async function clipToDataUrl(clipPath) {
  const res = await window.electronAPI?.readFileAsDataUrl?.(clipPath, 'video/mp4')
  if (!res?.success) {
    throw new Error(res?.error || `Could not read clip at ${clipPath}.`)
  }
  return { dataUrl: res.dataUrl, bytes: res.bytes || 0 }
}

function requireGeminiKey() {
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Open Settings → LLM to paste one before running video analysis.')
  }
  return settings
}

/**
 * Analyze a single shot clip. Returns the structured schema above plus
 * `rawText` and `model` for debugging. The `scene` object only needs
 * `{ id, tcIn, tcOut }`; everything else is derived from the project /
 * source video.
 *
 * `modelOverride` lets the caller swap in gemini-2.5-pro for the handful
 * of shots where Flash gets confused (fast cuts, heavy motion blur) —
 * Flash handles ~95% of ad shots at a fraction of the price.
 */
export async function analyzeSceneVideo(scene, {
  sourceVideoPath,
  projectDir,
  modelOverride,
  temperature = 0.2,
  // 3000 tokens is overkill for the JSON payload itself (~400 tokens)
  // but leaves room for Gemini 2.5 Pro when thinking is enabled
  // upstream by accident, and covers clips with long VO transcripts.
  // Raising this doesn't increase cost on empty-response shots; the
  // model only bills for tokens actually produced.
  maxTokens = 3000,
} = {}) {
  if (!scene?.id) throw new Error('analyzeSceneVideo: missing scene.id')
  if (!sourceVideoPath) throw new Error('analyzeSceneVideo: missing sourceVideoPath')
  if (!projectDir) throw new Error('analyzeSceneVideo: missing projectDir')

  const settings = requireGeminiKey()
  const model = modelOverride || settings.geminiModel || 'gemini-2.5-flash'

  const clipPath = await ensureSceneClip({ sourceVideoPath, projectDir, scene })
  const { dataUrl, bytes } = await clipToDataUrl(clipPath)

  // Inline base64 has a hard 20 MB ceiling on the request body. For ad
  // shots (typically <10 s at 1080p H.264) we're nowhere near that, but
  // surface an actionable error rather than letting Gemini reject it
  // with an opaque 400 when someone drags in a 4K master.
  if (bytes && bytes > INLINE_BYTE_LIMIT) {
    throw new Error(
      `Shot ${scene.id} is ${(bytes / 1024 / 1024).toFixed(1)} MB — above the ${(INLINE_BYTE_LIMIT / 1024 / 1024).toFixed(0)} MB inline limit. ` +
      `Re-transcode the source to 1080p/H.264 or wait for the Files API path.`
    )
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: USER_PROMPT },
        { type: 'video_url', video_url: { url: dataUrl } },
      ],
    },
  ]

  const response = await geminiChatCompletion({
    apiKey: settings.geminiApiKey,
    model,
    messages,
    temperature,
    maxTokens,
    responseMimeType: 'application/json',
    thinkingBudget: 0,
  })

  const rawText = response?.choices?.[0]?.message?.content || ''
  // Attach the finish/block reasons to the thrown error so the caller
  // can tell "safety filter" from "MAX_TOKENS cut us off mid-JSON"
  // instead of showing the generic "empty response" everywhere.
  if (!rawText) {
    const reason = response?.blockReason
      ? `prompt blocked (${response.blockReason})`
      : response?.finishReason === 'MAX_TOKENS'
        ? `output truncated at maxTokens=${maxTokens} — raise maxTokens or simplify the prompt`
        : response?.finishReason === 'SAFETY'
          ? 'response filtered for safety'
          : response?.finishReason === 'RECITATION'
            ? 'response suppressed for recitation'
            : response?.finishReason
              ? `finishReason=${response.finishReason}`
              : 'empty candidates array'
    const err = new Error(`Gemini returned no text for scene ${scene.id}: ${reason}.`)
    err.finishReason = response?.finishReason
    err.blockReason = response?.blockReason
    err.safetyRatings = response?.safetyRatings
    throw err
  }
  const parsed = extractJson(rawText) || {}

  return {
    visual: parsed.visual || null,
    camera_movement: parsed.camera_movement || null,
    camera_movement_intensity: parsed.camera_movement_intensity || null,
    subject_motion: parsed.subject_motion || null,
    subject_motion_direction: parsed.subject_motion_direction || null,
    objects: Array.isArray(parsed.objects) ? parsed.objects : [],
    framing: parsed.framing || null,
    brand: parsed.brand || null,
    emotion: parsed.emotion || null,
    movement: parsed.movement || null,
    audio: parsed.audio ?? null,
    // Normalise graphics.bboxes: Gemini may emit it at the top level of
    // graphics or inside removal_hint depending on how it interprets
    // the prompt. We keep it wherever it arrived; the main-process
    // mask picker looks in both spots before falling back to luma/color.
    graphics: parsed.graphics ?? null,
    cut_type: parsed.cut_type || null,
    tempo_cue: parsed.tempo_cue || null,
    clipPath,
    rawText,
    model,
    usage: response?.usage || null,
  }
}

// Paid Gemini tiers give RPM budgets that absorb a burst of 10-30
// sequential requests without backoff, so we don't throttle by default.
// Callers on the free tier (15 RPM on 2.5 Flash) can pass minGapMs=4000
// to space requests apart.
const DEFAULT_MIN_GAP_MS = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sequentially analyze a list of scenes. Matches the shape of
 * reeditCaptioner.captionScenes so the caller can swap it in behind
 * the same progress UI. `onProgress` fires after each scene with
 * { index, total, scene, analyzed, error? }.
 */
export async function analyzeScenesVideo(scenes, {
  sourceVideoPath,
  projectDir,
  modelOverride,
  onProgress,
  signal,
  minGapMs = DEFAULT_MIN_GAP_MS,
} = {}) {
  const results = []
  let lastCallEndedAt = 0
  for (let i = 0; i < scenes.length; i++) {
    if (signal?.aborted) {
      const err = new Error('Video analysis cancelled.')
      err.code = 'aborted'
      throw err
    }
    const scene = scenes[i]
    if (scene?.excluded) {
      results.push(scene)
      onProgress?.({ index: i, total: scenes.length, scene, skipped: true })
      continue
    }

    // Space requests out so a full timeline of 10–30 shots doesn't
    // burn through the 15 RPM window in two seconds and spend the rest
    // of the run in retry backoff. We only wait for the *gap*, not the
    // whole interval, so shots that genuinely take >minGap don't add
    // overhead on top.
    if (minGapMs > 0 && lastCallEndedAt) {
      const elapsed = Date.now() - lastCallEndedAt
      if (elapsed < minGapMs) await sleep(minGapMs - elapsed)
    }

    try {
      const analyzed = await analyzeSceneVideo(scene, { sourceVideoPath, projectDir, modelOverride })
      // Gemini occasionally returns a 200 with an empty candidates
      // array (safety filter tripped, or the model had nothing to
      // say). Surface that as an error rather than silently writing a
      // null-everything row that looks identical to "not run yet".
      if (!analyzed.visual && !analyzed.rawText) {
        const err = new Error('Gemini returned an empty response (likely safety filter or unreadable clip).')
        results.push({ ...scene, videoAnalysisError: err.message })
        onProgress?.({ index: i, total: scenes.length, scene, error: err })
      } else {
        results.push({ ...scene, videoAnalysis: analyzed, caption: analyzed.visual || scene.caption, videoAnalysisError: null })
        onProgress?.({ index: i, total: scenes.length, scene, analyzed })
      }
    } catch (err) {
      // Log with the scene id so the DevTools console is grep-able —
      // matches the warn() in AnalysisView and makes triage on a long
      // run tractable.
      console.warn(`[reedit] video analysis failed for scene ${scene?.id} (${scene?.index})`, err)
      results.push({ ...scene, videoAnalysisError: err?.message || String(err) })
      onProgress?.({ index: i, total: scenes.length, scene, error: err })
    } finally {
      lastCallEndedAt = Date.now()
    }
  }
  return { scenes: results }
}

/**
 * Embed a shot clip with Gemini Embedding 2 (multimodal). Returns
 * { values, model, dims } — drop it into whatever vector store the
 * retrieval layer ends up using. The default dimensionality stays at
 * 3072 (model default); callers can pass 1536 / 768 to save storage
 * at the usual Matryoshka cost.
 */
export async function embedSceneVideo(scene, {
  sourceVideoPath,
  projectDir,
  outputDimensionality,
  taskType = 'RETRIEVAL_DOCUMENT',
} = {}) {
  const settings = requireGeminiKey()
  const model = settings.geminiEmbeddingModel || 'gemini-embedding-2'

  const clipPath = await ensureSceneClip({ sourceVideoPath, projectDir, scene })
  const { dataUrl, bytes } = await clipToDataUrl(clipPath)
  if (bytes && bytes > INLINE_BYTE_LIMIT) {
    throw new Error(
      `Shot ${scene.id} is ${(bytes / 1024 / 1024).toFixed(1)} MB — above the inline embedding limit.`
    )
  }

  const { values } = await geminiEmbedMedia({
    apiKey: settings.geminiApiKey,
    model,
    dataUrl,
    outputDimensionality,
    taskType,
  })

  return {
    sceneId: scene.id,
    values,
    model,
    dims: values.length,
  }
}

/**
 * Convenience for the settings modal / "test connection" button. Tries
 * a cheap text-only generation to confirm the key + model id are good
 * before the user starts an expensive per-shot run.
 */
export async function pingGemini() {
  const settings = requireGeminiKey()
  const res = await geminiChatCompletion({
    apiKey: settings.geminiApiKey,
    model: settings.geminiModel || 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    temperature: 0,
    maxTokens: 8,
  })
  const text = (res?.choices?.[0]?.message?.content || '').trim()
  return { ok: /ok/i.test(text), raw: text, backend: LLM_BACKENDS.GEMINI }
}
