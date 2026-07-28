// Grok Imagine image-to-video. Single image reference, faster + cheaper
// than Kling but no multi-reference support and slightly less "stylised"
// outputs. Duration is best-effort 1–6 s.
const { safeSeed, formatPromptForGrok } = require('./shared')

module.exports = {
  id: 'grok-imagine-video-beta',
  label: 'Grok Imagine (cloud, draft tier)',
  kind: 'i2v',
  mode: 'cloud',
  partner: true,
  caps: { minDurationSec: 1, maxDurationSec: 6, needsReferenceImage: true },
  buildWorkflow({ referenceFilename, prompt, durationSec, outputPrefix, seed }) {
    const safeDur = Math.max(1, Math.min(6, Math.round(Number(durationSec) || 3)))
    const formattedPrompt = formatPromptForGrok(prompt)
    return {
      '3': { class_type: 'LoadImage', inputs: { image: referenceFilename }, _meta: { title: 'Reference frame' } },
      '1': {
        class_type: 'GrokVideoNode',
        inputs: {
          model: 'grok-imagine-video-beta',
          prompt: formattedPrompt.slice(0, 2000),
          resolution: '720p',
          aspect_ratio: 'auto',          // Grok accepts 'auto' and infers from the reference image
          duration: safeDur,
          seed: safeSeed(seed),
          image: ['3', 0],
        },
        _meta: { title: 'Grok Video i2v' },
      },
      '2': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['1', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
