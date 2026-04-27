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
export const LTX_I2V_WORKFLOW_PATH = '/workflows/ltx2_3_i2v_api.json'
// Re-export the LoadImage node id so the commit-extend service can
// tell main.js which slot to inject the uploaded last-frame PNG into
// without re-discovering it from the JSON.
export const LTX_LOAD_IMAGE_NODE_ID = '269'

// WAN 2.2 14B image-to-video — alternative path. Better quality than
// LTX 2.3 at the cost of slower inference (especially without the
// lightx2v 4-step LoRAs, which most users don't have installed
// alongside the base UNETs). The user has the base models per the
// dependency audit:
//   - wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors (UNETLoader)
//   - wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors (UNETLoader)
//   - wan_2.1_vae.safetensors (VAELoader)
//   - umt5_xxl_fp8_e4m3fn_scaled.safetensors (CLIPLoader)
export const WAN22_I2V_WORKFLOW_PATH = '/workflows/video_wan2_2_14B_i2v.json'
export const WAN22_LOAD_IMAGE_NODE_ID = '97'

const WAN22_NODE_IDS = {
  LOAD_IMAGE: '97',
  POSITIVE_PROMPT: '93',          // CLIPTextEncode positive
  NEGATIVE_PROMPT: '89',          // CLIPTextEncode negative
  WAN_I2V: '98',                  // WanImageToVideo (width / height / length)
  CREATE_VIDEO: '94',             // CreateVideo (fps)
  SAVE_VIDEO: '108',              // SaveVideo (filename_prefix)
  KSAMPLER_HIGH: '86',            // KSamplerAdvanced (high-noise pass; seed lives here)
  KSAMPLER_LOW: '85',             // KSamplerAdvanced (low-noise pass)
  LORA_HIGH: '101',               // lightx2v 4-step high-noise LoRA
  LORA_LOW: '102',                // lightx2v 4-step low-noise LoRA
}

// Bypass the lightx2v 4-step LoRAs the WAN template wires in by
// default. Those LoRAs let the model render in just 4 steps; without
// them the model needs 20+ steps with normal cfg to produce decent
// output. We rewire the LoRA consumers (the two ModelSamplingSD3 nodes)
// to read directly from the upstream UNETLoaders, then delete the LoRA
// nodes so ComfyUI doesn't reject the workflow on the missing files.
function bypassWan22Lightx2vLora(workflow) {
  for (const id of [WAN22_NODE_IDS.LORA_HIGH, WAN22_NODE_IDS.LORA_LOW]) {
    const loraNode = workflow[id]
    if (!loraNode || loraNode.class_type !== 'LoraLoaderModelOnly') continue
    const upstreamModel = loraNode.inputs?.model
    if (!Array.isArray(upstreamModel) || upstreamModel.length < 2) continue
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (nodeId === id) continue
      if (!node?.inputs) continue
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value.length >= 2 && value[0] === id) {
          node.inputs[key] = upstreamModel
        }
      }
    }
    delete workflow[id]
  }
}

/**
 * Patches the WAN 2.2 14B i2v workflow with per-run params. The
 * template was captured from a working ComfyUI run — dimensions,
 * length, fps, seed, prompt, and SaveVideo prefix are the only knobs
 * we tune per request. The lightx2v LoRA bypass + step-count bump
 * makes the workflow runnable without those LoRAs.
 *
 * Frame count math: WAN expects (4n+1) frames (e.g. 17, 33, 49, 65,
 * 81). We round up to the nearest legal value that covers
 * `durationSec`, since under-shooting clips the tail.
 *
 * @param {object} workflow  - parsed JSON of the WAN i2v template
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.negativePrompt]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.durationSec]
 * @param {number} [options.fps] - WAN trains at 16fps; we honour the
 *   caller's value but recommend 16 unless the source ad is also 16fps.
 * @param {number} [options.seed]
 * @param {string} [options.filenamePrefix]
 * @param {boolean} [options.bypassLightx2vLora=true]
 * @param {number} [options.stepsWithoutLora=20]
 */
