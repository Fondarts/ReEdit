// Google Veo 3.1 first/last-frame to video. Used for "bridge" fills: a
// placeholder that sits BETWEEN two original rows takes the previous
// row's last frame + the next row's first frame, giving far better
// continuity than single-reference i2v.
//
// Schema (verified 2026-07 via get_node): flat inputs; model options
// veo-3.1-generate | veo-3.1-fast-generate | veo-3.1-lite; duration
// 4-8 s; first_frame + last_frame IMAGE required.
const { safeSeed, capWords, trimEnd } = require('./shared')

// Veo favours flowing prose; audio cues are wasted tokens since we mute
// generated audio (fills ride under the cut's own music bed).
function formatPromptForVeo(note) {
  const body = trimEnd(note) || 'A subtle connecting moment consistent with the surrounding shots'
  return capWords(
    `${body}. Bridge naturally from the first frame to the last frame: continuous motion, matching lighting and palette, photoreal, cinematic.`,
    150,
  )
}

module.exports = {
  id: 'veo-3.1-flf',
  label: 'Veo 3.1 First/Last Frame (cloud, bridge)',
  kind: 'i2v',
  mode: 'cloud',
  partner: true,
  caps: {
    minDurationSec: 4, maxDurationSec: 8,
    needsReferenceImage: true, needsLastFrame: true,
    aspectRatios: ['16:9', '9:16'],
  },
  buildWorkflow({ referenceFilename, lastFrameFilename, prompt, durationSec, aspectRatio, resolution, outputPrefix, seed }) {
    const safeDur = Math.max(4, Math.min(8, Math.round(Number(durationSec) || 4)))
    return {
      '1': { class_type: 'LoadImage', inputs: { image: referenceFilename }, _meta: { title: 'First frame' } },
      '2': { class_type: 'LoadImage', inputs: { image: lastFrameFilename || referenceFilename }, _meta: { title: 'Last frame' } },
      '3': {
        class_type: 'Veo3FirstLastFrameNode',
        inputs: {
          prompt: formatPromptForVeo(prompt).slice(0, 2000),
          negative_prompt: 'text, captions, logos, watermarks, scene change, cuts, flicker',
          resolution: resolution === '1080p' || resolution === '4k' ? resolution : '720p',
          aspect_ratio: aspectRatio === '9:16' ? '9:16' : '16:9',
          duration: safeDur,
          seed: safeSeed(seed),
          first_frame: ['1', 0],
          last_frame: ['2', 0],
          model: 'veo-3.1-fast-generate',
          generate_audio: false,
        },
        _meta: { title: 'Veo 3.1 FLF' },
      },
      '4': {
        class_type: 'SaveVideo',
        inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['3', 0] },
        _meta: { title: 'Save Video' },
      },
    }
  },
}
