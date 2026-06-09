/**
 * System-font discovery for the text-clip inspectors.
 *
 * Strategy:
 *  - Primary: `window.queryLocalFonts()` (Chromium 103+, available in
 *    Electron 21+). Returns the OS's installed fonts so the dropdown
 *    shows exactly what's on the user's machine — no missing-font
 *    silent fallbacks.
 *  - Fallback: a tiny web-safe list so the dropdown isn't empty when
 *    the API is missing (older Electron, browser preview, etc).
 *
 * Permission: the Local Font Access API requires the `local-fonts`
 * permission. We pre-approve it from the Electron main process (see
 * `setPermissionRequestHandler` in electron/main.js) so the first
 * call resolves silently — no user prompt.
 *
 * Result is cached per session — the OS font list doesn't change
 * mid-app-run often enough to be worth polling.
 */

// Web-safe baseline used while we're loading + when the API is absent.
export const FALLBACK_FONT_OPTIONS = [
  'Inter',
  'Arial',
  'Helvetica',
  'Times New Roman',
  'Georgia',
  'Courier New',
  'Verdana',
  'Tahoma',
  'Impact',
  'Comic Sans MS',
  'Trebuchet MS',
]

// Backwards-compat — some callers import FONT_OPTIONS as a static
// list. Resolved to the fallback at module load; the hook below is
// what should be used for an up-to-date system list.
export const FONT_OPTIONS = FALLBACK_FONT_OPTIONS

let _cachedSystemFonts = null
let _inflightSystemFontsPromise = null

/**
 * Enumerate fonts installed on the user's OS. Cached per session.
 *
 * @returns {Promise<string[]>} unique family names, alpha-sorted.
 */
export async function loadSystemFonts() {
  if (_cachedSystemFonts) return _cachedSystemFonts
  if (_inflightSystemFontsPromise) return _inflightSystemFontsPromise

  _inflightSystemFontsPromise = (async () => {
    try {
      if (typeof window === 'undefined' || typeof window.queryLocalFonts !== 'function') {
        return FALLBACK_FONT_OPTIONS
      }
      const fonts = await window.queryLocalFonts()
      // `family` repeats across weights / styles of the same family
      // (Arial → Arial Regular, Arial Bold, Arial Italic …) — dedupe
      // by family so the dropdown shows ONE row per family. The
      // per-weight rendering is the inspector's other controls' job.
      const families = new Set()
      for (const f of fonts) {
        const name = (f?.family || '').trim()
        if (name) families.add(name)
      }
      const sorted = Array.from(families).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      if (sorted.length === 0) return FALLBACK_FONT_OPTIONS
      _cachedSystemFonts = sorted
      return sorted
    } catch (err) {
      console.warn('[fontOptions] queryLocalFonts() failed, falling back to web-safe list:', err?.message || err)
      return FALLBACK_FONT_OPTIONS
    } finally {
      _inflightSystemFontsPromise = null
    }
  })()

  return _inflightSystemFontsPromise
}
