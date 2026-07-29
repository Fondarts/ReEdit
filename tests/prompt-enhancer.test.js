// @vitest-environment jsdom
//
// The enhancer's value is entirely in what it asks Gemini for, so these
// tests assert the request (model-specific brief, role note, hard rules)
// and the cleanup of what comes back — with the LLM mocked, so the suite
// never spends credits or needs a key.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const chatCompletion = vi.fn()
vi.mock('../src/services/reeditLlmClient', () => ({
  chatCompletion: (...args) => chatCompletion(...args),
  LLM_BACKENDS: { GEMINI: 'gemini', ANTHROPIC: 'anthropic', LM_STUDIO: 'lmstudio' },
  LLM_TASKS: { ANALYSIS: 'analysis', PROPOSAL: 'proposal', REVIEW: 'review' },
  loadLlmSettings: () => ({ geminiApiKey: 'test-key' }),
}))

const { enhancePromptForModel, stripWrapping, briefForModel, enhancerModelLabel } =
  await import('../src/services/reeditPromptEnhancer.js')

const reply = (text) => ({ choices: [{ message: { content: text } }] })

beforeEach(() => {
  chatCompletion.mockReset()
  chatCompletion.mockResolvedValue(reply('A slow push in on the net as confetti drifts past.'))
})

describe('enhancePromptForModel — the request', () => {
  it('routes to Gemini regardless of the active backend', async () => {
    await enhancePromptForModel({ prompt: 'red de básquet moviéndose', modelId: 'seedance-2' })
    const call = chatCompletion.mock.calls[0][0]
    expect(call.backendOverride).toBe('gemini')
  })

  it('sends the user text unmodified as the user message', async () => {
    // Translation is the model's job; we must not pre-mangle the input.
    await enhancePromptForModel({ prompt: '  красная сетка  ', modelId: 'ltx-2.3' })
    const call = chatCompletion.mock.calls[0][0]
    expect(call.messages[1]).toEqual({ role: 'user', content: 'красная сетка' })
  })

  it('carries the target model brief into the system prompt', async () => {
    await enhancePromptForModel({ prompt: 'x', modelId: 'seedance-2' })
    const seedanceSystem = chatCompletion.mock.calls[0][0].messages[0].content
    expect(seedanceSystem).toMatch(/Seedance 2\.0/)
    // Seedance's defining constraint: exactly one camera move.
    expect(seedanceSystem).toMatch(/ONE camera move/i)

    chatCompletion.mockClear()
    await enhancePromptForModel({ prompt: 'x', modelId: 'ltx-2.3' })
    const ltxSystem = chatCompletion.mock.calls[0][0].messages[0].content
    expect(ltxSystem).toMatch(/LTX 2\.3/)
    expect(ltxSystem).not.toMatch(/Seedance/)
  })

  it('always demands English output and forbids invention', async () => {
    for (const modelId of ['seedance-2', 'ltx-2.3', 'wan-2.2-14b', 'unknown-model']) {
      chatCompletion.mockClear()
      await enhancePromptForModel({ prompt: 'x', modelId })
      const system = chatCompletion.mock.calls[0][0].messages[0].content
      expect(system, modelId).toMatch(/ENGLISH only/)
      expect(system, modelId).toMatch(/Do not invent/i)
      expect(system, modelId).toMatch(/Return ONLY the rewritten prompt/i)
    }
  })

  it('tells the model whether framing is already fixed by the frame role', async () => {
    await enhancePromptForModel({ prompt: 'x', modelId: 'seedance-2', frameRole: 'first' })
    expect(chatCompletion.mock.calls[0][0].messages[0].content).toMatch(/first frame/i)

    chatCompletion.mockClear()
    await enhancePromptForModel({ prompt: 'x', modelId: 'seedance-2', frameRole: 'reference' })
    const system = chatCompletion.mock.calls[0][0].messages[0].content
    expect(system).toMatch(/MUST establish framing/i)
  })
})

describe('enhancePromptForModel — guard rails', () => {
  it('refuses an empty prompt without calling the API', async () => {
    await expect(enhancePromptForModel({ prompt: '   ', modelId: 'ltx-2.3' }))
      .rejects.toThrow(/Write a prompt first/)
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('surfaces an empty model response instead of wiping the prompt', async () => {
    chatCompletion.mockResolvedValue(reply('   '))
    await expect(enhancePromptForModel({ prompt: 'algo', modelId: 'ltx-2.3' }))
      .rejects.toThrow(/empty prompt/i)
  })
})

describe('stripWrapping', () => {
  it('unwraps a fenced block', () => {
    expect(stripWrapping('```\nA slow push in.\n```')).toBe('A slow push in.')
    expect(stripWrapping('```text\nA slow push in.\n```')).toBe('A slow push in.')
  })

  it('unwraps quotes around the whole string', () => {
    expect(stripWrapping('"A slow push in."')).toBe('A slow push in.')
    expect(stripWrapping('“A slow push in.”')).toBe('A slow push in.')
  })

  it('keeps quotes that are part of the content', () => {
    const inner = 'A sign reading "OPEN" flickers above the door.'
    expect(stripWrapping(inner)).toBe(inner)
  })

  it('drops a leading label the model sometimes adds', () => {
    expect(stripWrapping('Enhanced prompt: A slow push in.')).toBe('A slow push in.')
    expect(stripWrapping('Prompt: A slow push in.')).toBe('A slow push in.')
  })

  it('is safe on empty input', () => {
    expect(stripWrapping('')).toBe('')
    expect(stripWrapping(null)).toBe('')
  })
})

describe('briefForModel', () => {
  it('has a specific brief per supported model', () => {
    expect(briefForModel('seedance-2').brief).toMatch(/Seedance/)
    expect(briefForModel('ltx-2.3').brief).toMatch(/LTX/)
    expect(briefForModel('wan-2.2-14b').brief).toMatch(/WAN/)
  })

  it('falls back to a generic brief and still labels the button', () => {
    expect(briefForModel('mystery').brief).toMatch(/general image-to-video/i)
    expect(enhancerModelLabel('mystery')).toBe('mystery')
  })
})
