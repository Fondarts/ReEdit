/**
 * project:re-edit — bulk generator for placeholder fills.
 *
 * The proposer can drop `kind: 'placeholder'` rows into the EDL when
 * `capabilities.footageGeneration` is on. Each placeholder carries a
 * `referenceFrame: { sourceSceneId, framePosition }` that the LLM
 * picked from the existing shot log — that reference image is fed to
 * Kling Omni i2v on Comfy Cloud to keep the generated clip visually
 * consistent with the rest of the cut.
 *
 * This service orchestrates the bulk path the UI calls from a single
 * "Generate fills" button: per placeholder, resolve the reference
 * timecode, invoke the `analysis:generateFill` IPC, persist the result
 * onto `project.fills[placeholderId]`, and emit progress events the
 * Proposal view renders.
 *
 * One-at-a-time on purpose: Kling Omni is rate-limited per account and
 * parallel jobs share the same queue, so a sequential loop is both
 * simpler and friendlier to the cloud quota.
 */

import useProjectStore from '../stores/projectStore'
import { getActiveComfyIpcContext } from './localComfyConnection'
import { appendFillVersion } from './placeholderVersions'

// The generation prompt for a placeholder fill: the user's per-row
// override (`fillPrompt`, set from the prompt modal) wins, else the
// proposer's note. Kept in one place so the bulk + single-row paths
// always agree on what was sent to the model.
export function fillPromptForRow(row) {
  const override = typeof row?.fillPrompt === 'string' ? row.fillPrompt.trim() : ''
  return override || row?.note || ''
}

// Catalogue of Comfy Cloud i2v models we know how to invoke. Each
// entry pairs the API id (sent verbatim to the IPC handler) with the
// display label / blurb the UI shows in the picker. Stays narrow on
// purpose — anything that needs API Nodes credits + a reference
// image. The IDs MUST match the keys of FILL_MODEL_REGISTRY in
// electron/main.js or the handler will reject with "Unknown fill
// model".
export const FILL_MODELS = [
  { id: 'kling-v3-omni',           label: 'Kling 3 Omni',     blurb: '3–15 s, accepts multi-image refs. Default — stylised, good with creative prompts.' },
  { id: 'grok-imagine-video-beta', label: 'Grok Video',       blurb: '1–6 s, single ref. Faster + cheaper than Kling; "auto" aspect.' },
  { id: 'viduq2-pro-fast',         label: 'Vidu Q2 Pro Fast', blurb: '4–8 s, single ref. 1080p native; cleaner frames, heavier files.' },
  { id: 'seedance-2',              label: 'Seedance 2.0 (multi-ref)', blurb: '4–15 s. Sends start/middle/end frames + a 3 s sub-clip of the reference scene — best product/brand consistency.' },
  { id: 'veo-3.1-flf',             label: 'Veo 3.1 Bridge (first/last frame)', blurb: '4–8 s. For placeholders BETWEEN two original rows: bridges the previous shot\'s last frame to the next shot\'s first frame.' },
]

export const DEFAULT_FILL_MODEL = 'kling-v3-omni'

// Map a framePosition + scene tcIn/tcOut to an absolute source-video
// timecode. The placeholder generator extracts a frame at this point.
// We clamp inside the scene with a tiny margin so 'end' doesn't fall
// past the last decodable frame.
function resolveReferenceTcSec(scene, framePosition) {
  const tcIn = Number(scene?.tcIn) || 0
  const tcOut = Number(scene?.tcOut) || tcIn
  const dur = Math.max(0, tcOut - tcIn)
  // Margin shrinks on very short shots so we don't end up landing on
  // exactly the same frame for every position.
  const margin = Math.min(0.1, dur * 0.1)
  switch (framePosition) {
    case 'start':  return tcIn + margin
    case 'end':    return Math.max(tcIn + margin, tcOut - margin)
    case 'middle':
    default:       return tcIn + dur / 2
  }
}

