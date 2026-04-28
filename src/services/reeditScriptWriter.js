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

function buildUserPrompt({ adConcept, originalTranscript, targetDurationSec, language, tone, extraInstructions, previousDrafts }) {
  const lang = languageLabel(language)
  // Budget: VO doesn't fill the whole timeline. Visuals carry the ad
  // and the read should breathe with the picture. We aim for ~55 % of
  // the target for SPOKEN content, leaving the rest for gaps + tail
  // silence so the closing tagline doesn't bump up against the cut.
  const targetSec = Math.max(4, targetDurationSec || 15)
  const spokenBudgetSec = targetSec * 0.55
  const wordBudget = Math.max(8, Math.round(SPOKEN_WORDS_PER_SEC * spokenBudgetSec))
  const totalTimelineSec = Math.max(spokenBudgetSec + 1, targetSec * 0.9)
  const taglineDeadline = Math.max(0, targetSec - 0.8)
  // Segment-count guidance scales with the timeline. Short pre-rolls
  // can land in 2 punchy lines; longer films need a beat structure
  // (intro → story → close). Bands tuned to keep ~3-5s of speech per
  // segment which is the sweet spot for ad reads.
  const segCount = (targetSec <= 12)
    ? { min: 2, max: 3, prefer: 2 }
    : (targetSec <= 22)
      ? { min: 2, max: 4, prefer: 3 }
      : (targetSec <= 35)
        ? { min: 3, max: 5, prefer: 4 }
        : (targetSec <= 50)
          ? { min: 4, max: 6, prefer: 5 }
          : { min: 5, max: 8, prefer: 6 }
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

# Timeline budget (HARD CONSTRAINTS — read carefully)
- Re-edit total length: **${targetSec.toFixed(1)} seconds**.
- Spoken word budget: approximately **${wordBudget} words across the whole script** (at ~${SPOKEN_WORDS_PER_SEC} words/sec spoken). Stay AT or UNDER — going over is worse than under.
- Spoken + gap totals MUST end by **${totalTimelineSec.toFixed(1)} s** (not the full ${targetSec.toFixed(1)} s — leave ~0.5–2 s of silence at the very end so the visual ending lands without VO bumping into it).
- VO does NOT need to fill the whole timeline. Most strong ads have 4–8 s of pure-picture moments (no VO at all) so the cut breathes. Lean toward LESS voice, not more.
- The TAGLINE (last segment) must START before **${taglineDeadline.toFixed(1)} s** so it has air to land.

${conceptBlock}

${refBlock}${toneBlock}${extraBlock}${previousBlock}

# Output language: ${lang}
Write all \`text\` values in ${lang}. Punctuation, contractions, and idioms should feel native — do NOT translate stiffly from English.

# Structure rules
- Break the script into **${segCount.min}–${segCount.max} SEGMENTS** (preferably ${segCount.prefer}). The most powerful ads use few words and let the picture do the rest — prefer fewer punchy segments over a wall of voiceover. NEVER more than ${segCount.max}.
- Each segment is one self-contained line that reads naturally on a single breath.
- The LAST segment MUST be the tagline / closing signature (\`role: "tagline"\`). Make it short, declarative, brand-forward.
- Other segments are \`role: "line"\` (default), \`role: "question"\` (rhetorical hook), or \`role: "legal"\` (rare, only if the brief truly requires a disclaimer).
- \`gapBeforeSec\` is the silence (in seconds) BEFORE this segment fires on the timeline. Use it to time the read with the visual beats:
    * The opening line usually has \`gapBeforeSec: 0\` or a small lead-in (0.3-0.8 s).
    * Mid-script lines breathe with the picture: typical gaps are 0.5–1.5 s.
    * The TAGLINE has a deliberate gap (1.0–2.5 s) so it lands on the final beat — but check the math: opening gap + spoken segments + mid gaps + tagline gap + spoken tagline must end by ${totalTimelineSec.toFixed(1)} s.
- Do NOT include direction (smile, beat, slow, etc.) inside the \`text\` — only spoken words.

# Self-check before emitting JSON
Mentally run the timeline: \`gap0 + spoken0 + gap1 + spoken1 + ... \`. If the sum exceeds ${totalTimelineSec.toFixed(1)} s, drop a segment or shorten one. The hard ceiling is non-negotiable; over-budget scripts get rejected.

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
  const userPrompt = buildUserPrompt({
    adConcept,
    originalTranscript,
    targetDurationSec,
    language,
    tone,
    extraInstructions,
    previousDrafts,
  })

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
  const parsed = extractJson(rawText) || {}
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
