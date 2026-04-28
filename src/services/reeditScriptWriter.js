/**
 * project:re-edit — Voiceover script writer.
 *
 * Standalone Gemini call that drafts a NEW voiceover script when the
 * `generateVoiceover` capability is on. Decoupled from the proposer:
 * the user generates one or more drafts, edits them inline, picks a
 * favourite, and only THEN runs the proposal — the chosen draft's
 * segments become the VO source the proposer plans around (instead
 * of the source ad's voiceover stem).
 *
 * Inputs we feed Gemini:
 *   - The overall ad analysis (concept / message / mood / target /
 *     brand role / narrative arc) so the new script is on-brand.
 *   - The original VO transcript as a tonal reference — NOT to copy,
 *     but so the model picks up cadence, formality, sentence length.
 *   - The target re-edit duration (drives total word budget — we use
 *     ~2.4 words/sec as a conservative spoken-word rate).
 *   - The output language (default English; Spanish, French, etc. all
 *     supported by F5-TTS once we wire synthesis).
 *
 * Output: an array of `{ text, role, gapBeforeSec }` segments matching
 * the same schema the original VO uses, so downstream timeline placer
 * code is unchanged.
 */

import { geminiChatCompletion } from './geminiClient'
import { loadLlmSettings, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'

// Conservative spoken-word rate for English ad VO. Slower than
// conversational (2.7-3.0 wps) because ad reads breathe more — ~150 wpm
// is what most pro VO tracks land at. We use this to budget total words
// so the synthesised segments don't overflow the re-edit window. For
// other languages the rate shifts a touch but 2.4 is a fine ballpark
// across EN/ES/FR/PT/IT.
const SPOKEN_WORDS_PER_SEC = 2.4

const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
]

export const SCRIPT_LANGUAGES = SUPPORTED_LANGUAGES

function requireGeminiKey() {
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Open Settings → LLM to paste one before generating a VO script.')
  }
  return settings
}

const SYSTEM_PROMPT = `You are a senior advertising copywriter rewriting voiceover scripts for short-form ads. You return ONLY a JSON object — no prose, no markdown fences, no preamble. Keep the brand voice on-strategy: every word earns its place, the read sounds like it belongs in a cinema or premium TVC, and the closing tagline pays off the central idea.`

function languageLabel(code) {
  const found = SUPPORTED_LANGUAGES.find((l) => l.code === code)
  return found ? found.label : code || 'English'
}

// Tone → density inference. Reads the user's tone-override field plus
// the ad-concept's mood line and snaps to one of three bands:
//   - 'dense'    : energetic / upbeat / playful / hard-hitting reads
//                  pack more words per second and use shorter pauses.
//                  Think beverage, sport, kids' toys, gaming, hip-hop.
//   - 'sparse'   : melancholic / contemplative / luxury / serene reads
//                  let the picture breathe and use long silences.
//                  Think luxury car, jewellery, tribute, slow-cinema.
//   - 'standard' : everything in between (default).
// We use simple keyword matching — the prompt also surfaces the band
// to Gemini so it can override our decision based on the full
// concept / mood text if our keyword pass missed a signal.
function inferDensityBand(tone, mood) {
  const text = `${tone || ''} ${mood || ''}`.toLowerCase()
  if (!text.trim()) return 'standard'
  const denseHits = /\b(?:playful|dynamic|energetic|upbeat|exciting|fast|frenetic|punchy|hype|hyper|edgy|rebellious|intense|bold|driving|rowdy|raucous|exuberant|kinetic|electric|fiery|fierce|wild|loud|aggressive|frantic|breakneck|relentless|raw|gritty)\b/.test(text)
  const sparseHits = /\b(?:melancholic|contemplative|somber|sombre|peaceful|serene|calm|intimate|quiet|sad|reflective|gentle|tender|restrained|subtle|hushed|muted|mournful|wistful|nostalgic|delicate|tranquil|meditative|introspective|elegiac|austere|sober|brooding|moody|hypnotic)\b/.test(text)
  if (denseHits && !sparseHits) return 'dense'
  if (sparseHits && !denseHits) return 'sparse'
  return 'standard'
}