// Model-specific reference extras beyond the single legacy frame:
//   - Seedance multi-ref: start/middle/end frames of the reference scene
//     plus a ≤3 s sub-clip for the reference_videos slot — this is what
//     buys product/brand consistency.
//   - Veo FLF bridge: previous original row's END frame + next original
//     row's START frame, so the generated shot connects both neighbours.
// Falls back to nothing (single-frame behaviour) when the shape doesn't
// apply — e.g. an FLF placeholder at the very start of the cut.
function buildReferenceExtras({ modelId, index, edl, sceneById, scene }) {
  if (modelId === 'seedance-2' && scene) {
    const tcIn = Number(scene.tcIn) || 0
    const tcOut = Number(scene.tcOut) || tcIn
    const dur = Math.max(0, tcOut - tcIn)
    const margin = Math.min(0.1, dur * 0.1)
    return {
      referenceTcSecList: [tcIn + margin, tcIn + dur / 2, Math.max(tcIn + margin, tcOut - margin)],
      referenceClip: { startSec: tcIn, durationSec: Math.min(3, Math.max(0.5, dur)) },
    }
  }
  if (modelId === 'veo-3.1-flf' && Array.isArray(edl)) {
    const prev = edl[index - 1]
    const next = edl[index + 1]
    const prevScene = prev?.kind === 'original' ? sceneById.get(prev.sourceSceneId) : null
    const nextScene = next?.kind === 'original' ? sceneById.get(next.sourceSceneId) : null
    if (prevScene || nextScene) {
      const prevTc = prevScene ? resolveReferenceTcSec(prevScene, 'end') : resolveReferenceTcSec(scene, 'start')
      const nextTc = nextScene ? resolveReferenceTcSec(nextScene, 'start') : resolveReferenceTcSec(scene, 'end')
      return { bridgeFrames: { prevTcSec: prevTc, nextTcSec: nextTc } }
    }
  }
  return {}
}

// Read the canonical placeholder id from a row. The EDL doesn't carry
// a stable id — the renderer keys rows by `index`. We synthesise one
// here so the same placeholder can be retried + cached without
// collisions. Pattern: `placeholder-<index>` (lines up with the EDL's
// own index field). Bring your own override (e.g. an existing `fillId`
// on the row) when the proposal already has fills attached.
export function placeholderIdFor(row) {
  if (row?.fillId) return String(row.fillId)
  return `placeholder-${row?.index ?? 0}`
}

// Pick the project's display aspect ratio for the i2v workflow.
// Kling only accepts the canonical buckets (16:9 / 9:16 / 1:1), so we
// map by comparing the project dims; anything ambiguous defaults to
// 16:9 (the most common ad shape).
function pickKlingAspect(settings) {
  const w = Number(settings?.width)  || 1920
  const h = Number(settings?.height) || 1080
  if (h > w * 1.2) return '9:16'
  if (Math.abs(w - h) < Math.max(w, h) * 0.05) return '1:1'
  return '16:9'
}

/**
 * Run the full fill pipeline. Walks the proposal's EDL rows, skips
 * non-placeholder rows + placeholders already filled, and invokes the
 * single-fill IPC sequentially for the rest.
 *
 * @param {object} opts
 * @param {(stage: string, payload?: object) => void} [opts.onProgress]
 *   Called with `{ placeholderId, stage, current, total, ... }` as the
 *   loop advances and as IPC progress events fire mid-job.
 * @param {{ aborted: boolean }} [opts.signal] Cooperative cancel flag.
 * @param {boolean} [opts.force] When true, regenerate fills that
 *   already have an outputPath. Default false.
 *
 * @returns {Promise<{ generated: number, skipped: number, failed: Array<{placeholderId, error}> }>}
 */
