/**
 * project:re-edit — OptimizeFootageCell.
 *
 * Per-scene control surface for the "remove on-screen graphics" pass
 * (Wan VACE inpainting). Originally lived inline inside AnalysisView;
 * lifted out so the new Optimization tab can render the same UI without
 * a circular import.
 *
 * Inputs:
 *   - scene             — { id, videoAnalysis, optimizations[], activeOptimizationVersion }
 *   - state             — transient run state from the parent's runner
 *                         ({ stage, error, elapsedSec })
 *   - previewState      — same shape, for the mask-only preview button
 *   - onRun             — () => parent kicks off optimizeFootage IPC
 *   - onPreview         — () => parent kicks off the mask-only preview
 *   - onSetActiveVersion — (sceneId, version) => parent persists the swap
 *   - disabled          — bool, parent gates the row when ComfyUI is busy
 */

import { Loader2, AlertCircle, CheckCircle2, RotateCcw, Wand2 } from 'lucide-react'

export function shotHasGraphics(scene) {
  const g = scene?.videoAnalysis?.graphics
  if (!g) return false
  if (g.has_text_on_screen || g.text_content) return true
  if (g.has_logo || g.logo_description) return true
  if (g.other_graphics) return true
  return false
}

// Human-readable labels for the progress stages emitted by main.js.
// Kept short so the cell stays narrow when rendered as a table column.
export const OPTIMIZE_STAGE_LABEL = {
  starting: 'Starting…',
  generating_mask: 'Masking…',
  mask_log: 'Masking…',
  uploading: 'Uploading…',
  queued_submit: 'Submitting…',
  queued: 'Queued',
  running: 'Generating…',
  poll_warn: 'Generating…',
  compositing: 'Compositing…',
  note: null,
  done: 'Done',
  error: 'Failed',
}

export default function OptimizeFootageCell({ scene, state, onRun, disabled, previewState, onPreview, onSetActiveVersion }) {
  if (!shotHasGraphics(scene)) {
    return <span className="text-sf-text-muted text-[10px] italic">—</span>
  }

  const stage = state?.stage
  const running = stage && !['done', 'error'].includes(stage)
  const label = OPTIMIZE_STAGE_LABEL[stage] || (stage ? stage : 'Optimize')
  const previewRunning = previewState?.stage === 'running'

  const stack = Array.isArray(scene.optimizations) ? scene.optimizations : []
  const hasHistory = stack.length > 0
  const active = scene.activeOptimizationVersion || null
  const activeEntry = active ? stack.find((o) => o.version === active) : null

  const versionDropdown = hasHistory ? (
    <select
      value={active || ''}
      onChange={(e) => onSetActiveVersion?.(scene.id, e.target.value || null)}
      className="text-[10px] bg-sf-dark-900 border border-sf-dark-700 rounded px-1 py-0.5 text-sf-text-secondary hover:border-sf-dark-500 focus:outline-none focus:border-sf-accent"
      title="Switch which clip the rest of the pipeline uses for this shot"
    >
      <option value="">Original</option>
      {stack.map((o) => {
        const kindHint = o.kind === 'reframe' || /^R/i.test(String(o.version))
          ? 'reframe'
          : 'graphics removed'
        return (
          <option key={o.version} value={o.version}>
            {o.version} — {kindHint}
          </option>
        )
      })}
    </select>
  ) : null

  const previewButton = (
    <button
      type="button"
      onClick={onPreview}
      disabled={disabled || previewRunning || running}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors
        ${(disabled || previewRunning || running)
          ? 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted/60 cursor-not-allowed'
          : 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-secondary hover:text-sf-text-primary hover:border-sf-accent/60'}`}
      title="Regenerate the mask (make_mask.py). Skips VACE + composite. Opens the mask folder when done."
    >
      {previewRunning ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <RotateCcw className="w-3 h-3" />
      )}
      {previewRunning ? 'Regenerating…' : 'Regenerate mask'}
    </button>
  )

  if (stage === 'error') {
    return (
      <div className="flex flex-col gap-1">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-sf-error" title={state?.error}>
          <AlertCircle className="w-3.5 h-3.5" />
          <span className="truncate">Failed</span>
        </div>
        {state?.error && (
          <div className="text-[10px] text-sf-error/80 leading-snug break-words">{state.error}</div>
        )}
        <button
          type="button"
          onClick={onRun}
          className="text-[10px] text-sf-accent hover:underline text-left"
        >
          Retry
        </button>
        {previewButton}
      </div>
    )
  }

  if (running) {
    const elapsed = state?.elapsedSec
    return (
      <div className="flex flex-col gap-1">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-sf-text-secondary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{label}{elapsed ? ` · ${elapsed}s` : ''}</span>
        </div>
        {previewButton}
      </div>
    )
  }

  if (hasHistory) {
    return (
      <div className="flex flex-col gap-1">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>
            {active ? `Active: ${active}` : 'Active: Original'}
          </span>
        </div>
        <div className="inline-flex items-center gap-1.5">
          <span className="text-[10px] text-sf-text-muted">Version:</span>
          {versionDropdown}
        </div>
        {activeEntry?.path && (
          <button
            type="button"
            onClick={() => window.electronAPI?.showItemInFolder?.(activeEntry.path)}
            className="text-[10px] text-sf-accent hover:underline text-left truncate"
            title={activeEntry.path}
          >
            Reveal active
          </button>
        )}
        <button
          type="button"
          onClick={onRun}
          className="text-[10px] text-sf-text-muted hover:text-sf-text-primary text-left"
        >
          Generate new version
        </button>
        {previewButton}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onRun}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-colors
          ${disabled
            ? 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted/60 cursor-not-allowed'
            : 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-primary hover:border-sf-accent/60'}`}
        title="Remove on-screen text / logos with Wan VACE"
      >
        <Wand2 className="w-3.5 h-3.5" />
        Optimize
      </button>
      {previewButton}
      {previewState?.stage === 'error' && previewState.error && (
        <div className="text-[10px] text-sf-error/80 leading-snug break-words">{previewState.error}</div>
      )}
    </div>
  )
}
