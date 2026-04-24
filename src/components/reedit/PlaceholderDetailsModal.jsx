import { useEffect, useState } from 'react'
import { X, ImagePlus, Loader2, Trash2, Film, CheckCircle2, AlertCircle, Wand2, RefreshCw } from 'lucide-react'
import { generateFrameForPlaceholder, generateFillForPlaceholder } from '../../services/reeditGenerate'

/**
 * Two-stage generation workspace for a single placeholder row.
 *
 *   Stage 1 — frame candidates: pressing "Generate first frame" kicks
 *   off a Z Image Turbo t2i run keyed on the placeholder's prompt.
 *   Each run stacks a new candidate in `genSpec.frameCandidates`. The
 *   user can generate many, browse the gallery, and pick the one that
 *   best matches the shot they want. Cheap iteration loop.
 *
 *   Stage 2 — video from selected frame: once a candidate is picked,
 *   "Generate video" runs the LTX 2.3 i2v workflow using that exact
 *   frame as the reference image (instead of the legacy fallback,
 *   which just grabbed the nearest surrounding scene's thumbnail).
 *   The result lands in `genSpec.generatedPath` and the populator
 *   swaps it onto the timeline on next Apply.
 *
 * The modal never saves the project itself — it calls `onChange` with
 * the next `genSpec` and ProposalView persists in its usual flow.
 */

