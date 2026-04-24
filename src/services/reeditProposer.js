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

import { pickVisionModelId, extractJson } from './reeditCaptioner'
import { chatCompletion, LLM_TASKS } from './reeditLlmClient'

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

// A scene is eligible for the proposal when the user hasn't excluded
// it AND we have enough data to describe it to the LLM. Shots whose
// Gemini analysis blew up (`videoAnalysisError`) are dropped — feeding
// a half-parsed row with null fields just gives the LLM placeholder
// garbage to reason about. Shots captioned with LM Studio / Claude
// don't set `videoAnalysisError`, so they pass through with the
// classical `caption + structured` data only.
function eligibleForProposal(scene) {
  if (!scene || scene.excluded) return false
  if (scene.videoAnalysisError) return false
  return Boolean(
    scene.videoAnalysis?.visual
    || scene.caption
    || scene.structured?.visual,
  )
}

// Build a multi-line block per scene that groups the videoAnalysis
// fields into semantic sections (Visual / Chips / Motion / Audio /
// Graphics / Pacing). Any section whose fields are all missing is
// omitted, so shots captioned with a non-video backend only emit
// Visual + Chips and don't clutter the prompt with empty lines.
function formatSceneBlock(scene) {
  const st = scene.structured || {}
  const va = scene.videoAnalysis || {}
  const lines = []
  const duration = Number(scene.duration) || (Number(scene.tcOut) - Number(scene.tcIn))
  lines.push(`## ${scene.id} · ${Number(scene.tcIn).toFixed(2)}–${Number(scene.tcOut).toFixed(2)}s · ${Number.isFinite(duration) ? duration.toFixed(2) : '?'}s`)

  const visual = va.visual || scene.caption || st.visual
  if (visual) lines.push(`Visual: ${visual}`)

  const chips = []
  if (st.brand) chips.push(`brand=${st.brand}`)
  if (st.emotion) chips.push(`emotion=${st.emotion}`)
  if (st.framing) chips.push(`framing=${st.framing}`)
  if (st.movement) chips.push(`movement=${st.movement}`)
  if (chips.length) lines.push(`Chips: ${chips.join(' · ')}`)

  // Motion: camera + subject. 'unknown' / 'none' / 'stationary' are
  // filler values the analyzer emits when there's nothing to say —
  // skip them so the line doesn't contribute noise.
  const motionPieces = []
  if (va.camera_movement && va.camera_movement !== 'unknown') {
    const intensity = va.camera_movement_intensity && va.camera_movement_intensity !== 'none'
      ? ` (${va.camera_movement_intensity})`
      : ''
    motionPieces.push(`camera=${va.camera_movement}${intensity}`)
  }
  if (va.subject_motion && va.subject_motion !== 'none') {
    const dir = va.subject_motion_direction && va.subject_motion_direction !== 'stationary'
      ? ` (${va.subject_motion_direction})`
      : ''
    motionPieces.push(`subject=${va.subject_motion}${dir}`)
  }
  if (motionPieces.length) lines.push(`Motion: ${motionPieces.join(' · ')}`)

  // Audio block only appears when the clip actually has audio — the
  // analyzer sets `audio` to null for silent shots.
  if (va.audio) {
    const a = va.audio
    const audioPieces = []
    if (a.voiceover_transcript) audioPieces.push(`VO="${a.voiceover_transcript}"`)
    if (a.music) audioPieces.push(`music=${a.music}`)
    if (Array.isArray(a.sfx) && a.sfx.length) audioPieces.push(`SFX=[${a.sfx.join(', ')}]`)
    if (a.ambient) audioPieces.push(`ambient=${a.ambient}`)
    if (audioPieces.length) lines.push(`Audio: ${audioPieces.join(' · ')}`)
  }

  // Graphics block for overlays — null when the shot has no text /
  // logo / overlay elements.
  if (va.graphics) {
    const g = va.graphics
    const gfxPieces = []
    if (g.text_content) {
      const role = g.text_role && g.text_role !== 'none' ? ` (${g.text_role})` : ''
      gfxPieces.push(`text${role}="${g.text_content}"`)
    }
    if (g.logo_description) gfxPieces.push(`logo=${g.logo_description}`)
    if (g.other_graphics) gfxPieces.push(`other=${g.other_graphics}`)
    if (gfxPieces.length) lines.push(`Graphics: ${gfxPieces.join(' · ')}`)
  }

  const pacingPieces = []
  if (va.cut_type && va.cut_type !== 'unknown') pacingPieces.push(`cut=${va.cut_type}`)
  if (va.tempo_cue) pacingPieces.push(`tempo=${va.tempo_cue}`)
  if (pacingPieces.length) lines.push(`Pacing: ${pacingPieces.join(' · ')}`)

  return lines.join('\n')
}

