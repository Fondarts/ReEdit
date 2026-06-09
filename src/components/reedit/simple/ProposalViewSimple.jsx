import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, FileText, CheckCircle2,
  ArrowRight, Wand2, Mic, Music, Layers, Upload, ChevronDown, ChevronUp, Pencil,
} from 'lucide-react'
import FillDetailsModal from './FillDetailsModal'
import {
  fillVersionList, activeFillVersionId, setActiveFillVersion, removeFillVersion,
} from '../../../services/placeholderVersions'
import useProjectStore from '../../../stores/projectStore'
import { generateProposal } from '../../../services/reeditProposer'
import { parseSundogsReport } from '../../../services/reeditSundogsReport'
import { applyEdlToTimeline } from '../../../services/reeditEdlToTimeline'
import {
  generateFillsForProposal,
  generateFillForRow,
  placeholderIdFor,
  FILL_MODELS,
  DEFAULT_FILL_MODEL,
} from '../../../services/reeditFills'
import {
  loadCapabilities as loadProposalCapabilities,
  saveCapabilities as saveProposalCapabilities,
  CAPABILITY_DEFINITIONS,
  DEFAULT_CAPABILITIES,
} from '../../../services/reeditProposalCapabilities'
import { pickVisionModelId } from '../../../services/reeditCaptioner'
import SundogsDimensionSection, { DeltaPill } from '../sundogs/SundogsDimensionSection'
import { SUNDOGS_TECHNIQUES } from '../../../services/reeditSundogsReport'
import ProposalInstructionsPanel from '../ProposalInstructionsPanel'

// Pull every technical directive out of an EDL note so we can render
// them as coloured chips at the start of the row. The proposer emits
// notes like:
//   "REFRAME zoom=1.8 anchor=0.50,0.45: Push in on the BMW roundel..."
//   "COLOR: exposure=+15 contrast=+10: Boost brightness..."
//   "EXTEND +1.5s: Hold the close-up..."
//   "Address person_in_first_5: Open with the serene close-up."
// We split on the first colon — everything before, that matches a
// known keyword, becomes a chip; the rest is the prose body.
//
// Returns `{ directives: [{ kind, text }], body }`. `directives` is in
// emission order so a "REFRAME ... + COLOR ..." note keeps both chips.
const DIRECTIVE_KEYWORDS = /^(REFRAME|COLOR|EXTEND|REPLACE|TRIM|HOLD|ADDRESS|FILL|GRAPHICS)\b/i
function parseNoteDirectives(note) {
  const raw = String(note || '').trim()
  if (!raw) return { directives: [], body: '' }
  const colonIdx = raw.indexOf(':')
  if (colonIdx < 0) return { directives: [], body: raw }
  const head = raw.slice(0, colonIdx).trim()
  const body = raw.slice(colonIdx + 1).trim()
  if (!DIRECTIVE_KEYWORDS.test(head)) {
    return { directives: [], body: raw }
  }
  // Split on `:` again inside `body` to chain multiple directives
  // (e.g. "REFRAME zoom=1.8: COLOR exposure=+10: actual prose..."),
  // but only when the next chunk starts with another keyword.
  const directives = [{ kind: head.split(/\s+/)[0].toUpperCase(), text: head }]
  let rest = body
  while (true) {
    const nextColon = rest.indexOf(':')
    if (nextColon < 0) break
    const candidate = rest.slice(0, nextColon).trim()
    if (!DIRECTIVE_KEYWORDS.test(candidate)) break
    directives.push({ kind: candidate.split(/\s+/)[0].toUpperCase(), text: candidate })
    rest = rest.slice(nextColon + 1).trim()
  }
  return { directives, body: rest }
}

// Tailwind classes per directive kind. Stays narrow on purpose — if
// the proposer invents a new keyword we just fall back to the neutral
// sf-text-muted treatment instead of trying to autopick a colour.
const DIRECTIVE_COLOR = {
  REFRAME:  'bg-sky-500/15 text-sky-300 border-sky-500/30',
  COLOR:    'bg-amber-500/15 text-amber-300 border-amber-500/30',
  EXTEND:   'bg-violet-500/15 text-violet-300 border-violet-500/30',
  REPLACE:  'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  TRIM:     'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  HOLD:     'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  ADDRESS:  'bg-rose-500/15 text-rose-300 border-rose-500/30',
  FILL:     'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30',
  GRAPHICS: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
}

