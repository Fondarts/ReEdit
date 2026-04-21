/**
 * project:re-edit — proposal generator.
 *
 * Takes the analyzed shot log (with per-scene captions + structured
 * fields) plus a brand brief and an optimization metric, and returns a
 * proposed edit decision list (EDL) with a rationale. Same LM Studio
 * transport as the captioner; we reuse the same model unless the
 * caller overrides, so there's no need for the user to swap models
 * between Analysis and Proposal.
 *
 * Output shape (persisted under project.proposal):
 *
 *   {
 *     rationale: string,
 *     edl: [
 *       { index, kind: "original"|"placeholder", sourceSceneId?, newTcIn, newTcOut, note }
 *     ],
 *     metric, model, createdAt, rawText
 *   }
 *
 * The EDL intentionally mirrors the Sundogs shot-log structure (Nissan
 * example, page 12 of the brief). `kind: "placeholder"` rows carry a
 * `note` describing what the gen-AI fill shot should contain — this is
 * the seam the M2 R&D track will plug into.
 */

import lmstudio from './lmstudio'
import { pickVisionModelId, extractJson } from './reeditCaptioner'

export const PROPOSAL_METRICS = [
  {
    id: 'Attention',
    label: 'Attention',
    blurb: 'Win the first 3-5 seconds so viewers don\'t scroll past.',
  },
  {
    id: 'Comprehension',
    label: 'Comprehension',
    blurb: 'Make the brand, product, and message crystal clear.',
  },
  {
    id: 'Persuasion',
    label: 'Persuasion',
    blurb: 'Strengthen the argument for why this brand over alternatives.',
  },
  {
    id: 'Action',
    label: 'Action',
    blurb: 'Drive the viewer toward a concrete next step (visit, buy, call).',
  },
  {
    // Compound metric: optimize for Google's ABCD framework for YouTube
    // / video-ad creative effectiveness
    // (https://support.google.com/google-ads/answer/14783551). When this
    // is picked we inject the four-letter rulebook directly into the
    // LLM prompt so the model doesn't have to recall the framework from
    // its training data — the wording there is specific enough that
    // paraphrasing it loses the actionable rules (first-5s brand, CTA
    // reinforced with audio, etc.).
    id: 'ABCD',
    label: "Google's ABCD",
    blurb: 'Attract • Brand • Connect • Direct. Google\'s holistic ad-effectiveness framework.',
    criteria: `Google's ABCD framework for video ad effectiveness. Satisfy ALL FOUR letters, not just one:

A — ATTRACT (hook + sustain engagement from frame 1)
  • "Jump in": reach the core narrative fast. Open with dynamic pacing and tight framing; cut filler setup shots.
  • Support visuals with audio and supers (on-screen text / voiceover) — make sure both reinforce the message and don't compete.
  • Favor bright, high-contrast shots that read on small screens.

B — BRAND (unmistakable brand presence, early AND throughout)
  • Show the brand or product within the first few seconds, and bring it back at regular intervals — not just at the end card.
  • Reinforce visual branding with VERBAL brand mentions.
  • Use varied branding assets (logo, product, color system, tagline) instead of leaning on one.

C — CONNECT (emotional resonance, relatability, clarity of message)
  • Humanize the story — feature people; product demos land better with a person interacting with the product.
  • Keep ONE focused message. Don't stack competing claims.
  • Engage with an emotional hook: humor, surprise, intrigue, or an aspirational shift in perspective.

D — DIRECT (clear next step)
  • End with an explicit call to action. No ambiguity about what the viewer should do.
  • Reinforce on-screen CTAs with voiceover so the instruction still lands on mute-off viewers and without subtitles.

Score the current cut against A / B / C / D and propose an EDL that visibly improves every letter the current edit is weak on.`,
  },
]

const SYSTEM_PROMPT = `You are a senior advertising creative director helping to re-edit an existing commercial using only its already-filmed shots plus at most a few AI-generated fill shots. You work from a shot log and return a concrete, ordered edit decision list (EDL) with per-shot rationale. You return ONLY a JSON object, no commentary, no markdown fences.`

function renderShotLog(scenes) {
  // Excluded scenes never reach the LLM — the user has already said
  // "don't use this" and the model shouldn't be tempted to reference
  // them in the rationale or EDL.
  return scenes
    .filter((s) => !s?.excluded)
    .map((s) => {
      const st = s.structured || {}
      const cap = s.caption || st.visual || '(no caption)'
      return `- ${s.id} (${Number(s.tcIn).toFixed(2)}–${Number(s.tcOut).toFixed(2)}s, ${Number(s.duration || s.tcOut - s.tcIn).toFixed(2)}s): ${cap} | brand=${st.brand || '?'} · emotion=${st.emotion || '?'} · framing=${st.framing || '?'} · motion=${st.movement || '?'}`
    })
    .join('\n')
}

