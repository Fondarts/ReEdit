// Vidu Q2 video extension — true video-context extend (the model sees
// the source clip's motion, not just a last frame), which is why its
// cloud ceiling (5 s) can sit above the 2 s drift-limit we impose on
// local last-frame i2v extends.
//
// Schema (verified 2026-07 via get_node): DynamicCombo `model`
// (viduq2-pro | viduq2-turbo) with dotted `model.duration` (1-7) and
// `model.resolution` (720p | 1080p); flat `video` / `prompt` / `seed`;
// optional `end_frame` IMAGE.
const { safeSeed, capWords, trimEnd } = require('./shared')

module.exports = {
  id: 'viduq2-pro-extend',
  label: 'Vidu Q2 Extend (cloud, video-context)',
  kind: 'extend',
  mode: 'cloud',
  partner: true,
  caps: { minDurationSec: 1, maxDurationSec: 7, needsSourceVideo: true },
  buildWorkflow({ sourceVideoFilename, prompt, durationSec, resolution, outputPrefix, seed }) {
    const safeDur = Math.max(1, Math.min(7, Math.round(Number(durationSec) || 4)))
    const body = trimEnd(prompt) || 'Continue this exact shot: same subject, lighting, palette and camera motion'
    return {
      '1': { class_type: 'LoadVideo', inputs: { file: sourceVideoFilename }, _meta: { title: 'Source clip' } },
      '2': {
        class_type: 'ViduExtendVideoNode',
        inputs: {
          model: 'viduq2-pro',
          'model.duration': safeDur,
          'model.resolution': resolution === '1080p' ? '1080p' : '720p',
          video: ['1', 0],
          prompt: capWords(`${body}. No new subjects, no scene change, seamless continuation.`, 150).slice(0, 2000),
          seed: safeSeed(seed),
        },
        _meta: { title: 'Vidu Q2 Extend' },
      },
      '3': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['2', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