function renderShotLog(scenes) {
  // `---` separator between blocks — `##` alone is enough markdown
  // structure but the HR makes the boundaries unambiguous for the LLM
  // when a shot's Visual runs long or wraps.
  const blocks = (scenes || [])
    .filter(eligibleForProposal)
    .map(formatSceneBlock)
  return blocks.join('\n\n---\n\n')
}

// Sum expected timeline seconds from an EDL, using source scenes'
// natural durations for originals and declared gap for placeholders —
// matches what reeditEdlToTimeline actually lays down at Apply time.
function estimateEdlDuration(edl, scenes) {
  const byId = new Map((scenes || []).map((s) => [s.id, s]))
  let total = 0
  for (const row of edl || []) {
    if (row?.excluded) continue
    if (row?.kind === 'placeholder') {
      const gap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
      total += Math.max(0.5, gap || 1.5)
      continue
    }
    const scene = byId.get(row?.sourceSceneId)
    if (!scene) continue
    total += Math.max(0.1, Number(scene.tcOut) - Number(scene.tcIn))
  }
  return total
}

// Human-friendly descriptions of each capability for the prompt. We
// stay deliberately prescriptive in the copy: the goal is for the
// model to treat these as hard rules, not suggestions.
function renderCapabilitiesBlock(capabilities) {
  const c = capabilities || {}
  const lines = []
  lines.push('# Capabilities (HARD RULES — respect exactly)')
  lines.push(c.footageGeneration
    ? '- Footage generation: ENABLED. You MAY add 1–3 `placeholder` rows to fill structural gaps, as specified in the output schema below.'
    : '- Footage generation: DISABLED. You MUST NOT propose any `placeholder` rows. Every row in the EDL must be `kind: "original"` and reference a scene that exists in the shot log.')
  lines.push(c.footageExtend
    ? '- Footage extend: ENABLED. You MAY flag a shot for AI extension by prefixing its note with `EXTEND +<seconds>s:` when you need a slightly longer beat than the source clip offers. Use sparingly — extensions introduce motion artefacts.'
    : '- Footage extend: DISABLED. You MUST NOT annotate shots with EXTEND directives. If a gap needs more time, solve it by reordering or (if enabled) a placeholder, never by stretching a shot.')
  lines.push(c.footageUpscale
    ? '- Footage upscale: ENABLED. You MAY use shots whose native resolution looks low in the shot log; they will be upscaled downstream. Do not avoid a strong shot purely because it would need upscaling.'
    : '- Footage upscale: DISABLED. Prefer shots with high native resolution. If the shot log mentions a shot is low-res, deprioritise it unless it is narratively critical.')
  lines.push(c.reframe
    ? '- Reframe: ENABLED. You MAY use shots whose native aspect ratio does not match the delivery aspect. Prefix the note with `REFRAME <direction>:` (e.g. `REFRAME to 9:16`) when you intend that.'
    : '- Reframe: DISABLED. You MUST NOT annotate shots with REFRAME directives. Assume every shot is used at its native aspect.')
  lines.push(c.useOriginalMusic
    ? '- Use original music stem: ENABLED. The source video\'s music has been separated via Demucs into an isolated stem. You MAY layer that music stem under ANY row of the EDL — including placeholder rows and shots that had no music in the original cut. To request this on a row, prefix the note with `AUDIO music:` (e.g. `AUDIO music: carry the main theme under this shot`).'
    : '- Use original music stem: DISABLED. Do NOT propose layering the isolated music stem freely. Music stays glued to its source shot as recorded.')
  lines.push(c.useOriginalVoiceover
    ? '- Use original voiceover stem: ENABLED. The source video\'s voiceover has been separated via Demucs into an isolated stem. You MAY reuse VO lines on any row, decoupled from where they originally appeared. Prefix the note with `AUDIO vo: "<exact verbatim line>"` to indicate which VO line should play there.'
    : '- Use original voiceover stem: DISABLED. Do NOT propose reusing VO lines outside their original shot. VO and the shot where it was recorded stay bound together.')
  return lines.join('\n')
}