function buildUserPrompt({ scenes, brandBrief, metric, totalDurationSec, criteria }) {
  const shotLog = renderShotLog(scenes)
  const budget = totalDurationSec
    ? `Target a total duration within ±10% of ${totalDurationSec.toFixed(1)}s (the original).`
    : 'Keep the total duration reasonable for a social ad.'

  // When the metric has an attached criteria block (e.g. Google's
  // ABCD), pin it at the top of the prompt so the model scores and
  // optimizes against the explicit rules rather than its own mental
  // model of the one-word label.
  const framework = criteria
    ? `\n# Framework\n${criteria}\n`
    : ''

  return `# Goal
Re-edit this commercial to improve its ${metric} score.${framework}

# Brand brief
${brandBrief?.trim() || '(not provided — infer from the shot log)'}

# Shot log (from the current cut)
${shotLog}

# Your task
Propose a new edit decision list that improves ${metric}. Reorder shots, cut weak moments, promote high-value shots to prime timecodes (first and last seconds), and add 1–3 NEW placeholder shots only if a structural gap truly needs one. Do not invent assets that don't exist in the shot log except for those placeholder rows. ${budget}

Return ONLY a JSON object in this schema:

{
  "rationale": "2–4 sentence overall strategy explaining how this re-edit improves ${metric}.",
  "edl": [
    {
      "index": 1,
      "kind": "original",
      "sourceSceneId": "scene-001",
      "newTcIn": 0.00,
      "newTcOut": 2.00,
      "note": "1 sentence on why this shot is here at this timecode."
    },
    {
      "index": 2,
      "kind": "placeholder",
      "sourceSceneId": null,
      "newTcIn": 2.00,
      "newTcOut": 3.50,
      "note": "Describe the fill shot to generate (subject, framing, motion, brand cue)."
    }
  ]
}

Rules:
- "original" rows must reference a sourceSceneId that exists in the shot log.
- "placeholder" rows have sourceSceneId: null.
- Consecutive rows must be contiguous (newTcIn of row N+1 equals newTcOut of row N).
- First row starts at 0.
- JSON only. No prose around the JSON. No markdown fences.`
}

export async function generateProposal({
  scenes,
  brandBrief,
  metric,
  modelId,
  totalDurationSec,
  criteria,
} = {}) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Shot log is empty — run Analysis first.')
  }
  const eligibleCount = scenes.filter((s) => !s?.excluded).length
  if (eligibleCount === 0) {
    throw new Error('Every scene is excluded. Re-include at least one scene in Analysis to draft a proposal.')
  }
  const targetMetric = metric || 'Comprehension'
  // `criteria` lets callers (e.g. ProposalView's user-edited preset
  // store) override the baked-in framework text for this metric id.
  // Falling back to PROPOSAL_METRICS keeps the service usable standalone
  // when no presets layer is wired in (e.g. scripted runs, tests).
  const metricDef = PROPOSAL_METRICS.find((m) => m.id === targetMetric)
  const effectiveCriteria = criteria !== undefined
    ? (criteria || null)
    : (metricDef?.criteria || null)
  const model = modelId || await pickVisionModelId()

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt({ scenes, brandBrief, metric: targetMetric, totalDurationSec, criteria: effectiveCriteria }) },
  ]

  const response = await lmstudio.chatCompletion(model, messages, {
    temperature: 0.3,
    max_tokens: 4000,
  })
  const rawText = response?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(rawText)
  if (!parsed) {
    throw new Error('LLM response was not valid JSON. Try re-generating.')
  }

  const edl = Array.isArray(parsed.edl) ? parsed.edl : []
  // Normalize shape and force contiguous timecodes. Qwen2.5-VL-7B is
  // inconsistent about honoring the "newTcIn of row N+1 equals
  // newTcOut of row N" instruction in the prompt — in practice it
  // often copies original scene timestamps verbatim, which leaves gaps
  // all over the timeline. We trust the per-row duration (newTcOut -
  // newTcIn) as the LLM's real intent and re-pack the rows flush from
  // zero. If the LLM returned newTcIn == newTcOut we fall back to a
  // minimum 0.1s slot so the row still shows on the timeline.
  let cursor = 0
  const normalized = edl.map((row, i) => {
    const rawDur = Math.max(0.1, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0))
    const start = cursor
    const end = cursor + rawDur
    cursor = end
    return {
      index: i + 1,
      kind: row.kind === 'placeholder' ? 'placeholder' : 'original',
      sourceSceneId: row.sourceSceneId || null,
      newTcIn: start,
      newTcOut: end,
      note: row.note || '',
    }
  })

  return {
    rationale: String(parsed.rationale || ''),
    edl: normalized,
    metric: targetMetric,
    brandBrief: brandBrief || '',
    model,
    createdAt: new Date().toISOString(),
    status: 'draft',
    rawText,
  }
}
