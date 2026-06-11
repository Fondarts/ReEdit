/**
 * Report source: where the "ad performance report" comes from.
 *
 *   'sundogs' (default) — the client delivers a Sundogs Video Performance
 *     Analysis PDF; Gemini parses it (see reeditSundogsReport.js) and the
 *     parsed scores drive the proposal + the Review comparison.
 *   'gemini' — no external PDF. Gemini watches the original video directly
 *     and produces a strengths / weaknesses / opportunities report with
 *     per-dimension scores (see reeditAdReport.js). Same report then feeds
 *     the proposal and the Review comparison.
 *
 * Global app preference (not per-project) persisted in localStorage so it
 * follows the user across projects, mirroring the other UI-mode toggles.
 */

const REPORT_SOURCE_KEY = 'report-source'
const VALID_SOURCES = new Set(['sundogs', 'gemini'])
const DEFAULT_SOURCE = 'sundogs'

export function getReportSource() {
  try {
    const stored = localStorage?.getItem?.(REPORT_SOURCE_KEY) || DEFAULT_SOURCE
    return VALID_SOURCES.has(stored) ? stored : DEFAULT_SOURCE
  } catch {
    return DEFAULT_SOURCE
  }
}

export function setReportSource(source) {
  if (!VALID_SOURCES.has(source)) return
  try {
    localStorage?.setItem?.(REPORT_SOURCE_KEY, source)
  } catch (_) { /* private mode / no storage — fall back to default */ }
}

// Returns true when the Gemini-generated ad report should replace the
// Sundogs PDF flow.
export function isGeminiReportMode() {
  return getReportSource() === 'gemini'
}
