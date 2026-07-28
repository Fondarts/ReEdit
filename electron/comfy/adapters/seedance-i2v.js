// Seedance 2.0 reference-to-video (ByteDance). The upstream Comfy
// `ByteDance2ReferenceNode` flipped its signature in late 2025 — all
// of prompt / resolution / ratio / duration / reference images now
// live nested inside a single `model` dict that also carries the
// selected variant name ("Seedance 2.0" vs "Seedance 2.0 Fast").
// Reference images go in as a sub-dict keyed `image_1` … `image_9`
// (the node supports up to 9). Top-level inputs are limited to
// `model`, `seed`, `watermark`.
// Schema reference:
//   https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_api_nodes/nodes_bytedance.py
//   (class ByteDance2ReferenceNode, _seedance2_reference_inputs)
const { safeSeed, aspectBucket, formatPromptForSeedance } = require('./shared')

module.exports = {
  id: 'seedance-2',
  label: 'Seedance 2.0 (cloud, ref-to-video)',
  kind: 'i2v',
  mode: 'cloud',
  partner: true,
  caps: { minDurationSec: 4, maxDurationSec: 15, needsReferenceImage: true, aspectRatios: ['16:9', '9:16', '1:1'], supportsMultiRef: true },
  buildWorkflow({ referenceFilename, referenceFilenames, referenceVideoFilename, prompt, durationSec, aspectRatio, outputPrefix, seed }) {
    // Seedance 2.0 duration is bounded [4, 15] s. Clamp accordingly.
    const safeDur = Math.max(4, Math.min(15, Math.round(Number(durationSec) || 5)))
    const formattedPrompt = formatPromptForSeedance(prompt)

    // Reference images: accept the legacy single `referenceFilename` or a
    // `referenceFilenames[]` list (up to 9) for product-consistency fills.
    const refs = (Array.isArray(referenceFilenames) && referenceFilenames.length > 0)
      ? referenceFilenames.slice(0, 9)
      : [referenceFilename]

    const workflow = {}
    // ByteDance2ReferenceNode wraps its real inputs in a DynamicCombo
    // widget called `model`. Comfy serialises that as FLAT, dotted keys
    // at the API layer ("model", "model.prompt", "model.ratio" …) — NOT
    // as a nested dict. The server's `build_nested_inputs` pass re-packs
    // the flat keys into the nested dict execute() receives. Sending a
    // nested `model: {…}` here produces "missing 1 required positional
    // argument: 'model'".
    const nodeInputs = {
      model: 'Seedance 2.0',
      'model.prompt': formattedPrompt.slice(0, 2000),
      'model.resolution': '720p',
      'model.ratio': aspectBucket(aspectRatio),
      'model.duration': safeDur,
      // Generated placeholders ride under the existing music bed —
      // we don't want Seedance synthesising its own audio track.
      'model.generate_audio': false,
      seed: safeSeed(seed),
      // Required boolean since the late-2025 node update. False so
      // outputs don't carry the ByteDance overlay.
      watermark: false,
    }
    refs.forEach((filename, i) => {
      // Load nodes live at 100+ so they can never collide with the fixed
      // generator ('11') / save ('12') / reference-video ('30') ids.
      const loadId = String(100 + i)
      workflow[loadId] = { class_type: 'LoadImage', inputs: { image: filename }, _meta: { title: `Reference frame ${i + 1}` } }
      // Autogrow widget slots finalise to `model.reference_images.image_N`.
      nodeInputs[`model.reference_images.image_${i + 1}`] = [loadId, 0]
    })
    if (referenceVideoFilename) {
      workflow['30'] = {
        class_type: 'LoadVideo',
        inputs: { file: referenceVideoFilename },
        _meta: { title: 'Reference video' },
      }
      nodeInputs['model.reference_videos.video_1'] = ['30', 0]
    }
    workflow['11'] = {
      class_type: 'ByteDance2ReferenceNode',
      inputs: nodeInputs,
      _meta: { title: 'Seedance 2.0 r2v' },
    }
    workflow['12'] = {
      class_type: 'SaveVideo',
      inputs: { filename_prefix: outputPrefix, format: 'auto', codec: 'auto', video: ['11', 0] },
      _meta: { title: 'Save Video' },
    }
    return workflow
  },
}
