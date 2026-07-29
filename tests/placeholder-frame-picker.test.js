// @vitest-environment jsdom
//
// Covers the pure helpers behind the source-frame picker in the
// placeholder fill modal. The scrub playhead has to open on the frame the
// automatic path would have used, so the manual picker is a nudge rather
// than a blind hunt — that math is duplicated from reeditFills.js's
// resolveReferenceTcSec and would drift silently without a test.
import { describe, it, expect } from 'vitest'
import { formatTc, initialScrubTc } from '../src/components/reedit/PlaceholderDetailsModal.jsx'

const scenes = [
  { id: 'sc-1', tcIn: 0, tcOut: 4 },
  { id: 'sc-2', tcIn: 4, tcOut: 9 },
  { id: 'sc-3', tcIn: 9, tcOut: 9.4 }, // very short shot — margin must shrink
]

describe('formatTc', () => {
  it('formats seconds as m:ss.hh', () => {
    expect(formatTc(0)).toBe('0:00.00')
    expect(formatTc(9.5)).toBe('0:09.50')
    expect(formatTc(75.25)).toBe('1:15.25')
  })

  it('pads the seconds so timecodes stay column-aligned', () => {
    expect(formatTc(61)).toBe('1:01.00')
  })

  it('renders a dash for non-finite input', () => {
    expect(formatTc(undefined)).toBe('—')
    expect(formatTc(NaN)).toBe('—')
  })
})

describe('initialScrubTc', () => {
  it('starts mid-shot for framePosition "middle"', () => {
    const row = { referenceFrame: { sourceSceneId: 'sc-2', framePosition: 'middle' } }
    expect(initialScrubTc(row, scenes)).toBeCloseTo(6.5)
  })

  it('starts just inside the shot for "start" and just before the cut for "end"', () => {
    const start = initialScrubTc({ referenceFrame: { sourceSceneId: 'sc-2', framePosition: 'start' } }, scenes)
    const end = initialScrubTc({ referenceFrame: { sourceSceneId: 'sc-2', framePosition: 'end' } }, scenes)
    // Inset by a margin so we never land on a cut frame.
    expect(start).toBeGreaterThan(4)
    expect(start).toBeLessThan(4.2)
    expect(end).toBeLessThan(9)
    expect(end).toBeGreaterThan(8.8)
  })

  it('shrinks the margin on very short shots instead of overshooting', () => {
    const row = { referenceFrame: { sourceSceneId: 'sc-3', framePosition: 'end' } }
    const tc = initialScrubTc(row, scenes)
    expect(tc).toBeGreaterThanOrEqual(9)
    expect(tc).toBeLessThanOrEqual(9.4)
  })

  it('falls back to 0 when the reference is missing or dangling', () => {
    expect(initialScrubTc({}, scenes)).toBe(0)
    expect(initialScrubTc({ referenceFrame: { sourceSceneId: 'nope' } }, scenes)).toBe(0)
    expect(initialScrubTc(null, scenes)).toBe(0)
    expect(initialScrubTc({ referenceFrame: { sourceSceneId: 'sc-1' } }, null)).toBe(0)
  })
})