export async function generateFillsForProposal({ onProgress, signal, force = false, modelId = DEFAULT_FILL_MODEL } = {}) {
  const store = useProjectStore.getState()
  const project = store.currentProject
  if (!project) throw new Error('No project open.')
  const handle = store.currentProjectHandle
  const projectDir = typeof handle === 'string' ? handle : null
  if (!projectDir) throw new Error('Project has no on-disk handle — save the project first.')
  const sourceVideo = project.sourceVideo
  if (!sourceVideo?.path) throw new Error('Source video missing — import one before generating fills.')
  const edl = Array.isArray(project.proposal?.edl) ? project.proposal.edl : []
  if (edl.length === 0) throw new Error('No EDL to generate fills for. Run Propose first.')

  const scenes = Array.isArray(project.analysis?.scenes) ? project.analysis.scenes : []
  const sceneById = new Map(scenes.map((s) => [s.id, s]))
  const existingFills = (project.fills && typeof project.fills === 'object') ? project.fills : {}
  const aspectRatio = pickKlingAspect(project.settings)
  const comfyCtx = getActiveComfyIpcContext()

  // Resolve every placeholder + reference timestamp up front. Surfaces
  // missing-reference errors in one pass instead of inside the loop.
  const targets = []
  for (let i = 0; i < edl.length; i++) {
    const row = edl[i]
    if (!row || row.kind !== 'placeholder') continue
    const pid = placeholderIdFor({ ...row, index: i })
    if (!force && existingFills[pid]?.path) {
      // Skip — already generated. Caller still wants to count these
      // for the "skipped" tally.
      targets.push({ row, index: i, pid, status: 'skip' })
      continue
    }
    if (!row.referenceFrame?.sourceSceneId) {
      targets.push({ row, index: i, pid, status: 'missing-ref', error: 'Placeholder is missing its referenceFrame — re-generate the proposal so the LLM picks one.' })
      continue
    }
    const scene = sceneById.get(row.referenceFrame.sourceSceneId)
    if (!scene) {
      targets.push({ row, index: i, pid, status: 'missing-ref', error: `Reference scene "${row.referenceFrame.sourceSceneId}" no longer exists in the shot log.` })
      continue
    }
    const tcSec = resolveReferenceTcSec(scene, row.referenceFrame.framePosition)
    const durationSec = Math.max(1, Math.min(2, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)))
    targets.push({ row, index: i, pid, status: 'ready', tcSec, durationSec })
  }

  const live = targets.filter((t) => t.status === 'ready')
  const skipped = targets.filter((t) => t.status === 'skip').length
  const upfrontFailed = targets.filter((t) => t.status === 'missing-ref')
    .map((t) => ({ placeholderId: t.pid, error: t.error }))

  onProgress?.('start', { total: live.length, skipped, upfrontFailed })

  let generated = 0
  const failed = [...upfrontFailed]
  for (let i = 0; i < live.length; i++) {
    if (signal?.aborted) {
      onProgress?.('cancelled', { generated, failed })
      return { generated, skipped, failed }
    }
    const t = live[i]
    onProgress?.('begin', { current: i + 1, total: live.length, placeholderId: t.pid, note: t.row.note })

    try {
      const promptText = fillPromptForRow(t.row)
      const res = await window.electronAPI.generateFill({
        placeholderId: t.pid,
        projectDir,
        sourceVideoPath: sourceVideo.path,
        referenceTcSec: t.tcSec,
        ...buildReferenceExtras({ modelId, index: t.index, edl, sceneById, scene: sceneById.get(t.row.referenceFrame.sourceSceneId) }),
        prompt: promptText,
        durationSec: t.durationSec,
        aspectRatio,
        modelId,
        ...comfyCtx,
      })
      if (!res?.success) {
        failed.push({ placeholderId: t.pid, error: res?.error || 'Generation failed.' })
        onProgress?.('error', { placeholderId: t.pid, error: res?.error || 'Generation failed.' })
        continue
      }
      // Append as a new version onto project.fills[pid] (keeping prior
      // renders) and persist so a reload / Apply picks it up without a
      // regenerate. The new version becomes active; its fields mirror to
      // the top level so the timeline keeps reading `fills[pid].path`.
      const latest = useProjectStore.getState().currentProject?.fills || {}
      const { fill } = appendFillVersion(latest[t.pid], {
        path: res.outputPath,
        referenceFramePath: res.referenceFramePath || null,
        modelId: res.modelId || modelId,
        createdAt: new Date().toISOString(),
        // Snapshot of inputs in case the user wants to A/B later.
        promptSnapshot: promptText,
        referenceFrameSnapshot: { ...t.row.referenceFrame, tcSec: t.tcSec },
        durationSec: t.durationSec,
      })
      await store.saveProject({ fills: { ...latest, [t.pid]: fill } })
      generated += 1
      onProgress?.('done', { current: i + 1, total: live.length, placeholderId: t.pid, outputPath: res.outputPath })
    } catch (err) {
      failed.push({ placeholderId: t.pid, error: err?.message || String(err) })
      onProgress?.('error', { placeholderId: t.pid, error: err?.message || String(err) })
    }
  }

  onProgress?.('finish', { generated, skipped, failed })
  return { generated, skipped, failed }
}