function buildUserPrompt({ adConcept, originalTranscript, targetDurationSec, language, tone, extraInstructions, previousDrafts }) {
  const lang = languageLabel(language)
  const targetSec = Math.max(4, targetDurationSec || 15)
  const densityBand = inferDensityBand(tone, adConcept?.mood)
  // Density → spoken-to-timeline ratio. Sparse reads use ~45 % of the
  // timeline for speech (lots of silence between lines); dense reads
  // pack ~72 %. Standard sits at 60 %, a touch above the old fixed
  // 55 % default — that fixed value was leaving even neutral-tone ads
  // feeling under-written for short pieces.
  const densityFractions = { sparse: 0.45, standard: 0.60, dense: 0.72 }
  const spokenFraction = densityFractions[densityBand]
  const spokenBudgetSec = targetSec * spokenFraction
  const wordBudget = Math.max(8, Math.round(SPOKEN_WORDS_PER_SEC * spokenBudgetSec))
  const totalTimelineSec = Math.max(spokenBudgetSec + 1, targetSec * 0.9)
  const minTimelineSec = Math.max(spokenBudgetSec + 1, targetSec * 0.75)
  const taglineDeadline = Math.max(0, targetSec - 0.8)
  const taglineFloor = Math.max(0, targetSec * 0.7)
  // Segment-count bands. Two axes: timeline length (longer films need
  // more beat structure) and density (energetic reads get one extra
  // segment, contemplative reads get one fewer). The lookup below
  // composes both so a 15 s playful ad gets 3-5 segments while a 15 s
  // melancholic ad gets 1-2.
  const baseSegCount = (targetSec <= 12)
    ? { min: 2, max: 3, prefer: 2 }
    : (targetSec <= 22)
      ? { min: 2, max: 4, prefer: 3 }
      : (targetSec <= 35)
        ? { min: 3, max: 5, prefer: 4 }
        : (targetSec <= 50)
          ? { min: 4, max: 6, prefer: 5 }
          : { min: 5, max: 8, prefer: 6 }
  const segShift = densityBand === 'dense' ? 1 : densityBand === 'sparse' ? -1 : 0
  const segCount = {
    min: Math.max(1, baseSegCount.min + segShift),
    max: Math.max(baseSegCount.min + segShift, baseSegCount.max + segShift),
    prefer: Math.max(1, baseSegCount.prefer + segShift),
  }
  // Human-readable band label — passed to the prompt so Gemini sees
  // the same word the keyword classifier used and can sanity-check
  // against the actual mood text.
  const densityLabel = densityBand === 'dense'
    ? 'DENSE (energetic / playful / hard-hitting — fill more of the timeline with VO, shorter pauses, more lines)'
    : densityBand === 'sparse'
      ? 'SPARSE (contemplative / melancholic / serene — fewer lines, long pauses, let the picture breathe)'
      : 'STANDARD (mid-energy — moderate density, normal pauses)'
  const conceptLines = []
  if (adConcept?.concept) conceptLines.push(`- Creative concept: ${adConcept.concept}`)
  if (adConcept?.message) conceptLines.push(`- Core message: ${adConcept.message}`)
  if (adConcept?.mood) conceptLines.push(`- Mood: ${adConcept.mood}`)
  if (adConcept?.target_audience) conceptLines.push(`- Target audience: ${adConcept.target_audience}`)
  if (adConcept?.brand_role) conceptLines.push(`- Brand role: ${adConcept.brand_role}`)
  if (adConcept?.narrative_arc) conceptLines.push(`- Narrative arc: ${adConcept.narrative_arc}`)
  const conceptBlock = conceptLines.length
    ? `# Original ad intent (preserve this)\n${conceptLines.join('\n')}`
    : '# Original ad intent\n(unavailable — work from the transcript reference and the brief alone.)'

  const refBlock = originalTranscript
    ? `# Original VO transcript (reference for tone / cadence — do NOT copy verbatim)\n"""\n${originalTranscript}\n"""\nUse this only as a feel for sentence length, formality, rhythm. Your output must be ORIGINAL copy that delivers the message above, not a paraphrase.`
    : ''

  const toneBlock = tone && tone.trim()
    ? `\n\n# Tone override (user-supplied)\n${tone.trim()}`
    : ''

  const extraBlock = extraInstructions && extraInstructions.trim()
    ? `\n\n# Additional notes from the user\n${extraInstructions.trim()}`
    : ''

  const previousBlock = (Array.isArray(previousDrafts) && previousDrafts.length > 0)
    ? `\n\n# Previous drafts (do NOT repeat these — the user has already seen them and wants a different angle)\n${previousDrafts.map((draft, i) => {
        const segs = Array.isArray(draft?.segments) ? draft.segments : []
        const joined = segs.map((s) => s.text).join(' ')
        return `- Draft ${i + 1}: "${joined}"`
      }).join('\n')}`
    : ''

  return `Write a NEW voiceover script for a re-edited ad.

# Density band (driven by tone + mood)
This script is **${densityLabel}**. The numeric budgets below are pre-tuned to that band — energetic reads get more words and shorter pauses, contemplative reads get fewer words and longer pauses. If the actual tone the user supplied or the mood line above suggests a different energy than the band we picked, you MAY adjust ±15% on the word budget and ±1 on the segment count, but stay within the band's spirit.

# Timeline budget (HARD CONSTRAINTS — read carefully)
- Re-edit total length: **${targetSec.toFixed(1)} seconds**.
- Spoken word budget: approximately **${wordBudget} words across the whole script** (at ~${SPOKEN_WORDS_PER_SEC} words/sec spoken). For this density band the speech occupies roughly **${(spokenFraction * 100).toFixed(0)}% of the timeline**, the rest is silence between lines.
- Spoken + gap totals MUST land between **${minTimelineSec.toFixed(1)} s and ${totalTimelineSec.toFixed(1)} s** on the timeline. Going below ${minTimelineSec.toFixed(1)} s is the most common failure — it produces a script that all crams at t=0 and leaves the back of the cut completely silent. Going above ${totalTimelineSec.toFixed(1)} s bumps into the visual ending.
- The TAGLINE (last segment) must START between **${taglineFloor.toFixed(1)} s and ${taglineDeadline.toFixed(1)} s** on the timeline. Earlier than ${taglineFloor.toFixed(1)} s and the closing line lands while the cut is still mid-story; later and there's no breath after it before the visual ends.
- VO does NOT need to fill the whole timeline — pure-picture moments between segments are good. The constraint is that the FINAL segment ends near ${totalTimelineSec.toFixed(1)} s, not that every second is spoken.

${conceptBlock}

${refBlock}${toneBlock}${extraBlock}${previousBlock}

# Output language: ${lang}
Write all \`text\` values in ${lang}. Punctuation, contractions, and idioms should feel native — do NOT translate stiffly from English.

# Structure rules
- Break the script into **${segCount.min}–${segCount.max} SEGMENTS** (preferably ${segCount.prefer}). The most powerful ads use few words and let the picture do the rest — prefer fewer punchy segments over a wall of voiceover. NEVER more than ${segCount.max}.
- Each segment is one self-contained line that reads naturally on a single breath.
- The LAST segment MUST be the tagline / closing signature (\`role: "tagline"\`). Make it short, declarative, brand-forward.
- Other segments are \`role: "line"\` (default), \`role: "question"\` (rhetorical hook), or \`role: "legal"\` (rare, only if the brief truly requires a disclaimer).
- \`gapBeforeSec\` is the silence (in seconds) BEFORE this segment fires on the timeline. Stack: segment N starts at sum(prev gaps + prev spoken durations) + gap_N.
- **The FIRST segment's gap is the OPENING LEAD-IN — it must NOT be 0.** Ad VO never crashes in at t=0; the music / picture establishes for 1.5-3 seconds before the first line lands. Set \`gapBeforeSec: 1.5\` to \`gapBeforeSec: 3.0\` on segment 0 (longer for slower / more contemplative ads, shorter for hard-hitting energetic ones). A first segment with \`gapBeforeSec: 0\` is rejected.
- Do NOT include direction (smile, beat, slow, etc.) inside the \`text\` — only spoken words.

# How to compute gaps so the script actually fills the timeline
The single biggest failure mode is gaps too small → segments cram at the start of the timeline → back half of the ad is silent. To prevent it, REVERSE-ENGINEER the gaps from the timeline budget:

  Step 1. Estimate spoken duration per segment: words / 2.4 (e.g. 5 words ≈ 2.1 s).
  Step 2. Sum spoken durations: \`spokenTotal\`.
  Step 3. Available silence to distribute: \`silenceBudget = ${totalTimelineSec.toFixed(1)} - spokenTotal\`. This MUST be positive — if not, you have too many words, drop some.
  Step 4. Distribute the silence so the LAST segment ends at ~${totalTimelineSec.toFixed(1)} s and the tagline starts within [${taglineFloor.toFixed(1)} s, ${taglineDeadline.toFixed(1)} s].
  Step 5. Re-add the gaps in order. Front gap is usually 0–0.8 s; gap before the tagline is the biggest chunk of \`silenceBudget\`.

## Worked example for a ${targetSec.toFixed(0)} s target
Suppose you write ${segCount.prefer} segments at ~${(spokenBudgetSec / segCount.prefer).toFixed(1)} s spoken each → \`spokenTotal ≈ ${(segCount.prefer * (spokenBudgetSec / segCount.prefer)).toFixed(1)} s\`. Available silence ≈ ${(totalTimelineSec - spokenBudgetSec).toFixed(1)} s. With opening gap = 0.3 s and ${segCount.prefer - 1} mid/closing gaps, gap before the tagline ≈ ${Math.max(1.5, (totalTimelineSec - spokenBudgetSec - 0.3 - 0.8 * Math.max(0, segCount.prefer - 2)) ).toFixed(1)} s. The tagline then lands around ${(targetSec * 0.85).toFixed(1)} s — squarely in the [${taglineFloor.toFixed(1)} s, ${taglineDeadline.toFixed(1)} s] window.

# Self-check before emitting JSON (mandatory)
Run the math: \`(timeline_end = sum of every gap + sum of every spoken duration)\`. Three checks, in order:
  1. \`timeline_end ≤ ${totalTimelineSec.toFixed(1)} s\` — no overflow.
  2. \`timeline_end ≥ ${minTimelineSec.toFixed(1)} s\` — no early-bunching. **If under: GROW your gaps (especially the one before the tagline) until you hit this floor.** Do not return a script that ends before ${minTimelineSec.toFixed(1)} s.
  3. The tagline's start time (sum of every gap + spoken duration BEFORE it) sits in [${taglineFloor.toFixed(1)} s, ${taglineDeadline.toFixed(1)} s].
If any check fails, fix the gaps and recompute before returning.

# Output schema (return EXACTLY this JSON, no extra fields)
{
  "title": "5-8 word descriptive label for this draft (e.g. 'Hero road-trip cold open' or 'Quiet luxury close')",
  "rationale": "1 sentence explaining WHY this script lands the brief (concept + audience). Plain prose, no bullets.",
  "segments": [
    { "text": "First line spoken, exactly as the VO actor will read it.", "role": "line", "gapBeforeSec": 0.0 },
    { "text": "Middle beat.", "role": "line", "gapBeforeSec": 1.2 },
    { "text": "Closing tagline.", "role": "tagline", "gapBeforeSec": 2.5 }
  ]
}

Return the JSON object only — no fences, no comment.`
}

