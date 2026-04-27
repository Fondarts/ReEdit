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

export const UPSCALE_MODEL_OPTIONS = [
  { id: '4x_NMKD-Siax_200k.pth', label: '4x NMKD-Siax 200k (default — sharper, real footage)' },
  { id: 'RealESRGAN_x4plus.pth', label: 'RealESRGAN x4+ (softer, safer)' },
  { id: 'RealESRGAN_x4plus_anime_6B.pth', label: 'RealESRGAN x4+ Anime (for cartoons)' },
]

export const DEFAULT_CAPABILITY_SETTINGS = Object.freeze({
  footageGeneration: {
    model: 'ltx-2.3',
    // Max seconds of generated footage per placeholder shot. LTX 2.3
    // sweet-spot is 2-4 s; longer durations tend to drift.
    maxDurationSec: 4,
    // Content filters — let the proposer know what kinds of fills it
    // may request. A "no faces" setting biases the prompt away from
    // identifiable people (useful for brands that don't have model
    // releases for AI-generated actors).
    allowProducts: true,
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
    upscaleModel: '4x_NMKD-Siax_200k.pth',
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