export function modifyWan22I2VApiWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    // English replacement for the Chinese negative prompt that ships
    // in the captured template — same intent (low quality, motion
    // jitter, watermark, etc.) but legible to anyone reading the
    // workflow JSON.
    negativePrompt = 'low quality, blurry, jpeg artifacts, watermark, subtitles, oversaturated, washed out, static frame, deformed hands, extra fingers, distorted face, motion smear, ghosting, jitter, hard cut',
    inputImage = '',
    width = 1280,
    height = 720,
    durationSec = 2,
    fps = 16,
    seed,
    filenamePrefix = 'video/WAN22_i2v',
    bypassLightx2vLora = true,
    stepsWithoutLora = 20,
  } = options

  const modified = JSON.parse(JSON.stringify(workflow))
  const setInput = (nodeId, key, value) => {
    if (modified[nodeId]?.inputs) modified[nodeId].inputs[key] = value
  }

  if (inputImage) setInput(WAN22_NODE_IDS.LOAD_IMAGE, 'image', inputImage)
  setInput(WAN22_NODE_IDS.POSITIVE_PROMPT, 'text', prompt || 'natural continuation of the previous shot, matching motion and lighting')
  setInput(WAN22_NODE_IDS.NEGATIVE_PROMPT, 'text', negativePrompt)

  const wantedFrames = Math.max(1, Math.ceil(Number(durationSec) * Number(fps)))
  // Round UP to the nearest 4n+1 — WAN's latent reshape requires it,
  // and chopping post-decode is preferable to coming up short.
  const length = wantedFrames + ((4 - ((wantedFrames - 1) % 4)) % 4)
  setInput(WAN22_NODE_IDS.WAN_I2V, 'width', Math.max(256, Math.round(Number(width) || 1280)))
  setInput(WAN22_NODE_IDS.WAN_I2V, 'height', Math.max(256, Math.round(Number(height) || 720)))
  setInput(WAN22_NODE_IDS.WAN_I2V, 'length', length)
  setInput(WAN22_NODE_IDS.CREATE_VIDEO, 'fps', Math.max(1, Math.round(Number(fps) || 16)))
  setInput(WAN22_NODE_IDS.SAVE_VIDEO, 'filename_prefix', filenamePrefix)

  if (Number.isFinite(seed)) {
    setInput(WAN22_NODE_IDS.KSAMPLER_HIGH, 'noise_seed', seed)
  }

  if (bypassLightx2vLora) {
    bypassWan22Lightx2vLora(modified)
    // Without the speed-up LoRAs, the 4-step setup produces garbage.
    // Re-balance the two sampler passes to share `stepsWithoutLora`
    // total steps (high-noise gets the first half, low-noise the
    // second half) and bump cfg from 1.0 (CFG-distilled) back to 5.5
    // for normal classifier-free guidance.
    const total = Math.max(8, Math.round(Number(stepsWithoutLora) || 20))
    const half = Math.floor(total / 2)
    setInput(WAN22_NODE_IDS.KSAMPLER_HIGH, 'steps', total)
    setInput(WAN22_NODE_IDS.KSAMPLER_HIGH, 'start_at_step', 0)
    setInput(WAN22_NODE_IDS.KSAMPLER_HIGH, 'end_at_step', half)
    setInput(WAN22_NODE_IDS.KSAMPLER_HIGH, 'cfg', 5.5)
    setInput(WAN22_NODE_IDS.KSAMPLER_LOW, 'steps', total)
    setInput(WAN22_NODE_IDS.KSAMPLER_LOW, 'start_at_step', half)
    setInput(WAN22_NODE_IDS.KSAMPLER_LOW, 'end_at_step', total)
    setInput(WAN22_NODE_IDS.KSAMPLER_LOW, 'cfg', 5.5)
  }

  return modified
}

export function fetchWan22I2VWorkflow() {
  return fetchWorkflowJson(WAN22_I2V_WORKFLOW_PATH)
}

// WAN 2.2 14B SVI Pro extend workflow. Distinct from the plain WAN
// i2v path: SVI takes the FULL source clip as input (not just a still
// frame), uses the last source frame as an anchor, and emits the
// concatenated original + extended MP4 in one go via
// ImageBatchExtendWithOverlap. Net effect for our pipeline: no
// last-frame extraction needed, no ffmpeg concat afterward.
export const WAN_SVI_WORKFLOW_PATH = '/workflows/wan2_2_svi_extend_api.json'
export const WAN_SVI_LOAD_VIDEO_NODE_ID = '338'

const WAN_SVI_NODE_IDS = {
  LOAD_VIDEO: '338',
  POSITIVE_PROMPT: '318',
  NEGATIVE_PROMPT: '320',
  SVI_HIGH: '308',                 // WanImageToVideoSVIPro (high-noise pass)
  SVI_LOW: '341',                  // WanImageToVideoSVIPro (low-noise pass)
  ANCHOR_FRAME_INDEX: '346',       // PrimitiveInt — frame index in source video
  RANDOM_NOISE_HIGH: '326',
  RANDOM_NOISE_LOW: '349',
  SAVE_VIDEO: '357',
  SAVE_HIGH_INTERMEDIATE: '359',   // we don't need the intermediate video saved
}

