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
import { chatCompletion, LLM_TASKS, LLM_BACKENDS, loadLlmSettings } from './reeditLlmClient'
import { INLINE_BYTE_LIMIT } from './geminiClient'
import { loadCapabilitySettings } from './reeditCapabilitySettings'

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

// System prompt varies with the footage-generation capability: if the
// user doesn't allow AI fill shots, it would be contradictory (and
// often confusing to the model) to advertise them in the role
// description. The rest of the brief stays identical regardless.
function buildSystemPrompt(capabilities) {
  const allowFill = Boolean(capabilities?.footageGeneration)
  const roleTail = allowFill
    ? 'using only its already-filmed shots plus, when a structural gap truly requires it, a few AI-generated placeholder shots you explicitly propose'
    : 'using only its already-filmed shots — you cannot add, generate, or invent new footage'
  return `You are a senior advertising creative director helping to re-edit an existing commercial ${roleTail}. You work from a shot log and return a concrete, ordered edit decision list (EDL) with per-shot rationale. You return ONLY a JSON object, no commentary, no markdown fences.`
}

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

  // Active optimization (Wan VACE graphics removal). Surface the
  // version tag so the LLM can reason about which shots now have
  // their on-screen text/logo removed vs still carry it. This is the
  // shot that will actually play on the timeline, so the LLM's mental
  // model should match that reality (e.g. a shot with its CTA removed
  // is now available to reuse in places it wasn't before).
  if (scene.activeOptimizationVersion) {
    lines.push(`Optimized: ${scene.activeOptimizationVersion} — on-screen graphics (text / logo overlays) have been removed via Wan VACE; the Graphics block below describes the ORIGINAL overlays, which are no longer visible on the active clip.`)
  }

  const visual = va.visual || scene.caption || st.visual
  if (visual) lines.push(`Visual: ${visual}`)

  // Bbox helpers — format the bbox into a single coordinate-heavy line
  // the LLM can copy into `anchor=`. We emit BOTH brand_mark_bbox and
  // subject_bbox when available so the proposer can pick the right
  // anchor per reframe intent (brand-focused vs generic push-in).
  const formatBbox = (bbox, fallbackLabel) => {
    if (!bbox || !Array.isArray(bbox.box_2d) || bbox.box_2d.length < 4) return null
    const [ymin, xmin, ymax, xmax] = bbox.box_2d.map((n) => Number(n) / 1000)
    if (![ymin, xmin, ymax, xmax].every((v) => Number.isFinite(v))) return null
    const cx = ((xmin + xmax) / 2).toFixed(2)
    const cy = ((ymin + ymax) / 2).toFixed(2)
    const w = (xmax - xmin).toFixed(2)
    const h = (ymax - ymin).toFixed(2)
    return { cx, cy, w, h, label: bbox.label || fallbackLabel, loose: (xmax - xmin) > 0.3 || (ymax - ymin) > 0.3 }
  }
  const brandMark = formatBbox(va.brand_mark_bbox, 'brand mark')
  if (brandMark && !brandMark.loose) {
    lines.push(`BrandMark: ${brandMark.label} centered at [${brandMark.cx},${brandMark.cy}] (bbox ~${brandMark.w}×${brandMark.h}) — use this anchor for any brand-focused REFRAME`)
  } else if (!brandMark) {
    lines.push('BrandMark: none visible — do NOT propose a brand-focused REFRAME on this shot')
  }
  const subject = formatBbox(va.subject_bbox, 'hero subject')
  if (subject) {
    const looseNote = subject.loose ? ' (LOOSE — too wide for a tight reframe; skip REFRAME on this shot)' : ''
    lines.push(`Subject: ${subject.label} centered at [${subject.cx},${subject.cy}] (bbox ~${subject.w}×${subject.h})${looseNote}`)
  }

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

  // Cinematography line — structured filmmaker vocabulary captured
  // by the analyzer (CHAI-inspired taxonomy). Compresses shot_size,
  // angle, lens, DOF, focus dynamics, lighting style, and special
  // techniques into one scannable line so the proposer can reason
  // about visual continuity (e.g. "follow a wide locked-off with a
  // shallow-DOF push-in", "match shadows-to-shadows on a low-key
  // pair"). Only emit fields that are present and non-'unknown'.
  const cin = va.cinematography || null
  if (cin) {
    const cinPieces = []
    if (cin.shot_size && cin.shot_size !== 'unknown') cinPieces.push(`shot=${cin.shot_size}`)
    if (cin.camera_angle && cin.camera_angle !== 'unknown' && cin.camera_angle !== 'eye_level') cinPieces.push(`angle=${cin.camera_angle}`)
    if (cin.camera_movement_quality && cin.camera_movement_quality !== 'unknown') cinPieces.push(`rig=${cin.camera_movement_quality}`)
    if (cin.lens_characteristic && cin.lens_characteristic !== 'unknown') cinPieces.push(`lens=${cin.lens_characteristic}`)
    if (cin.depth_of_field && cin.depth_of_field !== 'unknown') cinPieces.push(`DOF=${cin.depth_of_field}`)
    if (cin.focus_dynamics && cin.focus_dynamics !== 'unknown' && cin.focus_dynamics !== 'locked') cinPieces.push(`focus=${cin.focus_dynamics}`)
    if (cin.composition && cin.composition !== 'unknown') cinPieces.push(`comp=${cin.composition}`)
    if (cin.lighting_style && cin.lighting_style !== 'unknown') cinPieces.push(`light=${cin.lighting_style}`)
    if (cin.color_palette) cinPieces.push(`palette=${cin.color_palette}`)
    if (Array.isArray(cin.special_techniques) && cin.special_techniques.length) {
      cinPieces.push(`techniques=[${cin.special_techniques.join(', ')}]`)
    }
    if (cinPieces.length) lines.push(`Cinematography: ${cinPieces.join(' · ')}`)
  }

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
  // logo / overlay elements. When the analyzer produced bounding boxes
  // we surface the center point (normalised 0..1 on each axis) so the
  // proposer can use it directly as a REFRAME anchor — the
  // `graphics.bboxes[].box_2d` comes in `[ymin, xmin, ymax, xmax]`
  // normalised to 0..1000 per the analyzer prompt.
  if (va.graphics) {
    const g = va.graphics
    const gfxPieces = []
    const bboxCenterFor = (role) => {
      const bboxes = Array.isArray(g.bboxes) ? g.bboxes : []
      // Match either by exact role string or by a looser substring for
      // the role the proposer cares about (logo / wordmark / tagline).
      const hit = bboxes.find((b) => typeof b?.role === 'string' && b.role.toLowerCase().includes(role))
      if (!hit || !Array.isArray(hit.box_2d) || hit.box_2d.length < 4) return null
      const [ymin, xmin, ymax, xmax] = hit.box_2d.map((n) => Number(n) || 0)
      const cx = ((xmin + xmax) / 2) / 1000
      const cy = ((ymin + ymax) / 2) / 1000
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
      return { x: cx.toFixed(2), y: cy.toFixed(2) }
    }
    if (g.text_content) {
      const role = g.text_role && g.text_role !== 'none' ? ` (${g.text_role})` : ''
      const center = bboxCenterFor(g.text_role || 'caption') || bboxCenterFor('title') || bboxCenterFor('subtitle')
      const posHint = center ? ` at [${center.x},${center.y}]` : ''
      gfxPieces.push(`text${role}="${g.text_content}"${posHint}`)
    }
    if (g.logo_description || g.has_logo) {
      const center = bboxCenterFor('logo') || bboxCenterFor('wordmark') || bboxCenterFor('logo_symbol')
      const posHint = center ? ` at [${center.x},${center.y}]` : ''
      const desc = g.logo_description || 'brand logo'
      gfxPieces.push(`logo=${desc}${posHint}`)
    }
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

// Render the analysed shots from `additionalAssets.extraFootage` as a
// secondary shot log the proposer is allowed to pull from. Each scene
// gets a synthetic `id` (the same one persisted on the additional
// asset's scene entry, prefixed with `add-`) so the EDL can reference
// it directly. We only include scenes that have a `videoAnalysis` —
// un-analyzed shots have nothing useful to show the LLM.
function renderAdditionalShotLog(additionalAssets) {
  const extraFootage = additionalAssets?.extraFootage || []
  if (!Array.isArray(extraFootage) || extraFootage.length === 0) return ''
  const blocks = []
  for (const asset of extraFootage) {
    const scenes = Array.isArray(asset?.scenes) ? asset.scenes : []
    // Single-clip files (no scene split) still get treated as a single
    // shot when analysed: synthesise a virtual scene entry the same
    // way the apply path does.
    const effectiveScenes = scenes.length > 0
      ? scenes.filter((s) => s.videoAnalysis)
      : (asset.videoAnalysis ? [{ id: asset.id, tcIn: 0, tcOut: asset.duration || 0, duration: asset.duration || 0, videoAnalysis: asset.videoAnalysis, caption: asset.caption || '' }] : [])
    for (const scene of effectiveScenes) {
      // Reuse the source-shot formatter so the structure (chips,
      // motion, cinematography lines) matches exactly. `formatSceneBlock`
      // expects `videoAnalysis`, `caption`, `tcIn`, `tcOut`, `duration`,
      // `id` — we already match that schema on additional shots.
      const sceneShape = {
        id: scene.id,
        tcIn: scene.tcIn,
        tcOut: scene.tcOut,
        duration: scene.duration || (scene.tcOut - scene.tcIn) || 0,
        caption: scene.caption || '',
        videoAnalysis: scene.videoAnalysis,
        // Tag the source filename so the LLM has provenance context
        // (e.g. it's a "Honda 30s spot" vs a loose drone shot).
        structured: { brand: '', emotion: '', framing: '', movement: '' },
      }
      const block = formatSceneBlock(sceneShape)
      // Prefix each block with a "Source:" line so the LLM knows which
      // imported file the shot came from — useful when the user has
      // mixed multiple ads worth of additional footage.
      blocks.push(`Source: ${asset.name}\n${block}`)
    }
  }
  if (blocks.length === 0) return ''
  return `\n\n# Alternative footage available (from your imported additional material)
These shots are NOT in the source ad's cut but you imported them as additional material. You MAY substitute them into the EDL by using their \`id\` as \`sourceSceneId\` (the ids start with \`add-\`). Use them when:
- a beat in the source ad doesn't have great coverage and one of these is a clear win;
- a particular emotion or framing is missing from the source but available here.
Don't lean on these heavily — the source ad's shots stay primary; alternative footage is a tool, not the canvas.

${blocks.join('\n\n---\n\n')}`
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
    let dur = Math.max(0.1, Number(scene.tcOut) - Number(scene.tcIn))
    // EXTEND adds AI-generated continuation onto the end of the scene
    // — count those seconds toward the budget so the corrective retry
    // doesn't keep telling the LLM it's short when extends are
    // already filling the gap. Already clamped at parse time to the
    // user's max.
    if (row?.extend?.seconds) dur += Math.max(0, Number(row.extend.seconds) || 0)
    total += dur
  }
  return total
}

