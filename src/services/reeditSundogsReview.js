/**
 * project:re-edit — Internal Sundogs-style AI review of the edited cut.
 *
 * The Review tab asks Gemini to score the re-edited video against the
 * same dimensions Sundogs uses (Attention / Comprehension / Persuasion
 * / Action) so the user can A/B their cut against the original report
 * before committing to a paid Sundogs run.
 *
 * This is explicitly NOT a Sundogs call — we render a clear disclaimer
 * in the UI so the user knows the AI-generated review is an internal
 * approximation. The shape it returns matches `SundogsReport` (see
 * reeditSundogsReport.js) so the same dimension/technique renderers
 * can paint both sides of the side-by-side Review screen.
 *
 * When the upstream original Sundogs report is available we pass its
 * brand/product/duration metadata + the technique values it observed
 * so Gemini can frame the new review as a delta rather than a fresh
 * evaluation. That keeps the two columns visually comparable.
 */

import { SUNDOGS_TECHNIQUES } from './reeditSundogsReport'
import { loadLlmSettings, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'
import { geminiChatCompletion } from './geminiClient'

// Same Gemini-key gate the other Gemini-only services use. Inlined
// instead of imported because `reeditLlmClient` keeps it private and
// each consumer rebuilds it with a service-specific error message.
function requireGeminiKey() {
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Open Settings → LLM to paste one before generating the AI review.')
  }
  return settings
}

// Inline-byte ceiling for Gemini video uploads. Mirrors the limit the
// caption / overall-analysis paths enforce — Gemini's REST inline limit
// is ~20 MB before we have to switch to the Files API. Keep these in
// sync if/when one of the call sites changes.
const INLINE_BYTE_LIMIT = 19 * 1024 * 1024

const SYSTEM_PROMPT = `You are an in-house creative analyst standing in for the Sundogs Video Performance Analysis service. Score the supplied ad video using the same four-dimension framework Sundogs uses (Attention, Comprehension, Persuasion, Action). Be honest, specific, and benchmark-aware.

Constraints:
- Output JSON ONLY. No prose, no markdown, no leading text.
- Schema MUST match the structure described below — same keys, same shape, same technique ids.
- POPULATE EVERY DIMENSION (attention, comprehension.branding, comprehension.product, persuasion.emotional, action) with non-empty "doWell", "couldExplore", and "techniques" objects. Even when the cut shows weaknesses in a dimension, write 2-3 specific observations. NEVER return an empty array or omit a dimension — the UI renders blank panels for the missing ones and the user is staring at a half-filled report.
- When you can't observe a technique (e.g. you don't see a CTA), still include it under "techniques" with a meaningful "value" (e.g. "absent" / "not_observed") and status "evaluate".
- Status field is "good" when the technique helps the ad land, "evaluate" when it's worth reconsidering.
- 2-5 short strings per "doWell" and "couldExplore" array. Each string is a concrete observation, not generic praise.
- All percentage scores are integers (omit the % sign).
- Delta numbers are signed integers — a +12 means the cut beats the benchmark by 12 points, -8 means it lags by 8.
- finalScorePct / benchmarkPct stay in the 0-100 range.
- This is an INTERNAL review, not a Sundogs call. Don't claim authority you don't have — give your best read.
`

const TECHNIQUE_ID_LIST = `Canonical technique ids you must use (verbatim):
- Attention: ${SUNDOGS_TECHNIQUES.attention.join(', ')}
- Comprehension/branding: ${SUNDOGS_TECHNIQUES.comprehension_branding.join(', ')}
- Comprehension/product: ${SUNDOGS_TECHNIQUES.comprehension_product.join(', ')}
- Persuasion: ${SUNDOGS_TECHNIQUES.persuasion.join(', ')}
- Action: ${SUNDOGS_TECHNIQUES.action.join(', ')}
`

const SCHEMA_PREVIEW = `{
  "schemaVersion": 1,
  "meta": {
    "brand": "<carry over from the original report when supplied>",
    "product": "<...>",
    "contentType": "<...>",
    "durationSec": <number>,
    "benchmarkVideos": <number or null>
  },
  "overall": {
    "finalScorePct": <0-100>,
    "benchmarkPct":  <0-100>,
    "deltas": { "attention": <int>, "comprehension": <int>, "persuasion": <int>, "action": <int> }
  },
  "attention": {
    "deltas": { "first5": <int>, "overall": <int>, "last5": <int> },
    "doWell": ["..."], "couldExplore": ["..."],
    "techniques": { "<technique_id>": { "value": "<observed value>", "status": "good"|"evaluate" } }
  },
  "comprehension": {
    "branding": {
      "deltas": { "first5": <int>, "overall": <int>, "last5": <int> },
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "...", "status": "good"|"evaluate" } }
    },
    "product": {
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "...", "status": "good"|"evaluate" } }
    }
  },
  "persuasion": {
    "emotional": {
      "deltas": { "first5": <int>, "overall": <int>, "last5": <int> },
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "...", "status": "good"|"evaluate" } }
    }
  },
  "action": {
    "deltas": { "overall": <int>, "last5": <int> },
    "doWell": ["..."], "couldExplore": ["..."],
    "techniques": { "<technique_id>": { "value": "...", "status": "good"|"evaluate" } }
  },
  "differentiation": {
    "scorePct": <0-100>,
    "keyElements": ["..."]
  }
}`

