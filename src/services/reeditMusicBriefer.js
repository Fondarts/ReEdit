/**
 * project:re-edit — Music brief auto-populator.
 *
 * "Auto" affordance for the music generation panel. Reads the ad's
 * overall analysis (concept, message, mood, target audience, brand
 * role, narrative arc) plus per-shot audio.music descriptions, and
 * asks Gemini to pick the right combination of curated tags from the
 * taxonomies the panel already exposes (Genre / Mood / Video Theme /
 * Instrument) plus a short free-text addendum. The output drops
 * straight into the chip picker + free-text box — the user can
 * tweak before hitting Generate.
 *
 * We constrain the model to the EXACT chips available in the panel
 * so the round-trip lands on selectable values; anything Gemini
 * thinks is missing from the taxonomy goes into the free-text addendum.
 */

import { geminiChatCompletion } from './geminiClient'
import { loadLlmSettings, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'

function requireGeminiKey() {
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Open Settings → LLM to paste one before using Auto.')
  }
  return settings
}

const SYSTEM_PROMPT = `You are a senior music supervisor briefing an AI music composer for a short-form ad. You return ONLY a JSON object — no prose, no markdown fences, no preamble. You select tags from a fixed taxonomy and write a short free-text addendum that captures any nuance the taxonomy can't express.`

// Build a compact, high-signal context block from the ad analysis.
// Only ships fields that matter for music selection (mood, narrative
// arc, brand role, per-shot music descriptions if present) so the
// prompt stays small and Gemini doesn't get distracted by VO-only
// fields like target_audience copy.
function renderAnalysisContext(analysis) {
  const overall = analysis?.overall || {}
  const lines = []
  if (overall.concept) lines.push(`Concept: ${overall.concept}`)
  if (overall.message) lines.push(`Message: ${overall.message}`)
  if (overall.mood) lines.push(`Mood: ${overall.mood}`)
  if (overall.brand_role) lines.push(`Brand role: ${overall.brand_role}`)
  if (overall.narrative_arc) lines.push(`Narrative arc: ${overall.narrative_arc}`)
  if (overall.target_audience) lines.push(`Audience: ${overall.target_audience}`)

  const musicDescriptions = (analysis?.scenes || [])
    .map((s) => s?.videoAnalysis?.audio?.music)
    .filter((m) => typeof m === 'string' && m.trim())
  if (musicDescriptions.length > 0) {
    lines.push('')
    lines.push(`Music observed in the source ad (per-shot, in order):`)
    musicDescriptions.forEach((m, i) => lines.push(`  ${i + 1}. ${m.trim()}`))
  }
  return lines.join('\n')
}

function buildUserPrompt({ analysis, taxonomies, targetDurationSec }) {
  const ctx = renderAnalysisContext(analysis)
  const taxLines = taxonomies.map((t) => `  - ${t.id} (${t.label}): ${t.tags.join(', ')}`).join('\n')
  const target = Math.max(4, Math.round(Number(targetDurationSec) || 30))
  return `# Ad analysis
${ctx || '(No analysis text available — fall back to a neutral commercial brief.)'}

# Target track length
${target} seconds.

# Tag taxonomy (you MUST pick from these exact strings — no synonyms, no new tags)
${taxLines}

# Your task
Pick the smallest set of tags from the taxonomy above that captures what music this ad needs. Then write a 1-2 sentence free-text addendum describing anything the taxonomy can't say (specific instrument textures, energy curve, build vs. drop, references like "feels like a Nike summer ad", etc.). Avoid restating tags you already picked.

Selection rules:
- genre: pick 1, occasionally 2 if the track legitimately blends styles. Never more than 2.
- mood: pick 1-3 — the dominant emotional register first, then up to two reinforcing ones.
- theme: pick 1-2 (Commercial is almost always one of them for ads).
- instrument: pick 0-4. Only call out instruments that should be FOREGROUNDED in the track. Do not list a full session lineup.
- Total chips across all categories: aim for 5-8. Fewer when the brief is clear, more only when the ad spans contrasting beats.

Free-text addendum rules:
- Reinforce the energy curve (e.g. "slow build into a confident anthem at 0:08") — directors think in arcs, taxonomy chips don't.
- Mention production references when obvious ("Phantogram-style synths", "Clams Casino-style washed pads") — ACE-Step's text encoder responds well to artist refs.
- 60 words max, written in natural prose. Skip filler like "the music should..." — go straight to the description.
- Do NOT mention BPM or musical key (the panel has separate fields for those).
- If the analysis is silent on music or mood, infer from concept + brand role rather than refusing.

# Output schema
{
  "tags": {
    "genre":      ["..."],
    "mood":       ["..."],
    "theme":      ["..."],
    "instrument": ["..."]
  },
  "freeText": "..."
}

Every string inside "tags" MUST be copied VERBATIM from the taxonomy — same casing, same punctuation. Drop any category you don't need (empty array is fine). Return the JSON object only.`
}

