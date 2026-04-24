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

import comfyui, { modifyZImageTurboWorkflow } from './comfyui'
import useProjectStore from '../stores/projectStore'
import { getLocalComfyHttpBaseSync } from './localComfyConnection'

const FRAME_WORKFLOW_PATH = '/workflows/image_z_image_turbo.json'

// API-format snapshot of the official ComfyUI LTX-2.3 Image-to-Video
// template (fetched from /queue once the user ran it manually — the
// UI-format one that ships as a template can't be queued directly
// because it uses a subgraph and /prompt needs a flat graph).
const LTX_I2V_WORKFLOW_PATH = '/workflows/ltx2_3_i2v_api.json'

// All the node IDs we have to address in the flattened template carry
// the `<subgraph>:<inner>` prefix that ComfyUI's flattener produced.
// Keeping them as constants next to the modifier makes future template
// re-captures a single-file update.
const LTX_NODE_IDS = {
  LOAD_IMAGE: '269',
  SAVE_VIDEO: '75',
  POSITIVE_PROMPT: '320:319',   // PrimitiveStringMultiline "Prompt"
  NEGATIVE_PROMPT: '320:313',   // CLIPTextEncode (holds negative text literal)
  WIDTH: '320:312',             // PrimitiveInt "Width"
  HEIGHT: '320:299',            // PrimitiveInt "Height"
  FRAME_RATE: '320:300',        // PrimitiveInt "Frame Rate"
  DURATION: '320:301',          // PrimitiveInt "Duration" (seconds!)
  UPSCALER: '320:311',          // LatentUpscaleModelLoader
  NOISE_RANDOM: '320:277',      // RandomNoise — the "randomize" one
}

/**
 * Patches the captured LTX 2.3 API-format workflow with per-run
 * params. Unlike the old modifier this template drives duration in
 * SECONDS (via a PrimitiveInt "Duration" node), and has a dedicated
 * negative-prompt CLIPTextEncode we can literal-set instead of
 * wiring a second primitive. The spatial upscaler is still
 * referenced as v1.1 in the captured template but the user only has
 * v1.0 locally; we swap that at runtime here too.
 */
function modifyLTX23I2VApiWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    negativePrompt = 'pc game, console game, video game, cartoon, childish, ugly',
    inputImage = '',
    width = 1080,
    height = 1920,
    durationSec = 2,
    fps = 25,
    seed,
    filenamePrefix = 'video/LTX_2.3_i2v',
  } = options

  const modified = JSON.parse(JSON.stringify(workflow))

  const setInput = (nodeId, key, value) => {
    if (modified[nodeId]?.inputs) modified[nodeId].inputs[key] = value
  }

  if (inputImage) setInput(LTX_NODE_IDS.LOAD_IMAGE, 'image', inputImage)
  setInput(LTX_NODE_IDS.POSITIVE_PROMPT, 'value', prompt)
  setInput(LTX_NODE_IDS.NEGATIVE_PROMPT, 'text', negativePrompt)
  setInput(LTX_NODE_IDS.WIDTH, 'value', Math.max(256, Math.round(Number(width) || 1080)))
  setInput(LTX_NODE_IDS.HEIGHT, 'value', Math.max(256, Math.round(Number(height) || 1920)))
  setInput(LTX_NODE_IDS.FRAME_RATE, 'value', Math.max(1, Math.round(Number(fps) || 25)))
  setInput(LTX_NODE_IDS.DURATION, 'value', Math.max(1, Math.round(Number(durationSec) || 2)))

  // Seed: only the "randomize" RandomNoise gets our per-run value;
  // the "fixed" one (node :276, seed=42) stays as-is because the
  // template intentionally pairs a deterministic reference noise with
  // a randomized animation noise.
  if (Number.isFinite(seed)) {
    setInput(LTX_NODE_IDS.NOISE_RANDOM, 'noise_seed', seed)
  }

  setInput(LTX_NODE_IDS.SAVE_VIDEO, 'filename_prefix', filenamePrefix)

  // Upscaler model swap: the captured template references v1.1, the
  // user has v1.0. Same swap the old workflow needed.
  for (const node of Object.values(modified)) {
    if (node?.class_type === 'LatentUpscaleModelLoader') {
      const name = String(node.inputs?.model_name || '')
      if (name.includes('ltx-2.3-spatial-upscaler') || name.includes('ltx-2-spatial-upscaler-x2-1.1')) {
        node.inputs.model_name = 'ltx-2-spatial-upscaler-x2-1.0.safetensors'
      }
    }
  }

  return modified
}

