import { useEffect, useState } from 'react'
import { SlidersHorizontal, Dice5 } from 'lucide-react'

// Two-position UI-mode toggle: Auto / Advanced. Used by the TitleBar
// (when a project is open) and by the WelcomeScreen header (when picking
// which mode you want to start the next project in), so the persisted
// preference is the same regardless of where it was set.
//
// Storage / event contract matches what `useUiMode` and TitleBar already
// rely on — localStorage key `comfystudio-ui-mode` plus a custom event
// `comfystudio-ui-mode-changed` on `window`. A stale localStorage value
// (e.g. the retired `simple` mode) falls back to `advanced`.

const UI_MODE_STORAGE_KEY = 'comfystudio-ui-mode'
const UI_MODE_EVENT = 'comfystudio-ui-mode-changed'
const VALID_MODES = new Set(['advanced', 'lucky'])

function readPersistedUiMode() {
  try {
    const v = localStorage.getItem(UI_MODE_STORAGE_KEY)
    return VALID_MODES.has(v) ? v : 'advanced'
  } catch { return 'advanced' }
}

export default function UiModeToggle({ className = '' }) {
  const [uiMode, setUiModeState] = useState(readPersistedUiMode)

  // Stay in sync when something else (TitleBar in another window, the
  // useUiMode hook, dev tools) changes the mode — no leader/follower
  // problem because everyone reads + writes the same key.
  useEffect(() => {
    const onChange = (e) => {
      const next = VALID_MODES.has(e?.detail) ? e.detail : 'advanced'
      setUiModeState(next)
    }
    window.addEventListener(UI_MODE_EVENT, onChange)
    const onStorage = (e) => {
      if (e.key === UI_MODE_STORAGE_KEY) setUiModeState(readPersistedUiMode())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(UI_MODE_EVENT, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setUiMode = (next) => {
    if (!VALID_MODES.has(next) || next === uiMode) return
    try { localStorage.setItem(UI_MODE_STORAGE_KEY, next) } catch { /* ignore */ }
    setUiModeState(next)
    try {
      window.dispatchEvent(new CustomEvent(UI_MODE_EVENT, { detail: next }))
    } catch { /* ignore */ }
  }

  return (
    <div className={`no-drag flex items-center bg-sf-dark-800 border border-sf-dark-700 rounded-md overflow-hidden ${className}`}>
      <button
        type="button"
        onClick={() => setUiMode('lucky')}
        title="Auto — one button runs the whole pipeline"
        className={`h-7 px-2 flex items-center gap-1 text-[10px] transition-colors ${
          uiMode === 'lucky'
            ? 'bg-sf-accent text-white'
            : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
        }`}
      >
        <Dice5 className="w-3 h-3" /> Auto
      </button>
      <div className="w-px h-4 bg-sf-dark-600" aria-hidden />
      <button
        type="button"
        onClick={() => setUiMode('advanced')}
        title="Advanced — full pipeline with Optimization + Editor"
        className={`h-7 px-2 flex items-center gap-1 text-[10px] transition-colors ${
          uiMode === 'advanced'
            ? 'bg-sf-accent text-white'
            : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
        }`}
      >
        <SlidersHorizontal className="w-3 h-3" /> Advanced
      </button>
    </div>
  )
}
