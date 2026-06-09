/**
 * Proposal "Instructions" panel — full prompt-rules editor with a
 * preset library. Exposes 4 editable static sections from the proposer
 * prompt (System role / Editing craft / Placeholder quality / Output
 * rules) plus the existing Extra instructions block. Each section has
 * its own textarea + "Reset to default"; the whole bundle gets saved
 * as a named preset in localStorage and follows the user across
 * projects.
 *
 * Data flow:
 *   - Active preset id lives in localStorage (last picked).
 *   - The parent owns two pieces of state: `extraInstructions` (the
 *     free-form user block) and `rules` (the 4 rule overrides).
 *   - Selecting a preset writes both pieces back up to the parent via
 *     `onChange({ extraInstructions, rules })`.
 *   - Editing a textarea bumps the local in-memory rule object and
 *     pushes the new bundle upward. Save updates the preset.
 *
 * "View full prompt" calls into reeditProposer.buildSystemPrompt /
 * buildUserPrompt with the live values so the user sees the exact
 * bytes that would be sent to Gemini.
 */

import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronUp, Save, Plus, Trash2, Eye, EyeOff, Copy, Check,
  RotateCcw,
} from 'lucide-react'
import {
  loadInstructionPresets,
  upsertInstructionPreset,
  deleteInstructionPreset,
  loadActiveInstructionPresetId,
  saveActiveInstructionPresetId,
  newInstructionPresetId,
  FACTORY_DEFAULTS,
} from '../../services/reeditInstructionPresets'
import { buildSystemPrompt, buildUserPrompt } from '../../services/reeditProposer'

const RULE_SECTIONS = [
  {
    key: 'systemRole',
    label: 'System role',
    description: 'How Gemini introduces itself before reading anything else. Placeholder {{footageRoleAddendum}} resolves to the footage-generation clause based on the active capability.',
    rows: 4,
  },
  {
    key: 'editingCraft',
    label: 'Editing craft rules',
    description: 'Cut-quality principles (jump cuts, 180° line, cut-on-motion, hook, rhythm, no-churn). Applied while ordering shots.',
    rows: 12,
  },
  {
    key: 'placeholderQuality',
    label: 'Placeholder quality rules',
    description: 'Rules for AI-generated placeholder shots (only relevant when footage generation is enabled). Feeds directly into the i2v model.',
    rows: 10,
  },
  {
    key: 'outputRules',
    label: 'Output schema + rules',
    description: 'The JSON schema example + the hard rules Gemini must follow. Placeholder {{metric}} resolves to the active metric name.',
    rows: 14,
  },
]

