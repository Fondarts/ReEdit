/**
 * Anthropic Messages API client.
 *
 * We hit the REST endpoint directly with fetch — adding the official
 * SDK would drag in a second HTTP stack and tree-shake poorly for
 * Electron renderer. This wrapper accepts OpenAI-shape messages (same
 * format LM Studio uses) and returns an OpenAI-shape response so the
 * rest of the pipeline doesn't care which backend produced it.
 *
 * Handles the two shape differences between OpenAI and Anthropic:
 *   1. System prompt is a top-level `system` string, not a role in
 *      the messages array.
 *   2. Image content uses `{ type: 'image', source: { type: 'base64'|'url', ... } }`
 *      instead of `{ type: 'image_url', image_url: { url } }`.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

function convertMessages(messages) {
  const converted = []
  let systemContent = ''
  for (const msg of messages || []) {
    if (msg?.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((c) => c?.text || '').join('\n')
      systemContent += (systemContent ? '\n\n' : '') + text
      continue
    }
    const role = msg.role === 'assistant' ? 'assistant' : 'user'
    if (typeof msg.content === 'string') {
      converted.push({ role, content: msg.content })
      continue
    }
    // Multimodal — translate each content block.
    const parts = []
    for (const c of msg.content || []) {
      if (!c) continue
      if (c.type === 'text') {
        parts.push({ type: 'text', text: c.text || '' })
        continue
      }
      if (c.type === 'image_url') {
        const url = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url
        if (!url) continue
        if (url.startsWith('data:')) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/)
          if (match) {
            parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
            continue
          }
        }
        // Anthropic supports URL-based images (since mid-2024); pass through.
        parts.push({ type: 'image', source: { type: 'url', url } })
        continue
      }
      // Pass-through unknown content types — Anthropic will reject
      // cleanly and the caller will see the error message.
      parts.push(c)
    }
    converted.push({ role, content: parts })
  }
  return { messages: converted, system: systemContent || null }
}

export async function anthropicChatCompletion({
  apiKey,
  model,
  messages,
  temperature = 0.3,
  maxTokens = 4000,
}) {
  if (!apiKey) throw new Error('Missing Anthropic API key — open Settings → LLM to paste one.')
  if (!model) throw new Error('Missing Anthropic model id.')

  const { messages: anthropicMessages, system } = convertMessages(messages)
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: anthropicMessages,
  }
  if (system) body.system = system

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      // Anthropic requires this header when the browser is the
      // originator (no Node proxy) — Electron renderers present as a
      // browser User-Agent and are rejected otherwise.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const errBody = await res.json()
      detail = errBody?.error?.message || JSON.stringify(errBody)
    } catch {
      try { detail = await res.text() } catch { /* ignore */ }
    }
    throw new Error(`Anthropic API ${res.status}: ${detail || res.statusText}`)
  }

  const data = await res.json()
  const textContent = (data.content || [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text || '')
    .join('')

  // OpenAI-shape response so downstream parsers (extractJson, etc.)
  // don't need to branch on backend.
  return {
    choices: [{
      message: { role: 'assistant', content: textContent },
      finish_reason: data.stop_reason || 'stop',
    }],
    model: data.model || model,
    usage: data.usage,
  }
}

// Updated periodically; pulled into the settings modal as the dropdown.
// Mirrors the current (April 2026) recommended lineup.
export const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', blurb: 'Recommended. Fast, strong reasoning, good vision.' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', blurb: 'Most capable. Use for tricky re-edits where subtlety matters.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', blurb: 'Fastest / cheapest. OK for quick iteration passes.' },
]
