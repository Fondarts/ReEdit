/**
 * reeditAdReport.js
 *
 * Gemini-native ad performance report. The alternative to importing a
 * client Sundogs PDF (see reeditReportSource.js for the toggle): instead
 * of parsing an external document, Gemini watches the video directly and
 * returns a strengths / weaknesses / opportunities read with per-dimension
 * scores, framed explicitly as an *advertisement* analysis (branding,
 * hook, persuasion, call-to-action — not generic video critique).
 *
 * The same function scores both the original cut (Import tab → drives the
 * proposal) and the re-edited cut (Review tab → side-by-side comparison),
 * so the two reports are directly comparable score-for-score.
 *
 * Consumers:
 *   1) `AdReportPanel.jsx`        — renders the report (SWO + score bars)
 *   2) `ImportVideoView.jsx`      — "Generate report" button (original)
 *   3) `ReviewView.jsx`           — re-scores the new cut for comparison
 *   4) `reeditProposer.buildUserPrompt()` — `# Ad Report` prompt block
 *
 * Video upload mirrors `analyzeOverallVideo` (reeditVideoAnalyzer.js):
 * read the file as a data URL and send it inline. The same ~19 MB inline
 * ceiling applies; oversized videos surface a clear re-transcode error
 * rather than failing silently.
 */

import { loadLlmSettings, LLM_TASKS, resolveGeminiModelForTask } from './reeditLlmClient'
import { extractJson } from './reeditCaptioner'
import { geminiChatCompletion } from './geminiClient'

// Same Gemini-key gate the other Gemini-only services use.
function requireGeminiKey() {
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Open Settings → LLM to paste one before generating the report.')
  }
  return settings
}

// Mirror the inline ceiling enforced by the caption / overall-analysis
// paths. Gemini's REST inline limit is ~20 MB before the Files API is
// required; keep this in sync with reeditVideoAnalyzer.js.
const INLINE_BYTE_LIMIT = 19 * 1024 * 1024

// The four dimensions we score. Deliberately mapped onto the same mental
// model the Sundogs framework uses (Attention / Comprehension-branding /
// Persuasion / Action) so a user switching between report sources reads
// the two on the same axes.
export const AD_REPORT_DIMENSIONS = [
  { key: 'attention',  label: 'Attention',  hint: 'Hook strength, pacing, visual contrast — does it stop the scroll and hold the eye?' },
  { key: 'branding',   label: 'Branding',   hint: 'Brand presence, logo/packshot timing, distinctiveness — is it unmistakably this brand?' },
  { key: 'persuasion', label: 'Persuasion', hint: 'Emotional pull, value proposition clarity, credibility — does it make you want the product?' },
  { key: 'action',     label: 'Action',     hint: 'CTA presence/clarity, urgency, next-step legibility — does it drive the desired action?' },
]

const SYSTEM_PROMPT = `You are a senior advertising creative strategist and performance analyst. You are given a finished advertisement video. Analyze it AS AN AD — judge it on the things that make ads work: a strong hook in the first 2-3 seconds, clear and well-timed branding, an emotionally persuasive through-line, and a legible call to action. This is NOT a generic film critique; ground every observation in advertising performance.

Score four dimensions on a 0-100 scale (100 = best-in-class for this category):
- attention: hook strength, pacing, visual contrast, scroll-stopping power, retention through the cut.
- branding: brand presence, logo/packshot timing and frequency, distinctiveness, whether the viewer remembers the brand.
- persuasion: emotional pull, value-proposition clarity, credibility/social proof, desire it creates for the product.
- action: presence and clarity of the call to action, urgency, how obvious the next step is.

Then give an overall score (0-100) reflecting the ad's likely performance.

Constraints:
- Output JSON ONLY. No prose, no markdown, no leading text, no code fences.
- Every score is an integer 0-100.
- strengths / weaknesses / opportunities are each 3-6 short, SPECIFIC strings. Each references a concrete moment, technique, or timestamp — never generic praise like "good editing". "Weaknesses" are what hurts performance; "opportunities" are concrete, actionable changes a re-edit could make (reorder shots, tighten the open, add an end-card CTA, surface the logo earlier, etc.).
- summary is 2-3 sentences: the ad's core idea and your overall performance read.
- Fill meta from what you observe: brand (best guess from logos/VO), product, durationSec (your estimate).`

const SCHEMA_PREVIEW = `{
  "schemaVersion": 1,
  "meta": {
    "brand": "<brand name, best guess from the video>",
    "product": "<what's being advertised>",
    "durationSec": <number — your estimate of the video length>
  },
  "scores": {
    "attention":  <0-100>,
    "branding":   <0-100>,
    "persuasion": <0-100>,
    "action":     <0-100>,
    "overall":    <0-100>
  },
  "strengths":     ["...", "...", "..."],
  "weaknesses":    ["...", "...", "..."],
  "opportunities": ["...", "...", "..."],
  "summary": "2-3 sentence overall read."
}`

// Carry the original report's verdict into the new-cut pass so Gemini
// frames the second analysis as a delta on the same brand/product rather
// than a cold standalone read — keeps the two scores comparable.
function buildContextBlock(originalReport) {
  if (!originalReport) return 'This is a standalone analysis; no prior report was provided.'
  const meta = originalReport.meta || {}
  const scores = originalReport.scores || {}
  return [
    'You previously scored the ORIGINAL cut of this same ad. Carry brand/product over and judge the NEW cut on the same scale so the two are comparable:',
    `  brand: ${meta.brand || 'unknown'}`,
    `  product: ${meta.product || 'unknown'}`,
    `  original scores — attention: ${scores.attention ?? '?'}, branding: ${scores.branding ?? '?'}, persuasion: ${scores.persuasion ?? '?'}, action: ${scores.action ?? '?'}, overall: ${scores.overall ?? '?'}`,
  ].join('\n')
}

