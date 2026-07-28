// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { extractJson } from '../src/services/reeditCaptioner.js'
import { buildReframeTransform } from '../src/services/reeditEdlToTimeline.js'

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips markdown code fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('finds JSON surrounded by prose', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 })
  })

  it('repairs a MAX_TOKENS-truncated object', () => {
    const out = extractJson('{"visual": "low-angle hero shot of the car, golden hou')
    expect(out).toBeTruthy()
    expect(out.visual).toMatch(/low-angle hero shot/)
  })

  it('returns null for hopeless input', () => {
    expect(extractJson('sorry, no data')).toBeNull()
    expect(extractJson('')).toBeNull()
    expect(extractJson(null)).toBeNull()
  })
})

describe('buildReframeTransform', () => {
  it('returns null without a reframe', () => {
    expect(buildReframeTransform(null, 1920, 1080)).toBeNull()
  })

  it('centers the anchor point on the canvas', () => {
    // Anchor (0.75, 0.25) at zoom 2 on 1920x1080: the anchor pixel must
    // land at canvas centre → translate by -(a-0.5)*S*W / -(b-0.5)*S*H.
    const t = buildReframeTransform({ zoom: 2, anchorX: 0.75, anchorY: 0.25 }, 1920, 1080)
    expect(t.scaleX).toBe(200)
    expect(t.positionX).toBeCloseTo(-(0.75 - 0.5) * 2 * 1920)
    expect(t.positionY).toBeCloseTo(-(0.25 - 0.5) * 2 * 1080)
  })

  it('produces zero translation for a centered anchor', () => {
    const t = buildReframeTransform({ zoom: 1.5, anchorX: 0.5, anchorY: 0.5 }, 1920, 1080)
    expect(t.positionX).toBe(0)
    expect(t.positionY).toBe(0)
  })

  it('clamps zoom into [1, 3] and defaults missing anchors to center', () => {
    const t = buildReframeTransform({ zoom: 9 }, 1920, 1080)
    expect(t.scaleX).toBe(300)
    expect(t.positionX).toBe(0)
    expect(t.positionY).toBe(0)
  })

  it('treats NaN anchors as center instead of leaking NaN into positions', () => {
    const t = buildReframeTransform({ zoom: 1.3, anchorX: 'nope', anchorY: undefined }, 1920, 1080)
    expect(t.positionX).toBe(0)
    expect(t.positionY).toBe(0)
  })
})