// Extract a structured reframe from the `REFRAME [...]` directive the
// LLM writes into `row.note`. Returns `null` when no directive is
// present, otherwise `{ zoom, anchorX, anchorY }` with sane defaults
// filled in for any missing component. The regex is forgiving —
// params can appear in either order and anchor values can use `.` or
// nothing between them — because the model isn't perfect about the
// exact format even when we document it.
// Extract a structured extension from the `EXTEND +<seconds>s:` directive.
// Returns null when the directive isn't present, otherwise `{ seconds }`
// clamped to the [0.2, capabilitySettings.footageExtend.maxExtendSec]
// range. The cap lives in Settings → Capabilities so users can opt into
// longer extensions (at the cost of more visible drift). Default 2.0 s.
function parseExtendDirective(note) {
  if (!note || typeof note !== 'string') return null
  if (!/\bEXTEND\b/i.test(note)) return null
  const m = /\bEXTEND\b\s*:?\s*\+?\s*([\d.]+)\s*s?/i.exec(note)
  if (!m) return null
  const raw = parseFloat(m[1])
  if (!Number.isFinite(raw) || raw <= 0) return null
  const maxSec = Number(loadCapabilitySettings()?.footageExtend?.maxExtendSec) || 2
  const clamped = Math.max(0.2, Math.min(maxSec, raw))
  return { seconds: Math.round(clamped * 10) / 10 }
}

// Safety net for the case where the LLM proposes a REFRAME with an
// anchor that would clip the subject out of the post-crop window. We
// read the scene's subject_bbox first (the hero element, guaranteed
// by the analyzer prompt), falling back to graphics.bboxes for a
// logo/wordmark entry when no subject_bbox is present (older
// analysis passes). Adjust the reframe so the subject stays fully
// inside the visible window; this runs AFTER parseReframeDirective
// so a dropped directive (zoom without anchor, or centered anchor
// with high zoom) isn't revived here.
function pickSubjectBbox(scene) {
  // 1st choice: a literal brand mark (logo / badge / wordmark). This
  // is the tightest + most specific anchor when the proposer wants to
  // "establish brand" — a kidney grille bbox is NOT this.
  const bm = scene?.videoAnalysis?.brand_mark_bbox
  if (bm && Array.isArray(bm.box_2d) && bm.box_2d.length >= 4) return bm.box_2d
  // 2nd: the hero subject — required for every shot, but may be
  // broader than a brand mark (a face, a product silhouette).
  const sb = scene?.videoAnalysis?.subject_bbox
  if (sb && Array.isArray(sb.box_2d) && sb.box_2d.length >= 4) return sb.box_2d
  // 3rd: any logo / wordmark bbox from graphics (legacy path).
  const gfxBboxes = scene?.videoAnalysis?.graphics?.bboxes
  if (Array.isArray(gfxBboxes) && gfxBboxes.length > 0) {
    const logo = gfxBboxes.find((b) => typeof b?.role === 'string' && /logo|wordmark/i.test(b.role))
    if (logo && Array.isArray(logo.box_2d) && logo.box_2d.length >= 4) return logo.box_2d
  }
  return null
}