export default function ProposalInstructionsPanel({
  // Active extra-instructions text (legacy single field).
  value,
  onChange,
  // Active rule overrides — { systemRole?, editingCraft?, placeholderQuality?, outputRules? }
  rules,
  onRulesChange,
  // Bundle of args the parent would pass to generateProposal, used to
  // render the "View full prompt" preview faithfully.
  previewArgs,
}) {
  const [collapsed, setCollapsed] = useState(true)
  const [activeSection, setActiveSection] = useState('extra')
  const [showPreview, setShowPreview] = useState(false)
  const [copiedPreview, setCopiedPreview] = useState(false)
  const [presets, setPresets] = useState(() => loadInstructionPresets())
  const [activeId, setActiveId] = useState(() => loadActiveInstructionPresetId())

  const activePreset = useMemo(
    () => presets.find((p) => p.id === activeId) || presets[0],
    [presets, activeId],
  )

  // "Dirty" = the parent's active values diverge from the stored
  // preset's values. Drives the Save button enabled state and the
  // header indicator.
  const isDirty = useMemo(() => {
    if (!activePreset) return false
    if ((value || '') !== (activePreset.extraInstructions || '')) return true
    const presetRules = activePreset.rules || {}
    const liveRules = rules || {}
    for (const { key } of RULE_SECTIONS) {
      if ((presetRules[key] || '') !== (liveRules[key] || '')) return true
    }
    return false
  }, [activePreset, value, rules])

  const handleSelectPreset = (id) => {
    setActiveId(id)
    saveActiveInstructionPresetId(id)
    const p = presets.find((x) => x.id === id)
    if (!p) return
    onChange?.(p.extraInstructions || '')
    onRulesChange?.({ ...(p.rules || {}) })
  }

  const handleSave = () => {
    if (!activePreset) return
    const next = upsertInstructionPreset({
      ...activePreset,
      extraInstructions: value || '',
      rules: { ...(rules || {}) },
    })
    setPresets(next)
  }

  const handleSaveAsNew = () => {
    const defaultName = (activePreset?.name && !activePreset.builtIn)
      ? `${activePreset.name} (copy)`
      : 'New preset'
    const name = window.prompt('Name for this instruction preset:', defaultName)
    if (!name || !name.trim()) return
    const id = newInstructionPresetId()
    const next = upsertInstructionPreset({
      id,
      name: name.trim(),
      extraInstructions: value || '',
      rules: { ...(rules || {}) },
      builtIn: false,
    })
    setPresets(next)
    setActiveId(id)
    saveActiveInstructionPresetId(id)
  }

  const handleDelete = () => {
    if (!activePreset || activePreset.builtIn) return
    const ok = window.confirm(`Delete preset "${activePreset.name}"? This can't be undone.`)
    if (!ok) return
    const next = deleteInstructionPreset(activePreset.id)
    setPresets(next)
    setActiveId('builtin-default')
    saveActiveInstructionPresetId('builtin-default')
    const fallback = next.find((p) => p.id === 'builtin-default')
    onChange?.(fallback?.extraInstructions || '')
    onRulesChange?.({ ...(fallback?.rules || {}) })
  }

  const updateRule = (key, newText) => {
    onRulesChange?.({ ...(rules || {}), [key]: newText })
  }

  const resetRuleToDefault = (key) => {
    const next = { ...(rules || {}) }
    delete next[key]
    onRulesChange?.(next)
  }

  const promptPreview = useMemo(() => {
    if (!showPreview) return null
    try {
      const systemMsg = buildSystemPrompt(previewArgs?.capabilities || {}, { rules: rules || {} })
      const userMsg = buildUserPrompt({
        scenes: previewArgs?.scenes || [],
        brandBrief: previewArgs?.brandBrief || '',
        extraInstructions: value || '',
        metric: previewArgs?.metric || 'Comprehension',
        totalDurationSec: previewArgs?.totalDurationSec || null,
        targetDurationSec: previewArgs?.targetDurationSec || null,
        criteria: previewArgs?.criteria || null,
        correctionNote: null,
        capabilities: previewArgs?.capabilities || {},
        adConcept: previewArgs?.adConcept || null,
        voSegments: previewArgs?.voSegments || null,
        generatedVoiceover: previewArgs?.generatedVoiceover || null,
        generatedMusic: previewArgs?.generatedMusic || null,
        additionalAssets: previewArgs?.additionalAssets || null,
        sundogsReport: previewArgs?.sundogsReport || null,
        strictDuration: Boolean(previewArgs?.strictDuration),
        rules: rules || {},
      })
      return `===== SYSTEM =====\n${systemMsg}\n\n===== USER =====\n${userMsg}`
    } catch (err) {
      return `Error building prompt preview: ${err?.message || err}`
    }
  }, [showPreview, value, rules, previewArgs])

  const handleCopyPreview = async () => {
    if (!promptPreview) return
    try {
      await navigator.clipboard.writeText(promptPreview)
      setCopiedPreview(true)
      setTimeout(() => setCopiedPreview(false), 1500)
    } catch (_) { /* clipboard not available */ }
  }

  // Current text for the active section's textarea — fall back to the
  // factory default when the rule isn't overridden so the user sees
  // the real default instead of an empty box.
  const activeRuleText = activeSection === 'extra'
    ? (value || '')
    : (typeof rules?.[activeSection] === 'string'
        ? rules[activeSection]
        : (FACTORY_DEFAULTS[activeSection] || ''))

  const isRuleOverridden = activeSection !== 'extra'
    && typeof rules?.[activeSection] === 'string'
    && rules[activeSection] !== FACTORY_DEFAULTS[activeSection]

  const activeSectionDef = activeSection === 'extra'
    ? null
    : RULE_SECTIONS.find((s) => s.key === activeSection)

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40">
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-sf-dark-800/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-sf-text-muted uppercase tracking-wider">Instructions</span>
          <span className="text-[11px] text-sf-text-muted/80 truncate max-w-[420px]">
            {activePreset?.name || '—'}{isDirty ? ' · unsaved changes' : ''}
          </span>
        </div>
        {collapsed
          ? <ChevronDown className="w-4 h-4 text-sf-text-muted" />
          : <ChevronUp className="w-4 h-4 text-sf-text-muted" />}
      </button>

      {!collapsed && (
        <div className="border-t border-sf-dark-800 p-3 space-y-3">
          {/* Preset picker + library actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={activeId}
              onChange={(e) => handleSelectPreset(e.target.value)}
              className="flex-1 min-w-[200px] text-[12px] bg-sf-dark-800 border border-sf-dark-700 rounded-md px-2 py-1.5 text-sf-text-primary focus:outline-none focus:border-sf-accent"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.builtIn ? '★ ' : ''}{p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty || activePreset?.builtIn}
              title={activePreset?.builtIn ? 'Built-in presets are read-only — use Save as new' : 'Save edits to this preset'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary border border-sf-dark-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
            <button
              type="button"
              onClick={handleSaveAsNew}
              title="Create a new preset from the current text"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary border border-sf-dark-600"
            >
              <Plus className="w-3.5 h-3.5" />
              Save as new
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!activePreset || activePreset.builtIn}
              title={activePreset?.builtIn ? "Built-in presets can't be deleted" : `Delete "${activePreset?.name}"`}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] bg-sf-dark-800 hover:bg-sf-dark-700 text-rose-300 border border-sf-dark-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>

          {/* Section tabs — Extra instructions + 4 rule blocks. The
              active section drives which textarea renders below; this
              keeps the UI compact and lets all 5 fields share one
              editing surface instead of stacking 5 textareas. */}
          <div className="flex items-center gap-1 flex-wrap border-b border-sf-dark-800 pb-2">
            {[
              { key: 'extra', label: 'Extra instructions' },
              ...RULE_SECTIONS,
            ].map((s) => {
              const overridden = s.key !== 'extra'
                && typeof rules?.[s.key] === 'string'
                && rules[s.key] !== FACTORY_DEFAULTS[s.key]
              const isActive = activeSection === s.key
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveSection(s.key)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'bg-sf-accent text-white'
                      : 'bg-sf-dark-800 text-sf-text-secondary hover:bg-sf-dark-700 hover:text-sf-text-primary'
                  }`}
                >
                  {s.label}
                  {overridden && <span className="ml-1 text-amber-300" title="Overridden from factory default">●</span>}
                </button>
              )
            })}
          </div>

          {/* Description + reset for rule sections */}
          {activeSectionDef && (
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11px] text-sf-text-muted leading-relaxed flex-1">
                {activeSectionDef.description}
              </p>
              {isRuleOverridden && (
                <button
                  type="button"
                  onClick={() => resetRuleToDefault(activeSection)}
                  className="inline-flex items-center gap-1 text-[11px] text-sf-text-muted hover:text-sf-text-primary shrink-0"
                  title="Drop this override and use the factory default"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset to default
                </button>
              )}
            </div>
          )}

          {/* Active textarea */}
          {activeSection === 'extra' ? (
            <textarea
              value={value || ''}
              onChange={(e) => onChange?.(e.target.value)}
              placeholder="E.g. never use scenes where the driver's face is visible, always end with the aerial shot, keep at least one shot of the interior, avoid placeholder shots for the first 5 seconds."
              rows={6}
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent resize-y font-mono leading-relaxed"
            />
          ) : (
            <textarea
              value={activeRuleText}
              onChange={(e) => updateRule(activeSection, e.target.value)}
              rows={activeSectionDef?.rows || 8}
              className="w-full text-[12px] rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sf-text-primary focus:outline-none focus:border-sf-accent resize-y font-mono leading-relaxed"
            />
          )}

          {/* Full-prompt preview toggle */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowPreview((s) => !s)}
              className="inline-flex items-center gap-1.5 text-[11px] text-sf-text-muted hover:text-sf-text-primary"
            >
              {showPreview
                ? <><EyeOff className="w-3.5 h-3.5" /> Hide full prompt</>
                : <><Eye className="w-3.5 h-3.5" /> View full prompt (what gets sent to Gemini)</>}
            </button>
            {showPreview && (
              <button
                type="button"
                onClick={handleCopyPreview}
                className="inline-flex items-center gap-1.5 text-[11px] text-sf-text-muted hover:text-sf-text-primary"
              >
                {copiedPreview
                  ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</>
                  : <><Copy className="w-3.5 h-3.5" /> Copy</>}
              </button>
            )}
          </div>
          {showPreview && (
            <pre className="max-h-[420px] overflow-auto rounded-md border border-sf-dark-700 bg-sf-dark-900/80 p-3 text-[11px] text-sf-text-secondary whitespace-pre-wrap break-words leading-relaxed">
              {promptPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