const DEFAULT_FPS = 25

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

async function fetchWorkflowJson(path = LTX_I2V_WORKFLOW_PATH) {
  // Both dev (Vite) and prod (electron-builder extraResources) serve
  // public/workflows/ at /workflows/, so the same path works.
  const res = await fetch(path)
  if (!res.ok) throw new Error(`Could not load workflow ${path} (${res.status}).`)
  return await res.json()
}

// (Upscaler-filename patching is now inside modifyLTX23I2VApiWorkflow
// above — kept there so the template-specific tweaks live together
// with the rest of the per-run parameterization.)

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

/**
 * Upload the ref frame + build the fully-patched workflow for a
 * placeholder row, WITHOUT queueing it. Shared by the Generate path
 * (which then queues + waits + downloads) and the Send-to-ComfyUI
 * path (which exports the JSON so the user can inspect / tweak /
 * manually run inside ComfyUI's web UI).
 */
export async function prepareWorkflowForPlaceholder({
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
  // If the user picked one of their first-frame candidates in the
  // placeholder-details modal, use that image as the i2v reference.
  // Otherwise fall back to the nearest surrounding scene's thumbnail
  // (preserves the pre-frame-gallery behavior for rows where the
  // user just hits "generate video" without staging candidates).
  const selectedFrame = (row.genSpec?.frameCandidates || []).find(
    (c) => c?.id === row.genSpec?.selectedFrameId
  )
  let refPath = null
  let refSceneId = null
  let refMimeType = 'image/jpeg'
  if (selectedFrame?.path) {
    refPath = selectedFrame.path
    refMimeType = /\.(png|webp)$/i.test(selectedFrame.path)
      ? (selectedFrame.path.endsWith('.webp') ? 'image/webp' : 'image/png')
      : 'image/jpeg'
  } else {
    const sceneById = new Map((scenes || []).map((s) => [s.id, s]))
    const ref = pickReferenceThumbnail({ edl, rowIndex, sceneById })
    if (!ref) throw new Error('No reference frame available — generate a first frame or run Analysis first.')
    refPath = ref.thumbnail
    refSceneId = ref.sourceSceneId
  }

  onProgress?.({ stage: 'upload_ref' })
  const refBlob = await readFileAsBlob(refPath, refMimeType)
  const uploadFilename = `reedit_ref_row${String(rowIndex + 1).padStart(3, '0')}_${Date.now()}.${refMimeType === 'image/png' ? 'png' : refMimeType === 'image/webp' ? 'webp' : 'jpg'}`
  const upload = await comfyui.uploadFile(refBlob, uploadFilename, '', 'input')
  const comfyImageName = upload?.name || uploadFilename

  onProgress?.({ stage: 'queue_workflow' })
  const workflow = await fetchWorkflowJson(LTX_I2V_WORKFLOW_PATH)

  // Fit generation params to the proposal row. The new template
  // drives duration in WHOLE SECONDS (rounded up so a 1.5s EDL row
  // still gets a 2s clip rather than collapsing to 1s), uses 25 fps
  // per the template default, and takes source-video aspect so the
  // fill matches the surrounding clips.
  const rawDuration = Math.max(0.5, (Number(row.newTcOut) - Number(row.newTcIn)) || 1.5)
  const durationSec = Math.max(1, Math.ceil(rawDuration))
  const fps = DEFAULT_FPS
  const width = sourceVideo?.width || 1080
  const height = sourceVideo?.height || 1920
  const prompt = [row.note || 'cinematic shot', extraPrompt].filter(Boolean).join(' — ')
  const seed = Math.floor(Math.random() * 1e12)

  const modified = modifyLTX23I2VApiWorkflow(workflow, {
    prompt,
    negativePrompt: 'worst quality, low quality, blurry, distorted, artifacts, watermark',
    inputImage: comfyImageName,
    width,
    height,
    durationSec,
    fps,
    seed,
    filenamePrefix: `reedit/row-${String(rowIndex + 1).padStart(3, '0')}`,
  })

  return {
    workflow: modified,
    refFilename: comfyImageName,
    prompt,
    frames: durationSec * fps,
    width,
    height,
    durationSec,
    seed,
    refSceneId,
    refSource: selectedFrame ? 'frame-candidate' : 'scene-thumbnail',
    refFrameId: selectedFrame?.id || null,
  }
}

/**
 * Inspect-first handoff to ComfyUI: upload ref + patch the workflow +
 * copy the JSON to clipboard + save to disk + open ComfyUI in the
 * browser. Does NOT queue — the user wants to load the graph into
 * ComfyUI's canvas, eyeball it, tweak nodes if needed, and only then
 * hit Queue Prompt manually.
 *
 * ComfyUI doesn't currently expose a "load this workflow without
 * running" REST or URL contract. The two working paths to get a
 * workflow onto someone else's canvas are drag-drop of the JSON file
 * and Ctrl+V with the JSON on the clipboard. We set up both, and
 * surface them explicitly in a follow-up modal in the UI so the paste
 * step isn't silent.
 */
export async function sendPlaceholderWorkflowToComfyUI({ row, rowIndex, edl, scenes, sourceVideo, onProgress }) {
  const prepared = await prepareWorkflowForPlaceholder({ row, rowIndex, edl, scenes, sourceVideo, onProgress })
  const json = JSON.stringify(prepared.workflow, null, 2)

  onProgress?.({ stage: 'saving' })
  let savedPath = null
  const projectDir = useProjectStore.getState().currentProjectHandle
  if (typeof projectDir === 'string' && window.electronAPI?.writeFileFromArrayBuffer) {
    try {
      const filename = `row-${String(rowIndex + 1).padStart(3, '0')}-${Date.now()}.json`
      const outputPath = `${projectDir.replace(/\\/g, '/')}/.reedit/workflows/${filename}`
      const bytes = new TextEncoder().encode(json)
      const res = await window.electronAPI.writeFileFromArrayBuffer(outputPath, bytes.buffer)
      if (res?.success) savedPath = outputPath
    } catch (_) { /* non-fatal — clipboard fallback below still works */ }
  }

  // Prefer the main-process clipboard (electronAPI.writeTextToClipboard)
  // — it uses Electron's native `clipboard.writeText` which doesn't
  // race with focus-stealing openExternal. navigator.clipboard is the
  // web fallback for any environment that doesn't expose the IPC.
  let copied = false
  if (window.electronAPI?.writeTextToClipboard) {
    try {
      const res = await window.electronAPI.writeTextToClipboard(json)
      copied = Boolean(res?.success)
    } catch (_) { /* fall through to navigator.clipboard */ }
  }
  if (!copied) {
    try {
      await navigator.clipboard.writeText(json)
      copied = true
    } catch (_) { /* modal offers a retry button */ }
  }

  // Open ComfyUI AFTER the clipboard write resolves so the focus
  // shift can't cancel the write in-flight.
  const comfyBase = getLocalComfyHttpBaseSync()
  if (comfyBase) {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(comfyBase).catch(() => {})
    } else {
      window.open(comfyBase, '_blank', 'noopener,noreferrer')
    }
  }

  return { savedPath, copied, comfyBase, refFilename: prepared.refFilename, json }
}

