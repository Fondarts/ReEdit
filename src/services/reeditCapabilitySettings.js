/**
 * Settings for each capability (footage generation, extend, reframe,
 * music, VO). These are the KNOBS that live behind the Capabilities
 * toggles in `reeditProposalCapabilities.js`: the toggles say "is this
 * tool available to the proposer?", the settings here say "when it
 * IS available, how does it behave?".
 *
 * Persisted globally in localStorage (one set of knobs applies to
 * every project) — same pattern as proposal capabilities + LLM
 * settings. Consumers read via `loadCapabilitySettings()`; the
 * Settings UI writes via `saveCapabilitySettings(patch)`.
 */

const STORAGE_KEY = 'reedit.capability.settings.v1'

// Model options per capability. Labels are shown in the Settings UI;
// ids are the values stored in localStorage and passed to downstream
// workflows. Adding a new model means appending an entry here + wiring
// the id in the relevant service (reeditGenerate.js, main.js, etc).
export const I2V_MODEL_OPTIONS = [
  { id: 'ltx-2.3', label: 'LTX 2.3 (default — ~4 GB VRAM, fast)' },
  { id: 'wan-2.2-14b', label: 'WAN 2.2 14B (higher quality, ~24 GB VRAM)' },
  { id: 'wan-2.2-svi', label: 'WAN 2.2 14B SVI Pro (extend-aware, video-context)' },
]

// Extend-capable models. Local last-frame i2v drifts past ~2 s, so those
// cap at 2.0; cloud video-context extension (Vidu sees the whole clip's
// motion) holds up to ~5 s. The ceiling is enforced three times: in the
// proposer prompt, in the UI slider, and as a clamp in main.js.
export const EXTEND_MODEL_OPTIONS = [
  { id: 'ltx-2.3', label: 'LTX 2.3 (local, last-frame)', maxExtendSec: 2.0 },
  { id: 'wan-2.2-14b', label: 'WAN 2.2 14B (local, last-frame)', maxExtendSec: 2.0 },
  { id: 'wan-2.2-svi', label: 'WAN 2.2 SVI Pro (local, video-context)', maxExtendSec: 2.0 },
  { id: 'viduq2-pro-extend', label: 'Vidu Q2 Extend (cloud, video-context)', maxExtendSec: 5.0 },
]

export function maxExtendSecForModel(modelId) {
  const opt = EXTEND_MODEL_OPTIONS.find((o) => o.id === modelId)
  return opt?.maxExtendSec ?? 2.0
}

// Outpaint engines for the reframe capability. Crop-reframe can only
// remove pixels; outpaint fills NEW canvas so 9:16 footage becomes true
// 16:9. Luma runs on Comfy Cloud (≤30 s source, 1080p out); the LTX
// IC-LoRA path runs on local ComfyUI using the bundled workflow.
export const OUTPAINT_MODEL_OPTIONS = [
  { id: 'luma-ray-3.2-reframe', label: 'Luma Ray 3.2 Reframe (cloud — one shot, 1080p)' },
  { id: 'ltx-ic-local', label: 'LTX 2.3 IC-LoRA Outpaint (local — needs outpaint LoRA)' },
]

export const UPSCALE_MODEL_OPTIONS = [
  { id: 'RealESRGAN_x4plus.pth', label: 'RealESRGAN x4+ (default — works on Cloud + Local)' },
  { id: '4x_NMKD-Siax_200k.pth', label: '4x NMKD-Siax 200k (sharper, local only)' },
  { id: 'RealESRGAN_x4plus_anime_6B.pth', label: 'RealESRGAN x4+ Anime (for cartoons)' },
]

export const DEFAULT_CAPABILITY_SETTINGS = Object.freeze({
  footageGeneration: {
    // Default engine is now Kling (Comfy Cloud image-to-video with
    // reference-image support). LTX 2.3 is still available as a fallback
    // for users on local Comfy who don't want to pay per-fill.
    model: 'kling-i2v',
    // Max seconds of generated footage per placeholder shot. The LLM
    // is told to pick what feels natural for each beat (typically
    // 1.0–2.5 s for ad-style intercuts); this is the hard ceiling
    // applied both in the proposer prompt and as a clamp inside the
    // generator. Push beyond 3 s only when you really need a held
    // beat — i2v models drift past that range.
    maxDurationSec: 3,
    // Content filters. Defaults match the brief: no product shots
    // (avoid generating mis-rendered logos / packaging), keep faces +
    // text off too since those are the standard image-gen failure
    // modes. Users can flip any of these in Settings → Capabilities.
    allowProducts: false,
    allowFaces: true,
    allowText: false,
  },
  footageExtend: {
    model: 'ltx-2.3',
    // The proposer's EXTEND parser clamps to this. Users who want more
    // aggressive extensions raise it here; 2.0 s is the tested sweet
    // spot for LTX without visible drift.
    maxExtendSec: 2.0,
  },
  footageReframe: {
    // Max zoom factor as a percentage (130 = 1.30x). The proposer's
    // REFRAME parser clamps zoom to this value so a stray zoom=2.5
    // doesn't blow up the crop. 130 % is the conservative default —
    // most ad reframes land in the 110-140 range.
    maxScalePct: 130,
    // Upscale model used by Commit reframe (the ComfyUI pass that
    // bakes the zoom+crop into a full-resolution MP4). Stored here so
    // main.js can read it per-run instead of hard-coding.
    upscaleModel: 'RealESRGAN_x4plus.pth',
    // 'crop' zooms/crops inside the existing frame (default, free);
    // 'outpaint' generates new canvas to reach a different aspect.
    mode: 'crop',
    outpaintModel: 'luma-ray-3.2-reframe',
    outpaintTargetAspect: '16:9',
  },
  // Music + VO knobs are stubbed for now — UI shows "coming soon"
  // so the section layout stays stable as we flesh them out.
  music: {},
  voiceover: {},
})

function deepMergeSettings(base, patch) {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = { ...(base[key] || {}), ...value }
    } else {
      result[key] = value
    }
  }
  return result
}

export function loadCapabilitySettings() {
  if (typeof localStorage === 'undefined') return deepMergeSettings(DEFAULT_CAPABILITY_SETTINGS, {})
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return deepMergeSettings(DEFAULT_CAPABILITY_SETTINGS, {})
    const parsed = JSON.parse(raw) || {}
    return deepMergeSettings(DEFAULT_CAPABILITY_SETTINGS, parsed)
  } catch {
    return deepMergeSettings(DEFAULT_CAPABILITY_SETTINGS, {})
  }
}

export function saveCapabilitySettings(patch) {
  if (typeof localStorage === 'undefined') return loadCapabilitySettings()
  const current = loadCapabilitySettings()
  const next = deepMergeSettings(current, patch)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('reedit-capability-settings-changed', { detail: next }))
  } catch { /* quota errors non-fatal */ }
  return next
}
