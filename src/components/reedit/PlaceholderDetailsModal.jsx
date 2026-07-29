import { useEffect, useState } from 'react'
import { X, ImagePlus, Loader2, Trash2, Film, CheckCircle2, AlertCircle, Wand2, RefreshCw } from 'lucide-react'
import {
  generateFrameForPlaceholder, generateFillForPlaceholder,
  captureSourceFrameForPlaceholder,
  LOCAL_PLACEHOLDER_I2V_MODELS, DEFAULT_PLACEHOLDER_I2V_MODEL,
} from '../../services/reeditGenerate'
import SourceFramePicker from './SourceFramePicker'
import { loadCapabilitySettings } from '../../services/reeditCapabilitySettings'
import {
  appendVideoVersion, setActiveVideoVersion, removeVideoVersion,
  videoVersionList, activeVideoVersionId,
} from '../../services/placeholderVersions'

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

export function formatTc(sec) {
  if (!Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

// Where to park the scrub playhead when the modal opens. The proposer
// already picked a reference shot + position for this placeholder, so
// start there — it's the frame the automatic path would have used, which
// makes the manual picker a nudge rather than a blind hunt. Mirrors
// resolveReferenceTcSec in reeditFills.js.
export function initialScrubTc(row, scenes) {
  const ref = row?.referenceFrame
  const scene = ref?.sourceSceneId
    ? (scenes || []).find((s) => s?.id === ref.sourceSceneId)
    : null
  if (!scene) return 0
  const tcIn = Number(scene.tcIn) || 0
  const tcOut = Number(scene.tcOut) || tcIn
  const dur = Math.max(0, tcOut - tcIn)
  const margin = Math.min(0.1, dur * 0.1)
  if (ref.framePosition === 'start') return tcIn + margin
  if (ref.framePosition === 'end') return Math.max(tcIn + margin, tcOut - margin)
  return tcIn + dur / 2
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
  const [grabState, setGrabState] = useState({ running: false })
  const [videoState, setVideoState] = useState({ running: false })
  const [error, setError] = useState(null)
  // Local i2v model picker. Seeded per-row from genSpec.preferredModelId
  // → Settings → Capabilities → default. Persisted onto genSpec on
  // change so the choice survives a modal close/reopen.
  const [modelId, setModelId] = useState(DEFAULT_PLACEHOLDER_I2V_MODEL)

  useEffect(() => {
    if (!isOpen) return
    // Start the editable prompt from whatever is stored in genSpec,
    // falling back to the EDL row's note so the user sees something
    // meaningful on the very first open.
    setPrompt(row?.genSpec?.prompt || row?.note || '')
    const stored = row?.genSpec?.preferredModelId
    const fromSettings = loadCapabilitySettings()?.footageGeneration?.model
    const seed = [stored, fromSettings, DEFAULT_PLACEHOLDER_I2V_MODEL]
      .find((v) => LOCAL_PLACEHOLDER_I2V_MODELS.some((m) => m.id === v))
    setModelId(seed || DEFAULT_PLACEHOLDER_I2V_MODEL)
    setFrameState({ running: false })
    setGrabState({ running: false })
    setVideoState({ running: false })
    setError(null)
  }, [isOpen, row?.genSpec?.prompt, row?.note, row?.genSpec?.preferredModelId])

  if (!isOpen || !row) return null

  const genSpec = row.genSpec || {}
  const candidates = Array.isArray(genSpec.frameCandidates) ? genSpec.frameCandidates : []
  const selectedFrameId = genSpec.selectedFrameId || null
  const selectedFrame = candidates.find((c) => c?.id === selectedFrameId) || null
  const hasVideo = Boolean(genSpec.generatedPath)
  // Video versions (migrated lazily from a legacy single generatedPath).
  const versions = videoVersionList(genSpec)
  const activeVersionId = activeVideoVersionId(genSpec)
  // Scrub playhead start: a previously grabbed frame's timecode wins, so
  // reopening the modal lands where the user left off; otherwise the
  // proposer's chosen reference point.
  const lastGrabbedTc = [...candidates].reverse().find((c) => Number.isFinite(c?.tcSec))?.tcSec
  const referenceTcSec = Number.isFinite(lastGrabbedTc)
    ? lastGrabbedTc
    : initialScrubTc(row, scenes)

  const patchGenSpec = (patch) => {
    onChange?.({ ...genSpec, ...patch })
  }

  const selectVersion = (id) => {
    const next = setActiveVideoVersion(genSpec, id)
    if (next) onChange?.(next)
  }

  const deleteVersion = (id) => {
    onChange?.(removeVideoVersion(genSpec, id))
  }

  const pickModel = (id) => {
    if (!LOCAL_PLACEHOLDER_I2V_MODELS.some((m) => m.id === id)) return
    setModelId(id)
    patchGenSpec({ preferredModelId: id })
  }

  // Persist a prompt edit on close even if the user never generated, so
  // the override isn't lost. Compare against the value we seeded the
  // textarea with to avoid spurious writes.
  const initialPrompt = genSpec.prompt ?? row.note ?? ''
  const handleClose = () => {
    if (prompt !== initialPrompt) patchGenSpec({ prompt })
    onClose?.()
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

  // Pull a frame out of the source video and add it to the same
  // candidate gallery, so stage 2 treats it exactly like a generated one.
  const captureSourceFrame = async (tcSec) => {
    if (grabState.running) return
    setError(null)
    setGrabState({ running: true })
    try {
      const candidate = await captureSourceFrameForPlaceholder({
        rowIndex,
        sourceVideo,
        tcSec,
        prompt,
      })
      patchGenSpec({
        frameCandidates: [...candidates, candidate],
        // A hand-picked frame is almost certainly the one they want to
        // animate, so select it outright rather than only when empty.
        selectedFrameId: candidate.id,
        prompt,
      })
      setGrabState({ running: false })
    } catch (err) {
      console.error('[reedit] source frame grab failed:', err)
      setError(err?.message || 'Could not grab that frame.')
      setGrabState({ running: false })
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
        modelId,
        onProgress: (info) => setVideoState({ running: true, ...info }),
      })
      // Append as a new version (keep prior renders) and make it active.
      // The selected first-frame id is snapshotted so the gallery can
      // show which frame each version animated.
      const { genSpec: nextGenSpec } = appendVideoVersion(genSpec, {
        ...result,
        prompt,
        frameId: selectedFrameId || undefined,
      })
      onChange?.({ ...nextGenSpec, prompt })
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
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose() }}
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

            {/* Or take the reference straight from the source video. Feeds
                the same gallery, so stage 2 doesn't care which way the
                frame arrived. */}
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted/80 mb-1.5">
                or pick a frame from the source video
              </div>
              <SourceFramePicker
                sourceVideo={sourceVideo}
                scenes={scenes}
                initialTcSec={referenceTcSec}
                busy={grabState.running}
                onCapture={captureSourceFrame}
              />
            </div>

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
                      {(c.seed != null || Number.isFinite(c.tcSec)) && (
                        <div className="absolute bottom-1 left-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white/90 text-[9px] font-mono truncate pointer-events-none">
                          {Number.isFinite(c.tcSec) ? `source @ ${formatTc(c.tcSec)}` : `seed ${c.seed}`}
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
              <div className="flex items-center gap-2">
                <select
                  value={modelId}
                  onChange={(e) => pickModel(e.target.value)}
                  disabled={videoState.running}
                  title="Which local i2v model to use for this placeholder"
                  className="bg-sf-dark-800 border border-sf-dark-700 text-sf-text-primary text-[11px] rounded px-2 py-1 focus:outline-none focus:border-sf-accent disabled:opacity-50"
                >
                  {LOCAL_PLACEHOLDER_I2V_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
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
            </div>

            {!selectedFrame && candidates.length === 0 && (
              <p className="text-xs text-sf-text-muted">Generate a first frame first.</p>
            )}
            {!selectedFrame && candidates.length > 0 && (
              <p className="text-xs text-sf-text-muted">Pick a frame from the gallery above.</p>
            )}

            {/* Version gallery — every "Generate video" run stacks a new
                version. Click one to make it active (the active version is
                what Apply drops on the timeline). */}
            {versions.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted mb-1.5">
                  Versions <span className="normal-case text-sf-text-muted/70">— click to activate · the active one lands on the timeline</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {versions.map((v, idx) => {
                    const isActive = v.id === activeVersionId
                    const url = buildComfyUrl(v.generatedPath, v.generatedAt)
                    return (
                      <div
                        key={v.id}
                        className={`relative group rounded-lg border overflow-hidden cursor-pointer transition-colors
                          ${isActive
                            ? 'border-emerald-400 ring-2 ring-emerald-400/40'
                            : 'border-sf-dark-700 hover:border-sf-dark-500'}`}
                        style={{ width: thumbWidth, height: thumbHeight }}
                        onClick={() => selectVersion(v.id)}
                        title={`v${idx + 1} · ${v.model || 'i2v'}\n${v.prompt || ''}`}
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
                          onClick={(e) => { e.stopPropagation(); deleteVersion(v.id) }}
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

export default PlaceholderDetailsModal
