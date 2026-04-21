/**
 * project:re-edit — placeholder fill generator.
 *
 * For each "placeholder" row in the approved EDL, kicks off an LTX 2.3
 * i2v generation in the user's local ComfyUI using a reference frame
 * grabbed from the nearest surrounding original scene (so the fill
 * stays on-brand / on-set instead of drifting into generic stock).
 *
 * Flow:
 *   1. Pick a reference JPEG from the project's scene-thumbnail cache.
 *   2. Upload it to ComfyUI's /upload/image as the workflow's input.
 *   3. Load the bundled LTX 2.3 i2v workflow, run it through the
 *      existing `modifyLTX23I2VWorkflow` modifier (prompt, dims,
 *      frames), and patch the spatial-upscaler filename down to v1.0
 *      because that's what the user has locally.
 *   4. queuePrompt, listen for ComfyUI's `complete` event, pull the
 *      output MP4 via `/history/<promptId>` + `/view`, write it to
 *      `<project>/.reedit/generated/row-NNN-<ts>.mp4`.
 *   5. Return a `genSpec.generatedPath` so the EDL-to-timeline
 *      populator can materialize it as a real video clip on the next
 *      Apply (swapping out the "GENERATION NEEDED" SVG card).
 *
 * Non-goals for this first cut: multi-reference conditioning, VACE,
 * speed-ramping, speaker/VO generation. The seam is `ModelAdapter`-
 * ready — additional backends slot in next to this one.
 */

import comfyui, { modifyLTX23I2VWorkflow } from './comfyui'
import useProjectStore from '../stores/projectStore'

const WORKFLOW_PATH = '/workflows/video_ltx2_3_i2v.json'
const DEFAULT_FPS = 24
const MIN_FRAMES = 24
const MAX_FRAMES = 121

/** Pick the nearest original scene's thumbnail as the i2v reference. */
function pickReferenceThumbnail({ edl, rowIndex, sceneById }) {
  for (let i = rowIndex - 1; i >= 0; i--) {
    const ref = edl[i]
    if (ref?.kind === 'original' && ref.sourceSceneId) {
      const scene = sceneById.get(ref.sourceSceneId)
      if (scene?.thumbnail) return { thumbnail: scene.thumbnail, sourceSceneId: ref.sourceSceneId, direction: 'prev' }
    }
  }
  for (let i = rowIndex + 1; i < edl.length; i++) {
    const ref = edl[i]
    if (ref?.kind === 'original' && ref.sourceSceneId) {
      const scene = sceneById.get(ref.sourceSceneId)
      if (scene?.thumbnail) return { thumbnail: scene.thumbnail, sourceSceneId: ref.sourceSceneId, direction: 'next' }
    }
  }
  for (const scene of sceneById.values()) {
    if (scene?.thumbnail) return { thumbnail: scene.thumbnail, sourceSceneId: scene.id, direction: 'any' }
  }
  return null
}

async function readFileAsBlob(absolutePath, mimeType = 'image/jpeg') {
  const res = await window.electronAPI?.readFileAsDataUrl?.(absolutePath, mimeType)
  if (!res?.success) throw new Error(res?.error || `Could not read ${absolutePath}`)
  const r = await fetch(res.dataUrl)
  return await r.blob()
}

async function fetchWorkflowJson() {
  // Both dev (Vite) and prod (electron-builder extraResources) serve
  // public/workflows/ at /workflows/, so the same path works.
  const res = await fetch(WORKFLOW_PATH)
  if (!res.ok) throw new Error(`Could not load LTX workflow (${res.status}).`)
  return await res.json()
}

// User has `ltx-2-spatial-upscaler-x2-1.0.safetensors` in upscale_models
// but the bundled workflow was exported against 1.1. Swap on the fly
// so we don't require them to download a tiny version bump.
function patchUpscalerFilename(workflow) {
  for (const node of Object.values(workflow)) {
    if (node?.class_type === 'LatentUpscaleModelLoader') {
      const name = String(node.inputs?.model_name || '')
      if (name.includes('ltx-2.3-spatial-upscaler') || name.includes('ltx-2-spatial-upscaler-x2-1.1')) {
        node.inputs.model_name = 'ltx-2-spatial-upscaler-x2-1.0.safetensors'
      }
    }
  }
  return workflow
}

function pickSaveOutputFromHistory(historyEntry) {
  // History payload shape: { "<promptId>": { outputs: { "<nodeId>": { videos: [...], gifs: [...], images: [...] } } } }
  const outputs = historyEntry?.outputs || {}
  for (const nodeData of Object.values(outputs)) {
    const candidates = [
      ...(nodeData.videos || []),
      ...(nodeData.gifs || []),
      ...(nodeData.images || []),
    ]
    // Prefer mp4 / video-like outputs over intermediate image saves.
    const video = candidates.find((c) => c?.filename && /\.(mp4|webm|mkv|mov|gif)$/i.test(c.filename))
      || candidates.find((c) => c?.filename)
    if (video) return video
  }
  return null
}

