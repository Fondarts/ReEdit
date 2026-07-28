import { describe, it, expect } from 'vitest'
import { ADAPTERS, getAdapter, listAdapters } from './index.js'

const BASE_PARAMS = {
  referenceFilename: 'ref.png',
  prompt: 'Slow dolly across the dashboard at dusk',
  durationSec: 3,
  aspectRatio: '16:9',
  outputPrefix: 'reedit_fills/test',
  seed: 42,
}

describe('adapter registry', () => {
  it('exposes every adapter with the required shape', () => {
    for (const a of ADAPTERS) {
      expect(a.id).toBeTruthy()
      expect(a.label).toBeTruthy()
      expect(['i2v', 'r2v', 'v2v', 'extend', 'reframe-outpaint', 'upscale']).toContain(a.kind)
      expect(['cloud', 'local']).toContain(a.mode)
      expect(typeof a.buildWorkflow).toBe('function')
    }
  })

  it('getAdapter finds by id and returns null for unknowns', () => {
    expect(getAdapter('kling-v3-omni')?.id).toBe('kling-v3-omni')
    expect(getAdapter('nope')).toBeNull()
  })

  it('listAdapters filters by kind and mode', () => {
    const cloudI2v = listAdapters({ kind: 'i2v', mode: 'cloud' })
    expect(cloudI2v.map((a) => a.id)).toContain('seedance-2')
    expect(listAdapters({ kind: 'no-such-kind' })).toEqual([])
  })
})

// Every workflow an adapter builds must be a valid API graph: node
// references point at nodes that exist, and a SaveVideo carries the
// caller's filename_prefix.
function validateGraph(workflow, outputPrefix) {
  const ids = new Set(Object.keys(workflow))
  for (const [id, node] of Object.entries(workflow)) {
    expect(node.class_type, `node ${id} class_type`).toBeTruthy()
    for (const value of Object.values(node.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') {
        expect(ids.has(String(value[0])), `node ${id} links to missing node ${value[0]}`).toBe(true)
      }
    }
  }
  const save = Object.values(workflow).find((n) => n.class_type === 'SaveVideo')
  expect(save?.inputs?.filename_prefix).toBe(outputPrefix)
}

describe.each(ADAPTERS.map((a) => [a.id, a]))('adapter %s', (id, adapter) => {
  it('builds a well-formed graph', () => {
    validateGraph(adapter.buildWorkflow(BASE_PARAMS), BASE_PARAMS.outputPrefix)
  })

  it('clamps duration into the advertised caps', () => {
    const { minDurationSec, maxDurationSec } = adapter.caps || {}
    if (!Number.isFinite(minDurationSec) || !Number.isFinite(maxDurationSec)) return
    for (const requested of [0, 999]) {
      const wf = adapter.buildWorkflow({ ...BASE_PARAMS, durationSec: requested })
      const gen = Object.values(wf).find((n) => n.class_type !== 'LoadImage' && n.class_type !== 'LoadVideo' && n.class_type !== 'SaveVideo')
      const dur = gen.inputs.duration ?? gen.inputs['model.duration']
      expect(dur).toBeGreaterThanOrEqual(minDurationSec)
      expect(dur).toBeLessThanOrEqual(maxDurationSec)
    }
  })

  it('injects the prompt into the generator node', () => {
    const wf = adapter.buildWorkflow(BASE_PARAMS)
    const gen = Object.values(wf).find((n) => n.class_type !== 'LoadImage' && n.class_type !== 'LoadVideo' && n.class_type !== 'SaveVideo')
    const prompt = gen.inputs.prompt ?? gen.inputs['model.prompt']
    expect(prompt).toContain('dolly across the dashboard')
  })
})

describe('seedance-2 specifics', () => {
  const adapter = getAdapter('seedance-2')

  it('serialises the DynamicCombo as flat dotted keys, never a nested dict', () => {
    const wf = adapter.buildWorkflow(BASE_PARAMS)
    const node = Object.values(wf).find((n) => n.class_type === 'ByteDance2ReferenceNode')
    expect(node.inputs.model).toBe('Seedance 2.0')
    expect(typeof node.inputs.model).toBe('string')
    expect(node.inputs['model.ratio']).toBe('16:9')
    expect(node.inputs['model.generate_audio']).toBe(false)
    expect(node.inputs.watermark).toBe(false)
    expect(node.inputs['model.reference_images.image_1']).toEqual(['100', 0])
  })

  it('supports multi-ref images (up to 9) and a reference video', () => {
    const wf = adapter.buildWorkflow({
      ...BASE_PARAMS,
      referenceFilenames: ['a.png', 'b.png', 'c.png'],
      referenceVideoFilename: 'clip.mp4',
    })
    const node = Object.values(wf).find((n) => n.class_type === 'ByteDance2ReferenceNode')
    expect(node.inputs['model.reference_images.image_1']).toBeDefined()
    expect(node.inputs['model.reference_images.image_3']).toBeDefined()
    expect(node.inputs['model.reference_videos.video_1']).toEqual(['30', 0])
    const loads = Object.values(wf).filter((n) => n.class_type === 'LoadImage')
    expect(loads).toHaveLength(3)
    expect(Object.values(wf).some((n) => n.class_type === 'LoadVideo')).toBe(true)
  })

  it('caps multi-ref at 9 images', () => {
    const wf = adapter.buildWorkflow({
      ...BASE_PARAMS,
      referenceFilenames: Array.from({ length: 12 }, (_, i) => `r${i}.png`),
    })
    const loads = Object.values(wf).filter((n) => n.class_type === 'LoadImage')
    expect(loads).toHaveLength(9)
  })
})

describe('kling-v3-omni specifics', () => {
  it('buckets non-standard aspect ratios to 16:9 and disables audio', () => {
    const wf = getAdapter('kling-v3-omni').buildWorkflow({ ...BASE_PARAMS, aspectRatio: '21:9' })
    const node = Object.values(wf).find((n) => n.class_type === 'KlingOmniProImageToVideoNode')
    expect(node.inputs.aspect_ratio).toBe('16:9')
    expect(node.inputs.generate_audio).toBe(false)
  })
})