/**
 * Generate a single first-frame candidate for a placeholder. Each
 * click stacks a new candidate under `row.genSpec.frameCandidates` —
 * the user then reviews the gallery and picks the one they want the
 * i2v pass to animate. This separates the "did the model understand
 * the shot" question from the "is the motion right" question, which
 * in practice takes many fewer video gens to land a good result.
 *
 * Uses Z Image Turbo (the T2I workflow ComfyStudio bundles) for
 * speed — a first-frame candidate should come back in ~5-10s so
 * iteration feels cheap. A prompt override lets the UI pass a more
 * specific caption than `row.note` if the user edited it in the
 * placeholder-details modal.
 */
export async function generateFrameForPlaceholder({
  row,
  rowIndex,
  sourceVideo,
  prompt: promptOverride,
  onProgress,
}) {
  if (row?.kind !== 'placeholder') {
    throw new Error('Only placeholder rows support frame generation.')
  }

  const projectDir = useProjectStore.getState().currentProjectHandle
  if (typeof projectDir !== 'string') {
    throw new Error('Frame generation requires the desktop build (project path needed).')
  }

  onProgress?.({ stage: 'load_workflow' })
  const res = await fetch(FRAME_WORKFLOW_PATH)
  if (!res.ok) throw new Error(`Could not load frame workflow (${res.status}).`)
  const workflow = await res.json()

  const prompt = (promptOverride || row.note || 'cinematic shot').trim()
  const width = sourceVideo?.width || 1024
  const height = sourceVideo?.height || 1024
  // Explicit random seed per call. The modifier's destructuring
  // default is `Math.floor(Math.random() * 1e12)`, which should work,
  // but in practice we were seeing near-identical candidates across
  // repeated clicks — pass the seed ourselves and keep it in the
  // candidate metadata so the gallery can confirm it's actually
  // changing between runs.
  const seed = Math.floor(Math.random() * 1e12)
  const modified = modifyZImageTurboWorkflow(workflow, {
    prompt,
    seed,
    width,
    height,
    filenamePrefix: `reedit/frame-row-${String(rowIndex + 1).padStart(3, '0')}`,
  })

  onProgress?.({ stage: 'queue_workflow' })
  const promptId = await comfyui.queuePrompt(modified)
  if (!promptId) throw new Error('ComfyUI did not return a prompt id.')

  onProgress?.({ stage: 'generating', promptId })
  await waitForCompletion({ promptId, onProgress })

  onProgress?.({ stage: 'download' })
  const history = await comfyui.getHistory(promptId)
  const entry = history?.[promptId]
  const output = pickSaveOutputFromHistory(entry)
  if (!output?.filename) {
    throw new Error('ComfyUI finished but produced no image output — check the workflow and log.')
  }
  // downloadVideo works for images too — it's just a /view fetch.
  const file = await comfyui.downloadVideo(output.filename, output.subfolder || '', output.type || 'output')
  const arrayBuffer = await file.arrayBuffer()

  const localDir = `${projectDir.replace(/\\/g, '/')}/.reedit/frames`
  const id = `frame-${rowIndex + 1}-${Date.now()}`
  const ext = (output.filename.match(/\.(png|jpg|jpeg|webp)$/i)?.[1] || 'png').toLowerCase()
  const outputPath = `${localDir}/${id}.${ext}`
  const writeRes = await window.electronAPI?.writeFileFromArrayBuffer?.(outputPath, arrayBuffer)
  if (!writeRes?.success) throw new Error(writeRes?.error || 'Could not write generated frame to disk.')

  onProgress?.({ stage: 'done' })
  return {
    id,
    path: outputPath,
    prompt,
    seed,
    width,
    height,
    model: 'z-image-turbo',
    promptId,
    createdAt: new Date().toISOString(),
  }
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

  const prepared = await prepareWorkflowForPlaceholder({
    row, rowIndex, edl, scenes, sourceVideo, onProgress, extraPrompt,
  })
  const { workflow: modified, prompt, frames, width, height, durationSec, refSceneId } = prepared

  const promptId = await comfyui.queuePrompt(modified)
  if (!promptId) throw new Error('ComfyUI did not return a prompt id.')

  // Persist the exact workflow that was queued so the user can
  // inspect it later in ComfyUI if the output needs debugging.
  try {
    const filename = `row-${String(rowIndex + 1).padStart(3, '0')}-${promptId.slice(0, 8)}.json`
    const outputPath = `${projectDir.replace(/\\/g, '/')}/.reedit/workflows/${filename}`
    const bytes = new TextEncoder().encode(JSON.stringify(modified, null, 2))
    await window.electronAPI?.writeFileFromArrayBuffer?.(outputPath, bytes.buffer)
  } catch (_) { /* non-fatal */ }

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
    refSceneId,
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
