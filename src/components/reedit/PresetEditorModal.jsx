import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Save, RotateCcw, Trash2, Loader2, Plus } from 'lucide-react'

/**
 * Big modal for editing one proposal preset (or creating a new one).
 *
 *   - Label + Blurb drive the metric card in Proposal's grid.
 *   - Criteria is a full framework block that gets pinned at the top
 *     of the LLM prompt under a "# Framework" heading. This is where
 *     the ABCD rulebook lives; users can paste any custom framework
 *     here and the proposer will respect it.
 *
 * Save/cancel are standard. For built-in defaults a "Reset to default"
 * button appears (restores the factory version of that preset). For
 * user-created presets, "Delete" appears instead.
 */
function PresetEditorModal({
  isOpen,
  mode = 'edit',         // 'edit' | 'create'
  preset,                 // when editing, the current preset
  isBuiltinDefault,       // (id) => boolean
  onClose,
  onSave,                 // (patch) => void
  onDelete,               // () => void  (only for user-created)
  onReset,                // () => void  (only for builtins)
}) {
  const [label, setLabel] = useState('')
  const [blurb, setBlurb] = useState('')
  const [criteria, setCriteria] = useState('')
  const labelInputRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    setLabel(preset?.label || '')
    setBlurb(preset?.blurb || '')
    setCriteria(preset?.criteria || '')
    setTimeout(() => { labelInputRef.current?.focus() }, 0)
  }, [isOpen, preset?.id])

  const dirty = useMemo(() => {
    if (mode === 'create') return Boolean(label.trim())
    return (
      (label || '') !== (preset?.label || '')
      || (blurb || '') !== (preset?.blurb || '')
      || (criteria || '') !== (preset?.criteria || '')
    )
  }, [mode, label, blurb, criteria, preset?.label, preset?.blurb, preset?.criteria])

  if (!isOpen) return null

  const canReset = mode === 'edit' && preset?.id && isBuiltinDefault?.(preset.id)
  const canDelete = mode === 'edit' && preset?.id && !canReset

  const handleSave = () => {
    const trimmed = label.trim()
    if (!trimmed) return
    onSave?.({ label: trimmed, blurb: blurb.trim(), criteria })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose?.()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty) handleSave()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] flex flex-col bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <div>
            <h2 className="text-sm font-semibold text-sf-text-primary">
              {mode === 'create' ? 'New preset' : 'Edit preset'}
            </h2>
            {preset?.id && (
              <p className="text-[10px] text-sf-text-muted mt-0.5 font-mono">
                {preset.id}
                {canReset && <span className="ml-2 text-sf-text-muted/70">· built-in</span>}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Label</label>
            <input
              ref={labelInputRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="E.g. ABCD, Hook-Pay-Off, My playbook…"
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
              Card description <span className="text-sf-text-muted/70 normal-case">(shown on the Proposal card)</span>
            </label>
            <input
              type="text"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
              placeholder="1 sentence — e.g. 'Attract • Brand • Connect • Direct. Google's framework.'"
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
              Framework criteria <span className="text-sf-text-muted/70 normal-case">(pinned at the top of the LLM prompt under "# Framework")</span>
            </label>
            <textarea
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              rows={14}
              placeholder={'Describe the framework in concrete, actionable rules.\n\nExample:\nA — ATTRACT\n  • Hook in the first 3 seconds.\n  • Keep visuals high-contrast, readable on mobile.\n\nB — BRAND\n  • Show the logo within 2 seconds of frame one.\n  …'}
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent font-mono leading-relaxed resize-none"
            />
            <p className="mt-2 text-[10px] text-sf-text-muted leading-snug">
              Leave empty for a plain "improve [label]" prompt. Fill this in when you want the LLM to score the cut against a specific rubric (ABCD, your agency's playbook, a PDF framework you paste in, etc.).
            </p>
          </div>
        </div>

        <div className="flex-shrink-0 flex items-center justify-between gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <div className="flex items-center gap-2">
            {canReset && (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
                title="Restore the factory version of this preset"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset to default
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={onDelete}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-error/40 bg-sf-error/10 hover:bg-sf-error/20 text-sf-error transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete preset
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || !label.trim()}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${!dirty || !label.trim()
                  ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
            >
              {mode === 'create' ? <Plus className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              {mode === 'create' ? 'Create preset' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PresetEditorModal
