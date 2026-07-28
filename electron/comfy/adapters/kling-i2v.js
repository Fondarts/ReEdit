// Kling 3 Omni image-to-video via Comfy Cloud partner node.
const { safeSeed, aspectBucket, formatPromptForKling } = require('./shared')

module.exports = {
  id: 'kling-v3-omni',
  label: 'Kling 3 Omni (cloud)',
  kind: 'i2v',
  mode: 'cloud',
  partner: true, // requires extra_data.api_key_comfy_org on submit
  caps: { minDurationSec: 3, maxDurationSec: 15, needsReferenceImage: true, aspectRatios: ['16:9', '9:16', '1:1'] },
  buildWorkflow({ referenceFilename, prompt, durationSec, aspectRatio, resolution, outputPrefix, seed }) {
    // Kling's KlingOmniProImageToVideoNode requires duration in [3, 15].
    // We always request 3 s from the model; the timeline applier trims
    // the clip down to whatever the EDL row actually needs.
    const safeDur = Math.max(3, Math.min(15, Math.round(Number(durationSec) || 3)))
    const formattedPrompt = formatPromptForKling(prompt)
    return {
      '17': { class_type: 'LoadImage', inputs: { image: referenceFilename }, _meta: { title: 'Reference frame' } },
      '21': {
        class_type: 'KlingOmniProImageToVideoNode',
        inputs: {
          model_name: 'kling-v3-omni',
          prompt: formattedPrompt.slice(0, 2000),
          aspect_ratio: aspectBucket(aspectRatio),
          duration: safeDur,
          resolution: resolution || '720p',
          storyboards: 'disabled',
          generate_audio: false,
          seed: safeSeed(seed),
          reference_images: ['17', 0],
        },
        _meta: { title: 'Kling 3 Omni i2v' },
      },
      '20': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['21', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
