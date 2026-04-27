/**
 * Proposal capabilities — user-controlled flags that gate what the
 * LLM is allowed to propose when generating the re-edit EDL.
 *
 * Each flag represents a post-production operation the team may or
 * may not want this ad to use. Stored globally in localStorage (one
 * set of flags applies to every project) per the user's pick in the
 * initial design conversation — we can switch to per-project later
 * if brand-specific rules start mattering.
 *
 * Flags:
 * - footageGeneration: allow placeholder rows (AI-generated fill
 *   shots). When off, the LLM must only reorder / trim existing shots.
 * - footageExtend: allow annotating shots as "needs N seconds of
 *   extension" via AI. Note-level only today — no EDL kind change.
 * - footageReframe: allow zoom/pan re-framing within the same aspect
 *   ratio. Timeline previews the crop instantly via transforms; the
 *   user can then Commit reframe which sends the shot to ComfyUI for
 *   a final upscale+crop pass that becomes a new version in the stack.
 * - useOriginalMusic / useOriginalVoiceover: let the proposer layer
 *   the separated stems across the re-edit decoupled from their
 *   source shot.
 *
 * Defaults: all false. The default re-edit is brand-safe — the LLM
 * can only reorder / trim the shot log without introducing any
 * post-production steps that might change brand-approved footage.
 */

const STORAGE_KEY = 'reedit.proposal.capabilities.v1'

export const DEFAULT_CAPABILITIES = Object.freeze({
  footageGeneration: false,
  footageExtend: false,
  footageReframe: false,
  colorCorrection: false,
  useOriginalMusic: false,
  useOriginalVoiceover: false,
  generateVoiceover: false,
})

export const CAPABILITY_DEFINITIONS = [
  {
    id: 'footageGeneration',
    label: 'Footage generation',
    blurb: 'Lets the proposer add AI-generated placeholder shots to fill structural gaps.',
  },
  {
    id: 'footageExtend',
    label: 'Footage extend',
    blurb: 'Lets the proposer flag shots that should be extended by N seconds via AI.',
  },
  {
    id: 'footageReframe',
    label: 'Footage reframe',
    blurb: 'Lets the proposer mark shots for zoom/pan re-framing within the same aspect. Timeline previews the crop instantly via transforms; a Commit button upscales with ComfyUI for final delivery quality.',
  },
  {
    id: 'colorCorrection',
    label: 'Color correction',
    blurb: 'Lets the proposer annotate shots with color adjustments (exposure, contrast, saturation, gain, gamma, offset, hue). Applied directly to the timeline clip via the native Color controls — no baking required.',
  },
  {
    id: 'useOriginalMusic',
    label: 'Use original music',
    blurb: 'Lets the proposer layer the isolated music stem (Demucs output) under any shot — including placeholders or shots that didn’t have music originally.',
  },
  {
    id: 'useOriginalVoiceover',
    label: 'Use original voiceover',
    blurb: 'Lets the proposer reuse the isolated VO stem on any shot, decoupled from where it appeared in the source.',
  },
  {
    id: 'generateVoiceover',
    label: 'Generate new voiceover',
    blurb: 'Have Gemini write a fresh VO script (in any supported language) using the ad concept, mood, and brand role as inspiration. Synthesised by ComfyUI (F5-TTS) cloning the original speaker’s voice. Replaces the original VO when enabled — mutually exclusive with “Use original voiceover”.',
  },
]

export function loadCapabilities() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CAPABILITIES }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CAPABILITIES }
    const parsed = JSON.parse(raw) || {}
    // Migration: the old builds stored `footageUpscale` and `reframe`
    // as two separate flags. Either one should promote to the new
    // unified `footageReframe` so users don't lose intent across the
    // upgrade. The legacy keys are stripped on next save.
    if ((parsed.footageUpscale || parsed.reframe) && parsed.footageReframe == null) {
      parsed.footageReframe = true
    }
    delete parsed.footageUpscale
    delete parsed.reframe
    // Merge over defaults so a stored shape missing a flag (from an
    // older build) still returns a complete object.
    return { ...DEFAULT_CAPABILITIES, ...parsed }
  } catch {
    return { ...DEFAULT_CAPABILITIES }
  }
}

export function saveCapabilities(patch) {
  if (typeof localStorage === 'undefined') return loadCapabilities()
  const current = loadCapabilities()
  const next = { ...current, ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // Broadcast so other views (ProposalView instances on a multi-pane
    // layout, debug overlays) pick the change up without reloading.
    window.dispatchEvent(new CustomEvent('reedit-proposal-capabilities-changed', { detail: next }))
  } catch { /* quota errors are non-fatal */ }
  return next
}