/**
 * Single-row fill generator. Used by the per-row "Generate" button.
 * Reuses the same path the bulk loop walks (validation → IPC →
 * project.fills[] persistence) but for exactly one row, so per-row
 * progress doesn't have to share the bulk state.
 *
 * @param {object} opts
 * @param {object} opts.row     The EDL row (must be a placeholder).
 * @param {number} opts.index   The row's position in `proposal.edl`.
 * @param {string} [opts.modelId] Override the default fill model.
 * @param {(stage: string, payload?: object) => void} [opts.onProgress]
 */
export async function generateFillForRow({ row, index, modelId = DEFAULT_FILL_MODEL, onProgress } = {}) {
  if (!row || row.kind !== 'placeholder') {
    throw new Error('generateFillForRow: row must be a placeholder.')
  }
  const store = useProjectStore.getState()
  const project = store.currentProject
  if (!project) throw new Error('No project open.')
  const handle = store.currentProjectHandle
  const projectDir = typeof handle === 'string' ? handle : null
  if (!projectDir) throw new Error('Project has no on-disk handle.')
  const sourceVideo = project.sourceVideo
  if (!sourceVideo?.path) throw new Error('Source video missing.')

  const scenes = Array.isArray(project.analysis?.scenes) ? project.analysis.scenes : []
  const sceneById = new Map(scenes.map((s) => [s.id, s]))
  const refId = row.referenceFrame?.sourceSceneId
  if (!refId) throw new Error('Placeholder is missing its referenceFrame — re-generate the proposal.')
  const scene = sceneById.get(refId)
  if (!scene) throw new Error(`Reference scene "${refId}" no longer exists in the shot log.`)

  const pid = placeholderIdFor({ ...row, index })
  const tcSec = resolveReferenceTcSec(scene, row.referenceFrame.framePosition)
  const durationSec = Math.max(1, Math.min(2, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)))
  const aspectRatio = pickKlingAspect(project.settings)
  const comfyCtx = getActiveComfyIpcContext()

  onProgress?.('begin', { placeholderId: pid })
  const promptText = fillPromptForRow(row)
  const res = await window.electronAPI.generateFill({
    placeholderId: pid,
    projectDir,
    sourceVideoPath: sourceVideo.path,
    referenceTcSec: tcSec,
    ...buildReferenceExtras({ modelId, index, edl: project.proposal?.edl, sceneById, scene }),
    prompt: promptText,
    durationSec,
    aspectRatio,
    modelId,
    ...comfyCtx,
  })
  if (!res?.success) {
    onProgress?.('error', { placeholderId: pid, error: res?.error || 'Generation failed.' })
    throw new Error(res?.error || 'Generation failed.')
  }
  // Append as a new version (keep prior renders); the new one is active.
  const latest = useProjectStore.getState().currentProject?.fills || {}
  const { fill } = appendFillVersion(latest[pid], {
    path: res.outputPath,
    referenceFramePath: res.referenceFramePath || null,
    modelId: res.modelId || modelId,
    createdAt: new Date().toISOString(),
    promptSnapshot: promptText,
    referenceFrameSnapshot: { ...row.referenceFrame, tcSec },
    durationSec,
  })
  await store.saveProject({ fills: { ...latest, [pid]: fill } })
  onProgress?.('done', { placeholderId: pid, outputPath: res.outputPath })
  return res
}