function buildUserPrompt({ scenes, brandBrief, extraInstructions, metric, totalDurationSec, targetDurationSec, criteria, correctionNote, capabilities }) {
  const shotLog = renderShotLog(scenes)
  // Keep the budget math consistent with the shot log — if a shot
  // isn't in the log, the LLM can't reference it, so its seconds
  // shouldn't count toward "available footage" either.
  const eligibleScenes = (scenes || []).filter(eligibleForProposal)
  const totalNatural = eligibleScenes.reduce((sum, s) => {
    const d = Number(s.duration) || (Number(s.tcOut) - Number(s.tcIn)) || 0
    return sum + Math.max(0, d)
  }, 0)
  const avgDur = eligibleScenes.length > 0 ? totalNatural / eligibleScenes.length : 0

  let budget
  const placeholdersAllowed = capabilities?.footageGeneration !== false
    ? (capabilities?.footageGeneration ? true : false)
    : false
  if (Number.isFinite(targetDurationSec) && targetDurationSec > 0) {
    const lo = Math.max(1, targetDurationSec * 0.85)
    const hi = targetDurationSec * 1.15
    const needsPlaceholders = targetDurationSec > totalNatural * 1.05
    const neededPlaceholderSec = needsPlaceholders ? targetDurationSec - totalNatural : 0

    // When placeholders are disabled by capabilities, the "gap
    // exceeds budget" advice flips: instead of telling the model to
    // add synthetic rows, we instruct it to cap the EDL at the
    // available footage so it doesn't propose a short cut and flag it
    // as a budget failure.
    let gapLine
    if (!needsPlaceholders) {
      gapLine = `You can reach the target using existing scenes alone — include enough of them that the natural durations sum to ~${targetDurationSec.toFixed(1)}s.`
    } else if (placeholdersAllowed) {
      gapLine = `The target exceeds available footage by ${neededPlaceholderSec.toFixed(1)}s. You MUST add ~${Math.max(2, Math.round(neededPlaceholderSec / 2))} placeholder rows averaging ~2s each. Without enough placeholders, you will NOT reach the budget.`
    } else {
      gapLine = `The target exceeds available footage by ${neededPlaceholderSec.toFixed(1)}s AND placeholder rows are DISABLED by capabilities. Use every eligible scene — the final EDL will be ${totalNatural.toFixed(1)}s, which is below the target; that is expected. Do not attempt to hit the target with non-original rows.`
    }

    const lines = [
      `**HARD BUDGET — ${targetDurationSec.toFixed(1)}s total (acceptable ${lo.toFixed(1)}–${hi.toFixed(1)}s).**`,
      `You have ${eligibleScenes.length} scenes, ${totalNatural.toFixed(1)}s of source footage, average ${avgDur.toFixed(2)}s per shot.`,
      'Each row plays at the SOURCE scene\'s natural length shown in the shot log — you cannot stretch or shrink a clip.',
      gapLine,
      placeholdersAllowed
        ? 'Before returning, SUM the natural durations of your chosen rows + placeholder durations. If the sum is under the lower bound, ADD more rows until you are in range. Do not return an EDL that is short.'
        : 'Before returning, SUM the natural durations of your chosen rows. Include every eligible scene once unless you have a strong reason to skip it.',
      correctionNote ? `\n**CORRECTION REQUIRED**: ${correctionNote}` : null,
    ].filter(Boolean)
    budget = lines.join('\n')
  } else if (Number.isFinite(totalDurationSec) && totalDurationSec > 0) {
    budget = `Target a total duration within ±10% of ${totalDurationSec.toFixed(1)}s (the original). Each EDL row's on-timeline duration is the source scene's natural length.`
  } else {
    budget = 'Keep the duration reasonable. Each row plays at its source scene\'s natural length.'
  }

  // When the metric has an attached criteria block (e.g. Google's
  // ABCD), pin it at the top of the prompt so the model scores and
  // optimizes against the explicit rules rather than its own mental
  // model of the one-word label.
  const framework = criteria
    ? `\n# Framework\n${criteria}\n`
    : ''

  // Optional project-specific constraints the user dropped into the
  // "Extra instructions" box in ProposalView. We surface them right
  // after the brand brief under their own heading so the LLM treats
  // them as hard rules, not generic fluff. Empty string = no section.
  const extraBlock = (extraInstructions && extraInstructions.trim())
    ? `\n\n# Extra instructions (honor these strictly)\n${extraInstructions.trim()}`
    : ''

  // Capabilities block sits between the brief and the shot log so the
  // LLM has the rules in mind before it starts scoring shots. When all
  // four flags are off (the default), the block reads as a tight
  // "reorder / trim only" instruction.
  const capabilitiesBlock = `\n\n${renderCapabilitiesBlock(capabilities)}`

  return `# Goal
Re-edit this commercial to improve its ${metric} score.${framework}

# Brand brief
${brandBrief?.trim() || '(not provided — infer from the shot log)'}${extraBlock}${capabilitiesBlock}

# Shot log (from the current cut)
Each shot below is a multi-line block separated by \`---\`:
- Visual: factual description of what happens on screen.
- Chips: brand presence · emotion · framing · overall movement.
- Motion: camera movement (with intensity) and subject motion (with direction).
- Audio: verbatim voiceover (VO), music description, SFX list, ambient bed. Omitted on silent clips.
- Graphics: on-screen text with its role (title, tagline, caption, legal_disclaimer, etc.) and logos present. Omitted on clean frames.
- Pacing: shot boundary character (cut_type) and tempo feel.
Use Audio.VO to anchor narrative continuity — never split a VO line across shots arbitrarily. Use Pacing + music tempo to size shot durations. Use Graphics to decide which shots MUST carry brand elements (logo, tagline, legal disclaimer) and which ones can be replaced.

${shotLog}

# Your task
Propose a new edit decision list that improves ${metric}. Reorder shots, cut weak moments, promote high-value shots to prime timecodes (first and last seconds).${placeholdersAllowed ? ' You may add 1–3 NEW placeholder shots only if a structural gap truly needs one.' : ' Work only with shots that exist in the shot log — no placeholder rows.'} ${budget}

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
      "note": "1 sentence on why this shot is here at this timecode (rationale, not a prompt)."
    },
    {
      "index": 2,
      "kind": "placeholder",
      "sourceSceneId": null,
      "newTcIn": 2.00,
      "newTcOut": 3.50,
      "note": "Close-up of a hand gripping a black leather steering wheel with the chrome Honda logo centered in-frame; subtle tilt-up as the grip tightens; golden-hour warm side-light; shallow depth of field with the dashboard softly out of focus."
    }
  ]
}

Rules:
- "original" rows must reference a sourceSceneId that exists in the shot log.
- "placeholder" rows have sourceSceneId: null.
- Consecutive rows must be contiguous (newTcIn of row N+1 equals newTcOut of row N).
- First row starts at 0.
- JSON only. No prose around the JSON. No markdown fences.

PLACEHOLDER QUALITY (critical — these notes are fed directly to a video-generation model):
- Write each placeholder's note as a concrete DIRECTOR'S SHOT INSTRUCTION, not a meta description ("add a shot of X" is forbidden).
- Include: subject + action, camera framing (ECU / close-up / medium / wide / aerial), motion (static / slow / moderate / high, and direction — pan left, push in, etc.), lighting/mood, and explicit brand presence if relevant to the re-edit strategy.
- Match the visual language of the surrounding original scenes (look at their structured fields: brand, emotion, framing, motion). A placeholder that breaks style looks like a generic stock cut.
- 15–40 words per note. Concrete nouns, not adjectives ("red Honda Armada on wet asphalt at dusk" beats "cool-looking shot of a car").
- No placeholder should read "generic brand shot", "establishing shot", "product hero", "cutaway", etc. unless paired with specific subject details.
- If the same placeholder intent repeats, vary the angle/framing so the final edit doesn't feel looped.`
}