function snapReframeToLogo(reframe, scene) {
  if (!reframe) return null
  const raw = pickSubjectBbox(scene)
  if (!raw) return reframe
  const [ymin, xmin, ymax, xmax] = raw.map((n) => Number(n) / 1000)
  if (![ymin, xmin, ymax, xmax].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return reframe
  // Bbox sanity: if the analyzer boxed the parent object (whole grille,
  // whole face) rather than the tight subject (logo, eye), the centre
  // is almost meaningless as a reframe anchor — pushing in on a
  // 0.40×0.47 box lands "somewhere near the middle of the grille",
  // not on a specific element. Drop the reframe so the shot plays at
  // its native framing instead of a misleading center-ish zoom.
  // The threshold mirrors the amber "loose bbox" warning in
  // AnalysisView so the user sees the same bar on both views.
  const bboxW = xmax - xmin
  const bboxH = ymax - ymin
  if (bboxW > 0.3 || bboxH > 0.3) return null
  const logoW = xmax - xmin
  const logoH = ymax - ymin
  const subjectCx = (xmin + xmax) / 2
  const subjectCy = (ymin + ymax) / 2
  // Policy: respect the LLM's anchor only when it's within 0.1 of the
  // subject center on both axes (half-meaningful deviation — e.g. it
  // wanted rule-of-thirds). Beyond that tolerance the LLM is almost
  // certainly wrong — guessing without looking at the analyzer's
  // ground-truth subject position. Snap hard to the subject center in
  // that case so the preview actually lands on the subject.
  const anchorFar = (
    Math.abs(reframe.anchorX - subjectCx) > 0.1
    || Math.abs(reframe.anchorY - subjectCy) > 0.1
  )
  let nextAnchorX = anchorFar ? subjectCx : reframe.anchorX
  let nextAnchorY = anchorFar ? subjectCy : reframe.anchorY
  // If the subject doesn't fit inside the crop at this zoom, reduce
  // zoom so the subject fills ~90 % of the crop. Clamp to 1.0–2.5 to
  // respect the same bounds parseReframeDirective uses.
  let nextZoom = reframe.zoom
  const maxSubjectSpan = Math.max(logoW, logoH)
  const cropSpan = 1 / nextZoom
  if (maxSubjectSpan > 0.9 * cropSpan) {
    nextZoom = Math.max(1.0, Math.min(reframe.zoom, 0.9 / maxSubjectSpan))
  }
  // Final clamp: anchor must keep the crop window inside [0,1] on both
  // axes AND keep the subject bbox inside the crop. When the two
  // constraints can't both be satisfied (subject too big for crop even
  // after zoom reduction), we centre on the subject — better than
  // chopping it off.
  const halfW = 1 / nextZoom / 2
  const halfH = 1 / nextZoom / 2
  const axMin = Math.max(halfW, xmax - halfW)
  const axMax = Math.min(1 - halfW, xmin + halfW)
  const ayMin = Math.max(halfH, ymax - halfH)
  const ayMax = Math.min(1 - halfH, ymin + halfH)
  if (axMin <= axMax) nextAnchorX = Math.max(axMin, Math.min(axMax, nextAnchorX))
  else nextAnchorX = subjectCx
  if (ayMin <= ayMax) nextAnchorY = Math.max(ayMin, Math.min(ayMax, nextAnchorY))
  else nextAnchorY = subjectCy
  const moved = (
    Math.abs(nextAnchorX - reframe.anchorX) > 0.02
    || Math.abs(nextAnchorY - reframe.anchorY) > 0.02
    || Math.abs(nextZoom - reframe.zoom) > 0.05
  )
  if (!moved) return reframe
  return {
    zoom: Math.round(nextZoom * 100) / 100,
    anchorX: Math.round(nextAnchorX * 100) / 100,
    anchorY: Math.round(nextAnchorY * 100) / 100,
    snappedToLogo: true,
  }
}

function parseReframeDirective(note) {
  if (!note || typeof note !== 'string') return null
  if (!/\bREFRAME\b/i.test(note)) return null
  const zoomMatch = /\bzoom\s*=\s*([\d.]+)/i.exec(note)
  const anchorMatch = /\banchor\s*=\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(note)
  const zoomRaw = zoomMatch ? parseFloat(zoomMatch[1]) : NaN
  const axRaw = anchorMatch ? parseFloat(anchorMatch[1]) : NaN
  const ayRaw = anchorMatch ? parseFloat(anchorMatch[2]) : NaN
  // Drop the directive when zoom > 1.0 but the LLM forgot the anchor.
  // A center-zoom is almost never the repositioning the prompt asked
  // for — the user sees a shot that looks exactly like the original
  // with everything cropped off the edges, which reads as a regression.
  // We'd rather land a clean "no reframe" than apply a misleading one.
  const hasValidZoom = Number.isFinite(zoomRaw) && zoomRaw > 1
  const hasValidAnchor = Number.isFinite(axRaw) && Number.isFinite(ayRaw)
  if (hasValidZoom && !hasValidAnchor) return null
  if (!hasValidZoom && !hasValidAnchor) return null
  // Clamp zoom to the user's configured max scale (Settings →
  // Capabilities → Footage reframe). The knob is stored as a percentage
  // (130 = 1.30×) so divide by 100 before clamping. Floor at 1.05 so a
  // mis-configured 100 % setting doesn't effectively disable reframe.
  const maxZoom = Math.max(1.05, (Number(loadCapabilitySettings()?.footageReframe?.maxScalePct) || 130) / 100)
  const zoom = hasValidZoom ? Math.min(zoomRaw, maxZoom) : 1.2
  const anchorX = Math.max(0, Math.min(1, axRaw))
  const anchorY = Math.max(0, Math.min(1, ayRaw))
  // Reject the common failure mode: the LLM agrees REFRAME is needed,
  // includes the `anchor=` token to pass the format check, but writes
  // 0.5,0.5 (dead center) because it didn't actually work out where
  // the subject is. A zoom > 1.2 with a centered anchor is a pure
  // symmetric crop — it never improves placement and frequently chops
  // off exactly the element the rationale claims to emphasise. The
  // snap safety net can't help when there's no subject bbox (common
  // case: physical brand elements like a BMW badge aren't flagged as
  // "graphics" by the analyzer). Drop the reframe and let the shot
  // play at its native framing — better than a misleading preview.
  const isCenteredAnchor = Math.abs(anchorX - 0.5) < 0.05 && Math.abs(anchorY - 0.5) < 0.05
  if (zoom > 1.2 && isCenteredAnchor) return null
  return { zoom, anchorX, anchorY }
}

// Extract a structured color correction from the `COLOR: ...` directive
// the LLM writes into `row.note`. Returns null when no directive is
// present, otherwise an object keyed by the app's adjustment field names
// (which differ from the UI labels: UI says "Exposure" but the data
// layer keys it as `brightness`). Values clamp to -100..+100 for all
// axes except `hue`, which is -180..+180.
//
// The regex matches each key=value pair independently so the model can
// emit any subset and in any order, and accepts optional '+' prefix and
// decimal values since models love to return floats even when we ask
// for integers. We ignore unknown keys.
const COLOR_AXIS_MAP = {
  // UI label → data key
  exposure: { key: 'brightness', min: -100, max: 100 },
  brightness: { key: 'brightness', min: -100, max: 100 },
  contrast: { key: 'contrast', min: -100, max: 100 },
  saturation: { key: 'saturation', min: -100, max: 100 },
  gain: { key: 'gain', min: -100, max: 100 },
  gamma: { key: 'gamma', min: -100, max: 100 },
  offset: { key: 'offset', min: -100, max: 100 },
  hue: { key: 'hue', min: -180, max: 180 },
}

function parseColorDirective(note) {
  if (!note || typeof note !== 'string') return null
  if (!/\bCOLOR\b\s*:/i.test(note)) return null
  // Capture the segment after "COLOR:" up to the first period or end of
  // line so a rationale tail ("warm sun-soaked grade") doesn't get
  // mined for numbers.
  const segMatch = /\bCOLOR\b\s*:\s*([^\n\.]+)/i.exec(note)
  const segment = segMatch ? segMatch[1] : note
  const result = {}
  for (const [alias, { key, min, max }] of Object.entries(COLOR_AXIS_MAP)) {
    const re = new RegExp(`\\b${alias}\\s*=\\s*([+-]?\\d+(?:\\.\\d+)?)`, 'i')
    const m = re.exec(segment)
    if (!m) continue
    const raw = parseFloat(m[1])
    if (!Number.isFinite(raw)) continue
    const clamped = Math.max(min, Math.min(max, Math.round(raw)))
    // Skip zero values — no reason to emit a no-op adjustment, and it
    // keeps the merged clip settings tidy when inspecting.
    if (clamped === 0) continue
    result[key] = clamped
  }
  return Object.keys(result).length > 0 ? result : null
}

// Human-friendly descriptions of each capability for the prompt. We
// stay deliberately prescriptive in the copy: the goal is for the
// model to treat these as hard rules, not suggestions.
function renderCapabilitiesBlock(capabilities) {
  const c = capabilities || {}
  // User knobs from Settings → Capabilities flow into the prompt here
  // so the LLM respects per-user limits (max extend seconds, max
  // placeholder duration, content filters for gen fills). Falls back
  // to the module defaults when settings haven't been written yet.
  const kn = loadCapabilitySettings()
  const maxExtendSec = Number(kn?.footageExtend?.maxExtendSec) || 2.0
  const maxGenDurSec = Number(kn?.footageGeneration?.maxDurationSec) || 4
  const allowProducts = kn?.footageGeneration?.allowProducts !== false
  const allowFaces = kn?.footageGeneration?.allowFaces !== false
  const allowText = Boolean(kn?.footageGeneration?.allowText)
  const genFilterLines = [
    allowProducts ? null : 'You MUST NOT propose placeholder shots whose subject is a product, packaging, or product label. Skip any idea that requires generating a product shot.',
    allowFaces ? null : 'You MUST NOT propose placeholder shots whose subject is a human face (actors, drivers, close-ups of faces). Describe hands, silhouettes, or environment-level shots instead when brand presence calls for a human beat.',
    allowText ? null : 'You MUST NOT propose placeholder shots that require on-screen text, titles, taglines, or wordmarks — text generation is unreliable. If a beat needs to SAY something, write the note so it\'s conveyed through imagery alone.',
  ].filter(Boolean).map((line) => `      ${line}`).join('\n')
  const lines = []
  lines.push('# Capabilities (HARD RULES — respect exactly)')
  lines.push(c.footageGeneration
    ? [
        `- Footage generation: ENABLED. You MAY add 1–3 \`placeholder\` rows to fill structural gaps, as specified in the output schema below.`,
        `      Each placeholder shot is capped at **${maxGenDurSec.toFixed(1)} s maximum** — longer generated footage drifts. Do NOT propose placeholders longer than this.`,
        genFilterLines || null,
      ].filter(Boolean).join('\n')
    : '- Footage generation: DISABLED. You MUST NOT propose any `placeholder` rows. Every row in the EDL must be `kind: "original"` and reference a scene that exists in the shot log.')
  lines.push(c.footageExtend
    ? `- Footage extend: ENABLED. Flag a shot with \`EXTEND +<seconds>s:\` to add AI-generated continuation at the END of that shot. Extensions are capped at **+${maxExtendSec.toFixed(1)} s per shot** (anything more is clamped down). This is a PRIMARY tool for hitting the target duration when the source ad is shorter than the cut you're building — every shot in the EDL is a candidate for EXTEND, and you can add it to as many as needed. Prefer extending shots that can sustain a longer beat (held looks, slow camera moves, ambient establishing shots) over fast-cutting action. Example: \`EXTEND +${Math.min(1.5, maxExtendSec).toFixed(1)}s: hold on the driver's reveal for one extra beat before the cut\`.`
    : '- Footage extend: DISABLED. You MUST NOT annotate shots with EXTEND directives. If a gap needs more time, solve it by reordering or (if enabled) a placeholder, never by stretching a shot.')
  lines.push(c.footageReframe
    ? '- Footage reframe: ENABLED. You MAY mark shots for re-framing (zoom + pan within the same aspect ratio) when a tighter or repositioned view would land a beat better.\n  **FORMAT (non-negotiable)**: `REFRAME zoom=<X.X> anchor=<x>,<y>: <rationale>` — zoom in 1.0–2.5, anchor both values 0–1 (0,0 = top-left, 1,1 = bottom-right, 0.5,0.5 = center). You MUST emit BOTH `zoom=` AND `anchor=` on every REFRAME. A directive missing `anchor=` is invalid and will be silently dropped — a pure zoom is a symmetric center-crop, which almost never improves brand placement and usually chops off the element you wanted to emphasise.\n  **HOW TO PICK THE ANCHOR — READ THE `BrandMark` AND `Subject` LINES OF THE SHOT LOG**:\n    * If your rationale mentions establishing the brand, logo, badge, or identity: the shot MUST have a `BrandMark: <label> centered at [x,y]` line. Copy THOSE coordinates into `anchor=`. If instead the shot says `BrandMark: none visible`, the shot has no literal logo — DO NOT propose a brand-focused REFRAME on it. Pick a different shot to establish brand.\n    * For any other REFRAME intent (push in on driver, tighten on product, emphasise reveal), use the `Subject: <label> centered at [x,y]` coordinates.\n    * If the Subject line ends with `LOOSE`, the bbox is too wide to be a reliable anchor — DO NOT reframe this shot, pick a different one.\n  Example: if `BrandMark: BMW roundel centered at [0.51,0.38]` is in the shot log, `REFRAME zoom=1.6 anchor=0.51,0.38: push in on the BMW roundel to land the brand identity` is correct. Using `anchor=0.5,0.5` on that same shot crops the roundel off the top-left.\n  **GOOD examples** (anchor derived from actual subject position):\n    * `REFRAME zoom=1.4 anchor=0.5,0.42: logo reads at 0.5,0.42 per the Graphics line — tighten on it without clipping the top`\n    * `REFRAME zoom=1.3 anchor=0.3,0.4: driver\'s face sits in the upper-left third per the Visual description; push toward it`\n    * `REFRAME zoom=1.5 anchor=0.5,0.85: tagline is bottom-center; crop in so the copy fills the screen`\n  **BAD examples** (will be dropped):\n    * `REFRAME: zoom=1.3: Opens on the logo` — no anchor, just a center zoom\n    * `REFRAME zoom=1.5 anchor=0.5,0.5: push in on the BMW grille` — Graphics line said the logo was at 0.5,0.42 but the proposal used 0.5,0.5 → logo gets cropped off the top\n  **HARD RULE (ENFORCED BY PARSER)**: any REFRAME with `zoom > 1.2` and `anchor=0.5,0.5` (or within ±0.05 of dead center on both axes) will be DROPPED automatically. The parser treats that combination as "the LLM didn\'t bother to locate the subject" — a symmetric center-crop is almost never the right answer for a reframe. If the subject truly sits dead-center in the frame AND a modest zoom is enough, just use `zoom=1.15 anchor=0.5,0.5` (light enough to stay within tolerance). Otherwise pick a real anchor or don\'t reframe at all.\n  Aspect stays at the delivery target — do NOT change aspect ratio.'
    : '- Footage reframe: DISABLED. You MUST NOT annotate shots with REFRAME directives. Every shot plays at its native framing.')
  lines.push(c.colorCorrection
    ? '- Color correction: ENABLED. You MUST actively consider color grading as part of the re-edit. Whenever the target metric, framework, brand brief, or ad-concept section mentions visual qualities (e.g. "bright", "high-contrast", "warm", "cool", "vibrant", "desaturated", "moody", "clinical", "cinematic"), you SHOULD annotate the shots that fail those qualities with a corrective `COLOR:` directive — do not silently ignore the cue. Prefix the note with `COLOR:` followed by any combination of these keys (all integer values in the -100..+100 range unless noted, 0 = no change): `exposure`, `contrast`, `saturation`, `gain`, `gamma`, `offset`, `hue` (-180..+180 degrees). Example: `COLOR: exposure=+18 contrast=+22 saturation=-6: lift the blacks and punch the mids so the product reads on small screens`. Another: `COLOR: saturation=-25 gain=-8: drain the clinic scene to neutral before the product reveal`. Keep grades subtle — ±10 to ±25 on each axis is a strong edit; ±50 is destructive. Use a maximum of 4 keys per shot; leave the rest neutral. If a shot is already on-concept, omit the directive.'
    : '- Color correction: DISABLED. You MUST NOT annotate shots with COLOR directives. Every shot plays with the source grade.')
  lines.push(c.useOriginalMusic
    ? '- Use original music stem: ENABLED. The source video\'s music has been separated via Demucs into an isolated stem. You MAY layer that music stem under ANY row of the EDL — including placeholder rows and shots that had no music in the original cut. To request this on a row, prefix the note with `AUDIO music:` (e.g. `AUDIO music: carry the main theme under this shot`).'
    : '- Use original music stem: DISABLED. Do NOT propose layering the isolated music stem freely. Music stays glued to its source shot as recorded.')
  lines.push(c.useOriginalVoiceover
    ? '- Use original voiceover stem: ENABLED. The source video\'s voiceover has been separated via Demucs into an isolated stem. You MAY reuse VO lines on any row, decoupled from where they originally appeared. Prefix the note with `AUDIO vo: "<exact verbatim line>"` to indicate which VO line should play there.'
    : '- Use original voiceover stem: DISABLED. Do NOT propose reusing VO lines outside their original shot. VO and the shot where it was recorded stay bound together.')
  return lines.join('\n')
}

// Render the overall ad concept block. The creative strategist view of
// the ad (concept / message / mood / audience / brand role / arc) lets
// the proposer re-edit with the ORIGINAL intent in mind — without it,
// the model can only infer from shots, and "subtle" ideas (a quiet
// reveal, a callback, a metaphor) tend to get steamrolled into a
// generic highlight reel. Returns empty string when no overall
// analysis has been run yet; caller sections it in conditionally.
// Render the voiceover script block — a time-stamped list of the VO
// segments captured by the overall-analysis pass. The proposer gets
// this when the VO capability is enabled AND the user has Auto-edit
// turned on (the manual mode bypasses the LLM entirely and uses the
// user's explicit picks). Without this block the LLM has no handle on
// which phrases to keep when shortening from 30s → 15s.
function renderVoiceoverScriptBlock(voSegments, targetDurationSec) {
  if (!Array.isArray(voSegments) || voSegments.length === 0) return ''
  const lines = voSegments.map((s) => {
    const dur = Math.max(0, Number(s.endSec) - Number(s.startSec))
    const role = s.role && s.role !== 'line' ? ` [${s.role}]` : ''
    return `- id="${s.id}" (${Number(s.startSec).toFixed(1)}s, ${dur.toFixed(1)}s long)${role}: "${s.text}"`
  })
  const totalVoDur = voSegments.reduce((sum, s) => sum + Math.max(0, Number(s.endSec) - Number(s.startSec)), 0)
  const hasTagline = voSegments.some((s) => s.role === 'tagline')
  const targetLine = Number.isFinite(targetDurationSec) && targetDurationSec > 0
    ? `Pick the subset of segments whose combined spoken duration fits in roughly ${Math.min(targetDurationSec, targetDurationSec * 0.85).toFixed(1)}s of VO time (leaving ~15 % of the target for breath / pauses between segments).`
    : 'Pick the subset of segments that best tell the story; drop redundant lines.'
  // Compute a target window for the closing line so the tagline lands
  // near the end of the re-edit instead of being concatenated at the
  // top. We aim for "last ~20 % of the timeline" — generous enough that
  // the LLM doesn't have to nail it to the second.
  const taglineWindowText = (Number.isFinite(targetDurationSec) && targetDurationSec > 0)
    ? `between ${Math.max(0, targetDurationSec * 0.7).toFixed(1)}s and ${targetDurationSec.toFixed(1)}s on the timeline`
    : 'in the final third of the re-edit'
  return `\n\n# Voiceover script (segmented from the source VO)
Full VO is ${totalVoDur.toFixed(1)}s across ${voSegments.length} segment${voSegments.length === 1 ? '' : 's'}. ${targetLine} Keep the ORIGINAL ORDER of segments — do NOT reorder; only include or skip each one. Prefer segments that reinforce the core message and the brand role; drop legal disclaimers if the target is tight.

${lines.join('\n')}

## Placement on the re-edit timeline (CRITICAL)
By default the app concatenates picked VO segments back-to-back starting at t=0. That makes every line stack at the top of the cut and leaves the tail silent — wrong for almost every ad. Use \`segmentGaps\` to push segments later in the timeline so the VO breathes with the picture:

- Each value in \`segmentGaps\` is the silence (in seconds) inserted BEFORE that segment fires. Gaps STACK on top of the previous segment's end position. \`gap=0\` means "play immediately after the previous segment ends".
- Beat structure should drive the gaps: opening line lands early (gap≈0), middle lines breathe with the visual beats they support, **the tagline / closing line MUST land ${taglineWindowText}** so it pays off the last shot, not the first.${hasTagline ? ' One of the segments above is tagged `[tagline]` — that is the line whose placement matters most.' : ''}
- Keep gaps realistic: 0.3-2 s between conversational lines, 1.5-6 s before a tagline so it has air. Do not insert a gap so large the VO would extend past the timeline — the placer truncates anything past the end.
- If you are intentionally stacking everything tight (e.g. dense product-feature voiceover), it's fine to leave \`segmentGaps\` empty — but never let the tagline land in the first half of the cut.

In addition to the EDL, return a \`voiceoverPlan\` field at the top level of the JSON response:
  "voiceoverPlan": {
    "segmentIds": ["vo-0", "vo-2", "vo-3"],
    "segmentGaps": { "vo-0": 0.0, "vo-2": 1.2, "vo-3": 6.5 }
  }
Listing the ids (preserve order) of the VO segments that should play on the timeline, plus the silence-before-each-segment in seconds. \`segmentGaps\` is a flat map keyed by id; omitted ids default to 0 (no gap). If the full script fits, include every id. If VO should be silenced entirely, return \`segmentIds: []\`.`
}

// Render the FIXED voiceover script block when the user has the
// `generateVoiceover` capability on and selected a synthesised draft.
// Different from the original-VO block: the proposer doesn't pick or
// reorder anything — the user already wrote and synthesised the VO.
// We just tell the model what will play and when so it plans visual
// beats around it (e.g. don't put fast-cut action under a delicate
// closing line; don't park a still hero shot under silence).
function renderGeneratedVoiceoverBlock(generatedVoiceover) {
  if (!generatedVoiceover || !Array.isArray(generatedVoiceover.segments) || generatedVoiceover.segments.length === 0) return ''
  const segs = generatedVoiceover.segments
  const audio = generatedVoiceover.synthesis?.segmentAudio || {}
  // Compute placement: cumulative cursor, gap-before each segment,
  // segment duration from the synthesised WAV. Falls back to a 2.4
  // wps estimate if synth audio metadata is missing (UI may not have
  // populated durations on a stale draft).
  let cursor = 0
  const lines = []
  let totalDur = 0
  for (const s of segs) {
    const gap = Math.max(0, Number(s.gapBeforeSec) || 0)
    cursor += gap
    const dur = Number(audio[s.id]?.durationSec) || (((s.text || '').trim().split(/\s+/).filter(Boolean).length) / 2.4)
    const start = cursor
    const end = cursor + dur
    cursor = end
    totalDur = end
    const role = s.role && s.role !== 'line' ? ` [${s.role}]` : ''
    lines.push(`- ${start.toFixed(1)}s → ${end.toFixed(1)}s${role}: "${s.text}"`)
  }
  return `\n\n# Voiceover script (FIXED — already written and synthesised)
The user has authored a NEW voiceover script and synthesised it (cloning the source speaker's voice). It is NOT a transcript of the original ad — it is the new copy that WILL play under your re-edit, in the order shown. You CANNOT change the lines themselves. Total VO occupies ${totalDur.toFixed(1)}s of timeline content (lines + gaps).

${lines.join('\n')}

## How to anchor each VO line to a shot
The placer is **EDL-driven** — each VO line lands on the timeline at the \`newTcIn\` of whichever EDL row you annotate with it. To anchor a line, prefix that row's \`note\` with:
  \`AUDIO vo: "<exact verbatim text of the line>"\` — the quoted text MUST match the line in the script word-for-word so the placer can match it.

Choose anchors thoughtfully:
- Match each VO line to the shot that best illustrates / pays it off. Hero / static / contemplative shots tend to live under VO; fast-cut action lives between lines.
- **Do NOT anchor any VO line to a row whose \`newTcIn\` is below 1.5 s.** The picture needs at least 1.5 s of music + visuals to establish before the first line crashes in — VO at t=0 sounds rushed.
- The TAGLINE (last VO line) MUST anchor to a row near the END of the cut so the closing line pays off the final beat.
- Lines should anchor in the order they appear in the script — don't shuffle (the synthesised audio plays in order).
- It's OK to leave gaps between VO lines — that's the whole point of the cadence shown above.
- Do NOT return a \`voiceoverPlan\` field. Do NOT invent new VO lines. Use only the lines listed above, verbatim, in their script order.`
}

// Render a short block describing the music bed the user already
// authored / synthesised so the proposer can pace cuts to it. The
// block is only emitted when the `generateMusic` capability is on
// and a synthesised music draft is selected. Includes tempo, key,
// genre tags and total duration — enough context for the proposer
// to align beat hits, sustain held shots over instrumental pads,
// or push hard cuts to drum-heavy moments.
function renderGeneratedMusicBlock(generatedMusic) {
  if (!generatedMusic) return ''
  const synth = generatedMusic.synthesis || {}
  const dur = Number(synth.durationSec) || generatedMusic.durationSec
  const pieces = []
  if (generatedMusic.tags) pieces.push(`style: ${generatedMusic.tags}`)
  if (generatedMusic.bpm) pieces.push(`tempo: ${generatedMusic.bpm} bpm`)
  if (generatedMusic.keyscale) pieces.push(`key: ${generatedMusic.keyscale}`)
  if (Number.isFinite(dur)) pieces.push(`length: ${dur.toFixed(1)}s`)
  if (pieces.length === 0) return ''
  return `\n\n# Music bed (already chosen, plays under the whole re-edit)
A ${pieces.join(' · ')} track is locked in as the audio bed. Plan the cut to ride that bed — match hard cuts to drum hits / accents in a high-tempo track, hold contemplative shots over sustained pads in a slower one, and reserve the final beat for the brand resolution. Don't propose anything that fights the music's energy curve.`
}

function renderAdConceptBlock(adConcept) {
  if (!adConcept) return ''
  const rows = []
  if (adConcept.concept) rows.push(`- **Concept**: ${adConcept.concept}`)
  if (adConcept.message) rows.push(`- **Core message**: ${adConcept.message}`)
  if (adConcept.mood) rows.push(`- **Mood**: ${adConcept.mood}`)
  if (adConcept.target_audience) rows.push(`- **Target audience**: ${adConcept.target_audience}`)
  if (adConcept.brand_role) rows.push(`- **Brand role**: ${adConcept.brand_role}`)
  if (adConcept.narrative_arc) rows.push(`- **Narrative arc**: ${adConcept.narrative_arc}`)
  if (rows.length === 0) return ''
  return `\n\n# Original ad intent (preserve this)
These are the creative strategist's notes on what the ORIGINAL ad is about. Your re-edit should still land this concept, message, and mood — do not drift into a different story. If the target metric would push you to dilute the brand role or reshape the narrative arc beyond recognition, make the smaller change.
${rows.join('\n')}`
}

function buildUserPrompt({ scenes, brandBrief, extraInstructions, metric, totalDurationSec, targetDurationSec, criteria, correctionNote, capabilities, adConcept, voSegments, generatedVoiceover, generatedMusic, additionalAssets }) {
  const shotLog = renderShotLog(scenes)
  // Alternative footage block — only rendered when the capability is
  // on. The block is appended after the main shot log so the LLM treats
  // the source ad's shots as primary and these as a secondary pool.
  const additionalShotLog = capabilities?.useAdditionalAssets
    ? renderAdditionalShotLog(additionalAssets)
    : ''
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
  const extendAllowed = Boolean(capabilities?.footageExtend)
  const userKnobs = loadCapabilitySettings()
  const maxExtendSecForBudget = Number(userKnobs?.footageExtend?.maxExtendSec) || 2.0
  if (Number.isFinite(targetDurationSec) && targetDurationSec > 0) {
    const lo = Math.max(1, targetDurationSec * 0.85)
    const hi = targetDurationSec * 1.15
    const gapSec = targetDurationSec - totalNatural
    const needsMoreSec = gapSec > totalNatural * 0.05  // > 5% short
    // Budget for what EXTEND alone can buy: max +Xs per eligible
    // shot (capped by capability settings). Used to decide whether
    // EXTEND can close the gap on its own or placeholders are still
    // required on top.
    const extendCapacitySec = extendAllowed ? eligibleScenes.length * maxExtendSecForBudget : 0
    const extendCanCoverGap = extendAllowed && extendCapacitySec >= gapSec - 0.1

    // Gap-filling strategy depends on which capabilities are on.
    // We list the available tools in priority order — EXTEND first
    // (least disruptive to brand integrity), placeholders second
    // (introduces synthetic footage). Both can be combined.
    let gapLine
    if (!needsMoreSec) {
      gapLine = `You can reach the target using existing scenes alone — include enough of them that the natural durations sum to ~${targetDurationSec.toFixed(1)}s.`
    } else if (extendAllowed && extendCanCoverGap) {
      const avgPerShot = gapSec / Math.max(1, eligibleScenes.length)
      gapLine = `The target exceeds available footage by ${gapSec.toFixed(1)}s. You MUST close that gap. EXTEND alone can do it: averaging +${avgPerShot.toFixed(1)}s across the ${eligibleScenes.length} included shots gets you there. In practice, pick the ${Math.max(3, Math.round(gapSec / maxExtendSecForBudget))} shots that most benefit from breathing room and tag each with \`EXTEND +${maxExtendSecForBudget.toFixed(1)}s:\` (or smaller increments spread across more shots). The MAXIMUM extension per shot is +${maxExtendSecForBudget.toFixed(1)}s — stay at or below that.${placeholdersAllowed ? ` Placeholders are also available if you prefer to fill some of the gap with NEW shots — pick whichever combination best serves the metric.` : ''}`
    } else if (extendAllowed && placeholdersAllowed) {
      const placeholderSec = Math.max(0, gapSec - extendCapacitySec)
      gapLine = `The target exceeds available footage by ${gapSec.toFixed(1)}s. You MUST close that gap with a combination of: (a) EXTEND directives — up to +${maxExtendSecForBudget.toFixed(1)}s per shot, total capacity ${extendCapacitySec.toFixed(1)}s across all ${eligibleScenes.length} shots; and (b) ~${Math.max(2, Math.round(placeholderSec / 2))} placeholder rows averaging ~2s each to cover the remaining ${placeholderSec.toFixed(1)}s. Do NOT return a short EDL.`
    } else if (placeholdersAllowed) {
      gapLine = `The target exceeds available footage by ${gapSec.toFixed(1)}s. You MUST add ~${Math.max(2, Math.round(gapSec / 2))} placeholder rows averaging ~2s each. Without enough placeholders, you will NOT reach the budget.`
    } else if (extendAllowed) {
      gapLine = `The target exceeds available footage by ${gapSec.toFixed(1)}s AND placeholder rows are disabled. Use EXTEND aggressively: tag every shot that can sustain it with up to \`EXTEND +${maxExtendSecForBudget.toFixed(1)}s:\` until the sum reaches the target. Available extend capacity is ${extendCapacitySec.toFixed(1)}s across ${eligibleScenes.length} shots — that is ${extendCapacitySec >= gapSec ? 'enough' : 'NOT enough; the final EDL will fall ' + (gapSec - extendCapacitySec).toFixed(1) + 's short of target, which is acceptable in this case'}.`
    } else {
      gapLine = `The target exceeds available footage by ${gapSec.toFixed(1)}s AND both placeholder rows AND extend are DISABLED. Use every eligible scene — the final EDL will be ${totalNatural.toFixed(1)}s, which is below the target; that is expected. Do not attempt to hit the target with non-original rows.`
    }

    const tools = []
    tools.push('source-scene durations')
    if (extendAllowed) tools.push(`EXTEND seconds (max +${maxExtendSecForBudget.toFixed(1)}s per shot)`)
    if (placeholdersAllowed) tools.push('placeholder rows')

    const lines = [
      `**HARD BUDGET — ${targetDurationSec.toFixed(1)}s total (acceptable ${lo.toFixed(1)}–${hi.toFixed(1)}s).**`,
      `You have ${eligibleScenes.length} scenes, ${totalNatural.toFixed(1)}s of source footage, average ${avgDur.toFixed(2)}s per shot.`,
      `Each row's on-timeline duration = source-scene length${extendAllowed ? ' + any EXTEND seconds you flag (capped at +' + maxExtendSecForBudget.toFixed(1) + 's per shot)' : ''}.`,
      gapLine,
      `Before returning, SUM the on-timeline durations of every row (${tools.join(' + ')}). If the sum is below ${lo.toFixed(1)}s, ADD more material until you're in range. Do not return a short EDL.`,
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

  // Ad-intent block. Sits right under the brand brief so the strategic
  // read (concept / message / arc) colours every downstream decision
  // the model makes while reading the shot log. Empty string when no
  // overall analysis has been run.
  const adConceptBlock = renderAdConceptBlock(adConcept)
  // VO script block: when `generateVoiceover` is on AND a synthesised
  // draft was passed, the FIXED block wins (proposer doesn't pick or
  // reorder; the user already authored the new script). When
  // `useOriginalVoiceover` is on, render the pickable original-VO
  // block. Otherwise nothing.
  const voScriptBlock = (capabilities?.generateVoiceover && generatedVoiceover && Array.isArray(generatedVoiceover.segments) && generatedVoiceover.segments.length > 0)
    ? renderGeneratedVoiceoverBlock(generatedVoiceover)
    : (capabilities?.useOriginalVoiceover && Array.isArray(voSegments) && voSegments.length > 0)
      ? renderVoiceoverScriptBlock(voSegments, targetDurationSec)
      : ''
  // Music bed context — only when the user generated a fresh track.
  // The original-music branch (Demucs stem) doesn't render here because
  // the proposer doesn't have a tempo / genre breakdown of the source
  // ad's music; that's a future enhancement.
  const musicBedBlock = (capabilities?.generateMusic && generatedMusic)
    ? renderGeneratedMusicBlock(generatedMusic)
    : ''

  return `# Goal
Re-edit this commercial to improve its ${metric} score.${framework}

# Brand brief
${brandBrief?.trim() || '(not provided — infer from the shot log)'}${extraBlock}${adConceptBlock}${voScriptBlock}${musicBedBlock}${capabilitiesBlock}

# Shot log (from the current cut)
Each shot below is a multi-line block separated by \`---\`:
- Visual: factual description of what happens on screen.
- Chips: brand presence · emotion · framing · overall movement.
- Motion: camera movement (with intensity) and subject motion (with direction).
- Cinematography: precise filmmaker terms — shot size, angle, rig, lens, DOF, focus dynamics, composition, lighting style, colour palette, special techniques. Omitted when the analyzer couldn't categorise the shot.
- Audio: verbatim voiceover (VO), music description, SFX list, ambient bed. Omitted on silent clips.
- Graphics: on-screen text with its role (title, tagline, caption, legal_disclaimer, etc.) and logos present. Omitted on clean frames.
- Pacing: shot boundary character (cut_type) and tempo feel.
Use Audio.VO to anchor narrative continuity — never split a VO line across shots arbitrarily. Use Pacing + music tempo to size shot durations. Use Graphics to decide which shots MUST carry brand elements (logo, tagline, legal disclaimer) and which ones can be replaced. Use Cinematography to keep visual continuity tight: when ordering shots, alternate or match \`shot_size\` deliberately (don't bounce ECU→Wide→ECU at random), keep \`lighting_style\` consistent within a beat, and match \`composition\` lines (a leading-line shot pairs well with another that continues the line).

${shotLog}${additionalShotLog}

# Your task
Propose a new edit decision list that improves ${metric}. The tools available to you depend on the Capabilities block above:
- **Always**: reorder shots, cut weak moments, promote high-value shots to prime timecodes (first and last seconds).${placeholdersAllowed ? '\n- **Placeholder rows**: add 1–3 NEW placeholder shots if a structural gap truly needs one.' : ''}${capabilities?.footageReframe ? '\n- **Reframe** (`REFRAME:` directive): tighten or reposition a shot when the current framing buries a beat.' : ''}${capabilities?.colorCorrection ? '\n- **Color grading** (`COLOR:` directive): correct shots that fight the target metric / brand mood. If the framework or brief explicitly calls for a look (bright, warm, moody, desaturated, etc), you MUST apply COLOR to the shots that miss it — reordering alone will not fix an off-concept grade.' : ''}${capabilities?.footageExtend ? '\n- **Extend** (`EXTEND +Xs:` directive): add up to +' + (Number(loadCapabilitySettings()?.footageExtend?.maxExtendSec) || 2).toFixed(1) + 's of AI continuation to a shot. Use this aggressively when the target duration exceeds available footage — a +2s on each of 4 shots adds 8s without introducing new placeholders.' : ''}${capabilities?.useOriginalMusic ? '\n- **Music stem** (`AUDIO music:` directive): layer the isolated music stem anywhere.' : ''}${capabilities?.useOriginalVoiceover ? '\n- **VO stem** (`AUDIO vo: "..."` directive): reuse a VO line on a different shot.' : ''}

${budget}

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
  sourceVideoPath,
  adConcept,
  voSegments,
  voPlanOverride,
  generatedVoiceover, // { segments: [{id,text,role,gapBeforeSec}], synthesis: { segmentAudio: { [id]: { path, durationSec } } } } | null
  generatedMusic,     // selected synthesised music draft — { tags, bpm, keyscale, durationSec, synthesis } | null
  additionalAssets,   // currentProject.additionalAssets — only consumed when capability `useAdditionalAssets` is on
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

  // One-time source-video hydration. When the user has turned on
  // "Send source video to proposal (Gemini only)" and the active
  // backend is Gemini, read the source file as a data URL so we can
  // attach it alongside the text shot log. We do this once outside
  // runOnce because the file bytes don't change between retry attempts
  // and the read can easily be 15–25 MB — worth caching.
  const settings = loadLlmSettings()
  const sendVideo = Boolean(
    sourceVideoPath
    && settings.backend === LLM_BACKENDS.GEMINI
    && settings.geminiSendSourceVideo,
  )
  let sourceVideoDataUrl = null
  if (sendVideo) {
    try {
      const mime = /\.mov$/i.test(sourceVideoPath) ? 'video/quicktime'
        : /\.webm$/i.test(sourceVideoPath) ? 'video/webm'
        : 'video/mp4'
      const res = await window.electronAPI?.readFileAsDataUrl?.(sourceVideoPath, mime)
      if (res?.success && res.dataUrl) {
        if (!res.bytes || res.bytes <= INLINE_BYTE_LIMIT) {
          sourceVideoDataUrl = res.dataUrl
        } else {
          console.warn(`[reedit] Source video is ${(res.bytes / 1024 / 1024).toFixed(1)} MB — over the ${(INLINE_BYTE_LIMIT / 1024 / 1024).toFixed(0)} MB inline cap for Gemini. Falling back to text-only proposal.`)
        }
      }
    } catch (err) {
      console.warn('[reedit] Could not read source video for Gemini proposal:', err?.message || err)
    }
  }

  // Single attempt helper so we can re-run with a correction note if
  // the first pass undershoots the budget (which local Qwen2.5-VL
  // reliably does when the duration target requires padding with
  // placeholders). Routing through reeditLlmClient.chatCompletion
  // so this path works for both LM Studio and the Anthropic backend
  // without the proposer knowing which is active.
  const runOnce = async (correctionNote) => {
    const userPromptText = buildUserPrompt({ scenes, brandBrief, extraInstructions, metric: targetMetric, totalDurationSec, targetDurationSec, criteria: effectiveCriteria, correctionNote, capabilities, adConcept, voSegments, generatedVoiceover, generatedMusic, additionalAssets })
    // When we have a video ready, compose the user message as a
    // content array: the prompt first (order matters — Gemini treats
    // the last text as the active instruction) then the video. The
    // dispatcher forwards OpenAI-shape content arrays to the Gemini
    // client which translates `video_url` into inlineData.
    const userContent = sourceVideoDataUrl
      ? [
          { type: 'text', text: userPromptText + '\n\nThe full source video is attached below. Use it to sanity-check the shot log (camera movements, continuity, graphic placement) when making edit decisions.' },
          { type: 'video_url', video_url: { url: sourceVideoDataUrl } },
        ]
      : userPromptText
    const messages = [
      { role: 'system', content: buildSystemPrompt(capabilities) },
      { role: 'user', content: userContent },
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
    const sceneById = new Map((scenes || []).map((s) => [s.id, s]))
    let cursor = 0
    const normalized = rawEdl.map((row, i) => {
      const rawDur = Math.max(0.1, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0))
      const start = cursor
      const end = cursor + rawDur
      cursor = end
      // Parse `REFRAME [zoom=X.X] [anchor=x,y]` out of the note. We
      // leave the note text alone so the UI keeps showing human-
      // readable rationale; the parsed params land on `row.reframe`
      // for the timeline to consume without a second pass.
      let reframe = parseReframeDirective(row.note)
      // Safety net: if the scene has an analyzed logo bbox and the
      // LLM's anchor would clip the logo out of the post-crop window,
      // snap the anchor (and if necessary reduce zoom) so the logo
      // stays visible. This catches the common failure mode where the
      // LLM says "push in on the logo" but writes anchor=0.5,0.5 when
      // the logo is actually off-center — without this clamp, the
      // preview would crop the logo out of frame.
      if (reframe && row.kind !== 'placeholder') {
        const scene = sceneById.get(row.sourceSceneId)
        if (scene) reframe = snapReframeToLogo(reframe, scene)
      }
      // Same deal for `COLOR: exposure=... contrast=... ...` — the
      // directive stays in the note as rationale, the parsed object
      // becomes `row.colorAdjustments` for the timeline applier.
      const colorAdjustments = parseColorDirective(row.note)
      // `EXTEND +Xs:` — parsed into a clamped `{ seconds }` object for
      // the timeline to slow down the clip as a preview, and for the
      // Commit extend flow to pass to ComfyUI.
      const extend = parseExtendDirective(row.note)
      return {
        index: i + 1,
        kind: row.kind === 'placeholder' ? 'placeholder' : 'original',
        sourceSceneId: row.sourceSceneId || null,
        newTcIn: start,
        newTcOut: end,
        note: row.note || '',
        reframe,
        colorAdjustments,
        extend,
      }
    })
    // VO plan: if the user has taken manual control (voPlanOverride with
    // autoEdit=false) we use their segment ids verbatim. Otherwise we
    // accept the proposer's pick from the JSON response; if the LLM
    // didn't emit one we fall back to "all segments" so nothing is
    // silently dropped.
    //
    // We CARRY OVER any user-side knobs from the override — lead pads,
    // per-segment timing edits — because those live in the UI and the
    // LLM doesn't know about them. Without this carry the proposer's
    // returned plan would erase the lead-in / lead-out that the user
    // set, and the timeline would build VO clips trimmed to Gemini's
    // (already-late) raw timestamps.
    const allSegIds = Array.isArray(voSegments) ? voSegments.map((s) => s.id) : []
    const userExtras = voPlanOverride ? {
      leadInSec: Number.isFinite(voPlanOverride.leadInSec) ? voPlanOverride.leadInSec : undefined,
      leadOutSec: Number.isFinite(voPlanOverride.leadOutSec) ? voPlanOverride.leadOutSec : undefined,
      segmentEdits: voPlanOverride.segmentEdits || undefined,
    } : {}
    // Strip undefineds so spread doesn't clobber later fields.
    Object.keys(userExtras).forEach((k) => userExtras[k] === undefined && delete userExtras[k])
    // segmentGaps from the LLM: silence-before-each-segment in seconds,
    // keyed by segment id. Only honoured when the proposer auto-picked
    // (manual mode bypasses the LLM entirely). Carry user gap edits if
    // the override has them — same pattern as segmentEdits.
    const sanitizeGaps = (raw) => {
      if (!raw || typeof raw !== 'object') return null
      const out = {}
      for (const [id, val] of Object.entries(raw)) {
        const num = Number(val)
        if (!Number.isFinite(num) || num < 0) continue
        // Cap at a sane upper bound — a 30 s gap on a 30 s ad = pure
        // silence with one VO line at the very end. Beyond that the LLM
        // is almost certainly hallucinating.
        out[id] = Math.min(30, num)
      }
      return Object.keys(out).length > 0 ? out : null
    }
    const overrideGaps = voPlanOverride && sanitizeGaps(voPlanOverride.segmentGaps)
    const proposedGaps = sanitizeGaps(parsed?.voiceoverPlan?.segmentGaps)
    let voiceoverPlan = null
    if (voPlanOverride && voPlanOverride.autoEdit === false && Array.isArray(voPlanOverride.segmentIds)) {
      voiceoverPlan = { autoEdit: false, segmentIds: voPlanOverride.segmentIds, ...userExtras }
      if (overrideGaps) voiceoverPlan.segmentGaps = overrideGaps
    } else if (Array.isArray(parsed?.voiceoverPlan?.segmentIds)) {
      const validIds = parsed.voiceoverPlan.segmentIds.filter((id) => allSegIds.includes(id))
      voiceoverPlan = { autoEdit: true, segmentIds: validIds, ...userExtras }
      // User-edited gaps win over the LLM's pick on re-prompts; otherwise
      // adopt whatever the LLM emitted.
      const mergedGaps = overrideGaps || proposedGaps
      if (mergedGaps) voiceoverPlan.segmentGaps = mergedGaps
    } else if (allSegIds.length > 0) {
      voiceoverPlan = { autoEdit: true, segmentIds: allSegIds, ...userExtras }
      if (overrideGaps) voiceoverPlan.segmentGaps = overrideGaps
    }
    return { rationale: String(parsed.rationale || ''), edl: normalized, rawText, voiceoverPlan }
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
