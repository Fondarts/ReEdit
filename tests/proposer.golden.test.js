// @vitest-environment jsdom
//
// Golden tests for the proposal parser + prompt builders, replayed from
// real projects (Apple, BMW X3, The Rise of Electric). Fixtures carry the
// raw LLM response each project actually produced plus the EDL the app
// parsed out of it at the time — so any parser change that would alter a
// shipped proposal fails here without spending a single LLM token.
//
// Regenerate fixtures with: node scripts/extract-golden-fixtures.mjs
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  parseProposalResponse,
  buildSystemPrompt,
  buildUserPrompt,
  DEFAULT_RULES,
} from '../src/services/reeditProposer.js'

const fixtureDir = path.join(__dirname, 'fixtures', 'proposer')
const fixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf-8'))])

// The saved EDL includes fields the UI mutates after parsing (fill render
// paths, active versions, user tweaks). Compare only what the parser is
// responsible for.
const PARSER_FIELDS = ['index', 'kind', 'sourceSceneId', 'newTcIn', 'newTcOut', 'note', 'reframe', 'colorAdjustments', 'extend', 'referenceFrame']
const pickParserFields = (row) => {
  const out = {}
  for (const f of PARSER_FIELDS) out[f] = row[f] ?? null
  return out
}

describe.each(fixtures)('golden: %s', (name, fx) => {
  const result = parseProposalResponse(fx.rawText, {
    scenes: fx.scenes,
    voSegments: fx.voSegments,
    voPlanOverride: null,
  })

  it('re-parses the recorded rawText into the shipped EDL', () => {
    expect(result.edl.map(pickParserFields)).toEqual(fx.expectedEdl.map(pickParserFields))
  })

  it('recovers the shipped rationale', () => {
    expect(result.rationale).toBe(fx.expectedRationale)
  })

  it('produces a contiguous, positive-duration EDL', () => {
    let cursor = 0
    for (const row of result.edl) {
      expect(row.newTcIn).toBeCloseTo(cursor, 6)
      expect(row.newTcOut).toBeGreaterThan(row.newTcIn)
      cursor = row.newTcOut
    }
  })

  it('only references scenes that exist in the shot log', () => {
    const ids = new Set(fx.scenes.map((s) => s.id))
    for (const row of result.edl) {
      if (row.kind === 'original') expect(ids.has(row.sourceSceneId)).toBe(true)
      if (row.referenceFrame) expect(ids.has(row.referenceFrame.sourceSceneId)).toBe(true)
    }
  })

  it('keeps the prompts stable (snapshot)', () => {
    // Prompts ARE the product: any wording change must show up in a PR
    // diff as an intentional snapshot update, not slip through silently.
    expect(buildSystemPrompt(fx.capabilities, { rules: DEFAULT_RULES })).toMatchSnapshot('system-prompt')
    expect(buildUserPrompt({
      scenes: fx.scenes,
      brandBrief: fx.brandBrief,
      metric: fx.metric,
      targetDurationSec: fx.targetDurationSec,
      capabilities: fx.capabilities,
      voSegments: fx.voSegments,
      rules: DEFAULT_RULES,
    })).toMatchSnapshot('user-prompt')
  })
})

describe('parseProposalResponse — directive parsing', () => {
  const scenes = [
    { id: 'sc-1', tcIn: 0, tcOut: 4, duration: 4 },
    { id: 'sc-2', tcIn: 4, tcOut: 9, duration: 5 },
  ]
  const wrap = (rows) => JSON.stringify({ rationale: 'test', edl: rows })

  it('parses REFRAME zoom/anchor and clamps zoom to the capability max (130% default)', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-1', newTcIn: 0, newTcOut: 3, note: 'Tighten. REFRAME zoom=1.4 anchor=0.3,0.6' },
    ]), { scenes })
    expect(edl[0].reframe).toMatchObject({ zoom: 1.3, anchorX: 0.3, anchorY: 0.6 })
  })

  it('drops a REFRAME whose anchor is dead-center with zoom > 1.2 (symmetric-crop failure mode)', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-1', newTcIn: 0, newTcOut: 3, note: 'REFRAME zoom=1.3 anchor=0.5,0.5' },
    ]), { scenes })
    expect(edl[0].reframe).toBeNull()
  })

  it('parses EXTEND +Xs into a clamped extend object', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-2', newTcIn: 0, newTcOut: 5, note: 'Hold the beat. EXTEND +1.5s: let the car settle.' },
    ]), { scenes })
    expect(edl[0].extend).toMatchObject({ seconds: 1.5 })
  })

  it('parses COLOR directives into colorAdjustments (integer -100..100 axes)', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-1', newTcIn: 0, newTcOut: 2, note: 'COLOR: exposure=20 contrast=10' },
    ]), { scenes })
    expect(edl[0].colorAdjustments).toEqual({ brightness: 20, contrast: 10 })
  })

  it('drops referenceFrame rows pointing at unknown scenes', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'placeholder', newTcIn: 0, newTcOut: 2, note: 'Fill', referenceFrame: { sourceSceneId: 'nope', framePosition: 'end' } },
    ]), { scenes })
    expect(edl[0].referenceFrame).toBeNull()
  })

  it('normalizes timecodes into a contiguous timeline', () => {
    const { edl } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-1', newTcIn: 10, newTcOut: 12, note: '' },
      { kind: 'original', sourceSceneId: 'sc-2', newTcIn: 50, newTcOut: 53, note: '' },
    ]), { scenes })
    expect(edl[0].newTcIn).toBe(0)
    expect(edl[0].newTcOut).toBe(2)
    expect(edl[1].newTcIn).toBe(2)
    expect(edl[1].newTcOut).toBe(5)
  })

  it('throws on non-JSON responses', () => {
    expect(() => parseProposalResponse('sorry, I cannot help with that', { scenes })).toThrow(/not valid JSON/)
  })

  it('falls back to all VO segments when the LLM omits a plan', () => {
    const voSegments = [{ id: 'vo-1' }, { id: 'vo-2' }]
    const { voiceoverPlan } = parseProposalResponse(wrap([
      { kind: 'original', sourceSceneId: 'sc-1', newTcIn: 0, newTcOut: 2, note: '' },
    ]), { scenes, voSegments })
    expect(voiceoverPlan).toMatchObject({ autoEdit: true, segmentIds: ['vo-1', 'vo-2'] })
  })
})