/**
 * Generate a music brief (tag selection + free-text addendum) from the
 * ad analysis. The output is shaped to drop straight into MusicPanel's
 * chip picker + free-text box.
 *
 * @param {object}   args
 * @param {object}   args.analysis            — currentProject.analysis
 * @param {array}    args.taxonomies          — same TAG_CATEGORIES the panel renders
 * @param {number}   args.targetDurationSec   — defaults to 30
 * @param {string?}  args.modelOverride
 */
export async function generateMusicBriefDraft({
  analysis,
  taxonomies,
  targetDurationSec = 30,
  modelOverride,
  temperature = 0.6,
  // Gemini 2.5 Pro burns output budget on internal thinking even with
  // thinkingBudget:0 — the JSON tag-selection + free-text response is
  // small (<300 tokens) but 1200 was getting truncated mid-think. 4000
  // matches the headroom reeditScriptWriter settled on for the same
  // reason; we only get billed for tokens actually produced.
  maxTokens = 4000,
} = {}) {
  if (!Array.isArray(taxonomies) || taxonomies.length === 0) {
    throw new Error('generateMusicBriefDraft: taxonomies are required')
  }
  const settings = requireGeminiKey()
  const model = modelOverride || resolveGeminiModelForTask(settings, LLM_TASKS.PROPOSAL)
  const userPrompt = buildUserPrompt({ analysis, taxonomies, targetDurationSec })
  const response = await geminiChatCompletion({
    apiKey: settings.geminiApiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
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
    throw new Error(`Gemini returned no text for music brief: ${reason}.`)
  }
  const parsed = extractJson(rawText) || {}
  // Whitelist tags against the taxonomy so a hallucinated chip can't
  // crash the chip-picker (e.g. "Cinematic Orchestral" when the actual
  // chip is just "Cinematic"). Anything that doesn't match exactly
  // gets demoted to the free-text addendum so the intent isn't lost.
  const validByCat = new Map(taxonomies.map((t) => [t.id, new Set(t.tags)]))
  const acceptedTags = new Set()
  const rejected = []
  const rawTags = parsed.tags || {}
  for (const [catId, set] of validByCat) {
    const list = Array.isArray(rawTags[catId]) ? rawTags[catId] : []
    for (const tag of list) {
      if (typeof tag !== 'string') continue
      if (set.has(tag)) {
        acceptedTags.add(tag)
      } else {
        rejected.push(tag)
      }
    }
  }
  const baseFreeText = typeof parsed.freeText === 'string' ? parsed.freeText.trim() : ''
  const freeText = rejected.length > 0
    ? [baseFreeText, `Additional cues: ${rejected.join(', ')}`].filter(Boolean).join(' ')
    : baseFreeText

  return {
    tags: [...acceptedTags],
    freeText,
    rawResponse: parsed,
  }
}