/**
 * Patches the WAN 2.2 SVI Pro extend workflow with per-run params.
 * Length math: SVI emits a concatenated `original + extension` video,
 * so the length input is total frames at the workflow's 16 fps. We
 * compute that as ceil(sourceDur * 16) + ceil(extendSec * 16), and
 * set the anchor frame to the last frame of the source so SVI extends
 * from there.
 *
 * The SVI Pro LoRAs are required by this template (HIGH + LOW rank
 * 128, plus a step-distill LoRA). We don't bypass them — without them
 * the SVI Pro node likely won't even validate. Users who picked this
 * model from Settings → Capabilities have committed to it.
 */
export function modifyWanSviExtendWorkflow(workflow, options = {}) {
  const {
    inputVideoFilename = '',
    prompt = '',
    negativePrompt = 'ugly, horror, creepy, injured, warped, deformed, glitch, stutter, artifacts, flashes, hard cut, scene change',
    sourceDurationSec = 1,
    extendSec = 1,
    sourceWidth = 1920,
    sourceHeight = 1080,
    // Max edge for the LOW-noise SVI pass. WAN 2.2 14B fp8 + the
    // SVI Pro HIGH/LOW LoRAs already eats ~10 GB resident; running
    // 49-frame latents at 1920×1080 pushes a 12 GB card into the
    // dynamic-VRAM-swap death spiral (we observed > 20 min hangs
    // with 11.6/12 GB used). 720p max edge keeps working memory
    // bounded; main.js's ffmpeg post-process upscales the final
    // output back to the source dimensions.
    lowNoiseMaxEdge = 720,
    seed,
    filenamePrefix = 'reedit_extend/svi',
  } = options

  const modified = JSON.parse(JSON.stringify(workflow))
  const setInput = (nodeId, key, value) => {
    if (modified[nodeId]?.inputs) modified[nodeId].inputs[key] = value
  }

  if (inputVideoFilename) setInput(WAN_SVI_NODE_IDS.LOAD_VIDEO, 'video', inputVideoFilename)
  setInput(WAN_SVI_NODE_IDS.POSITIVE_PROMPT, 'text', prompt || 'natural continuation of the scene, matching motion, lighting, and subject — no scene change, no cut')
  setInput(WAN_SVI_NODE_IDS.NEGATIVE_PROMPT, 'text', negativePrompt)

  // SVI runs at 16 fps. force_rate=16 on VHS_LoadVideo means whatever
  // fps the source clip is at, ComfyUI re-times it to 16 fps before
  // feeding the model. So our frame counts are always at 16 fps.
  const FPS = 16
  const sourceFrames = Math.max(1, Math.round(Number(sourceDurationSec) * FPS))
  const extendFrames = Math.max(1, Math.round(Number(extendSec) * FPS))
  const totalFrames = sourceFrames + extendFrames
  // SVI Pro expects (4n+1) frame counts the same way the base WAN
  // i2v does. Round up.
  const length = totalFrames + ((4 - ((totalFrames - 1) % 4)) % 4)
  const anchorIndex = Math.max(0, sourceFrames - 1)

  setInput(WAN_SVI_NODE_IDS.SVI_HIGH, 'length', length)
  setInput(WAN_SVI_NODE_IDS.SVI_LOW, 'length', length)
  setInput(WAN_SVI_NODE_IDS.ANCHOR_FRAME_INDEX, 'value', anchorIndex)

  if (Number.isFinite(seed)) {
    setInput(WAN_SVI_NODE_IDS.RANDOM_NOISE_HIGH, 'noise_seed', seed)
    setInput(WAN_SVI_NODE_IDS.RANDOM_NOISE_LOW, 'noise_seed', seed)
  }

  // Final concatenated output. We override the prefix so the file
  // lands in our reedit_extend subfolder instead of the workflow's
  // default `extended_video` name.
  setInput(WAN_SVI_NODE_IDS.SAVE_VIDEO, 'filename_prefix', filenamePrefix)
  // The intermediate "high noise" video the workflow saves is debug
  // output we don't need on disk — flip save_output off so ComfyUI
  // skips the file write but the node still functions in the graph.
  setInput(WAN_SVI_NODE_IDS.SAVE_HIGH_INTERMEDIATE, 'save_output', false)

  // VAE filename normalisation: the captured template references
  // `wan2.1-vae.safetensors` (with hyphens) but most installations
  // use `wan_2.1_vae.safetensors` (with underscores). Swap to the
  // user's filename convention so VAELoader doesn't 400.
  const vaeNode = modified['316']
  if (vaeNode?.class_type === 'VAELoader') {
    const name = String(vaeNode.inputs?.vae_name || '')
    if (name === 'wan2.1-vae.safetensors') {
      vaeNode.inputs.vae_name = 'wan_2.1_vae.safetensors'
    }
  }

  // Model + LoRA filename normalisation. The captured template was
  // exported from a ComfyUI install that organises models in `wan/`
  // and `svi/` subfolders and uses fp16 weights. Most installs (the
  // user's included) keep models flat at the loader root and only
  // have fp8 weights for the WAN 14B i2v pair (fp16 is ~30 GB,
  // doesn't fit on a 4070). Walk every UNET / LoRA node and rewrite
  // the names so ComfyUI can find them. The mapping is conservative
  // — we only rewrite the EXACT strings shipped in the SVI template;
  // anything else passes through untouched so user-tweaked workflows
  // aren't clobbered.
  const MODEL_NAME_MAP = {
    'wan/wan2.2_i2v_high_noise_14B_fp16.safetensors': 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
    'wan/wan2.2_i2v_low_noise_14B_fp16.safetensors': 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  }
  const LORA_NAME_MAP = {
    'svi/SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors': 'SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors',
    'svi/SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors': 'SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors',
    'wan/lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors': 'lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors',
  }
  for (const node of Object.values(modified)) {
    if (!node?.inputs) continue
    if (node.class_type === 'UNETLoader' || node.class_type === 'DiffusionModelLoaderKJ') {
      const before = String(node.inputs.model_name || node.inputs.unet_name || '')
      const after = MODEL_NAME_MAP[before]
      if (after) {
        if (node.inputs.model_name !== undefined) node.inputs.model_name = after
        if (node.inputs.unet_name !== undefined) node.inputs.unet_name = after
      }
    } else if (node.class_type === 'LoraLoaderModelOnly' || node.class_type === 'LoraLoader') {
      const before = String(node.inputs.lora_name || '')
      const after = LORA_NAME_MAP[before]
      if (after) node.inputs.lora_name = after
    }
  }

  // VRAM cap on the low-noise pass. Replace node 358's width/height
  // INPUTS (which the template wired to GetImageSize → source dims)
  // with literal numbers computed from `lowNoiseMaxEdge`. Working
  // memory in the latent space scales linearly with width × height,
  // so capping the long edge keeps the workload tractable on a 12 GB
  // card. main.js post-rescales the output to source dims via
  // ffmpeg / lanczos, so the user still sees full-resolution video
  // on the timeline.
  const aspect = Math.max(0.1, Number(sourceWidth) / Math.max(1, Number(sourceHeight)))
  const longEdge = Math.max(256, Math.round(Number(lowNoiseMaxEdge) || 720))
  let cappedW, cappedH
  if (aspect >= 1) {
    cappedW = longEdge
    cappedH = Math.round(longEdge / aspect)
  } else {
    cappedH = longEdge
    cappedW = Math.round(longEdge * aspect)
  }
  // Round to multiples of 8 to keep the WAN VAE happy.
  cappedW = Math.max(64, Math.round(cappedW / 8) * 8)
  cappedH = Math.max(64, Math.round(cappedH / 8) * 8)
  const resizeNode = modified['358']
  if (resizeNode?.class_type === 'ImageResizeKJv2') {
    resizeNode.inputs.width = cappedW
    resizeNode.inputs.height = cappedH
    resizeNode.inputs.divisible_by = 8
  }

  // Sanitise nodes that ComfyUI's "Save (API Format)" couldn't fully
  // serialise — a missing `class_type` means the exporter saw a custom
  // node it didn't recognise. The captured template has node 329 in
  // this shape (between BasicScheduler/330 and the high-noise sampler
  // 325, with an `UNKNOWN: 0.9` parameter — almost certainly a
  // sigma-split-by-denoise node). We try a best-effort recovery:
  // first guess SplitSigmasDenoise, and if that node id isn't
  // registered in the user's ComfyUI install we'll fall back at
  // submit time by short-circuiting consumers to read from the
  // upstream BasicScheduler instead.
  for (const [nodeId, node] of Object.entries(modified)) {
    if (node && typeof node === 'object' && !node.class_type && node.inputs) {
      const inputKeys = Object.keys(node.inputs)
      const hasSigmas = inputKeys.includes('sigmas')
      const denoiseLike = node.inputs.UNKNOWN
      if (hasSigmas && Number.isFinite(Number(denoiseLike))) {
        // Best guess: a sigma-split-by-denoise. Rename UNKNOWN → denoise
        // and stamp the class_type. If wrong, the bypass below kicks in.
        node.inputs.denoise = Number(denoiseLike)
        delete node.inputs.UNKNOWN
        node.class_type = 'SplitSigmasDenoise'
        node._meta = { title: 'Split Sigmas Denoise (recovered)' }
      } else {
        // Last resort: bypass. Rewrite every consumer of [nodeId, *] to
        // read from the first inputs link we can find (so the data
        // flows through, just skipping whatever this node was meant
        // to do).
        const passthrough = inputKeys
          .map((k) => node.inputs[k])
          .find((v) => Array.isArray(v) && v.length >= 2)
        if (passthrough) {
          for (const [otherId, other] of Object.entries(modified)) {
            if (otherId === nodeId || !other?.inputs) continue
            for (const [key, value] of Object.entries(other.inputs)) {
              if (Array.isArray(value) && value.length >= 2 && value[0] === nodeId) {
                other.inputs[key] = passthrough
              }
            }
          }
          delete modified[nodeId]
        }
      }
    }
  }

  return modified
}

