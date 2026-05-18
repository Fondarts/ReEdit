/**
 * reeditSundogsReport.js
 *
 * Imports a Sundogs Video Performance Analysis report (the PDF the
 * client delivers) and extracts the structured fields the Proposal
 * pass needs to optimise against. The report is parsed by Gemini —
 * we send the PDF as `inlineData` (mimeType `application/pdf`) and
 * ask the model to fill a fixed JSON schema. PDF parsing is
 * Gemini-only at the moment because Anthropic / LM Studio either
 * don't accept PDFs at all or do so in a different shape; surfacing
 * a clear "switch to Gemini" error is preferable to a silent fail.
 *
 * Schema mirrors the actual Sundogs PDF layout (overall + 4
 * dimensions, each with deltas vs benchmark, doWell / couldExplore
 * bullets, and a Techniques table).
 *
 * Consumers:
 *   1) `SundogsReportPanel.jsx` (UI rendering of the imported report)
 *   2) `reeditProposer.buildUserPrompt()` (`# Sundogs Report` block
 *      injected into the proposal prompt when metric === 'Sundogs')
 *
 * The report is opaque to the rest of the app — we don't try to
 * map technique values to local shot ids. The proposer LLM gets
 * Sundogs' overall verdict + the local shot log and is instructed
 * to bridge the two.
 */

import { extractJson } from './reeditCaptioner'
import {
  chatCompletion, LLM_BACKENDS, LLM_TASKS, loadLlmSettings,
} from './reeditLlmClient'

// Canonical technique IDs per dimension. Mirror the Sundogs PDF
// taxonomy. The LLM normalises whatever the PDF happens to call them
// (case, spacing, "Has CTA" vs "has_cta") into these IDs.
export const SUNDOGS_TECHNIQUES = {
  attention: [
    'contrast', 'brightness', 'saturation', 'luminosity_changes',
    'movement', 'static_share',
    'scenes_per_second_first5', 'scenes_per_second_all', 'scenes_per_second_last5',
    'has_close_ups', 'framing_angles_count', 'unusual_angles',
    'person_in_first_5', 'face_close_up_first_5',
    'voice_over', 'supers_match_vo', 'has_music', 'music_type', 'has_sfx',
  ],
  comprehension_branding: [
    'branding_cues', 'audio_mention', 'branding_explicitness', 'brand_spikes',
  ],
  comprehension_product: [
    'packshot', 'product_close_ups', 'product_extreme_close_ups', 'product_people_interaction',
  ],
  persuasion: [
    'people_presence', 'people_extreme_close_ups', 'people_interaction',
    'intense_emotions', 'emotion_modalities', 'emotional_complexity', 'emotional_music',
  ],
  action: [
    'has_cta', 'has_promotion', 'has_urgency',
  ],
}

const SCHEMA_PREVIEW = `{
  "schemaVersion": 1,
  "meta": {
    "brand": "<as printed on the PDF cover>",
    "product": "<...>",
    "contentType": "<e.g. Financial Services, Electronics & Hardware>",
    "category": "<e.g. Services, Tech>",
    "categoryDetails": "<full category details if printed, else same as contentType>",
    "durationSec": <number — from 'Duration: NN seconds'>,
    "benchmarkVideos": <number — '220 videos' from the benchmark line, else null>
  },
  "overall": {
    "finalScorePct": <number — final score, e.g. 90>,
    "benchmarkPct":  <number — benchmark score, e.g. 68>,
    "deltas": {
      "attention":     <number — % above/below benchmark, e.g. 11 or -27>,
      "comprehension": <number>,
      "persuasion":    <number>,
      "action":        <number>
    }
  },
  "attention": {
    "deltas": { "first5": <number>, "overall": <number>, "last5": <number> },
    "doWell": ["..."],
    "couldExplore": ["..."],
    "techniques": { "<technique_id>": { "value": "<as printed>", "status": "good" | "evaluate" } }
  },
  "comprehension": {
    "branding": {
      "deltas": { "first5": <number>, "overall": <number>, "last5": <number> },
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "<as printed>", "status": "good" | "evaluate" } }
    },
    "product": {
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "<as printed>", "status": "good" | "evaluate" } }
    }
  },
  "persuasion": {
    "emotional": {
      "deltas": { "first5": <number>, "overall": <number>, "last5": <number> },
      "doWell": ["..."], "couldExplore": ["..."],
      "techniques": { "<technique_id>": { "value": "<as printed>", "status": "good" | "evaluate" } }
    }
  },
  "action": {
    "deltas": { "overall": <number>, "last5": <number> },
    "doWell": ["..."], "couldExplore": ["..."],
    "techniques": { "<technique_id>": { "value": "<as printed>", "status": "good" | "evaluate" } }
  },
  "differentiation": {
    "scorePct": <number — overall differentiation score %, e.g. 76>,
    "keyElements": ["..."]
  }
}`

