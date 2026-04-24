import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, Save, RotateCcw,
  ArrowUp, ArrowDown, Trash2, CheckCircle2, Film, Wand2, Eye, EyeOff,
  Pencil, Plus, Cpu, KeyRound, ExternalLink, Video, Image as ImageIcon,
} from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { generateProposal } from '../../services/reeditProposer'
import { applyEdlToTimeline, buildPlaceholderSvgDataUrl } from '../../services/reeditEdlToTimeline'
import { generateFillForPlaceholder, sendPlaceholderWorkflowToComfyUI } from '../../services/reeditGenerate'
import { useReeditPresets } from '../../hooks/useReeditPresets'
import { useLlmSettings } from '../../hooks/useLlmSettings'
import { LLM_BACKENDS, BACKEND_LABELS, ANTHROPIC_MODELS } from '../../services/reeditLlmClient'
import {
  loadCapabilities as loadProposalCapabilities,
  saveCapabilities as saveProposalCapabilities,
  CAPABILITY_DEFINITIONS,
} from '../../services/reeditProposalCapabilities'
import PresetEditorModal from './PresetEditorModal'
import LlmSettingsModal from './LlmSettingsModal'
import SendToComfyModal from './SendToComfyModal'
import PlaceholderDetailsModal from './PlaceholderDetailsModal'

// Shared with AnalysisView: fixed row height, aspect-derived width.
const THUMB_HEIGHT = 100
const PREVIEW_LONG_EDGE = 420

function toComfyUrl(filePath, version) {
  if (!filePath) return null
  const base = `comfystudio://${encodeURIComponent(filePath)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

function formatTc(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// After any edit that changes row order or count, walk the EDL and
// push each row's newTcIn / newTcOut so they sit flush against the
// previous row. Durations are preserved; row numbering resets.
function recomputeTcContiguous(edl) {
  let cursor = 0
  return (edl || []).map((row, i) => {
    const dur = Math.max(0.1, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0))
    const out = cursor + dur
    const result = { ...row, index: i + 1, newTcIn: cursor, newTcOut: out }
    cursor = out
    return result
  })
}

function PrereqPrompt({ children }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-sf-dark-950 text-sf-text-primary p-8">
      <div className="max-w-md text-center text-sm text-sf-text-muted">{children}</div>
    </div>
  )
}

function KindBadge({ kind }) {
  const isPlaceholder = kind === 'placeholder'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap
      ${isPlaceholder
        ? 'bg-amber-500/10 text-amber-200 border-amber-500/30'
        : 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30'}`}>
      {isPlaceholder ? 'NEW' : 'original'}
    </span>
  )
}