export async function generateProposal({
  scenes,
  brandBrief,
  extraInstructions,
  metric,
  modelId,
  totalDurationSec,
  targetDurationSec,
  criteria,
  capabilities,
} = {}) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new Error('Shot log is empty — run Analysis first.')
  }
  if (scenes.filter((s) => !s?.excluded).length === 0) {
    throw new Error('Every scene is excluded. Re-include at least one scene in Analysis to draft a proposal.')
  }
  // Stricter second gate: among non-excluded scenes, we also need at
  // least one with a caption / visual / videoAnalysis to feed the LLM.
  // Catches the case where every shot failed the Gemini analyzer.
  if (scenes.filter(eligibleForProposal).length === 0) {
    throw new Error("No analyzed shots available for the proposal. Run 'Re-caption all' in the Analysis view (Gemini recommended) so each shot has at least a caption or a video analysis, then try again.")
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
  let lastModel = modelId || null

  // Single attempt helper so we can re-run with a correction note if
  // the first pass undershoots the budget (which local Qwen2.5-VL
  // reliably does when the duration target requires padding with
  // placeholders). Routing through reeditLlmClient.chatCompletion
  // so this path works for both LM Studio and the Anthropic backend
  // without the proposer knowing which is active.
  const runOnce = async (correctionNote) => {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ scenes, brandBrief, extraInstructions, metric: targetMetric, totalDurationSec, targetDurationSec, criteria: effectiveCriteria, correctionNote, capabilities }) },
    ]
    const response = await chatCompletion({
      messages,
      temperature: 0.3,
      // 12000 tokens covers the case where Gemini 2.5 Pro (or 3.x)
      // runs with thinking enabled and burns 3-8k tokens of reasoning
      // before emitting the EDL JSON. The old 4000 cap left the
      // response empty on long shot logs — parser saw no JSON and the
      // UI showed "LLM response was not valid JSON". Claude / LM Studio
      // don't bill unused tokens so the higher ceiling is free for
      // those backends.
      maxTokens: 12000,
      task: LLM_TASKS.PROPOSAL,
    })
    const rawText = response?.choices?.[0]?.message?.content || ''
    // The dispatcher picks a model based on the active backend; pass
    // it back out so the returned proposal records which one ran.
    lastModel = response?.model || lastModel
    const parsed = extractJson(rawText)
    if (!parsed) throw new Error('LLM response was not valid JSON. Try re-generating.')
    const rawEdl = Array.isArray(parsed.edl) ? parsed.edl : []
    let cursor = 0
    const normalized = rawEdl.map((row, i) => {
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
    return { rationale: String(parsed.rationale || ''), edl: normalized, rawText }
  }

  // Try once, validate the duration estimate, re-prompt with a
  // correction if we're outside ±15% of the target. Bail after one
  // retry — a stubborn under-selector won't be reformed by a third
  // pass, and the user can still massage the output by adding rows
  // in the UI.
  let attempt = await runOnce(null)
  if (Number.isFinite(targetDurationSec) && targetDurationSec > 0) {
    const first = estimateEdlDuration(attempt.edl, scenes)
    const tolerance = targetDurationSec * 0.15
    if (Math.abs(first - targetDurationSec) > tolerance) {
      const deficit = targetDurationSec - first
      const correction = deficit > 0
        ? `Your previous EDL totaled ${first.toFixed(1)}s but the target is ${targetDurationSec.toFixed(1)}s — you are ${deficit.toFixed(1)}s SHORT. Add more rows (original scenes or placeholders) until the sum hits the target. Do NOT return an EDL under the budget.`
        : `Your previous EDL totaled ${first.toFixed(1)}s but the target is ${targetDurationSec.toFixed(1)}s — you are ${Math.abs(deficit).toFixed(1)}s OVER. Remove ${Math.ceil(Math.abs(deficit) / Math.max(0.5, avgEligibleDuration(scenes)))} of the weakest rows.`
      try {
        const second = await runOnce(correction)
        const secondEst = estimateEdlDuration(second.edl, scenes)
        // Keep whichever attempt is closer to target.
        if (Math.abs(secondEst - targetDurationSec) < Math.abs(first - targetDurationSec)) {
          attempt = second
        }
      } catch (err) {
        console.warn('[reedit] retry failed, keeping first attempt:', err)
      }
    }
  }

  const { rationale, edl: normalized, rawText } = attempt

  return {
    rationale,
    edl: normalized,
    metric: targetMetric,
    brandBrief: brandBrief || '',
    extraInstructions: extraInstructions || '',
    targetDurationSec: Number.isFinite(targetDurationSec) ? targetDurationSec : null,
    // Record the capabilities the model was allowed to use. Lets the
    // UI show "this proposal was made under rules X/Y/Z" and keeps
    // the draft reproducible when someone re-opens the project later.
    capabilities: capabilities ? { ...capabilities } : null,
    model: lastModel,
    createdAt: new Date().toISOString(),
    status: 'draft',
    rawText,
  }
}

// Helper used by the retry correction math.
function avgEligibleDuration(scenes) {
  const elig = (scenes || []).filter((s) => !s?.excluded)
  if (elig.length === 0) return 1
  const total = elig.reduce((sum, s) => sum + (Number(s.duration) || (Number(s.tcOut) - Number(s.tcIn)) || 0), 0)
  return total / elig.length
}