/**
 * Generate one new script draft. Caller is responsible for storing the
 * returned object on the project (we don't touch persistence here so
 * this stays a pure function).
 *
 * @param {object} opts
 * @param {object} opts.adConcept            — analysis.overall payload (concept/message/mood/...).
 * @param {string} [opts.originalTranscript] — concatenated text of analysis.overall.voiceover_segments. Reference only.
 * @param {number} opts.targetDurationSec    — re-edit target duration. Drives word budget.
 * @param {string} [opts.language]           — ISO code: 'en' (default), 'es', 'pt', 'fr', etc.
 * @param {string} [opts.tone]               — free-text user override ("more playful", "drier, less salesy", etc.).
 * @param {string} [opts.extraInstructions]  — anything else the user wants to feed the model.
 * @param {Array}  [opts.previousDrafts]     — list of already-generated drafts so the LLM doesn't repeat itself.
 * @param {string} [opts.modelOverride]      — bypass settings.proposalModel.
 */
export async function generateVoiceoverScriptDraft({
  adConcept,
  originalTranscript,
  targetDurationSec,
  language = 'en',
  tone,
  extraInstructions,
  previousDrafts,
  modelOverride,
  temperature = 0.85, // creative task — bump from the analyzer's 0.2/0.3
  // 1200 was tight: Gemini 2.5 Pro burns tokens on thinking even with
  // thinkingBudget:0, and a 4-segment script with rationale + title can
  // legitimately need ~700 output tokens. 4000 covers Pro's reasoning
  // overhead with headroom; we only get billed for tokens actually
  // produced so the higher cap is free for shorter outputs.
  maxTokens = 4000,
} = {}) {
  const settings = requireGeminiKey()
  // Reuse the PROPOSAL slot — same lane (creative writing under a brief).
  const model = modelOverride || resolveGeminiModelForTask(settings, LLM_TASKS.PROPOSAL)
  const systemPrompt = SYSTEM_PROMPT
  const targetSec = Math.max(4, targetDurationSec || 15)
  // Floors / ceilings used for both the prompt and the post-validation
  // step so the LLM is checked against the same numbers it was told.
  const minTimelineSec = Math.max(targetSec * 0.55 + 1, targetSec * 0.75)
  const maxTimelineSec = Math.max(targetSec * 0.55 + 1, targetSec * 0.9)

  // Single-try inner runner so we can re-prompt with a correction note
  // when the model under-fills the timeline (the canonical failure mode
  // — segments cram at t=0 and the back of the cut is silent).
  const runOnce = async (correctionNote) => {
    const userPrompt = buildUserPrompt({
      adConcept,
      originalTranscript,
      targetDurationSec,
      language,
      tone,
      extraInstructions,
      previousDrafts,
    }) + (correctionNote ? `\n\n# CORRECTION REQUIRED\n${correctionNote}` : '')

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
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
      throw new Error(`Gemini returned no text for VO script generation: ${reason}.`)
    }
    return { rawText, parsed: extractJson(rawText) || {} }
  }

  // Estimate the timeline span of a parsed segments array.
  const measureTimeline = (segs) => {
    let cursor = 0
    let taglineStart = null
    for (const s of segs) {
      const gap = Math.max(0, Number(s.gapBeforeSec) || 0)
      cursor += gap
      const words = (s.text || '').trim().split(/\s+/).filter(Boolean).length
      const spoken = words / SPOKEN_WORDS_PER_SEC
      if (s.role === 'tagline') taglineStart = cursor
      cursor += spoken
    }
    return { totalEnd: cursor, taglineStart }
  }

  let { rawText, parsed } = await runOnce(null)
  // First-pass measurement. If the script crams (ends well below the
  // floor), the tagline lands too early, the first segment crashes
  // in at t=0 with no lead-in — re-prompt once with explicit numbers.
  // One retry only; further drift is the user's call.
  {
    const segs = Array.isArray(parsed.segments) ? parsed.segments : []
    const { totalEnd, taglineStart } = measureTimeline(segs)
    const taglineFloor = Math.max(0, targetSec * 0.7)
    const taglineCeil = Math.max(0, targetSec - 0.8)
    const firstGap = segs.length > 0 ? Number(segs[0].gapBeforeSec) || 0 : 0
    const tooShort = totalEnd < minTimelineSec - 0.2
    const taglineEarly = taglineStart != null && taglineStart < taglineFloor - 0.3
    const noLeadIn = firstGap < 1.0
    if (tooShort || taglineEarly || noLeadIn) {
      const issues = []
      if (noLeadIn) {
        issues.push(`Your first segment had gapBeforeSec=${firstGap.toFixed(1)} s — that means the VO crashes in at t=0 of the timeline with no breathing room. The opening line MUST land 1.5-3 s in so the picture establishes first. Set the first segment's \`gapBeforeSec\` to a value between 1.5 and 3.0.`)
      }
      if (tooShort) {
        issues.push(`Your script's combined timeline ended at ${totalEnd.toFixed(1)} s but the floor is ${minTimelineSec.toFixed(1)} s. The back of the cut would be silent. GROW the gaps — especially the gap BEFORE the tagline — until the script ends in [${minTimelineSec.toFixed(1)} s, ${maxTimelineSec.toFixed(1)} s]. Do NOT add more words; lengthen the silences between segments.`)
      }
      if (taglineEarly && taglineStart != null) {
        issues.push(`Your tagline started at ${taglineStart.toFixed(1)} s but the window is [${taglineFloor.toFixed(1)} s, ${taglineCeil.toFixed(1)} s]. Push the gap BEFORE the tagline up so the closing line lands in that window.`)
      }
      const correction = issues.join(' ')
      const retry = await runOnce(correction)
      rawText = retry.rawText
      parsed = retry.parsed
    }
  }

  const rawSegs = Array.isArray(parsed.segments) ? parsed.segments : []
  // Normalise: every segment gets a stable id, defaults filled, bogus
  // entries dropped. We keep the role values the LLM may have invented
  // because downstream code only specially-cases 'tagline' / 'legal' —
  // anything else is treated as a normal line.
  const segments = rawSegs
    .map((s, idx) => ({
      id: `vo-${idx}`,
      text: String(s?.text || '').trim(),
      role: typeof s?.role === 'string' && s.role.trim() ? s.role.trim() : 'line',
      gapBeforeSec: Number.isFinite(Number(s?.gapBeforeSec)) ? Math.max(0, Number(s.gapBeforeSec)) : 0,
    }))
    .filter((s) => s.text.length > 0)
  if (segments.length === 0) {
    throw new Error('Gemini returned a script with no usable segments. Try generating again or refining the tone.')
  }
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    title: String(parsed.title || '').trim() || `Draft (${new Date().toLocaleTimeString()})`,
    rationale: String(parsed.rationale || '').trim(),
    language,
    tone: tone || '',
    extraInstructions: extraInstructions || '',
    segments,
    // Synthesis state lives on this object too. M2 populates it when
    // the user clicks "Synthesize". Shape:
    //   { status: 'running'|'done'|'failed',
    //     segmentAudio: { [segId]: { path, durationSec } },
    //     voiceRef: { startSec, endSec, transcript, audioPath },
    //     error?, completedAt? }
    synthesis: null,
    rawText,
    model,
  }
}

