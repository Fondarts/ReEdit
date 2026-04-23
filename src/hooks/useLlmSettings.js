import { useCallback, useEffect, useState } from 'react'
import { loadLlmSettings, saveLlmSettings } from '../services/reeditLlmClient'

/**
 * React hook wrapping the LLM-settings localStorage store so any
 * component can read + write the current backend/model/API key and
 * stay in sync when another component (or another window of the same
 * Electron session) changes them.
 */
export function useLlmSettings() {
  const [settings, setSettings] = useState(() => loadLlmSettings())

  useEffect(() => {
    const onChange = (e) => {
      // Our own in-process save broadcasts the next settings directly;
      // the native `storage` event only fires across tabs/windows.
      if (e?.detail) setSettings(e.detail)
      else setSettings(loadLlmSettings())
    }
    const onStorage = (e) => {
      if (e.key === 'reedit.llm.v1') setSettings(loadLlmSettings())
    }
    window.addEventListener('reedit-llm-settings-changed', onChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('reedit-llm-settings-changed', onChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const update = useCallback((patch) => {
    const next = saveLlmSettings(patch)
    if (next) setSettings(next)
  }, [])

  return { settings, update }
}