// Map between human-readable names that show up on Sundogs PDFs and
// our canonical technique IDs. Listed both directions so the prompt
// can surface them. Anything the LLM can't confidently map to one of
// these IDs is dropped (rather than recorded under a freeform key)
// to keep the schema stable for the UI.
const TECHNIQUE_NAME_HINTS = `Map the PDF's technique names to these canonical ids:

ATTENTION:
  - "Contrast" → contrast
  - "Brightness" → brightness
  - "Saturation" → saturation
  - "Luminosity changes" → luminosity_changes
  - "Movement" → movement
  - "Static scenes (in share of scenes)" → static_share
  - "First 5" (under Scenes Per Second) → scenes_per_second_first5
  - "All" (under Scenes Per Second) → scenes_per_second_all
  - "Last 5" (under Scenes Per Second) → scenes_per_second_last5
  - "Has Close-ups" → has_close_ups
  - "Framing angles (distinct)" → framing_angles_count
  - "Unusual angles" → unusual_angles
  - "Has a person in first 5" → person_in_first_5
  - "Has a face close-up in first 5" → face_close_up_first_5
  - "Voice Over" → voice_over
  - "Supers Match Voice Over" → supers_match_vo
  - "Has Music" → has_music
  - "Music Type" → music_type
  - "Has Sound Effects" → has_sfx

COMPREHENSION · BRANDING:
  - "Number of branding techniques" → branding_cues
  - "Audio Mention" → audio_mention
  - "Explicit branding vs Implicit" → branding_explicitness
  - "Brand Highlights in Video" → brand_spikes

COMPREHENSION · PRODUCT:
  - "Packshot" → packshot
  - "Product Close-up" → product_close_ups
  - "Product Extreme Close-up" → product_extreme_close_ups
  - "Product x People Interaction" → product_people_interaction

PERSUASION · EMOTIONAL:
  - "Overall people presence" → people_presence
  - "People - Extreme close ups" → people_extreme_close_ups
  - "People Interaction / Relationships" → people_interaction
  - "Presence of intense emotions" → intense_emotions
  - "Modalities to convey emotions" → emotion_modalities
  - "Emotional Complexity" → emotional_complexity
  - "Emotional Music" → emotional_music

ACTION:
  - "Has CTA" → has_cta
  - "Has Promotion" → has_promotion
  - "Has Urgency" → has_urgency`

function buildSystemPrompt() {
  return `You are extracting structured fields from a "Sundogs Video Performance Analysis" PDF (an internal ad-effectiveness report). The PDF has a stable layout: a cover page with brand/product/duration, an overall score breakdown across four dimensions (Attention, Comprehension, Persuasion, Action), then per-dimension sections with windowed deltas (% above/below benchmark), "What you do well" / "What you could explore" recommendation columns, and a Techniques table with metric/value/status (Good / Evaluate). Extract every field into the JSON schema below. Return ONLY the JSON object, no commentary, no markdown fences.`
}

function buildUserPrompt() {
  return `Read the attached Sundogs report PDF and emit a JSON object matching this schema EXACTLY:

${SCHEMA_PREVIEW}

Rules:
- Deltas are NUMBERS (positive or negative). "+47%" → 47. "-27%" → -27. "0%" → 0. "On benchmark" → 0.
- For status, normalise "Good" → "good" and "Evaluate" → "evaluate". Drop techniques whose status the PDF marks as "N/A".
- For the technique \`value\` field, copy the PDF's printed value verbatim (e.g. "+7%", "-31%", "Yes", "No", "0% / 0% / 0%", "2 / 4 / 0", "16%", "Original", "No Audio Mention", "89% Explicit vs 10% Implicit", "1 Brand Spike / Highlight"). Don't reinterpret.
- doWell / couldExplore are the literal recommendation bullets ("What you do well" / "What you could explore" lists). Strip leading bullet glyphs.
- "Differentiation Key Elements" is the bulleted list under "Elements in your video present in less than 5% of benchmark".
- If a section is missing on the PDF, use an empty array / object — do NOT invent.
- JSON only.

${TECHNIQUE_NAME_HINTS}`
}