export function fetchWanSviExtendWorkflow() {
  return fetchWorkflowJson(WAN_SVI_WORKFLOW_PATH)
}

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
  DISTILLED_LORA: '320:285',    // LoraLoaderModelOnly — distilled LTX 2.3 LoRA
}

// Re-cable the workflow so consumers of the distilled LoRA's output
// read directly from the LoRA's input model, effectively removing the
// LoRA from the chain. Used when the user doesn't have the LoRA file
// locally — ComfyUI rejects the workflow at submission with a
// "lora_name not in list" error otherwise. The distilled LoRA is a
// quality-of-life enhancer at strength 0.5; bypassing it gives output
// that's a few percent softer but still usable.
function bypassDistilledLora(workflow) {
  const loraNode = workflow[LTX_NODE_IDS.DISTILLED_LORA]
  if (!loraNode || loraNode.class_type !== 'LoraLoaderModelOnly') return
  const upstreamModel = loraNode.inputs?.model
  if (!Array.isArray(upstreamModel) || upstreamModel.length < 2) return
  // Walk every node and rewrite any input link of shape ['320:285', N]
  // to point at the LoRA's upstream model link instead. We delete the
  // LoRA node afterwards so ComfyUI doesn't try to validate its
  // missing file.
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (nodeId === LTX_NODE_IDS.DISTILLED_LORA) continue
    if (!node?.inputs) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length >= 2 && value[0] === LTX_NODE_IDS.DISTILLED_LORA) {
        node.inputs[key] = upstreamModel
      }
    }
  }
  delete workflow[LTX_NODE_IDS.DISTILLED_LORA]
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
// Exported so commitExtend can reuse the exact same template patching
// (prompt, size, fps, duration, seed) that the placeholder generator
// already uses — if the upstream LTX template changes, both flows pick
// up the fix automatically.
export function modifyLTX23I2VApiWorkflow(workflow, options = {}) {
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
    // Bypass the distilled LoRA when the user doesn't have it
    // installed locally. ComfyUI hard-rejects workflows referencing
    // missing LoRA files, so the modifier needs to know whether to
    // re-cable the LoRA out of the chain. Default ON because the
    // distilled LoRA isn't widely installed and we'd rather ship a
    // workflow that runs (slightly softer output) than one that
    // 400s on submission.
    bypassDistilled = true,
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

  // Upscaler model swap: the captured template references the v1.1
  // file (ltx-2.3-spatial-upscaler-x2-1.1.safetensors) but most users
  // only have v1.0 locally. Swap to whichever 2.3 v1.0 file exists in
  // their ComfyUI dir — note the `2.3-` prefix is REQUIRED (an older
  // build of this code dropped it and pointed at a non-existent
  // `ltx-2-spatial-upscaler-x2-1.0.safetensors`, breaking submission
  // for everyone with the 2.3-named file).
  for (const node of Object.values(modified)) {
    if (node?.class_type === 'LatentUpscaleModelLoader') {
      const name = String(node.inputs?.model_name || '')
      if (name.includes('spatial-upscaler') && name.includes('1.1')) {
        node.inputs.model_name = 'ltx-2.3-spatial-upscaler-x2-1.0.safetensors'
      }
    }
  }

  // Bypass the distilled LoRA when the user doesn't have it. We don't
  // probe ComfyUI here — flipping bypassDistilled is the simpler
  // mechanism and the LoRA at strength 0.5 is a quality enhancer, not
  // structurally required.
  if (bypassDistilled) {
    bypassDistilledLora(modified)
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

// Convenience for sibling services (commitExtend) that only need the
// LTX i2v template. Keeping the fetch helper private otherwise so
// random callers can't load arbitrary workflow paths.
export function fetchLTX23I2VWorkflow() {
  return fetchWorkflowJson(LTX_I2V_WORKFLOW_PATH)
}

// F5-TTS voice synthesis workflow. The graph is small enough that
// constructing it in JS is cleaner than shipping a JSON template:
// just F5TTSAudio (the niknah custom node) → SaveAudio (built-in).
//
// Per-language model picker — F5-TTS_v1_Base is the strongest English
// model and also handles Mandarin. Other languages have community
// fine-tunes registered inside the F5-TTS node itself; we map the
// simple language code we use everywhere else to the model id the
// node exposes.
const F5_LANGUAGE_MODELS = {
  en: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
  zh: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
  es: { model: 'F5-ES', model_type: 'F5TTS_Base' },
  fr: { model: 'F5-FR', model_type: 'F5TTS_Base' },
  de: { model: 'F5-DE', model_type: 'F5TTS_Base' },
  it: { model: 'F5-IT', model_type: 'F5TTS_Base' },
  ja: { model: 'F5-JP', model_type: 'F5TTS_Base' },
  // No native PT model; English handles common Romance phonetics
  // acceptably for short ad reads. Users wanting better quality should
  // switch to ES (close enough for most words) or supply a custom .pt
  // file under models/checkpoints/F5-TTS/.
  pt: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
}

export const F5_F5_AUDIO_NODE_ID = '1'
export const F5_SAVE_AUDIO_NODE_ID = '2'

/**
 * Build a 2-node ComfyUI workflow that synthesises one segment of
 * voiceover from a reference voice clip + the target text. The caller
 * is responsible for uploading the reference WAV (and its paired .txt
 * with the EXACT transcript) to ComfyUI's input dir before queuing
 * this — the F5TTSAudio node looks up `sample` against
 * `<comfy_input>/<sample>` and `<comfy_input>/<stem>.txt`.
 *
 * @param {object} opts
 * @param {string} opts.referenceFilename — basename of the reference WAV inside ComfyUI's input dir.
 * @param {string} opts.speech            — segment text to synthesise.
 * @param {string} [opts.language]        — ISO code; default 'en'.
 * @param {number} [opts.speed]           — 1.0 default. Above 1.0 = SLOWER per node tooltip.
 * @param {number} [opts.seed]            — -1 random; pass a fixed int for reproducibility.
 * @param {string} [opts.filenamePrefix]  — prefix for SaveAudio. Default 'reedit_vo/segment'.
 * @param {string} [opts.vocoder]         — 'auto' (default), 'vocos', or 'bigvgan'.
 */
export function buildF5TTSWorkflow({
  referenceFilename,
  speech,
  language = 'en',
  speed = 1.0,
  seed = -1,
  filenamePrefix = 'reedit_vo/segment',
  vocoder = 'auto',
} = {}) {
  if (!referenceFilename) throw new Error('buildF5TTSWorkflow: referenceFilename required')
  if (!speech || !String(speech).trim()) throw new Error('buildF5TTSWorkflow: speech required')
  const langModel = F5_LANGUAGE_MODELS[language] || F5_LANGUAGE_MODELS.en
  return {
    [F5_F5_AUDIO_NODE_ID]: {
      class_type: 'F5TTSAudio',
      inputs: {
        sample: referenceFilename,
        speech: String(speech).trim(),
        seed: Number.isFinite(seed) ? Math.floor(seed) : -1,
        model: langModel.model,
        vocoder,
        speed: Number.isFinite(speed) ? speed : 1.0,
        model_type: langModel.model_type,
      },
    },
    [F5_SAVE_AUDIO_NODE_ID]: {
      class_type: 'SaveAudio',
      inputs: {
        audio: [F5_F5_AUDIO_NODE_ID, 0],
        filename_prefix: filenamePrefix,
      },
    },
  }
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