function clampScore(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, v))
}

function normalizeBullets(arr) {
  if (!Array.isArray(arr)) return []
  return arr.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8)
}

/**
 * Generate a Gemini ad report for a video.
 *
 * @param {object} opts
 * @param {string} opts.videoPath        Absolute path to the MP4 to analyze.
 * @param {string} [opts.brandBrief]     Optional brand brief to ground the read.
 * @param {object} [opts.originalReport] When scoring the NEW cut, the original
 *   report — used for brand carry-over + comparable scoring.
 * @param {string} [opts.modelOverride]
 * @param {'analysis'|'review'} [opts.taskHint] Which LLM task slot to resolve
 *   the model from. Defaults to ANALYSIS.
 */
export async function generateAdReport({
  videoPath,
  brandBrief,
  originalReport,
  modelOverride,
  taskHint = 'analysis',
  temperature = 0.3,
  maxTokens = 4000,
} = {}) {
  if (!videoPath) throw new Error('generateAdReport: missing videoPath.')

  const settings = requireGeminiKey()
  const task = taskHint === 'review' ? LLM_TASKS.REVIEW : LLM_TASKS.ANALYSIS
  const model = modelOverride || resolveGeminiModelForTask(settings, task)

  const res = await window.electronAPI?.readFileAsDataUrl?.(videoPath, 'video/mp4')
  if (!res?.success) {
    throw new Error(res?.error || `Could not read video at ${videoPath}.`)
  }
  const bytes = res.bytes || 0
  if (bytes > INLINE_BYTE_LIMIT) {
    throw new Error(
      `Video is ${(bytes / 1024 / 1024).toFixed(1)} MB — above the ${(INLINE_BYTE_LIMIT / 1024 / 1024).toFixed(0)} MB inline limit. ` +
      `Re-transcode to 1080p/H.264 at a lower bitrate (CRF 22-24) before generating the report.`
    )
  }

  const userParts = [
    { type: 'text', text: buildContextBlock(originalReport) },
  ]
  if (brandBrief && String(brandBrief).trim()) {
    userParts.push({ type: 'text', text: `Brand brief (context):\n${String(brandBrief).trim()}` })
  }
  userParts.push({ type: 'text', text: `Return JSON conforming to this exact schema:\n${SCHEMA_PREVIEW}` })
  userParts.push({ type: 'video_url', video_url: { url: res.dataUrl } })

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts },
  ]

  // Gemini's video endpoints throw transient 5xx under load; retry a
  // couple of times with backoff like the Sundogs review path does.
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
    throw new Error(`Gemini returned no text for the ad report: ${reason}.`)
  }

  const parsed = extractJson(rawText) || {}
  const scores = parsed.scores || {}
  return {
    schemaVersion: 1,
    kind: 'gemini-ad-report',
    meta: {
      brand: parsed.meta?.brand || null,
      product: parsed.meta?.product || null,
      durationSec: Number.isFinite(Number(parsed.meta?.durationSec)) ? Number(parsed.meta.durationSec) : null,
    },
    scores: {
      attention: clampScore(scores.attention),
      branding: clampScore(scores.branding),
      persuasion: clampScore(scores.persuasion),
      action: clampScore(scores.action),
      overall: clampScore(scores.overall),
    },
    strengths: normalizeBullets(parsed.strengths),
    weaknesses: normalizeBullets(parsed.weaknesses),
    opportunities: normalizeBullets(parsed.opportunities),
    summary: String(parsed.summary || '').trim() || null,
    generatedAt: new Date().toISOString(),
    model: response?.model || model,
  }
}

/**
 * Render an ad report as a markdown block for the proposer prompt. The
 * proposer treats this as the brief's "what to fix" list — weaknesses and
 * opportunities are the levers, scores tell it which dimensions need the
 * most lift. Mirrors renderSundogsReport()'s role in the prompt.
 */
export function renderAdReportForPrompt(report) {
  if (!report) return ''
  const s = report.scores || {}
  const meta = report.meta || {}
  const lines = []
  lines.push('# Ad Report (Gemini analysis of the original cut)')
  lines.push('This is an AI performance read of the ORIGINAL ad. Treat the weaknesses and opportunities as the brief: the new edit should raise the weak dimensions while preserving the strengths. Scores are 0-100.')
  if (meta.brand || meta.product) {
    lines.push(`Brand: ${meta.brand || 'unknown'}${meta.product ? ` · Product: ${meta.product}` : ''}`)
  }
  lines.push('')
  lines.push(`Scores — Attention: ${s.attention ?? '?'} · Branding: ${s.branding ?? '?'} · Persuasion: ${s.persuasion ?? '?'} · Action: ${s.action ?? '?'} · Overall: ${s.overall ?? '?'}`)
  if (report.summary) {
    lines.push('')
    lines.push(`Read: ${report.summary}`)
  }
  if (report.strengths?.length) {
    lines.push('')
    lines.push('Strengths (preserve these):')
    report.strengths.forEach((b) => lines.push(`- ${b}`))
  }
  if (report.weaknesses?.length) {
    lines.push('')
    lines.push('Weaknesses (the new edit must address these):')
    report.weaknesses.forEach((b) => lines.push(`- ${b}`))
  }
  if (report.opportunities?.length) {
    lines.push('')
    lines.push('Opportunities (concrete changes to make):')
    report.opportunities.forEach((b) => lines.push(`- ${b}`))
  }
  return lines.join('\n')
}