const ALLOWED_STATUS = new Set(['good', 'evaluate'])

function emptyWindow() {
  return { deltas: null, doWell: [], couldExplore: [], techniques: {} }
}

function emptyWindowWithDeltas(keys) {
  const deltas = {}
  for (const k of keys) deltas[k] = null
  return { deltas, doWell: [], couldExplore: [], techniques: {} }
}

function normalizeTechniques(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [id, t] of Object.entries(raw)) {
    if (!t || typeof t !== 'object') continue
    const status = ALLOWED_STATUS.has(t.status) ? t.status : 'evaluate'
    const value = typeof t.value === 'string' ? t.value : (t.value != null ? String(t.value) : '')
    if (!value) continue
    out[id] = { value, status }
  }
  return out
}

function normalizeBullets(arr) {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^no salient points/i.test(s))
    .slice(0, 8)
}

function normalizeDeltas(raw, keys) {
  const out = {}
  for (const k of keys) {
    const v = raw && typeof raw === 'object' ? raw[k] : null
    out[k] = Number.isFinite(v) ? Math.round(v) : null
  }
  return out
}

function normalizeWindow(raw, deltaKeys = ['first5', 'overall', 'last5']) {
  if (!raw || typeof raw !== 'object') return emptyWindowWithDeltas(deltaKeys)
  return {
    deltas: deltaKeys.length ? normalizeDeltas(raw.deltas, deltaKeys) : null,
    doWell: normalizeBullets(raw.doWell),
    couldExplore: normalizeBullets(raw.couldExplore),
    techniques: normalizeTechniques(raw.techniques),
  }
}

export function validateReport(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Report JSON is empty or not an object.')
  }
  // Require at least 2 of the 4 dimensions to land. Anything less and
  // we're probably parsing a non-Sundogs PDF.
  const present = ['attention', 'comprehension', 'persuasion', 'action'].filter((k) => parsed[k] && typeof parsed[k] === 'object')
  if (present.length < 2) {
    throw new Error(`Report JSON missing dimensions (got: [${present.join(', ')}]). Make sure the PDF is a Sundogs Video Performance Analysis report.`)
  }
  const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {}
  const overallRaw = parsed.overall && typeof parsed.overall === 'object' ? parsed.overall : {}
  const compr = parsed.comprehension && typeof parsed.comprehension === 'object' ? parsed.comprehension : {}
  const persEmoRaw = parsed.persuasion?.emotional
  const actionRaw = parsed.action && typeof parsed.action === 'object' ? parsed.action : {}
  const diff = parsed.differentiation && typeof parsed.differentiation === 'object' ? parsed.differentiation : {}
  return {
    schemaVersion: 1,
    meta: {
      brand: typeof meta.brand === 'string' ? meta.brand.trim() : '',
      product: typeof meta.product === 'string' ? meta.product.trim() : '',
      contentType: typeof meta.contentType === 'string' ? meta.contentType.trim() : '',
      category: typeof meta.category === 'string' ? meta.category.trim() : '',
      categoryDetails: typeof meta.categoryDetails === 'string' ? meta.categoryDetails.trim() : '',
      durationSec: Number.isFinite(meta.durationSec) ? meta.durationSec : null,
      benchmarkVideos: Number.isFinite(meta.benchmarkVideos) ? meta.benchmarkVideos : null,
    },
    overall: {
      finalScorePct: Number.isFinite(overallRaw.finalScorePct) ? Math.round(overallRaw.finalScorePct) : null,
      benchmarkPct: Number.isFinite(overallRaw.benchmarkPct) ? Math.round(overallRaw.benchmarkPct) : null,
      deltas: normalizeDeltas(overallRaw.deltas, ['attention', 'comprehension', 'persuasion', 'action']),
    },
    attention: normalizeWindow(parsed.attention),
    comprehension: {
      branding: normalizeWindow(compr.branding),
      product: normalizeWindow(compr.product, []), // product has no first5/last5 deltas
    },
    persuasion: {
      emotional: normalizeWindow(persEmoRaw),
    },
    action: normalizeWindow(actionRaw, ['overall', 'last5']),
    differentiation: {
      scorePct: Number.isFinite(diff.scorePct) ? Math.round(diff.scorePct) : null,
      keyElements: normalizeBullets(diff.keyElements),
    },
  }
}

