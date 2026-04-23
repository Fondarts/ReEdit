/**
 * Unified LLM dispatcher for the re-edit pipeline.
 *
 * The rest of the app (proposer, captioner, anywhere that wants to
 * reason with a model) calls `chatCompletion()` here without caring
 * whether it runs against LM Studio locally or the Anthropic API.
 * Backend choice, model choice, and the Anthropic API key are
 * persisted in localStorage — same storage pattern we use for the
 * proposal presets. Storing the key in localStorage is a deliberate
 * MVP trade-off (visible in DevTools); we'll move to Electron's
 * safeStorage keyring if this fork ships beyond internal use.
 */

import lmstudio from './lmstudio'
import { anthropicChatCompletion, ANTHROPIC_MODELS } from './anthropicClient'
import { geminiChatCompletion, GEMINI_MODELS, GEMINI_EMBEDDING_MODELS } from './geminiClient'

export const LLM_BACKENDS = {
  LM_STUDIO: 'lm-studio',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
}

export const BACKEND_LABELS = {
  [LLM_BACKENDS.LM_STUDIO]: 'LM Studio (local)',
  [LLM_BACKENDS.ANTHROPIC]: 'Claude API',
  [LLM_BACKENDS.GEMINI]: 'Gemini API',
}

const STORAGE_KEY = 'reedit.llm.v1'
const DEFAULT_SETTINGS = {
  backend: LLM_BACKENDS.LM_STUDIO,
  anthropicModel: 'claude-sonnet-4-6',
  anthropicApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  geminiEmbeddingModel: 'gemini-embedding-2',
  geminiApiKey: '',
}

export function loadLlmSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveLlmSettings(patch) {
  if (typeof localStorage === 'undefined') return
  const current = loadLlmSettings()
  const next = { ...current, ...patch }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    // Broadcast so hooks subscribed to LLM settings see the change
    // without a reload.
    window.dispatchEvent(new CustomEvent('reedit-llm-settings-changed', { detail: next }))
  } catch { /* quota errors are non-fatal */ }
  return next
}

// Pick a loaded, chat-capable LM Studio model. Mirrors the logic in
// reeditCaptioner's pickVisionModelId, but without the vision bias —
// pure-text backends (proposer, future text work) don't need VL.
async function pickLmStudioChatModel(preferVision = false) {
  const models = await lmstudio.listModels()
  const chatLike = (models || []).filter((m) => {
    const type = String(m?.type || '').toLowerCase()
    return !type.includes('embed') && !type.includes('rerank')
  })
  const loaded = chatLike.filter((m) => m?.state === 'loaded' || m?.loaded === true || m?.state === undefined)
  if (preferVision) {
    const visionHints = ['-vl', 'vl-', 'vision', 'llava', 'minicpm-v', 'qwen2.5-vl', 'qwen3-vl', 'qwen2-vl', 'internvl', 'pixtral']
    const isVision = (m) => visionHints.some((h) => String(m?.id || m?.model || '').toLowerCase().includes(h))
    const loadedVision = loaded.find(isVision)
    if (loadedVision) return loadedVision.id || loadedVision.model
    const anyVision = chatLike.find(isVision)
    if (anyVision) return anyVision.id || anyVision.model
  }
  const first = loaded[0] || chatLike[0]
  if (!first) {
    throw new Error('No chat-capable model available in LM Studio. Load one from Discover, then retry.')
  }
  return first.id || first.model
}

/**
 * Unified chat completion. Accepts OpenAI-shape messages and returns
 * OpenAI-shape response regardless of backend.
 */
export async function chatCompletion({
  messages,
  temperature = 0.3,
  maxTokens = 4000,
  preferVision = false,
  backendOverride,
} = {}) {
  const settings = loadLlmSettings()
  const backend = backendOverride || settings.backend

  if (backend === LLM_BACKENDS.ANTHROPIC) {
    if (!settings.anthropicApiKey) {
      throw new Error('Claude API is selected but no API key is set. Open LLM Settings to paste one.')
    }
    return await anthropicChatCompletion({
      apiKey: settings.anthropicApiKey,
      model: settings.anthropicModel,
      messages,
      temperature,
      maxTokens,
    })
  }

  if (backend === LLM_BACKENDS.GEMINI) {
    if (!settings.geminiApiKey) {
      throw new Error('Gemini API is selected but no API key is set. Open LLM Settings to paste one.')
    }
    return await geminiChatCompletion({
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel,
      messages,
      temperature,
      maxTokens,
    })
  }

  // LM Studio (default)
  const modelId = await pickLmStudioChatModel(preferVision)
  return await lmstudio.chatCompletion(modelId, messages, {
    temperature,
    max_tokens: maxTokens,
  })
}

// Re-export so the settings modal can show the model picker without
// importing anthropicClient / geminiClient directly.
export { ANTHROPIC_MODELS, GEMINI_MODELS, GEMINI_EMBEDDING_MODELS }
