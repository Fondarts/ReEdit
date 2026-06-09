/**
 * Instruction / rule presets — bundles of editable prompt sections
 * that the user can save as a named library and reuse across projects.
 *
 * A preset's `rules` field overrides the corresponding default block
 * in the proposer prompt. Fields are optional; missing fields fall
 * back to the factory defaults exported from reeditProposer.js
 * (DEFAULT_SYSTEM_ROLE / DEFAULT_EDITING_CRAFT / etc).
 *
 * `extraInstructions` is a separate field that lands as the
 * `# Extra instructions (honor these strictly)` block — same as the
 * legacy single-textarea behaviour, just rolled into the same preset
 * so the user has ONE library entry to manage per "campaign style".
 *
 * Shape:
 *   {
 *     id: string
 *     name: string
 *     extraInstructions: string
 *     rules: {
 *       systemRole?: string             // {{footageRoleAddendum}} honoured
 *       editingCraft?: string
 *       placeholderQuality?: string
 *       outputRules?: string            // {{metric}} honoured
 *     }
 *     createdAt: ISO
 *     updatedAt: ISO
 *     builtIn?: boolean
 *   }
 *
 * Storage:
 *   reedit.proposal.instructionPresets.v2  — user library (factory
 *                                            presets are merged in
 *                                            on every load)
 *   reedit.proposal.activeInstructionPreset.v1 — last-picked id
 *
 * The .v1 storage from the previous extraInstructions-only design is
 * migrated on first load: each .v1 row becomes a .v2 row with the
 * same extraInstructions and an empty `rules` object.
 */

import {
  DEFAULT_SYSTEM_ROLE,
  DEFAULT_EDITING_CRAFT,
  DEFAULT_PLACEHOLDER_QUALITY,
  DEFAULT_OUTPUT_RULES,
} from './reeditProposer'

const STORAGE_KEY = 'reedit.proposal.instructionPresets.v2'
const LEGACY_KEY  = 'reedit.proposal.instructionPresets.v1'
const ACTIVE_KEY  = 'reedit.proposal.activeInstructionPreset.v1'

const FACTORY_PRESETS = [
  {
    id: 'builtin-default',
    name: 'Default rules (factory)',
    extraInstructions: '',
    rules: {},
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'builtin-performance',
    name: 'Performance / direct response',
    extraInstructions: [
      "Optimise for direct-response performance, not brand sentiment.",
      "- Lead with a problem or hook in the first 1.5s; no slow build.",
      "- Reinforce the CTA visually AND through any available VO line.",
      "- Prefer human-reaction / before-after shots over scenery beats.",
      "- Cuts should average 1.0-1.5s; held shots only when a beat genuinely needs the breath.",
    ].join('\n'),
    rules: {},
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'builtin-brand',
    name: 'Brand / awareness',
    extraInstructions: [
      "Optimise for brand resonance over conversion.",
      "- Earn the held shots. Let emotional beats breathe (1.5-2.5s).",
      "- Bring the brand back at regular intervals, not just at the end card.",
      "- Mood and lighting consistency matters more than density of cuts.",
      "- Avoid pure-product close-ups in the first 5s; lead with a human beat.",
    ].join('\n'),
    rules: {},
    builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

// Read defaults as a plain object — handy for the panel UI to pre-fill
// the "Reset to default" action against. Re-exported from the proposer
// constants so consumers don't have to import from two places.
export const FACTORY_DEFAULTS = {
  systemRole: DEFAULT_SYSTEM_ROLE,
  editingCraft: DEFAULT_EDITING_CRAFT,
  placeholderQuality: DEFAULT_PLACEHOLDER_QUALITY,
  outputRules: DEFAULT_OUTPUT_RULES,
}

function safeParse(str, fallback) {
  try { const v = JSON.parse(str); return v ?? fallback } catch { return fallback }
}

function migrateLegacy() {
  // Migrate the v1 presets (single-text "extra instructions" library)
  // into v2 by wrapping each row with an empty `rules` object. Runs
  // once: after the migration the v1 key is left alone (in case the
  // user rolls back) but we don't re-read it.
  const legacyRaw = localStorage.getItem(LEGACY_KEY)
  if (!legacyRaw) return null
  const arr = safeParse(legacyRaw, [])
  if (!Array.isArray(arr) || arr.length === 0) return null
  const migrated = arr
    .filter((p) => p && typeof p === 'object' && p.id && !String(p.id).startsWith('builtin-'))
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || 'Untitled'),
      extraInstructions: String(p.text || ''),
      rules: {},
      builtIn: false,
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || p.createdAt || new Date().toISOString(),
    }))
  if (migrated.length > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
  }
  return migrated
}