async function waitForCompletion({ promptId, onProgress, timeoutMs = 15 * 60 * 1000 }) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const deadline = Date.now() + timeoutMs

    const onComplete = (event) => {
      if (event?.promptId !== promptId || settled) return
      settled = true
      cleanup()
      resolve('complete')
    }
    const onError = (event) => {
      if (event?.promptId !== promptId || settled) return
      settled = true
      cleanup()
      reject(new Error(event?.message || 'ComfyUI execution error.'))
    }
    const onProgressEvt = (event) => {
      if (event?.promptId !== promptId) return
      onProgress?.({ stage: 'generating', step: event.value, maxSteps: event.max })
    }
    const onExecuting = (event) => {
      if (event?.promptId !== promptId) return
      onProgress?.({ stage: 'executing', node: event.node })
    }
    function cleanup() {
      try { comfyui.off('complete', onComplete) } catch (_) { /* ignore */ }
      try { comfyui.off('execution_error', onError) } catch (_) { /* ignore */ }
      try { comfyui.off('progress', onProgressEvt) } catch (_) { /* ignore */ }
      try { comfyui.off('executing', onExecuting) } catch (_) { /* ignore */ }
      clearInterval(timer)
    }

    comfyui.on('complete', onComplete)
    comfyui.on('execution_error', onError)
    comfyui.on('progress', onProgressEvt)
    comfyui.on('executing', onExecuting)

    // Safety net — if we somehow miss the WS event (reconnect, tab
    // switch eating messages), poll history and bail when the prompt
    // shows up as completed.
    const timer = setInterval(async () => {
      if (settled) return
      if (Date.now() > deadline) {
        settled = true
        cleanup()
        reject(new Error('Generation timed out (15 min).'))
        return
      }
      try {
        const history = await comfyui.getHistory(promptId)
        const entry = history?.[promptId]
        if (entry?.status?.completed || entry?.outputs) {
          settled = true
          cleanup()
          resolve('history')
        }
      } catch (_) { /* transient, keep polling */ }
    }, 5000)
  })
}

export async function generateFillForPlaceholder({
  row,
  rowIndex,
  edl,
  scenes,
  sourceVideo,
  onProgress,
  extraPrompt = '',
}) {
  if (row?.kind !== 'placeholder') {
    throw new Error('Only placeholder rows can be generated.')
  }

  const projectDir = useProjectStore.getState().currentProjectHandle
  if (typeof projectDir !== 'string') {
    throw new Error('Generation requires the desktop build (project path needed).')
  }

  const sceneById = new Map((scenes || []).map((s) => [s.id, s]))
  const ref = pickReferenceThumbnail({ edl, rowIndex, sceneById })
  if (!ref) throw new Error('No reference frame available — run Analysis first.')

  onProgress?.({ stage: 'upload_ref' })
  const refBlob = await readFileAsBlob(ref.thumbnail, 'image/jpeg')
  const uploadFilename = `reedit_ref_row${String(rowIndex + 1).padStart(3, '0')}_${Date.now()}.jpg`
  const upload = await comfyui.uploadFile(refBlob, uploadFilename, '', 'input')
  const comfyImageName = upload?.name || uploadFilename

  onProgress?.({ stage: 'queue_workflow' })
  let workflow = await fetchWorkflowJson()
  workflow = patchUpscalerFilename(workflow)

  // Fit generation params to what the proposal asks for — duration from
  // the EDL row, aspect from the source video so fills blend with the
  // original clips.
  const durationSec = Math.max(0.5, (Number(row.newTcOut) - Number(row.newTcIn)) || 1.5)
  const frames = Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(durationSec * DEFAULT_FPS)))
  const width = sourceVideo?.width || 1280
  const height = sourceVideo?.height || 720
  const prompt = [row.note || 'cinematic shot', extraPrompt].filter(Boolean).join(' — ')

  const modified = modifyLTX23I2VWorkflow(workflow, {
    prompt,
    negativePrompt: 'worst quality, low quality, blurry, distorted, artifacts, watermark',
    inputImage: comfyImageName,
    width,
    height,
    frames,
    fps: DEFAULT_FPS,
    filenamePrefix: `reedit/row-${String(rowIndex + 1).padStart(3, '0')}`,
  })

  const promptId = await comfyui.queuePrompt(modified)
  if (!promptId) throw new Error('ComfyUI did not return a prompt id.')

  onProgress?.({ stage: 'generating', promptId })
  await waitForCompletion({ promptId, onProgress })

  onProgress?.({ stage: 'download', promptId })
  const history = await comfyui.getHistory(promptId)
  const entry = history?.[promptId]
  const output = pickSaveOutputFromHistory(entry)
  if (!output?.filename) {
    throw new Error('ComfyUI finished but produced no video output — check the workflow and log.')
  }

  // Pull the bytes from ComfyUI. The downloadVideo helper returns a
  // File, which is a Blob subclass — its arrayBuffer() is fine here.
  const file = await comfyui.downloadVideo(output.filename, output.subfolder || 'reedit', output.type || 'output')
  const arrayBuffer = await file.arrayBuffer()

  const localDir = `${projectDir.replace(/\\/g, '/')}/.reedit/generated`
  const localName = `row-${String(rowIndex + 1).padStart(3, '0')}-${Date.now()}.mp4`
  const outputPath = `${localDir}/${localName}`
  const writeRes = await window.electronAPI?.writeFileFromArrayBuffer?.(outputPath, arrayBuffer)
  if (!writeRes?.success) throw new Error(writeRes?.error || 'Could not write generated clip to disk.')

  onProgress?.({ stage: 'done', promptId })

  return {
    generatedPath: outputPath,
    refSceneId: ref.sourceSceneId,
    refDirection: ref.direction,
    durationSec,
    frames,
    fps: DEFAULT_FPS,
    width,
    height,
    prompt,
    promptId,
    model: 'ltx-2.3-22b-dev-fp8 + distilled lora',
    generatedAt: new Date().toISOString(),
  }
}
