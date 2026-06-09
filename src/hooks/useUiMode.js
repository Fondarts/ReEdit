import { useEffect, useState } from 'react'

// Mirror of the storage key + event used by TitleBar.jsx. Kept in sync
// here so components can read the current UI mode without importing the
// TitleBar (which would create a render cycle). Default is 'advanced'
// so existing users see no behavior change until they flip the toggle.
//
// Two modes supported:
//   - 'advanced' → full pipeline with every tab + the Resolve-style Editor.
//   - 'lucky'    → "Auto": Import + Proposal only; one Go button runs the
//                  whole pipeline (Caption + Stems + Optimize + Propose)
//                  and lands the user on the proposal. Uses the compact
//                  ProposalViewSimple/EditorSimple components.
// A stale `simple` value in localStorage falls back to `advanced`.
const UI_MODE_STORAGE_KEY = 'comfystudio-ui-mode'
const UI_MODE_EVENT = 'comfystudio-ui-mode-changed'
const VALID_MODES = new Set(['advanced', 'lucky'])

function read() {
  try {
    const v = localStorage.getItem(UI_MODE_STORAGE_KEY)
    return VALID_MODES.has(v) ? v : 'advanced'
  } catch { return 'advanced' }
}

export function useUiMode() {
  const [mode, setMode] = useState(read)
  useEffect(() => {
    const onChange = (e) => {
      const next = VALID_MODES.has(e?.detail) ? e.detail : 'advanced'
      setMode(next)
    }
    window.addEventListener(UI_MODE_EVENT, onChange)
    // Also re-read on storage events from other windows (Electron has one
    // window so this is mostly defensive, but cheap).
    const onStorage = (e) => {
      if (e.key === UI_MODE_STORAGE_KEY) setMode(read())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(UI_MODE_EVENT, onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return mode
}