function ProposalView({ onNavigate }) {
  const currentProject = useProjectStore((s) => s.currentProject)
  const saveProject = useProjectStore((s) => s.saveProject)
  const {
    presets,
    updatePreset,
    createPreset,
    deletePreset,
    resetPreset,
    isBuiltinDefault,
  } = useReeditPresets()

  const sourceVideo = currentProject?.sourceVideo
  const analysis = currentProject?.analysis
  const scenes = analysis?.scenes || []
  const savedProposal = currentProject?.proposal || null

  // Preset editor modal state: null = closed, { mode: 'edit' | 'create', id? }
  const [presetEditor, setPresetEditor] = useState(null)
  const [llmModalOpen, setLlmModalOpen] = useState(false)
  const { settings: llmSettings, update: updateLlmSettings } = useLlmSettings()

  // After a successful "Send to ComfyUI" we pop this modal with
  // step-by-step instructions — the Ctrl+V step was getting missed
  // when it was just a one-line inline message.
  const [comfyHandoff, setComfyHandoff] = useState(null)
  // Index of the placeholder row the user opened for frame + video
  // generation (the two-stage i2v workflow). null when closed.
  const [placeholderDetails, setPlaceholderDetails] = useState(null)

  // Hover preview state for EDL row thumbnails — mirrors AnalysisView.
  const [hover, setHover] = useState(null) // { url, rect, previewW, previewH }

  // Re-sync local draft state whenever the project's source video
  // changes (user imported a different video) OR the saved proposal
  // is cleared. Without this the React useState initializer runs only
  // once — a stale draft from the previous video would otherwise
  // render against the new analysis, and the scene-N lookups would
  // resolve to whatever scene-N means in the CURRENT analysis (new
  // thumbs + new captions) even though the draft's rationale + EDL
  // structure is from the old video. Tying the reset to sourceVideo
  // path + proposal createdAt covers both "new import" and "manual
  // proposal clear" without clobbering in-progress edits during a
  // single session.
  const projectIdentity = (currentProject?.sourceVideo?.path || '') + '|' + (savedProposal?.createdAt || '')
  useEffect(() => {
    setDraft(savedProposal)
    setBrandBrief(savedProposal?.brandBrief || '')
    setExtraInstructions(savedProposal?.extraInstructions || '')
    setMetric(savedProposal?.metric || 'Comprehension')
    setTargetDurationSec(savedProposal?.targetDurationSec || sourceVideo?.duration || 30)
    setUseGeneratedVideos(savedProposal?.useGeneratedVideos !== false)
    setApplyResult(null)
    setError(null)
    setGenState({})
    setHover(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdentity])

  // Source video aspect drives thumb width. When sourceVideo has no
  // dimensions yet (first-run edge case), default to 16:9 so we still
  // render something reasonable instead of a 0-width cell.
  const aspectRatio = (sourceVideo?.width && sourceVideo?.height)
    ? sourceVideo.width / sourceVideo.height
    : 16 / 9
  const isVertical = aspectRatio < 1
  const thumbW = Math.max(40, Math.round(THUMB_HEIGHT * aspectRatio))
  const previewH = isVertical ? PREVIEW_LONG_EDGE : Math.round(PREVIEW_LONG_EDGE / aspectRatio)
  const previewW = isVertical ? Math.round(PREVIEW_LONG_EDGE * aspectRatio) : PREVIEW_LONG_EDGE

  // Local draft copy. Includes the whole proposal envelope (rationale,
  // edl, metric, model). Inputs (brandBrief, metric) reflect the
  // last-used values so Re-generate doesn't silently pick up stale
  // choices from a previous session.
  const [draft, setDraft] = useState(savedProposal)
  const [brandBrief, setBrandBrief] = useState(savedProposal?.brandBrief || '')
  const [extraInstructions, setExtraInstructions] = useState(savedProposal?.extraInstructions || '')
  const [metric, setMetric] = useState(savedProposal?.metric || 'Comprehension')
  // Target duration for the re-edited video. Defaults to whatever was
  // saved with the last proposal, falling back to the source video's
  // own length so "leave it alone" is the no-op default.
  const [targetDurationSec, setTargetDurationSec] = useState(
    savedProposal?.targetDurationSec || sourceVideo?.duration || 30
  )
  // Master toggle: when off, the timeline populator skips any
  // genSpec.generatedPath and falls back to the selected frame still
  // for placeholder rows. Lets the user A/B the i2v output against
  // the frame candidates without losing either. Default on so legacy
  // proposals still apply unchanged.
  const [useGeneratedVideos, setUseGeneratedVideos] = useState(
    savedProposal?.useGeneratedVideos !== false
  )
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)

  // Capability flags — global (localStorage), default all false per
  // the design conversation. Kept in local state so toggling repaints
  // instantly; the helper broadcasts changes so other mounted views
  // can mirror without a reload.
  const [capabilities, setCapabilities] = useState(() => loadProposalCapabilities())
  useEffect(() => {
    const onChange = (e) => setCapabilities(e.detail || loadProposalCapabilities())
    window.addEventListener('reedit-proposal-capabilities-changed', onChange)
    return () => window.removeEventListener('reedit-proposal-capabilities-changed', onChange)
  }, [])
  const toggleCapability = (id) => {
    const next = saveProposalCapabilities({ [id]: !capabilities[id] })
    setCapabilities(next)
  }

  const [applying, setApplying] = useState(false)
  const [applyProgress, setApplyProgress] = useState({ current: 0, total: 0 })
  const [applyResult, setApplyResult] = useState(null)

  // Per-row generation state: { [rowIndex]: { running, stage, progress, error } }
  const [genState, setGenState] = useState({})

  const sceneById = useMemo(() => {
    const map = new Map()
    for (const s of scenes) map.set(s.id, s)
    return map
  }, [scenes])

  if (!sourceVideo) {
    return <PrereqPrompt>Import a video first in the <span className="text-sf-text-primary">Import</span> tab.</PrereqPrompt>
  }
  if (!scenes.length) {
    return <PrereqPrompt>Run scene detection in the <span className="text-sf-text-primary">Analysis</span> tab before drafting a proposal.</PrereqPrompt>
  }
  const hasCaptions = scenes.some((s) => s.caption || s.structured)
  if (!hasCaptions) {
    return <PrereqPrompt>Run <span className="text-sf-text-primary">Caption all</span> in Analysis first — the LLM needs scene descriptions to reason about the edit.</PrereqPrompt>
  }

  const runGenerate = async () => {
    if (generating) return
    setGenerating(true)
    setError(null)
    setApplyResult(null)
    try {
      // Pass criteria from the presets layer (which may be a
      // user-edited or custom preset) rather than letting the proposer
      // fall back to the factory PROPOSAL_METRICS copy.
      const selected = presets.find((p) => p.id === metric) || presets[0]
      const proposal = await generateProposal({
        scenes,
        brandBrief,
        extraInstructions,
        metric: selected?.label || metric,
        criteria: selected?.criteria || '',
        totalDurationSec: sourceVideo.duration || null,
        targetDurationSec,
        capabilities,
        sourceVideoPath: sourceVideo?.path || null,
      })
      setDraft(proposal)
    } catch (err) {
      console.error('[reedit] proposal generation failed:', err)
      setError(err?.message || 'Proposal generation failed.')
    } finally {
      setGenerating(false)
    }
  }

  // Preset editor handlers. All three mutate via the hook, which
  // persists to localStorage; the modal closes after each action.
  const handleOpenEditPreset = (preset) => setPresetEditor({ mode: 'edit', id: preset.id })
  const handleOpenCreatePreset = () => setPresetEditor({ mode: 'create' })
  const closePresetEditor = () => setPresetEditor(null)
  const handleSavePreset = (patch) => {
    if (!presetEditor) return
    if (presetEditor.mode === 'create') {
      const created = createPreset(patch)
      setMetric(created.id)
    } else {
      updatePreset(presetEditor.id, patch)
    }
    closePresetEditor()
  }
  const handleDeletePreset = () => {
    if (!presetEditor?.id) return
    // If the currently-selected metric is about to vanish, fall back
    // to the first preset so the user isn't left with an orphan id.
    const fallback = presets.find((p) => p.id !== presetEditor.id)
    if (metric === presetEditor.id && fallback) setMetric(fallback.id)
    deletePreset(presetEditor.id)
    closePresetEditor()
  }
  const handleResetPreset = () => {
    if (!presetEditor?.id) return
    resetPreset(presetEditor.id)
    closePresetEditor()
  }

  const mutateDraftEdl = (updater) => {
    setDraft((prev) => {
      if (!prev) return prev
      const nextEdl = recomputeTcContiguous(updater(prev.edl || []))
      return { ...prev, edl: nextEdl }
    })
  }
  const moveUp = (i) => {
    if (i <= 0) return
    mutateDraftEdl((edl) => {
      const next = [...edl]
      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
      return next
    })
  }
  const moveDown = (i) => {
    mutateDraftEdl((edl) => {
      if (i >= edl.length - 1) return edl
      const next = [...edl]
      ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
      return next
    })
  }
  const removeRow = (i) => {
    mutateDraftEdl((edl) => edl.filter((_, idx) => idx !== i))
  }
  const updateNote = (i, note) => {
    // Note edits don't change TC or order, so skip recompute.
    setDraft((prev) => {
      if (!prev) return prev
      const next = [...(prev.edl || [])]
      if (!next[i]) return prev
      next[i] = { ...next[i], note }
      return { ...prev, edl: next }
    })
  }
  // Toggle a row out of the Apply-to-timeline pass without deleting
  // it. Lets the user A/B different subsets without re-generating
  // the whole proposal. Exclusion doesn't shift timecodes — that
  // happens when Apply packs the included rows flush from zero.
  const toggleRowExcluded = (i) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = [...(prev.edl || [])]
      if (!next[i]) return prev
      next[i] = { ...next[i], excluded: !next[i].excluded }
      return { ...prev, edl: next }
    })
  }
  const updateRationale = (rationale) => {
    setDraft((prev) => (prev ? { ...prev, rationale } : prev))
  }

  const saveDraft = async () => {
    if (!draft) return
    await saveProject({ proposal: { ...draft, brandBrief, metric, useGeneratedVideos, status: 'draft' } })
  }

  const discardDraft = () => {
    setDraft(savedProposal)
    setBrandBrief(savedProposal?.brandBrief || '')
    setExtraInstructions(savedProposal?.extraInstructions || '')
    setMetric(savedProposal?.metric || 'Comprehension')
    setTargetDurationSec(savedProposal?.targetDurationSec || sourceVideo?.duration || 30)
    setError(null)
    setApplyResult(null)
  }

  const applyToTimeline = async () => {
    if (!draft || applying) return
    setApplying(true)
    setError(null)
    setApplyProgress({ current: 0, total: draft.edl?.length || 0 })
    try {
      const result = await applyEdlToTimeline({
        edl: draft.edl,
        scenes,
        sourceVideo,
        useGeneratedVideos,
        // Live capabilities from the toggles, not `draft.capabilities`
        // frozen at generation time — the user may have toggled stems
        // on/off after the proposal was drafted and we want Apply to
        // honour the current intent, not the historical one.
        capabilities,
        onProgress: ({ index, total }) => {
          setApplyProgress({ current: index, total })
        },
      })
      await saveProject({
        proposal: {
          ...draft,
          brandBrief,
          metric,
          useGeneratedVideos,
          status: 'approved',
          appliedAt: new Date().toISOString(),
        },
      })
      setApplyResult(result)
      // Give the user a second to read the result badge, then jump to
      // the Editor. onNavigate is optional so the view still works if
      // App.jsx hasn't wired it yet.
      setTimeout(() => onNavigate?.('editor'), 700)
    } catch (err) {
      console.error('[reedit] apply to timeline failed:', err)
      setError(err?.message || 'Apply failed.')
    } finally {
      setApplying(false)
    }
  }

  // Build the LTX workflow for this placeholder (uploads ref frame
   // and patches params, no queue) then copy to clipboard + save to
   // disk + open ComfyUI. Lets the user inspect/tweak the graph
   // before committing to a generation run.
  const sendToComfy = async (i) => {
    if (!draft || genState[i]?.running) return
    setGenState((prev) => ({ ...prev, [i]: { running: true, stage: 'upload_ref', inspect: true, error: null } }))
    try {
      const result = await sendPlaceholderWorkflowToComfyUI({
        row: draft.edl[i],
        rowIndex: i,
        edl: draft.edl,
        scenes,
        sourceVideo,
        onProgress: (info) => {
          setGenState((prev) => ({ ...prev, [i]: { running: true, inspect: true, ...info } }))
        },
      })
      setComfyHandoff(result)
      setGenState((prev) => ({
        ...prev,
        [i]: { running: false, inspectReady: true, message: 'Opened ComfyUI — see the dialog for the paste step.' },
      }))
    } catch (err) {
      console.error('[reedit] send to comfy failed:', err)
      setGenState((prev) => ({ ...prev, [i]: { running: false, error: err?.message || 'Send failed.' } }))
    }
  }

  const generateFill = async (i) => {
    if (!draft || genState[i]?.running) return
    setGenState((prev) => ({ ...prev, [i]: { running: true, stage: 'starting', error: null } }))
    try {
      const result = await generateFillForPlaceholder({
        row: draft.edl[i],
        rowIndex: i,
        edl: draft.edl,
        scenes,
        sourceVideo,
        onProgress: (info) => {
          setGenState((prev) => ({ ...prev, [i]: { running: true, ...info } }))
        },
      })
      // Fold the result into the row's genSpec so the populator can
      // swap it in on the next Apply, and persist immediately so a
      // crash doesn't throw away an expensive generation.
      const nextDraft = {
        ...draft,
        edl: draft.edl.map((r, idx) => (
          idx === i
            ? { ...r, genSpec: { ...(r.genSpec || {}), ...result } }
            : r
        )),
      }
      setDraft(nextDraft)
      await saveProject({ proposal: { ...nextDraft, status: 'draft' } })
      setGenState((prev) => ({ ...prev, [i]: { running: false, done: true } }))
    } catch (err) {
      console.error('[reedit] generate fill failed:', err)
      setGenState((prev) => ({ ...prev, [i]: { running: false, error: err?.message || 'Generation failed.' } }))
    }
  }

  const selectedMetric = presets.find((m) => m.id === metric) || presets[0]
  const presetBeingEdited = presetEditor?.mode === 'edit'
    ? presets.find((p) => p.id === presetEditor.id)
    : null

  // Live duration estimate. Originals contribute their source scene's
  // natural length (the populator ignores the LLM's `newTc*` values);
  // placeholders contribute their declared gap, floored at 0.5s. Recomputed
  // on every edit so exclusions / reorders / deletions update the header
  // in real time. Excluded rows don't count — they're about to be
  // skipped by the populator anyway.
  const estimatedDuration = useMemo(() => {
    const rows = draft?.edl || []
    let total = 0
    for (const row of rows) {
      if (row.excluded) continue
      if (row.kind === 'placeholder') {
        const gap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
        total += Math.max(0.5, gap || 1.5)
        continue
      }
      const scene = sceneById.get(row.sourceSceneId)
      if (!scene) continue
      total += Math.max(0.1, (Number(scene.tcOut) - Number(scene.tcIn)))
    }
    return total
  }, [draft, sceneById])

  const durationMatch = (
    targetDurationSec > 0
    && estimatedDuration > 0
    && Math.abs(estimatedDuration - targetDurationSec) / targetDurationSec <= 0.15
  )
  const isDirty = draft && draft !== savedProposal
  const edl = draft?.edl || []
  const placeholderCount = edl.filter((r) => r.kind === 'placeholder').length
  const originalCount = edl.length - placeholderCount
  const excludedRowCount = edl.filter((r) => r.excluded).length

  return (
    <div className="flex-1 flex flex-col bg-sf-dark-950 text-sf-text-primary overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-sf-dark-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-sf-dark-800 border border-sf-dark-700 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-sf-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Proposal</h1>
            <p className="text-xs text-sf-text-muted">
              {draft
                ? (
                  <>
                    {edl.length} edits ({originalCount} original · {placeholderCount} new) · optimized for {draft.metric} · {draft.model}
                    {excludedRowCount > 0 && (
                      <span className="ml-2 text-amber-300/80">· {excludedRowCount} excluded</span>
                    )}
                    {draft.targetDurationSec && (
                      <span className={`ml-2 ${durationMatch ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>
                        · ~{estimatedDuration.toFixed(1)}s of {draft.targetDurationSec.toFixed(1)}s target
                      </span>
                    )}
                  </>
                )
                : 'Draft an improvement proposal from the shot log.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {draft && !generating && (
            <>
              {isDirty && (
                <button
                  type="button"
                  onClick={discardDraft}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Discard
                </button>
              )}
              <button
                type="button"
                onClick={saveDraft}
                disabled={!isDirty}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors
                  ${isDirty
                    ? 'border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-primary'
                    : 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'}`}
              >
                <Save className="w-3.5 h-3.5" />
                Save draft
              </button>
              {/* Video/image toggle for generated fills. Click flips
                  between "use i2v videos when available" and "use
                  selected frame stills even if a video exists". Takes
                  effect on the next Apply. */}
              <button
                type="button"
                onClick={() => setUseGeneratedVideos((v) => !v)}
                title={useGeneratedVideos
                  ? 'Using generated i2v videos for placeholder rows. Click to use frame stills instead (reversible).'
                  : 'Using frame stills for placeholder rows. Click to re-enable generated videos.'}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border transition-colors
                  ${useGeneratedVideos
                    ? 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}
              >
                {useGeneratedVideos
                  ? <><Video className="w-3.5 h-3.5" /> Videos on</>
                  : <><ImageIcon className="w-3.5 h-3.5" /> Stills only</>}
              </button>
              <button
                type="button"
                onClick={applyToTimeline}
                disabled={applying || edl.length === 0}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                  ${applying
                    ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                    : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
                title="Extract each scene to its own file then push to the timeline"
              >
                {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Film className="w-3.5 h-3.5" />}
                {applying
                  ? (applyProgress.total > 0
                      ? `Extracting ${applyProgress.current}/${applyProgress.total}…`
                      : 'Applying…')
                  : 'Apply to timeline'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Scroll area */}
      <div className="flex-1 overflow-auto">
        {/* Inputs */}
        <div className="px-6 py-5 border-b border-sf-dark-800 bg-sf-dark-950">
          <div className="max-w-4xl">
            <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">Optimize for</label>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mb-5">
              {presets.map((m) => (
                <div key={m.id} className="relative group/preset">
                  <button
                    type="button"
                    onClick={() => setMetric(m.id)}
                    className={`w-full h-full text-left p-3 rounded-lg border transition-colors
                      ${metric === m.id
                        ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                        : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                  >
                    <div className="text-sm font-medium pr-6">{m.label}</div>
                    <div className="text-[10px] leading-snug mt-1 opacity-80">{m.blurb || 'No description.'}</div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleOpenEditPreset(m) }}
                    title="Edit preset"
                    className="absolute top-1.5 right-1.5 p-1 rounded bg-sf-dark-800/80 hover:bg-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary opacity-0 group-hover/preset:opacity-100 focus:opacity-100 transition-opacity"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={handleOpenCreatePreset}
                className="text-left p-3 rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-950 hover:border-sf-accent hover:bg-sf-accent/5 text-sf-text-muted hover:text-sf-text-primary transition-colors flex flex-col items-center justify-center gap-1"
                title="Create a new preset"
              >
                <Plus className="w-4 h-4" />
                <span className="text-[11px]">New preset</span>
              </button>
            </div>

            <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">
              Target duration
              <span className="text-sf-text-muted/70 normal-case ml-2">
                (the LLM picks a subset of scenes whose natural durations sum close to this)
              </span>
            </label>
            <div className="mb-5 flex items-center flex-wrap gap-2">
              <div className="inline-flex items-center rounded-lg border border-sf-dark-700 bg-sf-dark-900 overflow-hidden">
                <input
                  type="number"
                  min={1}
                  max={600}
                  step={1}
                  value={Math.round(targetDurationSec)}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v) && v > 0) setTargetDurationSec(v)
                  }}
                  className="w-20 bg-transparent px-3 py-1.5 text-sm text-sf-text-primary focus:outline-none tabular-nums"
                />
                <span className="pr-3 pl-1 text-xs text-sf-text-muted">seconds</span>
              </div>
              {sourceVideo?.duration && (
                <button
                  type="button"
                  onClick={() => setTargetDurationSec(sourceVideo.duration)}
                  className={`px-2.5 py-1 rounded text-[11px] border transition-colors
                    ${Math.abs(targetDurationSec - sourceVideo.duration) < 0.5
                      ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                      : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                >
                  Original ({sourceVideo.duration.toFixed(1)}s)
                </button>
              )}
              {[6, 15, 30, 60].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setTargetDurationSec(n)}
                  className={`px-2.5 py-1 rounded text-[11px] border transition-colors
                    ${Math.abs(targetDurationSec - n) < 0.5
                      ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                      : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                >
                  {n}s
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">Brand brief (optional)</label>
                <textarea
                  value={brandBrief}
                  onChange={(e) => setBrandBrief(e.target.value)}
                  placeholder="E.g. Nissan Armada, focus on brand presence in the first 5s, emphasize the Invisible Hood View as the hero feature, highlight towing capability and the 'most capable Armada ever' line."
                  rows={4}
                  className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent resize-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">
                  Extra instructions (optional)
                  <span className="text-sf-text-muted/70 normal-case ml-2">injected into the LLM prompt</span>
                </label>
                <textarea
                  value={extraInstructions}
                  onChange={(e) => setExtraInstructions(e.target.value)}
                  placeholder="E.g. never use scenes where the driver's face is visible, always end with the aerial shot, keep at least one shot of the interior, avoid placeholder shots for the first 5 seconds."
                  rows={4}
                  className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent resize-none"
                />
              </div>
            </div>

            <div className="mt-4">
              <div className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">
                Capabilities
                <span className="text-sf-text-muted/70 normal-case ml-2">what the proposer is allowed to do</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {CAPABILITY_DEFINITIONS.map((cap) => {
                  const enabled = Boolean(capabilities[cap.id])
                  return (
                    <label
                      key={cap.id}
                      className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors
                        ${enabled
                          ? 'border-sf-accent bg-sf-accent/10'
                          : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500'}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleCapability(cap.id)}
                        className="mt-0.5 accent-sf-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium ${enabled ? 'text-sf-text-primary' : 'text-sf-text-secondary'}`}>
                          {cap.label}
                        </div>
                        <div className="text-[10px] leading-snug text-sf-text-muted mt-0.5">{cap.blurb}</div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={runGenerate}
                disabled={generating}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition-colors
                  ${generating
                    ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                    : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
              >
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {generating ? 'Generating…' : draft ? 'Re-generate proposal' : 'Generate proposal'}
              </button>

              {/* Engine chip — shows which backend will run the
                  proposal and surfaces the "set API key" state when
                  Claude is selected but the key is missing. Opens the
                  LLM settings modal on click. */}
              <button
                type="button"
                onClick={() => setLlmModalOpen(true)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border transition-colors
                  ${llmSettings.backend === LLM_BACKENDS.ANTHROPIC && !llmSettings.anthropicApiKey
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'}`}
                title="Switch engine, pick model, set API key"
              >
                {llmSettings.backend === LLM_BACKENDS.ANTHROPIC && !llmSettings.anthropicApiKey
                  ? <KeyRound className="w-3.5 h-3.5" />
                  : <Cpu className="w-3.5 h-3.5" />}
                {llmSettings.backend === LLM_BACKENDS.ANTHROPIC
                  ? (ANTHROPIC_MODELS.find((m) => m.id === llmSettings.anthropicModel)?.label || 'Claude')
                  : BACKEND_LABELS[LLM_BACKENDS.LM_STUDIO]}
                {llmSettings.backend === LLM_BACKENDS.ANTHROPIC && !llmSettings.anthropicApiKey && (
                  <span className="text-[10px] opacity-80">· no key</span>
                )}
              </button>

              <span className="text-[11px] text-sf-text-muted">{selectedMetric?.blurb || ''}</span>
            </div>
          </div>
        </div>

        {/* Errors / results */}
        {error && (
          <div className="px-6 py-3 text-xs text-sf-error border-b border-sf-dark-800 flex items-start gap-2 bg-sf-error/5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {applyResult && !error && (
          <div className="px-6 py-3 text-xs text-emerald-300 border-b border-sf-dark-800 flex items-start gap-2 bg-emerald-500/5">
            <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              Placed {applyResult.placed} scene clip{applyResult.placed === 1 ? '' : 's'}
              {applyResult.placeholdersPlaced > 0 && ` and ${applyResult.placeholdersPlaced} "generation needed" card${applyResult.placeholdersPlaced === 1 ? '' : 's'}`} on the timeline.
              {applyResult.skippedMissingScene > 0 && ` Skipped ${applyResult.skippedMissingScene} row${applyResult.skippedMissingScene === 1 ? '' : 's'} referencing unknown scenes.`}
              {' '}Opening Editor…
            </span>
          </div>
        )}

        {/* Draft */}
        {draft && (
          <div className="px-6 py-5">
            {/* Rationale */}
            <div className="mb-6 max-w-4xl">
              <h2 className="text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Rationale</h2>
              <textarea
                value={draft.rationale || ''}
                onChange={(e) => updateRationale(e.target.value)}
                rows={4}
                className="w-full p-4 rounded-lg border border-sf-dark-800 bg-sf-dark-900 text-sm leading-relaxed focus:outline-none focus:border-sf-accent resize-none"
              />
            </div>

            {/* EDL */}
            <h2 className="text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Edit decision list</h2>
            <div className="rounded-lg border border-sf-dark-800 bg-sf-dark-900 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-sf-dark-800/60 text-sf-text-muted uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium w-10">#</th>
                    <th className="text-left px-3 py-2 font-medium w-[82px]">Kind</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ width: thumbW + 24 }}>Thumb</th>
                    <th className="text-left px-3 py-2 font-medium w-[100px]">Source</th>
                    <th className="text-left px-3 py-2 font-medium w-[72px]">In</th>
                    <th className="text-left px-3 py-2 font-medium w-[72px]">Out</th>
                    <th className="text-left px-3 py-2 font-medium w-[60px]">Dur</th>
                    <th className="text-left px-3 py-2 font-medium">Rationale</th>
                    <th className="text-left px-3 py-2 font-medium w-[136px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {edl.map((row, i) => {
                    const dur = (row.newTcOut || 0) - (row.newTcIn || 0)
                    const sourceScene = row.sourceSceneId ? sceneById.get(row.sourceSceneId) : null
                    const rowExcluded = Boolean(row.excluded)
                    // Resolve a thumb URL per row: originals show the
                    // scene's analysis JPG (cache-busted with the
                    // analysis.createdAt so a re-analysis refreshes
                    // immediately), placeholders render the same
                    // "GENERATION NEEDED" SVG the populator uses so
                    // the row in Proposal matches what lands on the
                    // timeline. ?v= keys the SVG to the row position
                    // + note so edits live-update the preview.
                    const thumbUrl = row.kind === 'placeholder'
                      ? buildPlaceholderSvgDataUrl({
                          note: row.note,
                          index: row.index,
                          width: sourceVideo?.width,
                          height: sourceVideo?.height,
                        })
                      : (sourceScene?.thumbnail
                        ? toComfyUrl(sourceScene.thumbnail, analysis?.createdAt)
                        : null)
                    return (
                      <tr
                        key={`${row.index}-${i}`}
                        className={`border-t border-sf-dark-800 align-top transition-opacity ${rowExcluded ? 'opacity-40' : ''}`}
                      >
                        <td className="px-3 py-2 text-sf-text-muted tabular-nums">{row.index}</td>
                        <td className="px-3 py-2"><KindBadge kind={row.kind} /></td>
                        <td className="px-3 py-2">
                          <div
                            className="rounded bg-sf-dark-800 overflow-hidden cursor-zoom-in"
                            style={{ width: thumbW, height: THUMB_HEIGHT }}
                            onMouseEnter={(e) => {
                              if (!thumbUrl) return
                              const rect = e.currentTarget.getBoundingClientRect()
                              setHover({ url: thumbUrl, rect, previewW, previewH })
                            }}
                            onMouseLeave={() => setHover(null)}
                          >
                            {thumbUrl ? (
                              <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">—</div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-sf-text-secondary">
                          {row.sourceSceneId || <span className="italic text-sf-text-muted">—</span>}
                          {sourceScene && (
                            <div className="text-[10px] text-sf-text-muted mt-0.5">
                              orig {formatTc(sourceScene.tcIn)}–{formatTc(sourceScene.tcOut)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{formatTc(row.newTcIn)}</td>
                        <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{formatTc(row.newTcOut)}</td>
                        <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{dur.toFixed(1)}s</td>
                        <td className="px-3 py-2">
                          <textarea
                            value={row.note || ''}
                            onChange={(e) => updateNote(i, e.target.value)}
                            rows={2}
                            className="w-full text-xs rounded border border-transparent bg-transparent hover:border-sf-dark-700 focus:border-sf-accent focus:bg-sf-dark-800 px-1.5 py-1 text-sf-text-primary resize-none focus:outline-none"
                            placeholder="—"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => toggleRowExcluded(i)}
                              title={rowExcluded ? 'Include row (currently excluded)' : 'Exclude from Apply + Generate'}
                              className={`p-1 rounded transition-colors
                                ${rowExcluded
                                  ? 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
                                  : 'text-sf-accent hover:bg-sf-accent/20'}`}
                            >
                              {rowExcluded ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => moveUp(i)}
                              disabled={i === 0}
                              title="Move up"
                              className="p-1 rounded hover:bg-sf-dark-700 disabled:opacity-30 disabled:cursor-not-allowed text-sf-text-muted hover:text-sf-text-primary transition-colors"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveDown(i)}
                              disabled={i === edl.length - 1}
                              title="Move down"
                              className="p-1 rounded hover:bg-sf-dark-700 disabled:opacity-30 disabled:cursor-not-allowed text-sf-text-muted hover:text-sf-text-primary transition-colors"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeRow(i)}
                              title="Remove"
                              className="p-1 rounded hover:bg-sf-error/20 text-sf-text-muted hover:text-sf-error transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            {row.kind === 'placeholder' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => sendToComfy(i)}
                                  disabled={genState[i]?.running}
                                  title="Send workflow to ComfyUI (inspect / edit before generating)"
                                  className="p-1 rounded transition-colors text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary disabled:opacity-30 disabled:cursor-wait"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPlaceholderDetails(i)}
                                  title={
                                    row.genSpec?.generatedPath
                                      ? 'Open frame + video workspace (has video)'
                                      : (row.genSpec?.frameCandidates?.length
                                        ? 'Open frame + video workspace (candidates ready)'
                                        : 'Generate frames + video (i2v workspace)')
                                  }
                                  className={`p-1 rounded transition-colors
                                    ${row.genSpec?.generatedPath
                                      ? 'text-emerald-400 hover:bg-emerald-500/20'
                                      : (row.genSpec?.frameCandidates?.length
                                        ? 'text-sky-400 hover:bg-sky-500/20'
                                        : 'text-amber-400 hover:bg-amber-500/20')}`}
                                >
                                  {row.genSpec?.generatedPath
                                    ? <CheckCircle2 className="w-3.5 h-3.5" />
                                    : <Wand2 className="w-3.5 h-3.5" />}
                                </button>
                              </>
                            )}
                          </div>
                          {row.kind === 'placeholder' && genState[i] && (
                            <div className="mt-1 text-[10px] leading-snug">
                              {genState[i].running && (
                                <span className="text-sf-text-muted">
                                  {genState[i].inspect && genState[i].stage === 'upload_ref' && 'Uploading ref for ComfyUI…'}
                                  {genState[i].inspect && genState[i].stage === 'queue_workflow' && 'Building workflow…'}
                                  {!genState[i].inspect && genState[i].stage === 'upload_ref' && 'Uploading ref…'}
                                  {!genState[i].inspect && genState[i].stage === 'queue_workflow' && 'Queuing workflow…'}
                                  {genState[i].stage === 'generating' && (
                                    genState[i].step != null && genState[i].maxSteps
                                      ? `Generating ${genState[i].step}/${genState[i].maxSteps}…`
                                      : 'Generating…'
                                  )}
                                  {genState[i].stage === 'executing' && 'Running graph…'}
                                  {genState[i].stage === 'download' && 'Downloading…'}
                                </span>
                              )}
                              {!genState[i].running && genState[i].error && (
                                <span className="text-sf-error">{genState[i].error}</span>
                              )}
                              {!genState[i].running && genState[i].done && (
                                <span className="text-emerald-400">Ready — re-Apply to see on timeline.</span>
                              )}
                              {!genState[i].running && genState[i].inspectReady && (
                                <span className="text-sky-300">{genState[i].message || 'Workflow sent to ComfyUI.'}</span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {placeholderCount > 0 && (
              <div className="mt-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-100/90 leading-snug">
                <span className="font-medium text-amber-200">Note</span> — {placeholderCount} placeholder row{placeholderCount === 1 ? '' : 's'} will leave a gap on the timeline. That's where generated fill shots land in M2 (WAN / LTX / Seedance).
              </div>
            )}
          </div>
        )}

        {!draft && !generating && !error && (
          <div className="px-6 py-10 text-sm text-sf-text-muted text-center">
            Pick a metric, optionally paste a brand brief, then click <span className="mx-1 px-1.5 py-0.5 rounded bg-sf-dark-800 text-sf-text-primary">Generate proposal</span>.
          </div>
        )}
      </div>

      <PresetEditorModal
        isOpen={Boolean(presetEditor)}
        mode={presetEditor?.mode || 'edit'}
        preset={presetBeingEdited}
        isBuiltinDefault={isBuiltinDefault}
        onClose={closePresetEditor}
        onSave={handleSavePreset}
        onDelete={handleDeletePreset}
        onReset={handleResetPreset}
      />

      <LlmSettingsModal
        isOpen={llmModalOpen}
        settings={llmSettings}
        onClose={() => setLlmModalOpen(false)}
        onSave={(patch) => {
          updateLlmSettings(patch)
          setLlmModalOpen(false)
        }}
      />

      <SendToComfyModal
        isOpen={Boolean(comfyHandoff)}
        payload={comfyHandoff}
        onClose={() => setComfyHandoff(null)}
      />

      <PlaceholderDetailsModal
        isOpen={placeholderDetails != null}
        row={placeholderDetails != null ? draft?.edl?.[placeholderDetails] : null}
        rowIndex={placeholderDetails ?? 0}
        edl={draft?.edl || []}
        scenes={scenes}
        sourceVideo={sourceVideo}
        onClose={() => setPlaceholderDetails(null)}
        onChange={(nextGenSpec) => {
          // Merge the new genSpec into the draft's row and persist
          // immediately so an expensive frame / video generation
          // isn't lost if the user closes the modal right after.
          if (placeholderDetails == null || !draft) return
          const nextDraft = {
            ...draft,
            edl: draft.edl.map((r, idx) => (
              idx === placeholderDetails ? { ...r, genSpec: nextGenSpec } : r
            )),
          }
          setDraft(nextDraft)
          saveProject({ proposal: { ...nextDraft, status: 'draft' } })
        }}
      />

      {/* Thumbnail hover preview — fixed-positioned so it escapes the
          scrolling EDL table. Same pattern as AnalysisView: flip left
          when the preview would run off the right edge; clamp vertical
          so tall 9:16 previews don't clip off the top/bottom. */}
      {hover && (() => {
        const MARGIN = 12
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
        const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
        const rightSpace = vw - hover.rect.right
        const placeLeft = rightSpace < hover.previewW + MARGIN && hover.rect.left > hover.previewW + MARGIN
        const left = placeLeft ? hover.rect.left - hover.previewW - MARGIN : hover.rect.right + MARGIN
        let top = hover.rect.top + (hover.rect.height - hover.previewH) / 2
        top = Math.max(MARGIN, Math.min(top, vh - hover.previewH - MARGIN))
        return (
          <div
            className="fixed z-[1000] pointer-events-none rounded-lg overflow-hidden shadow-2xl shadow-black/70 border border-sf-dark-600 bg-sf-dark-900"
            style={{ top, left, width: hover.previewW, height: hover.previewH }}
          >
            <img src={hover.url} alt="" className="w-full h-full object-cover" />
          </div>
        )
      })()}
    </div>
  )
}

export default ProposalView
