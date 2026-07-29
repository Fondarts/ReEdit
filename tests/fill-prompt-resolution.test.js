// @vitest-environment jsdom
//
// One resolver decides what prompt a placeholder generates from. It has to
// be the same one everywhere: the bug this guards against shipped, and it
// was that the VIDEO pass read the proposer's note while the FRAME pass
// read the user's edited prompt — so the frame you approved and the clip
// you got were generated from different text.
import { describe, it, expect } from 'vitest'
import { fillPromptForRow } from '../src/services/reeditFills.js'

describe('fillPromptForRow', () => {
  const note = 'Proposer note: close-up of the net.'

  it('falls back to the proposer note when nothing was edited', () => {
    expect(fillPromptForRow({ note })).toBe(note)
  })

  it('prefers the Advanced modal prompt (genSpec.prompt) over the note', () => {
    // This is the regression: the modal writes genSpec.prompt, and the
    // local video path used to ignore it entirely.
    const row = { note, genSpec: { prompt: 'Hands gripping the ball, low-key.' } }
    expect(fillPromptForRow(row)).toBe('Hands gripping the ball, low-key.')
  })

  it('prefers the Auto/Simple modal prompt (fillPrompt) over the note', () => {
    const row = { note, fillPrompt: 'Confetti drifting past the rim.' }
    expect(fillPromptForRow(row)).toBe('Confetti drifting past the rim.')
  })

  it('takes genSpec.prompt when both overrides exist', () => {
    // Documented tie-break: genSpec is the surface with the enhancer.
    const row = { note, fillPrompt: 'simple-mode text', genSpec: { prompt: 'advanced-mode text' } }
    expect(fillPromptForRow(row)).toBe('advanced-mode text')
  })

  it('treats a whitespace-only override as no override', () => {
    expect(fillPromptForRow({ note, genSpec: { prompt: '   ' } })).toBe(note)
    expect(fillPromptForRow({ note, fillPrompt: '\n\t' })).toBe(note)
    // …and still honours the other one if it's real.
    expect(fillPromptForRow({ note, genSpec: { prompt: '  ' }, fillPrompt: 'real' })).toBe('real')
  })

  it('trims the override so stray whitespace never reaches the model', () => {
    expect(fillPromptForRow({ note, genSpec: { prompt: '  padded  ' } })).toBe('padded')
  })

  it('ignores non-string overrides instead of crashing', () => {
    expect(fillPromptForRow({ note, fillPrompt: 42 })).toBe(note)
    expect(fillPromptForRow({ note, genSpec: { prompt: { nope: true } } })).toBe(note)
  })

  it('returns empty string for an empty row rather than undefined', () => {
    expect(fillPromptForRow({})).toBe('')
    expect(fillPromptForRow(null)).toBe('')
  })
})
