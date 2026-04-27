/**
 * project:re-edit — Commit extend (AI footage extension).
 *
 * Renderer-side helper that:
 *   1. Fetches the bundled LTX 2.3 i2v workflow JSON.
 *   2. Runs it through `modifyLTX23I2VApiWorkflow` so the prompt / size
 *      / fps / duration / seed slots are baked in.
 *   3. Hands the patched workflow off to the main-process
 *      `analysis:commitExtend` handler, which extracts the clip's last
 *      frame, uploads it, submits the workflow, polls, and concats the
 *      tail with the original sub-clip.
 *
 * Keeping the LTX template patching here (vs. in main.js) lets us reuse
 * the same `modifyLTX23I2VApiWorkflow` that the placeholder generator
 * already vetted, so both flows stay in sync when the template changes.
 */

import { LTX_I2V_WORKFLOW_PATH, LTX_LOAD_IMAGE_NODE_ID, fetchLTX23I2VWorkflow, modifyLTX23I2VApiWorkflow } from './reeditGenerate'

const DEFAULT_NEGATIVE = 'worst quality, low quality, blurry, distorted, artifacts, watermark, hard cut, shot change, scene change, camera jump, different subject'

/**
 * Build the patched LTX i2v workflow and send the commit request to
 * main. The caller supplies the scene id + extend duration + framing
 * info; we fill in the rest.
 *
 * @param {object} opts
 * @param {string} opts.sceneId
 * @param {string} opts.projectDir
 * @param {number} opts.extendSec  - clamped to 0.2–2 s in main.js too
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {string} [opts.promptText] - rationale from the proposer's
 *   note, passed to the LTX prompt so the continuation stays on-shot.
 */
export async function commitExtend({ sceneId, projectDir, extendSec, width, height, fps, promptText }) {
  const workflow = await fetchLTX23I2VWorkflow()
  const seed = Math.floor(Math.random() * 1e12)
  const patched = modifyLTX23I2VApiWorkflow(workflow, {
    prompt: (promptText && promptText.trim()) || 'Continue the shot naturally with matching motion, lighting, and subject — no cuts or scene changes.',
    negativePrompt: DEFAULT_NEGATIVE,
    width,
    height,
    durationSec: Math.max(1, Math.ceil(Number(extendSec) || 1)),
    fps,
    seed,
    filenamePrefix: `reedit_extend/${sceneId}`,
  })

  return await window.electronAPI.commitExtend({
    sceneId,
    projectDir,
    extendSec,
    workflow: patched,
    loadImageNodeId: LTX_LOAD_IMAGE_NODE_ID,
  })
}
