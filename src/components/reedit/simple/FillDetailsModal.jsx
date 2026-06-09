import { useEffect, useState } from 'react'
import { X, Loader2, Trash2, Film, CheckCircle2, AlertCircle, Wand2, RefreshCw } from 'lucide-react'
import { FILL_MODELS } from '../../../services/reeditFills'
import { fillVersionList, activeFillVersionId } from '../../../services/placeholderVersions'

/**
 * Prompt + versions workspace for a single placeholder fill in the
 * Simple / Auto flow (cloud i2v via reeditFills.js → project.fills[pid]).
 *
 * Unlike Advanced's PlaceholderDetailsModal (two-stage frame→video on
 * local Comfy), this is single-stage: edit the prompt, pick a model,
 * Generate. Every render stacks a version; the gallery lets the user
 * pick which one is active (lands on the timeline).
 *
 * The modal owns no project state — it edits a local `prompt` and calls
 * back to ProposalViewSimple to persist (`onSavePrompt`), generate
 * (`onGenerate`), switch (`onSwitchVersion`) and delete (`onDeleteVersion`).
 */

function buildComfyUrl(filePath, version) {
  if (!filePath) return null
  const base = `comfystudio://${encodeURIComponent(filePath)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

export default function FillDetailsModal({
  isOpen,
  row,
  fill,
  modelId,
  busy = false,
  error = null,
  canGenerate = true,
  sourceVideo,
  onPickModel,
  onSavePrompt,
  onGenerate,
  onSwitchVersion,
  onDeleteVersion,
  onClose,
}) {
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setPrompt(row?.fillPrompt ?? row?.note ?? '')
  }, [isOpen, row?.fillPrompt, row?.note])

  if (!isOpen || !row) return null

  const versions = fillVersionList(fill)
  const activeId = activeFillVersionId(fill)
  const hasVideo = versions.length > 0
  const initialPrompt = row?.fillPrompt ?? row?.note ?? ''

  const persistPrompt = () => {
    if (prompt !== initialPrompt) onSavePrompt?.(prompt)
  }
  const handleClose = () => { persistPrompt(); onClose?.() }
  const handleGenerate = () => {
    persistPrompt()
    onGenerate?.(prompt)
  }

  const aspectRatio = (sourceVideo?.width && sourceVideo?.height)
    ? sourceVideo.width / sourceVideo.height
    : 16 / 9
  const thumbWidth = aspectRatio >= 1 ? 180 : Math.round(140 * aspectRatio)
  const thumbHeight = aspectRatio >= 1 ? Math.round(180 / aspectRatio) : 140

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <div>
            <h2 className="text-sm font-semibold text-sf-text-primary">
              Shot #{(row.index ?? 0) + 1} — generate fill
            </h2>
            <p className="text-[10px] text-sf-text-muted mt-0.5">
              {versions.length} version{versions.length === 1 ? '' : 's'}
              {hasVideo ? ' · video ready' : ' · not generated yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {/* Prompt */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
              Prompt <span className="text-sf-text-muted/70 normal-case">(overrides the proposer note for generation)</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={persistPrompt}
              rows={3}
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent resize-none"
              placeholder="Concrete director's instruction for the fill shot."
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded border border-sf-error/40 bg-sf-error/10 text-xs text-sf-error">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Model + generate */}
          <div>
            <div className="flex items-center justify-between mb-2 gap-2">
              <h3 className="text-[11px] uppercase tracking-wider text-sf-text-muted">Generator</h3>
              <div className="flex items-center gap-2">
                <select
                  value={modelId}
                  onChange={(e) => onPickModel?.(e.target.value)}
                  disabled={busy}
                  title={FILL_MODELS.find((m) => m.id === modelId)?.blurb || ''}
                  className="bg-sf-dark-800 border border-sf-dark-700 text-sf-text-primary text-[11px] rounded px-2 py-1 focus:outline-none focus:border-sf-accent disabled:opacity-50"
                >
                  {FILL_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleGenerate}
                  disabled={busy || !canGenerate || !prompt.trim()}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                    ${busy || !canGenerate || !prompt.trim()
                      ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                      : 'bg-fuchsia-600 hover:bg-fuchsia-500 text-white'}`}
                >
                  {busy
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : hasVideo
                      ? <RefreshCw className="w-3.5 h-3.5" />
                      : <Film className="w-3.5 h-3.5" />}
                  {busy ? 'Generating…' : hasVideo ? 'Re-generate' : 'Generate'}
                </button>
              </div>
            </div>
            {!canGenerate && (
              <p className="text-xs text-sf-text-muted">
                This placeholder has no reference frame — re-generate the proposal so the LLM picks one.
              </p>
            )}
          </div>

          {/* Versions */}
          {versions.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-sf-text-muted mb-1.5">
                Versions <span className="normal-case text-sf-text-muted/70">— click to activate · the active one lands on the timeline</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {versions.map((v, idx) => {
                  const isActive = v.id === activeId
                  const url = buildComfyUrl(v.path, v.createdAt)
                  return (
                    <div
                      key={v.id}
                      className={`relative group rounded-lg border overflow-hidden cursor-pointer transition-colors
                        ${isActive
                          ? 'border-emerald-400 ring-2 ring-emerald-400/40'
                          : 'border-sf-dark-700 hover:border-sf-dark-500'}`}
                      style={{ width: thumbWidth, height: thumbHeight }}
                      onClick={() => onSwitchVersion?.(v.id)}
                      title={`v${idx + 1} · ${v.modelId || 'i2v'}\n${v.promptSnapshot || ''}`}
                    >
                      {url ? (
                        <video src={url} muted preload="metadata" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">no video</div>
                      )}
                      <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-semibold">v{idx + 1}</div>
                      {isActive && (
                        <div className="absolute bottom-1 left-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500 text-white text-[9px] font-semibold uppercase tracking-wider">
                          <CheckCircle2 className="w-3 h-3" /> Active
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDeleteVersion?.(v.id) }}
                        className="absolute top-1 right-1 p-1 rounded bg-sf-dark-900/90 hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete this version"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!hasVideo && (
            <div className="flex items-center gap-2 text-xs text-sf-text-muted">
              <Wand2 className="w-3.5 h-3.5 text-fuchsia-400" />
              <span>Tweak the prompt and hit Generate — each run is saved as a version you can switch between.</span>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-md text-xs bg-sf-accent hover:bg-sf-accent-hover text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