function buildComfyUrl(filePath, version) {
  if (!filePath) return null
  const base = `comfystudio://${encodeURIComponent(filePath)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

function PlaceholderDetailsModal({
  isOpen,
  row,
  rowIndex,
  edl,
  scenes,
  sourceVideo,
  onClose,
  onChange,
}) {
  const [prompt, setPrompt] = useState('')
  const [frameState, setFrameState] = useState({ running: false })
  const [videoState, setVideoState] = useState({ running: false })
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    // Start the editable prompt from whatever is stored in genSpec,
    // falling back to the EDL row's note so the user sees something
    // meaningful on the very first open.
    setPrompt(row?.genSpec?.prompt || row?.note || '')
    setFrameState({ running: false })
    setVideoState({ running: false })
    setError(null)
  }, [isOpen, row?.genSpec?.prompt, row?.note])

  if (!isOpen || !row) return null

  const genSpec = row.genSpec || {}
  const candidates = Array.isArray(genSpec.frameCandidates) ? genSpec.frameCandidates : []
  const selectedFrameId = genSpec.selectedFrameId || null
  const selectedFrame = candidates.find((c) => c?.id === selectedFrameId) || null
  const hasVideo = Boolean(genSpec.generatedPath)

  const patchGenSpec = (patch) => {
    onChange?.({ ...genSpec, ...patch })
  }

  const generateFrame = async () => {
    if (frameState.running) return
    setError(null)
    setFrameState({ running: true, stage: 'load_workflow' })
    try {
      const candidate = await generateFrameForPlaceholder({
        row,
        rowIndex,
        sourceVideo,
        prompt,
        onProgress: (info) => setFrameState({ running: true, ...info }),
      })
      const nextCandidates = [...candidates, candidate]
      patchGenSpec({
        frameCandidates: nextCandidates,
        // Auto-select first candidate so the video button is
        // immediately actionable; subsequent generations leave the
        // selection alone so the user isn't yanked off their pick.
        selectedFrameId: selectedFrameId || candidate.id,
        prompt,
      })
      setFrameState({ running: false, done: true })
    } catch (err) {
      console.error('[reedit] frame generation failed:', err)
      setError(err?.message || 'Frame generation failed.')
      setFrameState({ running: false })
    }
  }

  const selectFrame = (id) => {
    patchGenSpec({ selectedFrameId: id })
  }

  const deleteFrame = (id) => {
    const nextCandidates = candidates.filter((c) => c.id !== id)
    patchGenSpec({
      frameCandidates: nextCandidates,
      selectedFrameId: selectedFrameId === id
        ? (nextCandidates[0]?.id || null)
        : selectedFrameId,
    })
  }

  const generateVideo = async () => {
    if (videoState.running || !selectedFrame) return
    setError(null)
    setVideoState({ running: true, stage: 'upload_ref' })
    try {
      const result = await generateFillForPlaceholder({
        row: { ...row, genSpec: { ...genSpec, prompt } },
        rowIndex,
        edl,
        scenes,
        sourceVideo,
        onProgress: (info) => setVideoState({ running: true, ...info }),
      })
      patchGenSpec({ ...result, prompt })
      setVideoState({ running: false, done: true })
    } catch (err) {
      console.error('[reedit] video generation failed:', err)
      setError(err?.message || 'Video generation failed.')
      setVideoState({ running: false })
    }
  }

  const stageLabel = (s) => {
    if (!s?.running) return ''
    if (s.stage === 'load_workflow') return 'Loading workflow…'
    if (s.stage === 'queue_workflow') return 'Queuing…'
    if (s.stage === 'upload_ref') return 'Uploading ref…'
    if (s.stage === 'generating') {
      if (s.step != null && s.maxSteps) return `Generating ${s.step}/${s.maxSteps}…`
      return 'Generating…'
    }
    if (s.stage === 'executing') return 'Running graph…'
    if (s.stage === 'download') return 'Downloading…'
    if (s.stage === 'saving') return 'Saving…'
    return 'Running…'
  }

  // Keep thumb aspect aligned with the source video.
  const aspectRatio = (sourceVideo?.width && sourceVideo?.height)
    ? sourceVideo.width / sourceVideo.height
    : 16 / 9
  const thumbWidth = aspectRatio >= 1 ? 180 : Math.round(140 * aspectRatio)
  const thumbHeight = aspectRatio >= 1 ? Math.round(180 / aspectRatio) : 140

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <div>
            <h2 className="text-sm font-semibold text-sf-text-primary">
              Placeholder #{row.index} — generate fill
            </h2>
            <p className="text-[10px] text-sf-text-muted mt-0.5">
              {candidates.length} frame{candidates.length === 1 ? '' : 's'}
              {selectedFrame ? ` · selected ${selectedFrame.id.split('-').slice(-1)[0].slice(0, 6)}` : ''}
              {hasVideo ? ' · video ready' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {/* Prompt */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
              Prompt <span className="text-sf-text-muted/70 normal-case">(used for frame + video generation)</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
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

          {/* Stage 1: frame candidates */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] uppercase tracking-wider text-sf-text-muted">1 — First-frame candidates</h3>
              <button
                type="button"
                onClick={generateFrame}
                disabled={frameState.running || !prompt.trim()}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                  ${frameState.running || !prompt.trim()
                    ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                    : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
              >
                {frameState.running
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <ImagePlus className="w-3.5 h-3.5" />}
                {frameState.running
                  ? (stageLabel(frameState) || 'Generating…')
                  : (candidates.length > 0 ? 'Generate another frame' : 'Generate first frame')}
              </button>
            </div>

            {candidates.length === 0 && !frameState.running && (
              <p className="text-xs text-sf-text-muted">
                Click "Generate first frame" to get a candidate. Run it multiple times to build up a gallery, then pick the one you want the video to animate.
              </p>
            )}

            {candidates.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {candidates.map((c) => {
                  const isSelected = c.id === selectedFrameId
                  const url = buildComfyUrl(c.path, c.createdAt)
                  return (
                    <div
                      key={c.id}
                      className={`relative group rounded-lg border overflow-hidden transition-colors cursor-pointer
                        ${isSelected
                          ? 'border-sf-accent ring-2 ring-sf-accent/40'
                          : 'border-sf-dark-700 hover:border-sf-dark-500'}`}
                      style={{ width: thumbWidth, height: thumbHeight }}
                      onClick={() => selectFrame(c.id)}
                      title={`seed ${c.seed ?? '?'}\n${c.prompt || ''}`}
                    >
                      {url ? (
                        <img src={url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">no img</div>
                      )}
                      {isSelected && (
                        <div className="absolute top-1 left-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sf-accent text-white text-[9px] font-semibold uppercase tracking-wider">
                          <CheckCircle2 className="w-3 h-3" />
                          Selected
                        </div>
                      )}
                      {c.seed != null && (
                        <div className="absolute bottom-1 left-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[9px] font-mono truncate pointer-events-none">
                          seed {c.seed}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteFrame(c.id) }}
                        className="absolute top-1 right-1 p-1 rounded bg-sf-dark-900/90 hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete candidate"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Stage 2: video */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] uppercase tracking-wider text-sf-text-muted">2 — Video from selected frame</h3>
              <button
                type="button"
                onClick={generateVideo}
                disabled={videoState.running || !selectedFrame}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                  ${videoState.running
                    ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                    : !selectedFrame
                      ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                      : hasVideo
                        ? 'border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'
                        : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
              >
                {videoState.running
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : hasVideo
                    ? <RefreshCw className="w-3.5 h-3.5" />
                    : <Film className="w-3.5 h-3.5" />}
                {videoState.running
                  ? (stageLabel(videoState) || 'Generating…')
                  : hasVideo
                    ? 'Re-generate video'
                    : 'Generate video'}
              </button>
            </div>

            {!selectedFrame && candidates.length === 0 && (
              <p className="text-xs text-sf-text-muted">Generate a first frame first.</p>
            )}
            {!selectedFrame && candidates.length > 0 && (
              <p className="text-xs text-sf-text-muted">Pick a frame from the gallery above.</p>
            )}

            {hasVideo && (
              <div className="mt-2 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-xs text-emerald-200">
                <div className="flex items-center gap-2 mb-1">
                  <Wand2 className="w-3.5 h-3.5" />
                  <span className="font-medium">Video ready</span>
                </div>
                <div className="text-[10px] font-mono text-emerald-200/80 break-all">{genSpec.generatedPath}</div>
                <div className="text-[10px] text-emerald-200/70 mt-1">
                  Re-Apply to timeline in Proposal to materialize it as a real clip.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-sf-accent hover:bg-sf-accent-hover text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export default PlaceholderDetailsModal