function buildContextBlock(originalReport) {
  if (!originalReport) return 'No original Sundogs report was provided; evaluate the video standalone.'
  const meta = originalReport.meta || {}
  const overall = originalReport.overall || {}
  const lines = [
    'Original Sundogs report metadata (carry brand/product/contentType into your output verbatim):',
    `  brand: ${meta.brand || 'unknown'}`,
    `  product: ${meta.product || 'unknown'}`,
    `  contentType: ${meta.contentType || 'unknown'}`,
    `  durationSec: ${meta.durationSec ?? 'unknown'}`,
    `  benchmarkVideos: ${meta.benchmarkVideos ?? 'unknown'}`,
    `  Original final score: ${overall.finalScorePct ?? '?'}% vs ${overall.benchmarkPct ?? '?'}% benchmark`,
  ]
  return lines.join('\n')
}

/**
 * Run an internal Gemini-powered Sundogs-style review against the new
 * cut. Returns a `SundogsReport`-shaped object plus a `kind: 'ai-internal'`
 * marker so the renderer can flag it visually.
 *
 * @param {object} opts
 * @param {string} opts.videoPath  Absolute path to the new-cut MP4 we're reviewing.
 * @param {object} [opts.originalReport] The Sundogs report we already
 *   have from the PDF, used for context + brand/product carry-over.
 * @param {string} [opts.modelOverride] Optional Gemini model id.
 */
export async function generateAiSundogsReview({
  videoPath,
  originalReport,
  modelOverride,
  temperature = 0.3,
  // 4 dimensions × 3 windows each × ~6 techniques + doWell/couldExplore
  // strings plus diff/header structure adds up — 4k was clipping the
  // body and leaving the Comprehension / Persuasion / Action panels
  // empty. Push to 8k so the full report fits.
  maxTokens = 8000,
} = {}) {
  if (!videoPath) throw new Error('generateAiSundogsReview: missing videoPath.')

  // Same Gemini-key gate the analyzer uses — keeps the error path
  // consistent across services. If the user has Gemini configured the
  // other analysis paths already, this just works.
  const settings = requireGeminiKey()
  const model = modelOverride || resolveGeminiModelForTask(settings, LLM_TASKS.REVIEW)

  // Inline upload of the new cut. The Files API path is on the roadmap
  // but for now we stay within Gemini's inline limit by re-encoding the
  // video before this point if needed.
  const res = await window.electronAPI?.readFileAsDataUrl?.(videoPath, 'video/mp4')
  if (!res?.success) {
    throw new Error(res?.error || `Could not read new-cut video at ${videoPath}.`)
  }
  const bytes = res.bytes || 0
  if (bytes > INLINE_BYTE_LIMIT) {
    throw new Error(
      `New-cut video is ${(bytes / 1024 / 1024).toFixed(1)} MB — above the ${(INLINE_BYTE_LIMIT / 1024 / 1024).toFixed(0)} MB inline limit. ` +
      `Re-export the timeline at a lower bitrate (CRF 22-24) before running the AI review.`
    )
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: TECHNIQUE_ID_LIST },
        { type: 'text', text: buildContextBlock(originalReport) },
        { type: 'text', text: `Return JSON conforming to this exact schema:\n${SCHEMA_PREVIEW}` },
        { type: 'video_url', video_url: { url: res.dataUrl } },
      ],
    },
  ]

  // Gemini's video-aware endpoints throw 500s under transient load
  // (the global `postJson` retries once but that's frequently not
  // enough for video payloads). Extra retries here with exponential
  // backoff cover that without changing the retry behaviour of the
  // text-only paths the proposer + captioner depend on.
  const SOFT_RETRIES = 2
  const SOFT_BASE_DELAY_MS = 1500
  let response
  let lastErr
  for (let attempt = 0; attempt <= SOFT_RETRIES; attempt++) {
    try {
      response = await geminiChatCompletion({
        apiKey: settings.geminiApiKey,
        model,
        messages,
        temperature,
        maxTokens,
        responseMimeType: 'application/json',
        thinkingBudget: 0,
      })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const status = err?.status
      const retriable = status === 500 || status === 502 || status === 503 || status === 504
      if (!retriable || attempt === SOFT_RETRIES) throw err
      // Exponential backoff: 1.5s, 3s.
      await new Promise((r) => setTimeout(r, SOFT_BASE_DELAY_MS * Math.pow(2, attempt)))
    }
  }
  if (lastErr) throw lastErr

  const rawText = response?.choices?.[0]?.message?.content || ''
  if (!rawText) {
    const reason = response?.blockReason
      ? `prompt blocked (${response.blockReason})`
      : response?.finishReason === 'MAX_TOKENS'
        ? `output truncated at maxTokens=${maxTokens}`
        : response?.finishReason || 'empty response'
    throw new Error(`Gemini returned no text for the AI review: ${reason}.`)
  }
  const parsed = extractJson(rawText) || {}
  return {
    ...parsed,
    schemaVersion: parsed.schemaVersion || 1,
    kind: 'ai-internal',                    // marks this as the non-Sundogs review
    generatedAt: new Date().toISOString(),
    model: response?.model || model,
  }
}
