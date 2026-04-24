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
 * - footageUpscale: allow using shots whose native resolution is
 *   below the delivery target (they'll be upscaled post-proposal).
 * - reframe: allow using shots outside the target aspect ratio
 *   (they'll be reframed post-proposal).
 *
 * Defaults: all false. The default re-edit is brand-safe — the LLM
 * can only reorder / trim the shot log without introducing any
 * post-production steps that might change brand-approved footage.
 */

const STORAGE_KEY = 'reedit.proposal.capabilities.v1'

export const DEFAULT_CAPABILITIES = Object.freeze({
  footageGeneration: false,
  footageExtend: false,
  footageUpscale: false,
  reframe: false,
  useOriginalMusic: false,
  useOriginalVoiceover: false,
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
    id: 'footageUpscale',
    label: 'Footage upscale',
    blurb: 'Allows using shots whose native resolution is below the delivery target (upscaled post-proposal).',
  },
  {
    id: 'reframe',
    label: 'Reframe',
    blurb: 'Allows using shots outside the target aspect ratio (reframed post-proposal).',
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
]

export function loadCapabilities() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CAPABILITIES }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CAPABILITIES }
    const parsed = JSON.parse(raw)
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