/**
 * Pick the best reference window for F5-TTS voice cloning from the
 * source VO. F5-TTS works best with 5-15 s of clean, single-speaker
 * audio + an exact transcript. We use Gemini's already-segmented
 * voiceover_segments (each one is a clean phrase boundary) and merge
 * adjacent ones until we have a contiguous block in the 6-12 s range.
 *
 * Strategy:
 *  - Walk segments in original order, keep adding until total duration
 *    crosses 6 s (minimum useful), stop before 13 s (F5-TTS hard-cuts
 *    at 15 s and we want headroom).
 *  - Skip segments tagged `legal` (fast disclaimers degrade clones).
 *  - If no run reaches 6 s, fall back to the longest single segment
 *    extended a bit on each side (clamped to its source bounds).
 *
 * Returns a plan object the IPC handler then turns into an actual
 * extracted .wav + .txt pair on disk.
 *
 * @param {Array<{ id, startSec, endSec, text, role? }>} segments
 * @returns {{ startSec: number, endSec: number, transcript: string } | null}
 */
export function pickVoiceReferenceWindow(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null
  const usable = segments.filter((s) => s.role !== 'legal' && s.text)
  if (usable.length === 0) return null
  const MIN_SEC = 6
  const MAX_SEC = 12
  // Greedy pass: for each starting index, extend forward through
  // adjacent segments until the running window is in [MIN_SEC, MAX_SEC].
  // The first match wins — we don't need a "best" here, just "good
  // enough"; the speakers's voice is consistent across the ad so any
  // 6-12 s clean block clones the same voice.
  for (let i = 0; i < usable.length; i++) {
    let start = usable[i].startSec
    let end = usable[i].endSec
    const texts = [usable[i].text]
    if (end - start >= MIN_SEC && end - start <= MAX_SEC) {
      return { startSec: start, endSec: end, transcript: texts.join(' ').trim() }
    }
    for (let j = i + 1; j < usable.length; j++) {
      // Only merge if the next segment starts within 1.5 s — a longer
      // gap means there's a music-only stretch in the middle, which
      // would break the clone with silence.
      if (usable[j].startSec - end > 1.5) break
      end = usable[j].endSec
      texts.push(usable[j].text)
      const dur = end - start
      if (dur >= MIN_SEC && dur <= MAX_SEC) {
        return { startSec: start, endSec: end, transcript: texts.join(' ').trim() }
      }
      if (dur > MAX_SEC) break
    }
  }
  // Fallback: pad the longest single segment up to MIN_SEC. We pad
  // backwards (earlier) first because most ad VOs ramp into the line
  // and trail off — the leading silence is usually cleaner audio.
  const longest = usable.reduce((best, s) => {
    const dur = s.endSec - s.startSec
    return (!best || dur > best.endSec - best.startSec) ? s : best
  }, null)
  if (!longest) return null
  const naturalDur = longest.endSec - longest.startSec
  const wantedExtra = Math.max(0, MIN_SEC - naturalDur)
  const padBefore = Math.min(wantedExtra, longest.startSec)
  return {
    startSec: Math.max(0, longest.startSec - padBefore),
    endSec: longest.endSec,
    transcript: longest.text.trim(),
  }
}
