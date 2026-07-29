/**
 * reeditPromptEnhancer.js
 *
 * Rewrites a shot instruction into an English prompt tuned for the video
 * model that's about to run it. Two problems it solves:
 *
 *   1. Language. Every one of these models is trained on English captions
 *      and degrades on anything else — but you shouldn't have to think in
 *      English while directing.
 *   2. House style. Each model wants a different shape. Seedance wants a
 *      short animation instruction that preserves the reference and names
 *      ONE camera move; LTX wants a flowing, densely visual paragraph;
 *      Kling wants scene → subject → action → camera. Writing to the
 *      wrong shape is a real quality loss, not a nicety.
 *
 * Gemini does the rewrite (it's a translation + restructuring job, and
 * Gemini is already the required backend for the analysis passes). The
 * mechanical per-provider formatters in the generation path still run
 * afterwards — they clamp length and append continuity boilerplate. This
 * only fixes the part a human wrote.
 *
 * The enhanced text replaces the prompt in the modal, where the user can
 * still edit it. Nothing is auto-applied.
 */

import { chatCompletion, LLM_BACKENDS, LLM_TASKS, loadLlmSettings } from './reeditLlmClient'

// Per-model prompting brief. Sourced from each provider's own guidance
// and mirrored in the formatters under electron/comfy/adapters/shared.js
// — keep the two in step if a provider changes its advice.
const MODEL_BRIEFS = {
  'seedance-2': {
    label: 'Seedance 2.0 (ByteDance)',
    brief: `Target: Seedance 2.0, image-conditioned.
- 60-100 words. Hard ceiling 120. Shorter beats longer here.
- Lead with the ANIMATION, not a re-description of the subject: the model already sees the reference image, and re-describing it fights the conditioning.
- Name exactly ONE camera move. Two or more produces jittery, incoherent motion.
- State that composition, palette and lighting from the reference are preserved.
- Plain declarative prose. No shot lists, no bullet points, no camera-spec jargon like "35mm f/1.4".`,
  },
  'ltx-2.3': {
    label: 'LTX 2.3',
    brief: `Target: LTX 2.3.
- 80-140 words. LTX rewards density; thin prompts give static, mushy motion.
- One flowing paragraph of concrete VISUAL detail: subject, what moves, lighting quality and direction, textures, depth of field, background behaviour.
- Describe motion as continuous and physical ("the fabric lifts and settles", not "nice movement").
- Name one clear camera behaviour and keep it simple (slow push in, gentle handheld drift, static).
- No lists, no headings, no negative phrasing — say what IS in frame, never what isn't.`,
  },
  'wan-2.2-14b': {
    label: 'WAN 2.2 14B',
    brief: `Target: WAN 2.2 14B.
- 60-110 words, one paragraph.
- Structure: subject and setting, then the action, then the camera, then the light.
- Concrete physical nouns and verbs; WAN drifts on abstract or emotional language.
- One camera move only.
- No lists, no negatives.`,
  },
}

const GENERIC_BRIEF = `Target: a general image-to-video model.
- 60-120 words, one paragraph of concrete visual detail.
- One camera move. Physical, observable description. No lists, no negatives.`

export function briefForModel(modelId) {
  return MODEL_BRIEFS[modelId] || { label: modelId || 'video model', brief: GENERIC_BRIEF }
}

/** Models we have specific guidance for — used to label the UI button. */
export function enhancerModelLabel(modelId) {
  return briefForModel(modelId).label
}

function buildSystemPrompt(modelId, frameRole) {
  const { brief } = briefForModel(modelId)
  // The role changes what the prompt should do about framing: as a first
  // frame the composition is already fixed by the image, so the prompt
  // should drive motion; as a loose reference the prompt has to carry the
  // composition itself.
  const roleNote = frameRole === 'reference'
    ? `The reference image guides look only — the model composes the shot itself, so the prompt MUST establish framing and subject placement.`
    : `The reference image is the clip's first frame — framing is already fixed, so spend the words on motion and how the shot evolves.`

  return `You rewrite a director's shot instruction into a production prompt for a video-generation model.

${brief}

${roleNote}

Rules that override everything above:
- Output ENGLISH only. The input may be in any language; translate it.
- Preserve the director's intent exactly. Do not invent new subjects, brands, logos, on-screen text, or story beats that aren't implied by the input.
- Do not add quality-booster word salad ("masterpiece, 8k, best quality, trending on artstation"). Describe the image instead.
- Return ONLY the rewritten prompt. No preamble, no quotes, no explanation, no markdown.`
}

/**
 * Rewrite `prompt` for `modelId`. Returns the enhanced string.
 *
 * Gemini-only: the other backends are optional in this app and a missing
 * key should say so plainly rather than fail somewhere downstream.
 */
export async function enhancePromptForModel({ prompt, modelId, frameRole = 'first' } = {}) {
  const original = String(prompt || '').trim()
  if (!original) throw new Error('Write a prompt first, then enhance it.')

  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Enhancing needs a Gemini API key — add one in Settings → LLM engine.')
  }

  const response = await chatCompletion({
    messages: [
      { role: 'system', content: buildSystemPrompt(modelId, frameRole) },
      { role: 'user', content: original },
    ],
    // Low but not zero: this is a rewrite, not a sampling task, though a
    // little freedom helps it restructure rather than translate literally.
    temperature: 0.4,
    maxTokens: 1200,
    task: LLM_TASKS.PROPOSAL,
    backendOverride: LLM_BACKENDS.GEMINI,
  })

  const text = String(response?.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error('Gemini returned an empty prompt. Try again.')

  return stripWrapping(text)
}

// Models occasionally wrap the answer in quotes or a fence despite being
// told not to, and a stray quote character ends up in the generation
// prompt verbatim. Strip the wrapper, never the content.
export function stripWrapping(text) {
  let out = String(text || '').trim()
  // Fenced block, with or without a language tag.
  const fence = out.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i)
  if (fence) out = fence[1].trim()
  // Outer quotes around the WHOLE string only — never quotes that are
  // part of the content (a sign reading "OPEN" must survive). Smart
  // quotes are asymmetric, so pairs are matched explicitly rather than
  // by backreference.
  const QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['«', '»']]
  for (const [open, close] of QUOTE_PAIRS) {
    if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
      const inner = out.slice(open.length, -close.length)
      // Only unwrap if the delimiter doesn't reappear inside, otherwise
      // we'd be joining two separately quoted spans.
      if (!inner.includes(close)) {
        out = inner.trim()
        break
      }
    }
  }
  // A leading label the model sometimes prepends.
  out = out.replace(/^(?:enhanced\s+prompt|prompt|output)\s*:\s*/i, '').trim()
  return out
}
