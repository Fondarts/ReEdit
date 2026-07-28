// Vidu Q2 image-to-video. 1080p native (heavier file but cleaner
// frames). Movement amplitude is "auto" by default; we surface it as
// a tunable later if needed.
const { safeSeed, formatPromptForVidu } = require('./shared')

module.exports = {
  id: 'viduq2-pro-fast',
  label: 'Vidu Q2 Pro Fast (cloud, 1080p)',
  kind: 'i2v',
  mode: 'cloud',
  partner: true,
  caps: { minDurationSec: 4, maxDurationSec: 8, needsReferenceImage: true },
  buildWorkflow({ referenceFilename, prompt, durationSec, outputPrefix, seed }) {
    const safeDur = Math.max(4, Math.min(8, Math.round(Number(durationSec) || 5)))
    const formattedPrompt = formatPromptForVidu(prompt)
    return {
      '40': { class_type: 'LoadImage', inputs: { image: referenceFilename }, _meta: { title: 'Reference frame' } },
      '39': {
        class_type: 'Vidu2ImageToVideoNode',
        inputs: {
          model: 'viduq2-pro-fast',
          prompt: formattedPrompt.slice(0, 2000),
          duration: safeDur,
          seed: safeSeed(seed),
          resolution: '1080p',
          movement_amplitude: 'auto',
          image: ['40', 0],
        },
        _meta: { title: 'Vidu 2 i2v' },
      },
      '37': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['39', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
