/**
 * project:re-edit — Commit extend (AI footage extension).
 *
 * Renderer-side helper that:
 *   1. Picks the i2v workflow per `capabilitySettings.footageExtend.model`
 *      — LTX 2.3 (default, fast) or WAN 2.2 14B (heavier, sharper).
 *   2. Patches the chosen workflow with the prompt / size / fps /
 *      duration / seed slots.
 *   3. Hands the patched workflow off to the main-process
 *      `analysis:commitExtend` handler, which extracts the clip's last
 *      frame, uploads it, submits the workflow, polls, and concats the
 *      tail with the original sub-clip.
 */

import {
  LTX_LOAD_IMAGE_NODE_ID,
  fetchLTX23I2VWorkflow,
  modifyLTX23I2VApiWorkflow,
  WAN22_LOAD_IMAGE_NODE_ID,
  fetchWan22I2VWorkflow,
  modifyWan22I2VApiWorkflow,
  WAN_SVI_LOAD_VIDEO_NODE_ID,
  fetchWanSviExtendWorkflow,
  modifyWanSviExtendWorkflow,
} from './reeditGenerate'
import { loadCapabilitySettings } from './reeditCapabilitySettings'

const DEFAULT_NEGATIVE = 'worst quality, low quality, blurry, distorted, artifacts, watermark, hard cut, shot change, scene change, camera jump, different subject'

/**
 * Build the patched i2v workflow and send the commit request to main.
 * The chosen i2v model (LTX 2.3 vs WAN 2.2 14B) comes from Settings →
 * Capabilities → Footage extend → Model. Both produce an MP4 tail
 * that main.js then concatenates with the source sub-clip.
 *
 * @param {object} opts
 * @param {string} opts.sceneId
 * @param {string} opts.projectDir
 * @param {number} opts.extendSec
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.promptText]
 */
export async function commitExtend({ sceneId, projectDir, extendSec, sourceDurationSec, width, height, fps, promptText, modelOverride }) {
  // Per-clip override (Inspector dropdown) wins over the global
  // Settings default when present. Lets the user A/B different i2v
  // models without thrashing global settings.
  const modelId = String(modelOverride || loadCapabilitySettings()?.footageExtend?.model || 'ltx-2.3')
  const seed = Math.floor(Math.random() * 1e12)
  const prompt = (promptText && promptText.trim())
    || 'Continue the shot naturally with matching motion, lighting, and subject — no cuts or scene changes.'

  let patched
  let loadImageNodeId = null
  let loadVideoNodeId = null

  if (modelId === 'wan-2.2-svi') {
    // WAN 2.2 SVI Pro extend. The workflow takes the FULL source clip
    // as input (VHS_LoadVideo), uses its last frame as the anchor,
    // and emits the concatenated original+extended MP4 in a single
    // graph run via ImageBatchExtendWithOverlap. main.js uploads the
    // source sub-clip MP4 and skips the last-frame extract + ffmpeg
    // concat steps it does for the other paths.
    const workflow = await fetchWanSviExtendWorkflow()
    patched = modifyWanSviExtendWorkflow(workflow, {
      prompt,
      negativePrompt: DEFAULT_NEGATIVE,
      sourceDurationSec: Math.max(0.5, Number(sourceDurationSec) || 1),
      extendSec: Math.max(0.5, Number(extendSec) || 1),
      // Source dims are passed so the modifier can cap the
      // low-noise pass internally (~720p max edge for 12 GB cards),
      // saving ~3 GB of working VRAM. main.js upscales the final
      // output back to source dims via ffmpeg.
      sourceWidth: width,
      sourceHeight: height,
      seed,
      filenamePrefix: `reedit_extend/${sceneId}`,
    })
    loadVideoNodeId = WAN_SVI_LOAD_VIDEO_NODE_ID
  } else if (modelId === 'wan-2.2-14b') {
    // WAN 2.2 14B base i2v. Render at 16fps (training rate) — main.js's
    // concat re-encodes via libx264 and we trust ffmpeg to bridge the
    // rate. Forcing the source's fps here would push the model
    // off-distribution and degrade output.
    const workflow = await fetchWan22I2VWorkflow()
    patched = modifyWan22I2VApiWorkflow(workflow, {
      prompt,
      negativePrompt: DEFAULT_NEGATIVE,
      width,
      height,
      durationSec: Math.max(0.5, Number(extendSec) || 1),
      fps: 16,
      seed,
      filenamePrefix: `reedit_extend/${sceneId}`,
    })
    loadImageNodeId = WAN22_LOAD_IMAGE_NODE_ID
  } else {
    // LTX 2.3 i2v (default, faster).
    const workflow = await fetchLTX23I2VWorkflow()
    patched = modifyLTX23I2VApiWorkflow(workflow, {
      prompt,
      negativePrompt: DEFAULT_NEGATIVE,
      width,
      height,
      durationSec: Math.max(1, Math.ceil(Number(extendSec) || 1)),
      fps,
      seed,
      filenamePrefix: `reedit_extend/${sceneId}`,
    })
    loadImageNodeId = LTX_LOAD_IMAGE_NODE_ID
  }

  return await window.electronAPI.commitExtend({
    sceneId,
    projectDir,
    extendSec,
    workflow: patched,
    loadImageNodeId,
    loadVideoNodeId,
    modelId,
  })
}