// Read a File object as a base64 data URL using FileReader. We need
// the data URL form because that's what `geminiClient.dataUrlToInline`
// expects when we wrap the PDF as an `image_url`-shaped content block
// in the chat message (the dispatcher routes any data URL with a
// PDF mimeType to `inlineData`).
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error('Failed to read PDF file.'))
    reader.readAsDataURL(file)
  })
}

// Polynomial hash of the data URL — stable across imports of the
// same PDF, used to detect duplicate imports and re-use cached
// renders without bouncing the panel state.
function fingerprintDataUrl(dataUrl) {
  if (!dataUrl) return ''
  let h = 0
  // Hash a sample of the payload — full base64 strings can be a few
  // megabytes; the first/last/middle 4 KB is plenty to disambiguate.
  const sample = dataUrl.length > 12000
    ? dataUrl.slice(0, 4000) + dataUrl.slice(dataUrl.length / 2 - 2000, dataUrl.length / 2 + 2000) + dataUrl.slice(-4000)
    : dataUrl
  for (let i = 0; i < sample.length; i++) {
    h = ((h * 31) | 0) + sample.charCodeAt(i)
    h |= 0
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Parse a Sundogs PDF report. Pass either a File from a file picker
 * or an absolute path (uses electronAPI.readFileAsDataUrl).
 *
 * Throws a descriptive error if the active LLM backend isn't Gemini
 * or no API key is set; PDF input is Gemini-only in this build.
 */
export async function parseSundogsReport({ file, filePath } = {}) {
  if (!file && !filePath) {
    throw new Error('parseSundogsReport: pass either { file } or { filePath }.')
  }
  // Force-Gemini: PDF input via inlineData is Gemini-shape. Calling
  // the dispatcher with a non-Gemini active backend would either error
  // unhelpfully or silently drop the PDF.
  const settings = loadLlmSettings()
  if (!settings.geminiApiKey) {
    throw new Error('Sundogs PDF import requires a Gemini API key (set it in LLM Settings). The other backends do not accept PDFs the same way.')
  }
  let dataUrl
  if (file) {
    dataUrl = await fileToDataUrl(file)
  } else {
    const res = await window.electronAPI?.readFileAsDataUrl?.(filePath, 'application/pdf')
    if (!res?.success || !res.dataUrl) {
      throw new Error(`Could not read PDF at ${filePath}: ${res?.error || 'unknown error'}`)
    }
    dataUrl = res.dataUrl
  }
  if (!/^data:application\/pdf;base64,/.test(dataUrl)) {
    // FileReader keeps the upload's reported MIME — Sundogs files come
    // out as application/pdf. Anything else is almost certainly the
    // wrong file (an image, a Word doc, etc.).
    throw new Error('The attached file does not look like a PDF. Pick a Sundogs Video Performance Analysis PDF.')
  }
  // We compose the user message as a content array: prompt text + the
  // PDF as a Gemini-native inlineData part. Going through the dispatcher
  // (with backendOverride=GEMINI) keeps this code unaware of any
  // Gemini-specific knobs the rest of the app uses.
  const userPromptText = buildUserPrompt()
  const [, mime, base64] = dataUrl.match(/^data:([^;]+);base64,(.+)$/) || []
  const pdfPart = { inlineData: { mimeType: mime || 'application/pdf', data: base64 || '' } }
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: [{ type: 'text', text: userPromptText }, pdfPart] },
  ]
  const response = await chatCompletion({
    messages,
    temperature: 0.1,
    maxTokens: 16000,
    task: LLM_TASKS.PROPOSAL,
    backendOverride: LLM_BACKENDS.GEMINI,
  })
  const rawText = response?.choices?.[0]?.message?.content || ''
  const parsed = extractJson(rawText)
  if (!parsed) {
    throw new Error('Gemini did not return valid JSON for the report. Re-import the PDF.')
  }
  const validated = validateReport(parsed)
  return {
    ...validated,
    importedAt: new Date().toISOString(),
    model: response?.model || null,
    pdfFingerprint: fingerprintDataUrl(dataUrl),
    fileName: file?.name || (filePath ? filePath.split(/[\\/]/).pop() : ''),
    rawText, // kept for debugging; UI doesn't render it
  }
}
