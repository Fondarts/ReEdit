// @vitest-environment jsdom
//
// The frame-role selector decides what the picked frame is FOR, and that
// isn't cosmetic — it selects a different API node. These tests pin the
// capability table (so the UI can never offer a mode the generator would
// ignore) and the Seedance first-frame graph.
import { describe, it, expect } from 'vitest'
import {
  FRAME_ROLES,
  FRAME_ROLE_LABELS,
  frameRoleSupport,
  resolveFrameRole,
  buildSeedance2FirstFrameWorkflow,
  LOCAL_PLACEHOLDER_I2V_MODELS,
} from '../src/services/reeditGenerate.js'

describe('frame role capability table', () => {
  it('labels both roles', () => {
    expect(FRAME_ROLE_LABELS[FRAME_ROLES.FIRST]).toBeTruthy()
    expect(FRAME_ROLE_LABELS[FRAME_ROLES.REFERENCE]).toBeTruthy()
  })

  it('covers every model the picker offers', () => {
    for (const { id } of LOCAL_PLACEHOLDER_I2V_MODELS) {
      const support = frameRoleSupport(id)
      expect(support.roles.length, `${id} must support at least one role`).toBeGreaterThan(0)
      expect(support.roles, `${id} default must be one of its roles`).toContain(support.default)
    }
  })

  it('restricts the local i2v models to first-frame', () => {
    // LTX and WAN condition the image in as frame 0 by construction —
    // there is no reference-only pathway in those workflows.
    for (const id of ['ltx-2.3', 'wan-2.2-14b']) {
      expect(frameRoleSupport(id).roles).toEqual(['first'])
    }
  })

  it('lets Seedance do both, defaulting to reference', () => {
    const support = frameRoleSupport('seedance-2')
    expect(support.roles).toContain('reference')
    expect(support.roles).toContain('first')
    // Reference is the node this path always used; changing the default
    // would silently alter existing behaviour.
    expect(support.default).toBe('reference')
  })

  it('falls back to first-frame for an unknown model', () => {
    expect(frameRoleSupport('who-knows')).toEqual({ roles: ['first'], default: 'first' })
  })
})

describe('resolveFrameRole', () => {
  it('honours a supported role', () => {
    expect(resolveFrameRole('seedance-2', 'first')).toBe('first')
    expect(resolveFrameRole('seedance-2', 'reference')).toBe('reference')
  })

  it('coerces a role the model cannot do back to its default', () => {
    // Stored while Seedance was selected, then the user switched to LTX.
    expect(resolveFrameRole('ltx-2.3', 'reference')).toBe('first')
  })

  it('coerces empty/garbage input', () => {
    expect(resolveFrameRole('seedance-2', undefined)).toBe('reference')
    expect(resolveFrameRole('seedance-2', 'nonsense')).toBe('reference')
    expect(resolveFrameRole('ltx-2.3', null)).toBe('first')
  })
})

describe('buildSeedance2FirstFrameWorkflow', () => {
  const wf = buildSeedance2FirstFrameWorkflow({
    prompt: 'net swaying against bokeh lights',
    inputImage: 'ref.jpg',
    aspectRatio: '16:9',
    resolution: '720p',
    durationSec: 4,
    seed: 12345,
    filenamePrefix: 'reedit/row-003',
  })
  const node = (type) => Object.values(wf).find((n) => n.class_type === type)

  it('uses the first-frame node, not the reference node', () => {
    expect(node('ByteDance2FirstLastFrameNode')).toBeDefined()
    expect(node('ByteDance2ReferenceNode')).toBeUndefined()
  })

  it('wires the image into first_frame', () => {
    const bd = node('ByteDance2FirstLastFrameNode')
    const load = Object.entries(wf).find(([, n]) => n.class_type === 'LoadImage')
    expect(bd.inputs.first_frame).toEqual([load[0], 0])
    expect(load[1].inputs.image).toBe('ref.jpg')
  })

  it('serialises the DynamicCombo as flat dotted keys', () => {
    const bd = node('ByteDance2FirstLastFrameNode')
    // A nested `model` object fails with "missing required argument: model".
    expect(typeof bd.inputs.model).toBe('string')
    expect(bd.inputs['model.ratio']).toBe('16:9')
    expect(bd.inputs['model.resolution']).toBe('720p')
    expect(bd.inputs['model.generate_audio']).toBe(false)
    expect(bd.inputs.watermark).toBe(false)
  })

  it('clamps duration into the node range and the seed into int32', () => {
    const short = buildSeedance2FirstFrameWorkflow({ durationSec: 1 })
    const long = buildSeedance2FirstFrameWorkflow({ durationSec: 999 })
    expect(short['2'].inputs['model.duration']).toBe(4)
    expect(long['2'].inputs['model.duration']).toBe(15)

    const big = buildSeedance2FirstFrameWorkflow({ seed: 1e12 })
    expect(big['2'].inputs.seed).toBeLessThan(2147483648)
    expect(big['2'].inputs.seed).toBeGreaterThanOrEqual(0)
  })

  it('produces a saveable graph with no dangling links', () => {
    const save = node('SaveVideo')
    expect(save.inputs.filename_prefix).toBe('reedit/row-003')
    for (const [id, n] of Object.entries(wf)) {
      for (const [k, v] of Object.entries(n.inputs)) {
        if (Array.isArray(v) && typeof v[1] === 'number') {
          expect(wf[String(v[0])], `${id}.${k} -> ${v[0]}`).toBeDefined()
        }
      }
    }
  })
})