// Normalise an arbitrary stored row to the v2 shape so the rest of
// the code can rely on `extraInstructions` + `rules` being present.
function normaliseRow(p) {
  if (!p || typeof p !== 'object' || !p.id) return null
  return {
    id: String(p.id),
    name: String(p.name || 'Untitled'),
    extraInstructions: typeof p.extraInstructions === 'string'
      ? p.extraInstructions
      : (typeof p.text === 'string' ? p.text : ''),  // legacy compat
    rules: (p.rules && typeof p.rules === 'object') ? {
      systemRole: typeof p.rules.systemRole === 'string' ? p.rules.systemRole : undefined,
      editingCraft: typeof p.rules.editingCraft === 'string' ? p.rules.editingCraft : undefined,
      placeholderQuality: typeof p.rules.placeholderQuality === 'string' ? p.rules.placeholderQuality : undefined,
      outputRules: typeof p.rules.outputRules === 'string' ? p.rules.outputRules : undefined,
    } : {},
    builtIn: Boolean(p.builtIn),
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || p.createdAt || new Date().toISOString(),
  }
}

export function loadInstructionPresets() {
  const raw = localStorage.getItem(STORAGE_KEY)
  let userList = []
  if (raw) {
    userList = safeParse(raw, [])
    if (!Array.isArray(userList)) userList = []
  } else {
    // First load on this storage version — try migration from v1.
    userList = migrateLegacy() || []
  }
  const byId = new Map()
  for (const p of FACTORY_PRESETS) byId.set(p.id, { ...p, rules: { ...p.rules } })
  for (const p of userList) {
    const norm = normaliseRow(p)
    if (norm) byId.set(norm.id, norm)
  }
  return Array.from(byId.values()).sort((a, b) => {
    if (a.builtIn && !b.builtIn) return -1
    if (!a.builtIn && b.builtIn) return 1
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  })
}

function persistInstructionPresets(list) {
  try {
    // Persist BOTH factory overrides + user presets. Built-ins from
    // factory are merged in on load anyway, but persisting overrides
    // by id keeps the "user customised a built-in" case round-trippable.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (err) {
    console.warn('[reedit] could not persist instruction presets:', err)
  }
}

export function upsertInstructionPreset(preset) {
  if (!preset || !preset.id) throw new Error('upsertInstructionPreset: id required')
  const list = loadInstructionPresets()
  const idx = list.findIndex((p) => p.id === preset.id)
  const stamp = new Date().toISOString()
  const next = {
    id: preset.id,
    name: preset.name || 'Untitled',
    extraInstructions: typeof preset.extraInstructions === 'string' ? preset.extraInstructions : '',
    rules: (preset.rules && typeof preset.rules === 'object') ? { ...preset.rules } : {},
    builtIn: Boolean(preset.builtIn),
    createdAt: idx >= 0 ? list[idx].createdAt : stamp,
    updatedAt: stamp,
  }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  persistInstructionPresets(list)
  return list
}

export function deleteInstructionPreset(id) {
  const list = loadInstructionPresets()
  const target = list.find((p) => p.id === id)
  if (!target || target.builtIn) return list
  const next = list.filter((p) => p.id !== id)
  persistInstructionPresets(next)
  return next
}

export function loadActiveInstructionPresetId() {
  const raw = localStorage.getItem(ACTIVE_KEY)
  return raw && typeof raw === 'string' ? raw : 'builtin-default'
}

export function saveActiveInstructionPresetId(id) {
  try { localStorage.setItem(ACTIVE_KEY, id || 'builtin-default') } catch (_) {}
}

export function newInstructionPresetId() {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `user-${t}-${r}`
}
