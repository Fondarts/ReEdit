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
import { loadLlmSettings, LLM_BACKENDS, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'

const SYSTEM_PROMPT = `You are a senior cinematographer analyzing one short video clip for an ad re-edit pipeline. You return ONLY a JSON object with the fields the user asks for, using precise filmmaking vocabulary throughout. No prose, no markdown fences, no preamble.

GROUNDING: Describe what you SEE, not what you assume. Use the structured cinematography vocabulary below to avoid generic captions. When in doubt about a specific term, prefer 'unknown' over guessing — false precision misleads downstream models.`

const USER_PROMPT = `Watch this clip end-to-end, including audio if present. Return a JSON object with exactly these fields:

{
  "visual": "2-4 sentence rich description USING CINEMATIC VOCABULARY: subject (who/what, appearance, clothing, notable features), setting (location, environment, time of day, weather, light quality), action (what the subject is doing — blocking, gaze, gestures), and the lensing/camera read (e.g. 'shallow-DOF medium close-up with a slow push-in', 'locked-off wide with deep focus', 'handheld over-the-shoulder with rack focus to the dashboard'). Use professional terms when applicable: push-in, pull-out, dolly, truck, crane, jib, whip pan, rack focus, dolly zoom, golden hour, blue hour, motivated key light, silhouette, backlit, etc. Prose, no bullet points.",
  "cinematography": {
    "shot_size": "One of: 'extreme_close_up' (single feature like an eye), 'close_up' (head-and-shoulders), 'medium_close_up' (chest up), 'medium' (waist up), 'medium_long' (knees up), 'long' (full body in environment), 'extreme_long' (figure tiny in landscape), 'insert' (object detail), 'two_shot' (two subjects), 'group' (3+ subjects), 'establishing' (place-setting wide), 'unknown'.",
    "camera_angle": "One of: 'eye_level', 'high_angle', 'low_angle', 'dutch_angle' (canted/tilted horizon), 'overhead' (top-down), 'worms_eye' (extreme low looking up), 'unknown'.",
    "camera_movement_quality": "How the camera moves PHYSICALLY. One of: 'locked_off' (tripod, static), 'handheld' (organic shake), 'steadicam' (smooth float), 'gimbal' (mechanical smooth), 'dolly_track' (smooth on rails/wheels), 'crane_jib' (vertical/arc moves), 'aerial_drone', 'vehicle_mount', 'shoulder_rig', 'unknown'.",
    "lens_characteristic": "One of: 'wide' (24mm-equivalent or wider, environmental), 'normal' (35-50mm-equivalent, neutral), 'telephoto' (85mm+ equivalent, compressed perspective), 'macro' (extreme close detail), 'fisheye' (extreme distortion), 'unknown'.",
    "depth_of_field": "One of: 'shallow' (subject sharp, background blurred — bokeh), 'medium' (most of frame in acceptable focus), 'deep' (foreground to background all sharp), 'unknown'.",
    "focus_dynamics": "One of: 'locked' (focus stays on one plane), 'rack_focus' (deliberate shift between two focal planes), 'focus_pull' (continuous follow-focus on a moving subject), 'breathing' (visible focus hunt), 'soft_throughout', 'unknown'.",
    "composition": "Primary compositional read. One of: 'centered' (subject dead-center), 'rule_of_thirds', 'symmetrical', 'leading_lines', 'frame_within_frame', 'diagonal', 'foreground_layered' (clear FG/MG/BG depth), 'negative_space', 'unknown'.",
    "lighting_style": "One of: 'high_key' (bright, low contrast, ad-typical product), 'low_key' (dark, high contrast, dramatic shadows), 'three_point' (classic key+fill+rim), 'natural_daylight', 'golden_hour' (warm, low-angle sun), 'blue_hour' (cool dusk/dawn), 'overcast' (soft, even, no shadows), 'practical' (lit by visible lamps in scene), 'silhouette', 'backlit' (rim-lit subject), 'mixed_color' (multi-color gel/neon), 'unknown'.",
    "color_palette": "Short comma-separated list of the 2-4 dominant colors / palette descriptors (e.g. 'warm amber, deep teal, cream highlights' or 'desaturated steel, charcoal, single pop of red').",
    "special_techniques": ["zero or more from: 'dolly_zoom' (vertigo / Hitchcock zoom), 'whip_pan' (ultra-fast pan as a transition), 'snap_zoom' (instant zoom), 'speed_ramp', 'slow_motion', 'time_lapse', 'freeze_frame', 'split_screen', 'in_camera_transition', 'match_cut_potential' (this shot pairs naturally with another via shape/motion), 'one_take_oner' (long unbroken move), 'reverse_motion'. Empty array if none apply."]
  },
  "camera_movement": "One of: 'static', 'handheld', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'push_in', 'pull_out', 'dolly_in', 'dolly_out', 'dolly_left', 'dolly_right', 'truck_left', 'truck_right', 'pedestal_up', 'pedestal_down', 'crane', 'jib', 'arc_left', 'arc_right', 'orbit', 'whip', 'rolling', 'aerial', 'vehicle_tracking', 'unknown'.",
  "camera_movement_intensity": "One of: 'none', 'subtle', 'moderate', 'aggressive'.",
  "subject_motion": "One of: 'none', 'slow', 'moderate', 'fast', 'explosive'.",
  "subject_motion_direction": "Free text — where the main subject moves within the frame (e.g. 'left-to-right', 'toward camera', 'orbits around axis', 'stationary').",
  "objects": ["list of prominent objects/entities in the shot, concise nouns"],
  "framing": "LEGACY shot type — keep filling for backward compat. One of: 'ECU', 'Close-up', 'Medium', 'Wide', 'Aerial'. Use the new cinematography.shot_size for granular value.",
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
  "subject_bbox": {
    "box_2d": [ymin, xmin, ymax, xmax],
    "label": "Short description of the SINGLE hero element in the frame — whatever the shot is ABOUT. TIGHT bbox (2-3 % padding), normalised 0-1000. Bboxes larger than ~0.3×0.3 are almost certainly too loose — you've boxed the parent object, not the subject. Examples: driver's face (NOT the driver's whole body), a hand gripping a wheel (NOT the whole driver), a product held up to camera (NOT the whole counter). If a literal brand mark is visible, use brand_mark_bbox below — DO NOT duplicate that element here; pick a different focal subject (the car body, the driver, the product silhouette)."
  },
  "brand_mark_bbox": {
    "box_2d": [ymin, xmin, ymax, xmax],
    "label": "The LITERAL brand logo / badge / wordmark visible in the frame. Populate this ONLY when a true brand mark is visible — not design signatures. Examples of LITERAL brand marks: the round BMW roundel (blue/white quadrants), the Nike swoosh, the Coca-Cola script wordmark, the Apple logo, a stitched brand tag, an embossed badge. Design signatures that are NOT brand marks: BMW kidney grilles, Porsche body curves, a particular shoe silhouette — those are brand-associated but aren't the logo. If no literal brand mark is visible in the frame, return null. Bbox must be TIGHT (2-3 % padding around the logo only, NOT the object carrying the logo). Coordinates normalised 0-1000."
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
- For 'subject_bbox': REQUIRED for every shot. Keep the bbox TIGHT (< 0.3 on each axis unless truly unavoidable). A loose bbox defeats the purpose — the downstream re-editor uses the centre as a zoom-in anchor, so it must land on a specific element. Never return null.
- For 'brand_mark_bbox': OPTIONAL. Populate ONLY when a literal brand mark (logo, badge, wordmark) is visible and clearly identifiable in the frame. A kidney grille is NOT a brand mark — it's a design signature. Return null when no literal brand mark is visible. This field feeds brand-focused reframes downstream; a false positive (labelling a design element as a logo) causes worse reframes than returning null.
- For 'audio', if there's no audio track at all, set the whole object to null.
- For 'graphics', if the shot has NO text and NO logo and NO overlay graphics, set the whole object to null. Otherwise fill individual sub-fields — don't omit the object just because one sub-field is absent.
- For 'graphics.bboxes':
  - Return ONE entry per distinct on-screen graphic element (each caption line, each logo, each icon) using its TIGHTEST bounding box as seen across the clip.
  - box_2d is [ymin, xmin, ymax, xmax] normalised to 0-1000 on each axis — (0,0) is top-left, (1000,1000) is bottom-right, ymax > ymin, xmax > xmin.
  - Be GENEROUS on box_2d — include a small padding (2-3% of the frame) around each graphic so letter outlines and anti-aliased edges sit inside. Prefer over-cover to missing pixels.
  - Include EVERY graphic visible at any point in the clip: overlayed graphics (titles, captions, legal disclaimers, URLs, chyrons, icons) AND **PHYSICAL BRAND MARKS** that are part of the filmed subject (a car badge on a grille, a logo stitched on clothing, a label on a product bottle, a manufacturer mark on a watch face). The physical ones matter because a downstream re-editor wants to know WHERE the brand lives in the frame even if it\'s not an overlay — use role \`logo_symbol\` or \`logo_wordmark\` for these, the same as for overlays.
  - If the same graphic element moves across the shot, return the UNION (the bbox that contains all its positions).
  - If there are no overlayed graphics AND no physical brand marks at all, set bboxes to [].
- Return the JSON object only.`

// Stream-copied sub-clips land next to the project under `.reedit/clips`
// — same convention the EDL → timeline path uses, so ffmpeg's path
// length / permission edge cases get exercised by the same code.
export function sceneOriginalClipPath(projectDir, scene) {
  const dir = (projectDir || '').replace(/\\/g, '/')
  return `${dir}/.reedit/clips/${scene.id}.mp4`
}

// The "active" clip for a scene is either (a) the optimized output the
// user selected via the version dropdown, or (b) the original sub-clip
// extracted from the source video. Every consumer that loads a scene
// clip (hover preview, re-caption pass, Apply-to-timeline) must resolve
// through here so switching the active version in one place swaps it
// everywhere else in the same render.
export function resolveActiveClipPath(scene, projectDir) {
  const version = scene?.activeOptimizationVersion
  if (version && Array.isArray(scene?.optimizations)) {
    const entry = scene.optimizations.find((o) => o?.version === version)
    if (entry?.path) return entry.path
  }
  return sceneOriginalClipPath(projectDir, scene)
}

// Legacy alias kept so internal callers don't need to change mid-refactor.
function sceneClipPath(projectDir, scene) {
  return sceneOriginalClipPath(projectDir, scene)
}

async function ensureSceneClip({ sourceVideoPath, projectDir, scene }) {
  // If an optimized version is active, skip the ffmpeg re-encode and
  // just verify the finished file exists. Optimized clips ARE already
  // frame-accurate MP4s at the native resolution, so we can use them
  // as-is for analysis, hover preview, and timeline registration.
  const activePath = resolveActiveClipPath(scene, projectDir)
  const originalPath = sceneOriginalClipPath(projectDir, scene)
  if (activePath !== originalPath) {
    try {
      const existsRes = await window.electronAPI?.exists?.(activePath)
      if (existsRes) return activePath
    } catch (_) { /* fall through to original */ }
    // Optimized file vanished (deleted externally, project moved, etc).
    // Fall through to the original-extract path below — the UI can
    // still show data, and the user can re-run optimize if they want
    // the clean version back.
  }

  const outputPath = originalPath
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
  const model = modelOverride || resolveGeminiModelForTask(settings, LLM_TASKS.ANALYSIS)

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
    // Structured cinematography read (CHAI-inspired — shot size,
    // angle, lensing, focus dynamics, lighting style, special
    // techniques). Surfaced in the proposer's shot log and used as
    // structured context when building Commit extend prompts. The
    // legacy fields below stay populated for backward compat with
    // older analyses.
    cinematography: parsed.cinematography ?? null,
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
    // Hero subject bbox for downstream reframe decisions. REQUIRED per
    // the prompt, but we tolerate null here in case an older analysis
    // pass (pre-schema-update) is still in the project file.
    subject_bbox: parsed.subject_bbox ?? null,
    // Tight bbox around a literal brand mark (logo / badge / wordmark)
    // when visible. Null when no literal brand mark appears — the
    // kidney grille or other brand-associated design elements do NOT
    // count. Used by the proposer to land "establish brand" reframes
    // on the actual logo rather than on the parent object.
    brand_mark_bbox: parsed.brand_mark_bbox ?? null,
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

// High-level "what's this ad about" prompt. Deliberately biased toward
// advertising lenses (concept, message, target, brand role) so the
// output is useful as a sanity check — does the model actually
// understand what the ad is trying to say? If the concept it describes
// back sounds wrong, the downstream per-shot captions and the proposer
// prompt are almost certainly going to be off too.
const OVERALL_SYSTEM_PROMPT = `You are a senior creative strategist reviewing an advertisement end-to-end. You return ONLY a JSON object — no prose, no markdown fences, no preamble.`

const OVERALL_USER_PROMPT = `Watch this ad in full, including audio. Return a JSON object with exactly these fields:

{
  "concept": "1-2 sentences describing the creative concept / central idea driving the ad (e.g. 'a road-trip montage that frames the product as the companion for small adventures').",
  "message": "1 sentence capturing the single takeaway the viewer should walk away with.",
  "mood": "3-6 words summarising the emotional register (e.g. 'warm, nostalgic, quietly aspirational').",
  "target_audience": "1 sentence describing who this is speaking to (demographic + psychographic, no numbers).",
  "brand_role": "1 sentence on how the brand / product appears in the ad (explicit hero, background enabler, punchline, etc).",
  "narrative_arc": "1-2 sentences summarising the beat structure (setup → turn → payoff), in the ad's own logic — not a shot list.",
  "voiceover_segments": [
    {
      "text": "VERBATIM transcription of this segment, word-for-word. Preserve punctuation as spoken (commas, question marks, ellipses for pauses within the segment).",
      "startSec": 0.0,
      "endSec": 0.0,
      "role": "line | question | tagline | legal | other — 'line' is the normal default, 'tagline' is the ad's closing signature, 'legal' is fast-spoken disclaimers (\\\"when-used-as-directed\\\" etc.)."
    }
  ]
}

Rules:
- Write the prose fields in natural English; no bullet points inside string fields.
- If you truly cannot determine a prose field from what you saw, use null.
- For 'voiceover_segments': return EVERY VO segment in the ad, in the order they are spoken. A SEGMENT is one complete sentence or phrase that reads naturally on its own — roughly what a person would read before taking a breath. Do NOT split mid-sentence; do NOT merge two sentences into one segment. A 30 s ad typically has 3-7 segments. Include startSec / endSec timestamps in seconds from the start of the source video, rounded to 0.1 s. If the ad has no VO at all, return an empty array []. Never null the field.
- Return the JSON object only.`

/**
 * Overall-ad analysis. Sends the entire source video to Gemini and
 * asks for a high-level read: concept, message, mood, target, brand
 * role, narrative arc. Used by AnalysisView as a sanity check — if the
 * concept description comes back wrong, the per-shot captions that
 * feed the proposer are likely wrong too.
 *
 * Inline byte limit applies (same 20 MB as per-shot analysis). For a
 * typical 15-60 s H.264 1080p ad this is safely under the limit; longer
 * or higher-bitrate sources will surface an actionable error instead
 * of a mysterious 400.
 */
export async function analyzeOverallVideo({
  sourceVideoPath,
  modelOverride,
  temperature = 0.3,
  maxTokens = 2000,
} = {}) {
  if (!sourceVideoPath) throw new Error('analyzeOverallVideo: missing sourceVideoPath')
  const settings = requireGeminiKey()
  const model = modelOverride || resolveGeminiModelForTask(settings, LLM_TASKS.ANALYSIS)

  const res = await window.electronAPI?.readFileAsDataUrl?.(sourceVideoPath, 'video/mp4')
  if (!res?.success) {
    throw new Error(res?.error || `Could not read source video at ${sourceVideoPath}.`)
  }
  const bytes = res.bytes || 0
  if (bytes > INLINE_BYTE_LIMIT) {
    throw new Error(
      `Source video is ${(bytes / 1024 / 1024).toFixed(1)} MB — above the ${(INLINE_BYTE_LIMIT / 1024 / 1024).toFixed(0)} MB inline limit. ` +
      `Re-transcode to 1080p/H.264 at a lower bitrate (CRF 22-24) before running overall analysis, ` +
      `or wait for the Files API path.`
    )
  }

  const messages = [
    { role: 'system', content: OVERALL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: OVERALL_USER_PROMPT },
        { type: 'video_url', video_url: { url: res.dataUrl } },
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
  if (!rawText) {
    const reason = response?.blockReason
      ? `prompt blocked (${response.blockReason})`
      : response?.finishReason === 'MAX_TOKENS'
        ? `output truncated at maxTokens=${maxTokens}`
        : response?.finishReason || 'empty response'
    throw new Error(`Gemini returned no text for overall analysis: ${reason}.`)
  }
  const parsed = extractJson(rawText) || {}
  // Normalise voiceover_segments into a stable shape + filter bogus
  // entries (missing timestamps, zero-length, malformed). Downstream
  // code indexes into this array so we want a clean, predictable
  // structure even when Gemini returns something weird.
  const rawSegs = Array.isArray(parsed.voiceover_segments) ? parsed.voiceover_segments : []
  const voiceoverSegments = rawSegs
    .map((s, idx) => ({
      id: `vo-${idx}`,
      text: String(s?.text || '').trim(),
      startSec: Number(s?.startSec),
      endSec: Number(s?.endSec),
      role: s?.role || 'line',
    }))
    .filter((s) => s.text && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
  return {
    concept: parsed.concept || null,
    message: parsed.message || null,
    mood: parsed.mood || null,
    target_audience: parsed.target_audience || null,
    brand_role: parsed.brand_role || null,
    narrative_arc: parsed.narrative_arc || null,
    voiceover_segments: voiceoverSegments,
    rawText,
    model,
    usage: response?.usage || null,
  }
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