function formatTc(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

// Mirror of toComfyUrl in AnalysisView — builds the comfystudio:// URL
// that the main process exposes for arbitrary local files. The cache
// buster suffix matches what Analysis uses so the same JPG (overwritten
// on re-run) serves a fresh frame here too.
function toComfyUrl(filePath, version) {
  if (!filePath) return null
  const base = `comfystudio://${encodeURIComponent(filePath)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

// VO and Music get a 3-way radio: off / use original stem / generate new.
// The two underlying capability flags are mutually exclusive so we keep
// them in sync via this helper.
function deriveMode(useOriginal, generate) {
  if (generate)    return 'generated'
  if (useOriginal) return 'original'
  return 'off'
}

function modeToCaps(mode, originalKey, generateKey) {
  return {
    [originalKey]: mode === 'original',
    [generateKey]: mode === 'generated',
  }
}

// The Advanced view exposes a long list of structural capabilities
// (extend, reframe, color correction…). Simple keeps the everyday ones
// the user actually toggles per project.
const SIMPLE_CAPABILITY_IDS = new Set([
  'footageGeneration',
  'footageExtend',
  'footageReframe',
  'colorCorrection',
  'useAdditionalAssets',
])

export default function ProposalViewSimple({ onNavigate }) {
  const currentProject = useProjectStore((s) => s.currentProject)
  const saveProject    = useProjectStore((s) => s.saveProject)

  const sourceVideo   = currentProject?.sourceVideo
  const analysis      = currentProject?.analysis || null
  const overall       = analysis?.overall || null
  const scenes        = analysis?.scenes || []
  const proposal      = currentProject?.proposal || null
  const sundogsReport = currentProject?.sundogsReport || null
  const additionalAssets = currentProject?.additionalAssets || {}
  const edl           = proposal?.edl || []
  const fills         = currentProject?.fills || {}

  // Local form state. Pre-fill from existing proposal so a re-generation
  // keeps the user's last choices visible.
  const [targetDurationSec, setTargetDurationSec] = useState(
    proposal?.targetDurationSec ?? sourceVideo?.duration ?? 30
  )
  // Strict-duration toggle. Default ON so when the user asks for 30 s
  // they actually get ~30 s — the LLM's default ±15 % drift is what
  // produced the 24 s output on a 30 s ad that prompted this feature.
  // Persisted to localStorage so the choice survives navigations and
  // applies to Auto / Advanced as a shared preference.
  const [strictDuration, setStrictDurationState] = useState(() => {
    try { return JSON.parse(localStorage.getItem('reedit.proposal.strictDuration.v1') ?? 'true') !== false }
    catch { return true }
  })
  const setStrictDuration = (val) => {
    setStrictDurationState(val)
    try { localStorage.setItem('reedit.proposal.strictDuration.v1', JSON.stringify(val)) } catch (_) {}
  }
  const [extraInstructions, setExtraInstructions] = useState(proposal?.extraInstructions || '')
  // Rule overrides bundled with the active Instructions preset. The
  // panel reads / writes this; the proposer accepts it via the `rules`
  // arg and swaps overridden blocks (system role, editing craft,
  // output rules, placeholder quality) into the prompt.
  const [proposalRules, setProposalRules] = useState(proposal?.rules || {})
  const [capabilities, setCapabilities] = useState(() => {
    const persisted = loadProposalCapabilities()
    return { ...DEFAULT_CAPABILITIES, ...persisted }
  })

  // VO/Music modes derived from capability flags.
  const voMode = deriveMode(capabilities.useOriginalVoiceover, capabilities.generateVoiceover)
  const musicMode = deriveMode(capabilities.useOriginalMusic, capabilities.generateMusic)

  function setVoMode(mode) {
    const patch = modeToCaps(mode, 'useOriginalVoiceover', 'generateVoiceover')
    const next = { ...capabilities, ...patch }
    setCapabilities(next)
    saveProposalCapabilities(patch)
  }
  function setMusicMode(mode) {
    const patch = modeToCaps(mode, 'useOriginalMusic', 'generateMusic')
    const next = { ...capabilities, ...patch }
    setCapabilities(next)
    saveProposalCapabilities(patch)
  }
  function toggleCap(id, value) {
    const next = { ...capabilities, [id]: value }
    setCapabilities(next)
    saveProposalCapabilities({ [id]: value })
  }

  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)
  const [applying, setApplying] = useState(false)
  const [applyOk, setApplyOk] = useState(false)
  // Placeholder-fill bulk pipeline state. Stays local — the persisted
  // project.fills[] is the source of truth for "what's already rendered".
  const [fillsRunning, setFillsRunning] = useState(false)
  const [fillProgress, setFillProgress] = useState({ current: 0, total: 0, note: '' })
  const [fillErrors, setFillErrors] = useState([])
  // Which i2v model the bulk + per-row Generate buttons dispatch to.
  // Persisted in localStorage so a single project keeps the user's
  // last pick across reloads — billing surprises hurt more than
  // discoverability here.
  const [fillModelId, setFillModelId] = useState(() => {
    try { return localStorage.getItem('reedit.fill.modelId') || DEFAULT_FILL_MODEL } catch { return DEFAULT_FILL_MODEL }
  })
  const handlePickFillModel = (next) => {
    setFillModelId(next)
    try { localStorage.setItem('reedit.fill.modelId', next) } catch { /* quota */ }
  }
  // Per-row "Generate" busy flags so two rows can't fire at the same
  // time and the spinner only spins on the row the user clicked.
  const [singleFillBusy, setSingleFillBusy] = useState({})    // { [placeholderId]: true }
  const [singleFillError, setSingleFillError] = useState({})  // { [placeholderId]: string }
  // Which placeholder row's prompt/versions modal is open (array index).
  const [fillDetails, setFillDetails] = useState(null)
  const [importingSundogs, setImportingSundogs] = useState(false)
  const [sundogsError, setSundogsError] = useState(null)
  const [sundogsExpanded, setSundogsExpanded] = useState(false)

  // Persist the last PDF path so the OS picker reopens in the same
  // folder next time. Storing the file path (not the directory) lets
  // Electron pre-select the actual file too — handy when the user is
  // iterating on the same report.
  const SUNDOGS_LAST_PATH_KEY = 'reedit.sundogs.lastPdfPath'

  async function importSundogs() {
    if (importingSundogs) return
    setSundogsError(null)
    try {
      let defaultPath = null
      try { defaultPath = localStorage.getItem(SUNDOGS_LAST_PATH_KEY) || null } catch (_) { /* ignore */ }
      const selected = await window.electronAPI?.selectFile?.({
        title: 'Import Sundogs framework PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        multiple: false,
        ...(defaultPath ? { defaultPath } : {}),
      })
      if (!selected) return
      const filePath = Array.isArray(selected) ? selected[0] : selected
      try { localStorage.setItem(SUNDOGS_LAST_PATH_KEY, filePath) } catch (_) { /* ignore */ }
      setImportingSundogs(true)
      const report = await parseSundogsReport({ filePath })
      await saveProject({ sundogsReport: report })
    } catch (err) {
      setSundogsError(err?.message || 'Could not parse Sundogs PDF.')
    } finally {
      setImportingSundogs(false)
    }
  }

  async function clearSundogs() {
    await saveProject({ sundogsReport: null })
  }

  async function handleGenerate() {
    if (generating) return
    setGenerateError(null)
    setApplyOk(false)
    if (!sourceVideo?.path) { setGenerateError('Import a main video first.'); return }
    if (!scenes.length)     { setGenerateError('Run Analysis first.'); return }

    setGenerating(true)
    try {
      const modelId = await pickVisionModelId().catch(() => null)
      const metric = sundogsReport ? 'Sundogs' : 'Comprehension'
      const result = await generateProposal({
        scenes,
        brandBrief: '',
        extraInstructions,
        metric,
        modelId,
        totalDurationSec: sourceVideo.duration || null,
        targetDurationSec,
        capabilities,
        sourceVideoPath: sourceVideo.path,
        adConcept: overall,
        voSegments: overall?.voiceover_segments || [],
        additionalAssets,
        sundogsReport,
        strictDuration,
        rules: proposalRules,
      })
      const newProposal = {
        edl: result?.edl || [],
        rationale: result?.rationale || '',
        metric,
        targetDurationSec,
        extraInstructions,
        capabilities: { ...capabilities },
        useGeneratedVideos: false,
        status: 'draft',
        createdAt: new Date().toISOString(),
      }
      await saveProject({ proposal: newProposal })
    } catch (err) {
      setGenerateError(err?.message || 'Proposal generation failed.')
    } finally {
      setGenerating(false)
    }
  }

  // Bulk-generate every unfilled placeholder via Kling Cloud. The
  // service handles per-row IPC + persistence; we just translate its
  // progress events into UI state.
  async function handleGenerateFills() {
    if (fillsRunning) return
    setFillsRunning(true)
    setGenerateError(null)
    setFillErrors([])
    setFillProgress({ current: 0, total: 0, note: '' })
    try {
      const res = await generateFillsForProposal({
        modelId: fillModelId,
        onProgress: (stage, payload) => {
          if (stage === 'start') {
            setFillProgress({ current: 0, total: payload?.total || 0, note: '' })
            if (payload?.upfrontFailed?.length) setFillErrors(payload.upfrontFailed)
          } else if (stage === 'begin') {
            setFillProgress({ current: payload?.current || 0, total: payload?.total || 0, note: payload?.note || '' })
          } else if (stage === 'error') {
            setFillErrors((prev) => [...prev, { placeholderId: payload?.placeholderId, error: payload?.error }])
          }
        },
      })
      if (res.failed?.length > 0) setFillErrors(res.failed)
    } catch (err) {
      setGenerateError(err?.message || 'Generate fills failed.')
    } finally {
      setFillsRunning(false)
    }
  }

  // Single-row generator — invoked by the per-row "Generate" button.
  async function handleGenerateRow(row, index) {
    const pid = placeholderIdFor({ ...row, index })
    if (singleFillBusy[pid]) return
    setSingleFillBusy((b) => ({ ...b, [pid]: true }))
    setSingleFillError((e) => ({ ...e, [pid]: null }))
    try {
      await generateFillForRow({ row, index, modelId: fillModelId })
    } catch (err) {
      setSingleFillError((e) => ({ ...e, [pid]: err?.message || String(err) }))
    } finally {
      setSingleFillBusy((b) => ({ ...b, [pid]: false }))
    }
  }

  // Persist a partial patch onto one EDL row in the proposal (e.g. a
  // per-row `fillPrompt` override set from the details modal).
  const writeRowField = async (rowArrayIndex, patch) => {
    const proposal = currentProject?.proposal
    if (!proposal) return
    const nextEdl = (proposal.edl || []).map((r, i) => (i === rowArrayIndex ? { ...r, ...patch } : r))
    await saveProject({ proposal: { ...proposal, edl: nextEdl } })
  }

  // Make a specific fill version active (mirrors its path to the top
  // level so the thumbnail + timeline pick it up).
  const setFillVersion = async (rowArrayIndex, versionId) => {
    const pid = placeholderIdFor({ ...edl[rowArrayIndex], index: rowArrayIndex })
    const nextFill = setActiveFillVersion(fills[pid], versionId)
    if (!nextFill) return
    await saveProject({ fills: { ...fills, [pid]: nextFill } })
  }

  // Step the active fill version by a delta (wraps). Drives the compact
  // ‹ v/n › switcher under each placeholder thumbnail.
  const stepFillVersion = async (rowArrayIndex, delta) => {
    const pid = placeholderIdFor({ ...edl[rowArrayIndex], index: rowArrayIndex })
    const list = fillVersionList(fills[pid])
    if (list.length < 2) return
    const cur = Math.max(0, list.findIndex((v) => v.id === activeFillVersionId(fills[pid])))
    const n = list.length
    const idx = ((cur + delta) % n + n) % n
    await setFillVersion(rowArrayIndex, list[idx].id)
  }

  const deleteFillVersion = async (rowArrayIndex, versionId) => {
    const pid = placeholderIdFor({ ...edl[rowArrayIndex], index: rowArrayIndex })
    const nextFill = removeFillVersion(fills[pid], versionId)
    const nextFills = { ...fills }
    if (nextFill) nextFills[pid] = nextFill
    else delete nextFills[pid]
    await saveProject({ fills: nextFills })
  }

  // Generate from the details modal: persist the prompt override first,
  // then run the per-row generator with the merged row so the override
  // actually reaches the model.
  const handleGenerateFromModal = async (rowArrayIndex, promptText) => {
    await writeRowField(rowArrayIndex, { fillPrompt: promptText })
    await handleGenerateRow({ ...edl[rowArrayIndex], index: rowArrayIndex, fillPrompt: promptText }, rowArrayIndex)
  }

  // Are there any placeholder rows that still need a fill?
  const placeholderRowsNeedingFill = edl.filter((row) => {
    if (!row || row.kind !== 'placeholder') return false
    const pid = placeholderIdFor({ ...row, index: edl.indexOf(row) })
    return !fills[pid]?.path
  })
  const placeholderRowsTotal = edl.filter((row) => row?.kind === 'placeholder').length

  async function handleApply() {
    if (applying || edl.length === 0) return
    setApplying(true)
    setApplyOk(false)
    try {
      // applyEdlToTimeline destructures its args — call it with at
      // least the edl, scenes and sourceVideo. The previous arg-less
      // call always threw "EDL is empty." (the function saw edl as
      // undefined). We mirror what the Advanced ProposalView passes,
      // but skip the optional generated VO/Music drafts since Simple/
      // Auto don't expose synthesis pickers.
      await applyEdlToTimeline({
        edl,
        scenes,
        sourceVideo,
        useGeneratedVideos: false,
        capabilities,
        voiceoverSegments: overall?.voiceover_segments || null,
        voiceoverPlan: null,
        generatedVoiceover: null,
        generatedMusic: null,
        additionalAssets,
        fills,
      })
      const latest = useProjectStore.getState().currentProject?.proposal || {}
      await saveProject({
        proposal: {
          ...latest,
          status: 'approved',
          appliedAt: new Date().toISOString(),
        },
      })
      setApplyOk(true)
      // Hand off to the editor (or wherever the parent wants).
      onNavigate?.('editor')
    } catch (err) {
      setGenerateError(err?.message || 'Apply failed.')
    } finally {
      setApplying(false)
    }
  }

  // EDL row rendering — keep it compact and read-only in Simple mode.
  // We attach two derived pieces per row:
  //   - `sceneRef`: the original Scene the EDL row references (for
  //      the thumbnail + duration meta).
  //   - `voLines`: the VO segments that overlap this row's source
  //      window. The proposer keeps VO in its own track on the
  //      timeline, but the EDL view is what the user reads first, so
  //      attaching the spoken line back to each shot helps them sanity-
  //      check the pairing without flipping to the Editor.
  const voSegments = useMemo(() => {
    return Array.isArray(overall?.voiceover_segments) ? overall.voiceover_segments : []
  }, [overall])

  const edlRows = useMemo(() => {
    // Step 1: per-row, find VO segments that overlap the row's source
    // window. Easy case — the EDL row's source scene is also where the
    // VO line was spoken originally.
    const initial = edl.map((row, i) => {
      const sceneRef = scenes.find((s) => s.id === row.sourceSceneId) || null
      let voLines = []
      if (sceneRef && voSegments.length > 0) {
        const sceneIn = Number(sceneRef.tcIn) || 0
        const sceneOut = Number(sceneRef.tcOut) || 0
        voLines = voSegments
          .filter((seg) => {
            const segIn  = Number(seg.startSec) || 0
            const segOut = Number(seg.endSec) || 0
            return segOut > sceneIn && segIn < sceneOut
          })
          .map((seg) => String(seg.text || '').trim())
          .filter(Boolean)
      }
      return {
        ...row,
        index: i,
        sceneRef,
        voLines,
      }
    })
    // Step 2: bridge mid-line gaps. The proposer often pulls an
    // intercut shot from a different source moment into the middle of
    // a VO line — so the row's own scene timestamps don't overlap the
    // VO segment even though the line keeps playing on the new cut.
    // If a row has no VO of its own but the rows immediately before
    // and after share at least one identical VO line, fill this row
    // with that shared line so the EDL reads as a continuous block.
    for (let i = 1; i < initial.length - 1; i++) {
      const row = initial[i]
      if (row.voLines.length > 0) continue
      const prev = initial[i - 1].voLines
      const next = initial[i + 1].voLines
      if (prev.length === 0 || next.length === 0) continue
      const shared = prev.filter((line) => next.includes(line))
      if (shared.length > 0) {
        row.voLines = shared
        row.voInherited = true   // optional flag if the renderer wants to style differently
      }
    }
    return initial
  }, [edl, scenes, voSegments])

  if (!sourceVideo) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Import a main video first.
      </div>
    )
  }
  if (!analysis || scenes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Run Analysis first.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="w-full px-6 py-5 space-y-4">

        <div>
          <h1 className="text-lg font-semibold leading-tight">Proposal</h1>
          <p className="text-xs text-sf-text-muted">Set the goals, then generate the edit decision list.</p>
        </div>

        {/* Two-column layout: settings on the left, audio choices on the right */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">

          {/* LEFT COLUMN: Sundogs framework + Extra instructions + Capabilities */}
          <div className="space-y-3">

            {/* Sundogs framework */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <FileText size={13} className="text-sf-text-muted"/>
                <div className="text-xs font-medium">Sundogs framework</div>
                {sundogsReport && (
                  <span className="text-[10px] text-green-400 inline-flex items-center gap-1">
                    <CheckCircle2 size={10}/> imported
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {sundogsReport ? (
                    <button onClick={clearSundogs} className="text-[11px] text-sf-text-muted hover:text-red-400">
                      Remove
                    </button>
                  ) : (
                    <button
                      onClick={importSundogs}
                      disabled={importingSundogs}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-sf-dark-700 hover:bg-sf-dark-800 text-[11px] disabled:opacity-50"
                    >
                      {importingSundogs ? <Loader2 size={11} className="animate-spin"/> : <Upload size={11}/>}
                      Import PDF
                    </button>
                  )}
                </div>
              </div>
              {sundogsError && (
                <div className="text-[11px] text-red-400">{sundogsError}</div>
              )}
            </div>

            {/* Sundogs report — compact summary (no expandable dimension
                sections; that's an Advanced thing). Shows the headline
                score vs benchmark + the 4 deltas (ATT / COMP / PERS / ACT)
                so the user knows at a glance what the proposer will
                optimise against. */}
            {sundogsReport && (() => {
              const o = sundogsReport.overall || {}
              const m = sundogsReport.meta || {}
              const headerBits = [
                m.brand && m.product ? `${m.brand} ${m.product}` : m.brand,
                m.contentType,
                Number.isFinite(m.durationSec) ? `${m.durationSec}s` : null,
              ].filter(Boolean)
              const diff = sundogsReport.differentiation
              return (
                <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <FileText size={13} className="text-amber-400"/>
                    <div className="text-xs font-medium">Sundogs report</div>
                    {Number.isFinite(o.finalScorePct) && Number.isFinite(o.benchmarkPct) && (
                      <span className="text-[11px] text-sf-text-primary/90 tabular-nums">
                        {o.finalScorePct}%
                        <span className="text-sf-text-muted"> vs {o.benchmarkPct}% benchmark</span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSundogsExpanded((v) => !v)}
                      className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded border border-sf-dark-700 hover:bg-sf-dark-800 text-[10px] text-sf-text-secondary"
                      title={sundogsExpanded ? 'Hide detail' : 'Show full report'}
                    >
                      {sundogsExpanded ? <ChevronUp size={11}/> : <ChevronDown size={11}/>}
                      {sundogsExpanded ? 'Hide' : 'Details'}
                    </button>
                  </div>
                  {headerBits.length > 0 && (
                    <div className="text-[10px] text-sf-text-muted">{headerBits.join(' · ')}</div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <DeltaPill delta={o.deltas?.attention} label="ATT" />
                    <DeltaPill delta={o.deltas?.comprehension} label="COMP" />
                    <DeltaPill delta={o.deltas?.persuasion} label="PERS" />
                    <DeltaPill delta={o.deltas?.action} label="ACT" />
                  </div>

                  {/* Full report body — Differentiation + 4 dimension sections.
                      Lifted from SundogsReportPanel so Simple users can drill
                      into the same data Advanced exposes without leaving the
                      tab. */}
                  {sundogsExpanded && (
                    <div className="pt-2 mt-2 border-t border-sf-dark-700 space-y-2">
                      {(Number.isFinite(diff?.scorePct) || diff?.keyElements?.length > 0) && (
                        <div className="rounded-md border border-sf-dark-800 bg-sf-dark-900/60 px-3 py-2">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-emerald-400/80">Differentiation</span>
                            {Number.isFinite(diff?.scorePct) && <DeltaPill delta={diff.scorePct} />}
                          </div>
                          {diff?.keyElements?.length > 0 && (
                            <ul className="list-disc list-inside text-[12px] leading-relaxed text-sf-text-primary/90 space-y-0.5">
                              {diff.keyElements.map((s, i) => <li key={i}>{s}</li>)}
                            </ul>
                          )}
                        </div>
                      )}

                      <SundogsDimensionSection
                        name="Attention"
                        headlineDelta={sundogsReport.attention?.deltas?.overall ?? o.deltas?.attention}
                        windowEntries={[
                          { label: 'First 5s', window: sundogsReport.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'first5' },
                          { label: 'Overall', window: sundogsReport.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'overall' },
                          { label: 'Last 5s', window: sundogsReport.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'last5' },
                        ]}
                      />

                      <SundogsDimensionSection
                        name="Comprehension"
                        headlineDelta={sundogsReport.comprehension?.branding?.deltas?.overall ?? o.deltas?.comprehension}
                        windowEntries={[
                          { label: 'Branding · First 5s', window: sundogsReport.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'first5' },
                          { label: 'Branding · Overall', window: sundogsReport.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'overall' },
                          { label: 'Branding · Last 5s', window: sundogsReport.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'last5' },
                          { label: 'Product', window: sundogsReport.comprehension?.product, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_product, deltaKey: null },
                        ]}
                      />

                      <SundogsDimensionSection
                        name="Persuasion"
                        headlineDelta={sundogsReport.persuasion?.emotional?.deltas?.overall ?? o.deltas?.persuasion}
                        windowEntries={[
                          { label: 'Emotional · First 5s', window: sundogsReport.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'first5' },
                          { label: 'Emotional · Overall', window: sundogsReport.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'overall' },
                          { label: 'Emotional · Last 5s', window: sundogsReport.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'last5' },
                        ]}
                      />

                      <SundogsDimensionSection
                        name="Action"
                        headlineDelta={sundogsReport.action?.deltas?.overall ?? o.deltas?.action}
                        windowEntries={[
                          { label: 'Overall', window: sundogsReport.action, techniqueIds: SUNDOGS_TECHNIQUES.action, deltaKey: 'overall' },
                          { label: 'Last 5s', window: sundogsReport.action, techniqueIds: SUNDOGS_TECHNIQUES.action, deltaKey: 'last5' },
                        ]}
                      />
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Instructions — preset library + editable text + optional
                preview of the full prompt that lands at Gemini. */}
            <ProposalInstructionsPanel
              value={extraInstructions}
              onChange={setExtraInstructions}
              rules={proposalRules}
              onRulesChange={setProposalRules}
              previewArgs={{
                scenes,
                brandBrief: '',
                metric: sundogsReport ? 'Sundogs' : 'Comprehension',
                totalDurationSec: sourceVideo?.duration || null,
                targetDurationSec,
                capabilities,
                adConcept: overall,
                voSegments: overall?.voiceover_segments || [],
                additionalAssets,
                sundogsReport,
                strictDuration,
              }}
            />
          </div>

          {/* RIGHT COLUMN: Target duration + Voiceover + Music */}
          <div className="space-y-3">

            {/* Target duration */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3">
              <label className="text-[10px] uppercase tracking-wider text-sf-text-muted block mb-1">Target duration (s)</label>
              <input
                type="number"
                min={3}
                max={180}
                step={1}
                value={Math.round(Number(targetDurationSec) || 0)}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value) || 0)
                  if (v > 0) setTargetDurationSec(v)
                }}
                className="bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-sm w-full"
              />
              <label className="mt-2 flex items-start gap-2 cursor-pointer text-[11px] text-sf-text-secondary leading-snug">
                <input
                  type="checkbox"
                  checked={strictDuration}
                  onChange={(e) => setStrictDuration(e.target.checked)}
                  className="mt-0.5 accent-sf-accent"
                />
                <span>
                  <span className="font-medium text-sf-text-primary">Strict duration.</span>
                  <span className="text-sf-text-muted">{' '}Force the EDL to land within ±3 % of the target (instead of ±15 %), and retry up to twice if it doesn't.</span>
                </span>
              </label>
            </div>

            {/* Voiceover */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Mic size={13} className="text-fuchsia-300"/>
                <div className="text-xs font-medium">Voiceover</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'off',       label: 'Skip' },
                  { id: 'original',  label: 'Use original' },
                  { id: 'generated', label: 'Generate new' },
                ].map((opt) => (
                  <label key={opt.id} className={`px-2.5 py-1 rounded border cursor-pointer text-xs ${
                    voMode === opt.id
                      ? 'border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-200'
                      : 'border-sf-dark-700 hover:bg-sf-dark-800/60 text-sf-text-secondary'
                  }`}>
                    <input
                      type="radio" name="voMode" value={opt.id}
                      checked={voMode === opt.id}
                      onChange={() => setVoMode(opt.id)}
                      className="hidden"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Music */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Music size={13} className="text-emerald-300"/>
                <div className="text-xs font-medium">Music</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: 'off',       label: 'Skip' },
                  { id: 'original',  label: 'Use original' },
                  { id: 'generated', label: 'Generate new' },
                ].map((opt) => (
                  <label key={opt.id} className={`px-2.5 py-1 rounded border cursor-pointer text-xs ${
                    musicMode === opt.id
                      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200'
                      : 'border-sf-dark-700 hover:bg-sf-dark-800/60 text-sf-text-secondary'
                  }`}>
                    <input
                      type="radio" name="musicMode" value={opt.id}
                      checked={musicMode === opt.id}
                      onChange={() => setMusicMode(opt.id)}
                      className="hidden"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Capabilities — moved into the right column so the Sundogs
                report has room to breathe on the left. */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Layers size={13} className="text-sf-text-muted"/>
                <div className="text-xs font-medium">Capabilities</div>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {CAPABILITY_DEFINITIONS.filter((c) => SIMPLE_CAPABILITY_IDS.has(c.id)).map((c) => (
                  <label
                    key={c.id}
                    title={c.blurb}
                    className="flex items-center gap-2 text-xs cursor-pointer py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={!!capabilities[c.id]}
                      onChange={(e) => toggleCap(c.id, e.target.checked)}
                    />
                    <span className="text-sf-text-primary truncate">{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Generate */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-4 py-2 rounded bg-sf-accent hover:bg-sf-accent-hover text-white text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {generating ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
            {generating ? 'Generating…' : (edl.length > 0 ? 'Re-generate' : 'Generate proposal')}
          </button>
          {edl.length > 0 && (
            <span className="text-xs text-sf-text-muted">{edl.length} shots in the EDL</span>
          )}
        </div>

        {generateError && (
          <div className="bg-red-900/20 border border-red-500/40 text-red-300 text-sm p-3 rounded flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0"/>
            <div className="flex-1">{generateError}</div>
          </div>
        )}

        {fillsRunning && fillProgress.note && (
          <div className="bg-fuchsia-500/10 border border-fuchsia-500/30 text-fuchsia-200 text-xs p-2 rounded flex items-start gap-2">
            <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin"/>
            <div className="flex-1">
              <div className="font-medium">Generating fill {fillProgress.current}/{fillProgress.total}…</div>
              <div className="opacity-80 line-clamp-2">{fillProgress.note}</div>
            </div>
          </div>
        )}

        {fillErrors.length > 0 && (
          <div className="bg-red-900/20 border border-red-500/40 text-red-300 text-xs p-2 rounded">
            <div className="font-medium mb-1">{fillErrors.length} fill{fillErrors.length === 1 ? '' : 's'} failed:</div>
            <ul className="space-y-0.5 list-disc list-inside max-h-32 overflow-y-auto">
              {fillErrors.map((f, i) => (
                <li key={i}><span className="text-sf-text-muted/80 font-mono">{f.placeholderId}:</span> {f.error}</li>
              ))}
            </ul>
          </div>
        )}

        {/* EDL */}
        {edl.length > 0 && (
          <section className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="flex items-center px-3 py-2 border-b border-sf-dark-700">
              <div className="text-xs font-medium">Edit decision list</div>
              <div className="ml-2 text-[10px] text-sf-text-muted">({edl.length} shots)</div>
              <div className="ml-auto flex items-center gap-2">
                {placeholderRowsTotal > 0 && (
                  <>
                    <select
                      value={fillModelId}
                      onChange={(e) => handlePickFillModel(e.target.value)}
                      disabled={fillsRunning}
                      title={FILL_MODELS.find((m) => m.id === fillModelId)?.blurb || ''}
                      className="bg-sf-dark-800 border border-sf-dark-700 text-sf-text-primary text-[11px] rounded px-2 py-1 focus:outline-none focus:border-sf-accent disabled:opacity-50"
                    >
                      {FILL_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleGenerateFills}
                      disabled={fillsRunning || placeholderRowsNeedingFill.length === 0}
                      className="px-2.5 py-1 rounded bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] flex items-center gap-1.5 disabled:opacity-50"
                      title={
                        placeholderRowsNeedingFill.length === 0
                          ? 'All placeholders already have a generated fill. Use the per-row Re-gen button to refresh one.'
                          : `Generate ${placeholderRowsNeedingFill.length} fill${placeholderRowsNeedingFill.length === 1 ? '' : 's'} on Comfy Cloud.`
                      }
                    >
                      {fillsRunning
                        ? <Loader2 size={11} className="animate-spin"/>
                        : <Wand2 size={11}/>}
                      {fillsRunning
                        ? `Generating ${fillProgress.current}/${fillProgress.total}…`
                        : placeholderRowsNeedingFill.length === 0
                          ? `Fills ready (${placeholderRowsTotal})`
                          : `Generate fills (${placeholderRowsNeedingFill.length})`}
                    </button>
                  </>
                )}
                <button
                  onClick={handleApply}
                  disabled={applying}
                  className="px-2.5 py-1 rounded bg-green-600 hover:bg-green-500 text-white text-[11px] flex items-center gap-1.5 disabled:opacity-50"
                >
                  {applying ? <Loader2 size={11} className="animate-spin"/> : <ArrowRight size={11}/>}
                  {applying ? 'Applying…' : 'Apply to timeline'}
                </button>
              </div>
            </div>
            {applyOk && (
              <div className="px-3 py-1.5 bg-green-900/20 text-green-300 text-[11px] border-b border-green-500/30 inline-flex items-center gap-1">
                <CheckCircle2 size={11}/> Applied. Switch to the Editor tab to fine-tune.
              </div>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase text-sf-text-muted bg-sf-dark-900/50">
                  <th className="px-2 py-1.5 text-left w-8">#</th>
                  <th className="px-2 py-1.5 text-left w-32">Frame</th>
                  <th className="px-2 py-1.5 text-left w-32">In → Out</th>
                  <th className="px-2 py-1.5 text-left w-28">Source</th>
                  <th className="px-2 py-1.5 text-left">Voiceover</th>
                  <th className="px-2 py-1.5 text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {edlRows.map((row) => {
                  const thumb = row.sceneRef?.thumbnail
                    ? toComfyUrl(row.sceneRef.thumbnail, analysis?.captionedAt || analysis?.createdAt)
                    : null
                  const dur = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
                  return (
                    <tr key={`${row.sourceSceneId || 'add'}-${row.index}`}
                        className={`border-t border-sf-dark-800 ${row.excluded ? 'opacity-40' : ''}`}>
                      <td className="px-2 py-1.5 align-top text-sf-text-muted">{row.index + 1}</td>
                      <td className="px-2 py-1.5 align-top">
                        <div className="w-28 h-16 bg-black border border-sf-dark-800 rounded overflow-hidden flex items-center justify-center relative">
                          {(() => {
                            // Placeholder thumbnail logic:
                            //   1. If the fill has been generated, show the video itself (will poster on mp4).
                            //   2. If the placeholder has a referenceFrame, use that as the thumbnail.
                            //   3. Else fall back to the Wand2 icon (LLM picked nothing).
                            if (row.kind === 'placeholder') {
                              const pid = placeholderIdFor(row)
                              const fill = fills[pid]
                              if (fill?.path) {
                                return <video src={toComfyUrl(fill.path, fill.createdAt)} muted preload="metadata" className="w-full h-full object-cover"/>
                              }
                              const refSceneId = row.referenceFrame?.sourceSceneId
                              const refScene = refSceneId ? scenes.find((s) => s.id === refSceneId) : null
                              const refThumb = refScene?.thumbnail
                                ? toComfyUrl(refScene.thumbnail, analysis?.captionedAt || analysis?.createdAt)
                                : null
                              return refThumb
                                ? <img src={refThumb} alt="" className="w-full h-full object-cover opacity-70"/>
                                : <Wand2 size={18} className="text-fuchsia-400"/>
                            }
                            return thumb
                              ? <img src={thumb} alt="" className="w-full h-full object-cover"/>
                              : <span className="text-[10px] text-sf-text-muted">—</span>
                          })()}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 align-top font-mono text-[10px] text-sf-text-muted">
                        <div>{formatTc(row.newTcIn)}</div>
                        <div>→ {formatTc(row.newTcOut)}</div>
                        {dur > 0 && <div className="text-sf-text-muted/70">{dur.toFixed(2)}s</div>}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        {row.kind === 'placeholder'
                          ? (() => {
                              const pid = placeholderIdFor(row)
                              const fill = fills[pid]
                              const busy = singleFillBusy[pid]
                              const err = singleFillError[pid]
                              const versions = fillVersionList(fill)
                              const activeIdx = versions.length
                                ? Math.max(0, versions.findIndex((v) => v.id === activeFillVersionId(fill)))
                                : -1
                              return (
                                <div className="flex flex-col gap-1">
                                  {fill?.path
                                    ? (
                                        <span className="inline-flex items-center gap-1 text-emerald-300 text-[11px]" title={`Generated via ${fill.modelId || 'i2v'}`}>
                                          <CheckCircle2 size={10}/> Fill ready
                                        </span>
                                      )
                                    : (
                                        <span className="inline-flex items-center gap-1 text-fuchsia-300 text-[11px]">
                                          <Wand2 size={10}/> AI fill
                                        </span>
                                      )
                                  }
                                  {row.referenceFrame?.sourceSceneId && (
                                    <span className="text-sf-text-muted/70 text-[10px]">ref {row.referenceFrame.sourceSceneId}</span>
                                  )}
                                  {/* Per-row Generate / Re-gen — independent of
                                      the bulk button. Same model is used for
                                      both unless the user changes the dropdown. */}
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => handleGenerateRow(row, row.index)}
                                      disabled={busy || fillsRunning || !row.referenceFrame?.sourceSceneId}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-200 text-[10px] disabled:opacity-40 disabled:cursor-not-allowed w-fit"
                                      title={fill?.path
                                        ? `Regenerate this fill with ${FILL_MODELS.find((m) => m.id === fillModelId)?.label || fillModelId}.`
                                        : `Generate this fill with ${FILL_MODELS.find((m) => m.id === fillModelId)?.label || fillModelId}.`
                                      }
                                    >
                                      {busy
                                        ? <Loader2 size={9} className="animate-spin"/>
                                        : <Wand2 size={9}/>}
                                      {busy ? '…' : (fill?.path ? 'Re-gen' : 'Generate')}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setFillDetails(row.index)}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sf-dark-600 bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-secondary hover:text-sf-text-primary text-[10px] w-fit"
                                      title="Edit prompt & manage versions"
                                    >
                                      <Pencil size={9}/> Prompt
                                    </button>
                                  </div>
                                  {versions.length > 1 && (
                                    <div className="flex items-center gap-1 text-[10px] text-sf-text-secondary" title="Switch generated version (lands on timeline on Apply)">
                                      <button type="button" onClick={() => stepFillVersion(row.index, -1)} className="px-1 rounded hover:bg-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary">‹</button>
                                      <span className="tabular-nums">v{activeIdx + 1}/{versions.length}</span>
                                      <button type="button" onClick={() => stepFillVersion(row.index, 1)} className="px-1 rounded hover:bg-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary">›</button>
                                    </div>
                                  )}
                                  {err && <span className="text-rose-300 text-[10px] line-clamp-2">{err}</span>}
                                </div>
                              )
                            })()
                          : (row.sceneRef
                              ? <span className="text-sf-text-primary text-[11px]">Shot {row.sceneRef.id}</span>
                              : <span className="text-sf-text-muted text-[11px]">—</span>)
                        }
                      </td>
                      <td className="px-2 py-1.5 align-top text-[11px] text-sf-text-secondary leading-snug">
                        {row.voLines && row.voLines.length > 0 ? (
                          <div className="space-y-0.5">
                            {row.voLines.map((line, i) => (
                              <div key={i} className="italic text-emerald-200/90">"{line}"</div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-sf-text-muted/50">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-top text-[11px] text-sf-text-secondary leading-snug">
                        {(() => {
                          const { directives, body } = parseNoteDirectives(row.note || row.rationale || '')
                          return (
                            <div className="space-y-1">
                              {directives.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {directives.map((d, i) => (
                                    <span
                                      key={i}
                                      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono ${DIRECTIVE_COLOR[d.kind] || 'bg-sf-dark-700/60 text-sf-text-muted border-sf-dark-600'}`}
                                    >
                                      {d.text}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {body && <div>{body}</div>}
                            </div>
                          )
                        })()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {proposal?.rationale && (
              <div className="px-3 py-2 border-t border-sf-dark-700 text-[11px] text-sf-text-muted whitespace-pre-wrap">
                {proposal.rationale}
              </div>
            )}
          </section>
        )}

      </div>

      {fillDetails != null && (() => {
        const rowArrayIndex = fillDetails
        const raw = edl[rowArrayIndex]
        if (!raw) return null
        const detailRow = { ...raw, index: rowArrayIndex }
        const pid = placeholderIdFor(detailRow)
        return (
          <FillDetailsModal
            isOpen
            row={detailRow}
            fill={fills[pid]}
            modelId={fillModelId}
            busy={Boolean(singleFillBusy[pid])}
            error={singleFillError[pid] || null}
            canGenerate={Boolean(raw.referenceFrame?.sourceSceneId)}
            sourceVideo={sourceVideo}
            onPickModel={handlePickFillModel}
            onSavePrompt={(text) => writeRowField(rowArrayIndex, { fillPrompt: text })}
            onGenerate={(text) => handleGenerateFromModal(rowArrayIndex, text)}
            onSwitchVersion={(vid) => setFillVersion(rowArrayIndex, vid)}
            onDeleteVersion={(vid) => deleteFillVersion(rowArrayIndex, vid)}
            onClose={() => setFillDetails(null)}
          />
        )
      })()}
    </div>
  )
}
