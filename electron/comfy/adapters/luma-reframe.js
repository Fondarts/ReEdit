// Luma Ray 3.2 video reframe — native aspect-ratio outpaint. Takes the
// source clip and fills the newly exposed canvas, so 9:16 footage can
// become true 16:9 instead of a crop. Source ≤30 s; output caps at
// 1080p (the reframe pipeline's RealESRGAN tail recovers resolution).
//
// Schema (verified 2026-07 via get_node): flat inputs — video, prompt
// (describes the fill), aspect_ratio (16:9|9:16|1:1|4:3|3:4|21:9),
// resolution (360p..1080p), seed. Outputs VIDEO + STRING.
const { safeSeed, capWords, trimEnd } = require('./shared')

const LUMA_ASPECTS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])

module.exports = {
  id: 'luma-ray-3.2-reframe',
  label: 'Luma Ray 3.2 Reframe (cloud, outpaint)',
  kind: 'reframe-outpaint',
  mode: 'cloud',
  partner: true,
  caps: { maxSourceSec: 30, maxResolution: '1080p', needsSourceVideo: true, aspectRatios: [...LUMA_ASPECTS] },
  buildWorkflow({ sourceVideoFilename, prompt, aspectRatio, resolution, outputPrefix, seed }) {
    const aspect = LUMA_ASPECTS.has(String(aspectRatio)) ? String(aspectRatio) : '16:9'
    const body = trimEnd(prompt) || 'the same scene and environment'
    return {
      '1': { class_type: 'LoadVideo', inputs: { file: sourceVideoFilename }, _meta: { title: 'Source clip' } },
      '2': {
        class_type: 'LumaRay32VideoReframeNode',
        inputs: {
          video: ['1', 0],
          prompt: capWords(`Seamlessly extend ${body} into the new canvas areas. Match lighting, palette and grain. No text, no logos, no new subjects.`, 150),
          aspect_ratio: aspect,
          resolution: resolution === '720p' ? '720p' : '1080p',
          seed: safeSeed(seed),
        },
        _meta: { title: 'Luma Ray 3.2 Reframe' },
      },
      '3': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['2', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
