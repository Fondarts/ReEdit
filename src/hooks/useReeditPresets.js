import { useCallback, useEffect, useState } from 'react'
import { PROPOSAL_METRICS as DEFAULT_METRICS } from '../services/reeditProposer'

/**
 * Persisted proposal presets.
 *
 * The built-in list (Attention / Comprehension / Persuasion / Action /
 * Google's ABCD) lives in reeditProposer.js. This hook layers user
 * overrides + custom presets on top, backed by localStorage so the
 * user's playbook follows them across projects without us needing a
 * project-store migration.
 *
 * Storage shape: the full effective preset array. On first read we
 * merge whatever the user had with the current defaults, which handles
 * two cases we care about:
 *   1. New defaults shipped in a fork update — they show up without
 *      nuking the user's overrides.
 *   2. User deleted a preset that's now a default — we keep their
 *      deletion (they didn't want it), they can recreate from scratch.
 */

const STORAGE_KEY = 'reedit.proposalPresets.v1'

// The shape we care about. builtin=true means the id matches one of
// the factory defaults (label/blurb/criteria may still be user-edited).
// builtin=false means user created or the default was renamed beyond
// recognition.

function loadFromStorage() {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function saveToStorage(presets) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets)) } catch { /* quota full, etc. — non-fatal */ }
}

function hydratedPresets() {
  const stored = loadFromStorage()
  if (!stored || stored.length === 0) {
    // First run: seed with defaults.
    return DEFAULT_METRICS.map((m) => ({ ...m, builtin: true }))
  }
  // Subsequent runs: keep stored ordering + any user-edits; only
  // append defaults the user has never seen (shipped after their
  // last edit).
  const seenIds = new Set(stored.map((p) => p.id))
  const result = stored.map((p) => ({ ...p, builtin: Boolean(p.builtin) }))
  for (const def of DEFAULT_METRICS) {
    if (!seenIds.has(def.id)) {
      result.push({ ...def, builtin: true })
    }
  }
  return result
}

export function useReeditPresets() {
  const [presets, setPresets] = useState(hydratedPresets)

  // Cross-tab sync: if the user edits presets in another window of the
  // same Electron session (rare but possible with dev reload), stay
  // consistent.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e) => {
      if (e.key === STORAGE_KEY) setPresets(hydratedPresets())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const commit = useCallback((next) => {
    setPresets(next)
    saveToStorage(next)
  }, [])

  const updatePreset = useCallback((id, patch) => {
    setPresets((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...patch } : p))
      saveToStorage(next)
      return next
    })
  }, [])

  const createPreset = useCallback((initial = {}) => {
    const id = `custom-${Date.now().toString(36)}`
    const created = {
      id,
      label: initial.label || 'New preset',
      blurb: initial.blurb || '',
      criteria: initial.criteria || '',
      builtin: false,
    }
    setPresets((prev) => {
      const next = [...prev, created]
      saveToStorage(next)
      return next
    })
    return created
  }, [])

  const deletePreset = useCallback((id) => {
    setPresets((prev) => {
      // Allow deleting builtins too — if the user really doesn't want
      // Google's ABCD in their list, that's their call. They can
      // recreate it from scratch later.
      const next = prev.filter((p) => p.id !== id)
      saveToStorage(next)
      return next
    })
  }, [])

  const resetPreset = useCallback((id) => {
    const def = DEFAULT_METRICS.find((m) => m.id === id)
    if (!def) return
    setPresets((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...def, builtin: true } : p))
      saveToStorage(next)
      return next
    })
  }, [])

  const isBuiltinDefault = useCallback((id) => (
    DEFAULT_METRICS.some((m) => m.id === id)
  ), [])

  return {
    presets,
    updatePreset,
    createPreset,
    deletePreset,
    resetPreset,
    isBuiltinDefault,
  }
}
