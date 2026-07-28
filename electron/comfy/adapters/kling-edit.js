// Kling 3.0 Omni Edit Video — prompt-based video editing (remove or
// change elements) with no mask required. Output length matches the
// input. Used as the maskless cloud engine in the Optimization tab for
// graphics/supers the local mask pipeline struggles with.
//
// Schema (verified 2026-07 via get_node): flat inputs — model_name,
// prompt, video, keep_original_sound, optional reference_images (≤4),
// resolution, seed.
const { safeSeed, capWords, trimEnd } = require('./shared')

module.exports = {
  id: 'kling-omni-edit',
  label: 'Kling 3 Omni Edit (cloud, prompt-based)',
  kind: 'v2v',
  mode: 'cloud',
  partner: true,
  caps: { needsSourceVideo: true, keepsDuration: true },
  buildWorkflow({ sourceVideoFilename, prompt, resolution, outputPrefix, seed }) {
    const body = trimEnd(prompt) || 'Remove all on-screen text, graphics and logos'
    return {
      '1': { class_type: 'LoadVideo', inputs: { file: sourceVideoFilename }, _meta: { title: 'Source clip' } },
      '2': {
        class_type: 'KlingOmniProEditVideoNode',
        inputs: {
          model_name: 'kling-v3-omni',
          prompt: capWords(`${body}. Keep everything else identical: same subject, motion, lighting, framing and duration. Reconstruct the background naturally where elements are removed.`, 150).slice(0, 2000),
          video: ['1', 0],
          keep_original_sound: true,
          resolution: resolution === '720p' ? '720p' : '1080p',
          seed: safeSeed(seed),
        },
        _meta: { title: 'Kling Omni Edit' },
      },
      '3': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['2', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
