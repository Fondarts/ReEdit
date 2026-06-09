import { useEffect, useState } from 'react'
import { FALLBACK_FONT_OPTIONS, loadSystemFonts } from '../utils/fontOptions'

/**
 * Returns the OS-installed font list (alpha-sorted, deduped by family).
 * Renders with the fallback web-safe list on first paint, then swaps
 * in the real list once `window.queryLocalFonts()` resolves. Cached
 * at module level so a re-render in any consumer reuses the same
 * resolved list.
 */
export function useSystemFonts() {
  const [fonts, setFonts] = useState(FALLBACK_FONT_OPTIONS)

  useEffect(() => {
    let cancelled = false
    loadSystemFonts().then((list) => {
      if (!cancelled && Array.isArray(list) && list.length > 0) {
        setFonts(list)
      }
    })
    return () => { cancelled = true }
  }, [])

  return fonts
}
