// Shared helpers for model adapters: seed hygiene, prompt formatting,
// aspect bucketing. Moved verbatim from electron/main.js when the fill
// builders became adapters.

// Sanitise + bound a seed so every model gets a positive int32 value.
// Each provider has slightly different limits but int32 max is the
// strictest among them.
function safeSeed(seed) {
  const INT32_MAX = 2147483647
  return Number.isFinite(seed)
    ? Math.abs(Math.floor(Number(seed))) % (INT32_MAX + 1)
    : Math.floor(Math.random() * INT32_MAX)
}

// Strip trailing punctuation so prepended / appended clauses chain
// cleanly without ugly ". ." sequences.
function trimEnd(s) { return String(s || '').trim().replace(/[.;,]\s*$/, '') }

// Hard-cap a prompt to N words. Some providers (Seedance) explicitly
// recommend ≤150; we keep 180 for safety margin without truncating
// notes the proposer wrote tightly.
function capWords(s, max = 180) {
  const words = String(s || '').trim().split(/\s+/)
  if (words.length <= max) return words.join(' ')
  return words.slice(0, max).join(' ') + '…'
}

// Pick the canonical aspect bucket the provider accepts. Most i2v
// providers reject anything that isn't 16:9 / 9:16 / 1:1.
function aspectBucket(aspectRatio) {
  const ASPECT_BUCKETS = new Set(['16:9', '9:16', '1:1'])
  return ASPECT_BUCKETS.has(String(aspectRatio)) ? String(aspectRatio) : '16:9'
}

// Per-model prompt formatters. The proposer writes one generic
// "director's shot instruction" per placeholder; each i2v provider
// has its own structural preferences we tune the prompt to here so
// the same note lands well on every backend. The formatters never
// hallucinate content — they only re-order, clip, and prepend/append
// boilerplate that the model's official prompting guide recommends.

// Kling 3 Omni — scene → character → action → camera → progression.
// The proposer notes are already short cinematic shot instructions so
// we just append a continuity cue + cap to 4-ish sentences.
function formatPromptForKling(note) {
  const body = trimEnd(note) || 'A subtle moment of atmosphere consistent with the reference image'
  return capWords(
    `${body}. Match the lighting, palette, and tone of the reference image. Smooth, deliberate camera motion. Photoreal, cinematic.`,
    180,
  )
}

// Grok Imagine — natural sentences, 1 subject + 1 action + 1 camera
// move + emotion tag. Strip a second camera move if the proposer
// stacked two ("dolly + push" → keep "dolly"), and append an emotion
// keyword if the note has none.
function formatPromptForGrok(note) {
  let body = trimEnd(note) || 'A quiet moment of atmosphere consistent with the reference image'
  const CAMERA_VERBS = /\b(pan|tilt|dolly|track|push\s+in|pull\s+out|crane|orbit|zoom|tracking shot|aerial|whip\s+pan|handheld)\b/gi
  const verbs = body.match(CAMERA_VERBS) || []
  if (verbs.length > 1) {
    const seen = new Set()
    body = body.replace(CAMERA_VERBS, (match) => {
      const key = match.toLowerCase()
      if (seen.has(key)) return ''
      if (seen.size >= 1) return ''
      seen.add(key)
      return match
    })
  }
  const hasMood = /\b(nostalgic|melancholic|electric|tense|dreamlike|serene|cinematic|atmospheric|moody|peaceful|romantic|warm|cool|epic|tranquil)\b/i.test(body)
  const mood = hasMood ? '' : ', atmospheric and cinematic'
  return capWords(`${body}${mood}.`, 120)
}

// Seedance 2.0 — i2v omits subject re-description. Prepend the
// preservation clause + animation instruction, keep ONE camera move,
// 60-100 words target.
function formatPromptForSeedance(note) {
  const body = trimEnd(note) || 'Subtle motion consistent with the reference image'
  return capWords(
    `Animate the provided image. Preserve composition, color palette, and lighting from the reference. ${body}. Single, smooth camera move. Photoreal, natural motion, no flicker.`,
    120,
  )
}

// Vidu — provider's guide is sparse; treat as generic prompt
// passthrough with a light cinematic suffix that matches their demo
// captions.
function formatPromptForVidu(note) {
  const body = trimEnd(note) || 'Subtle motion consistent with the reference image'
  return capWords(`${body}. Photoreal, cinematic, natural motion.`, 150)
}

module.exports = {
  safeSeed,
  trimEnd,
  capWords,
  aspectBucket,
  formatPromptForKling,
  formatPromptForGrok,
  formatPromptForSeedance,
  formatPromptForVidu,
}
