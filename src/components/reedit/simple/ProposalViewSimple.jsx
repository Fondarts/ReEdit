import { useEffect, useMemo, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, FileText, CheckCircle2,
  ArrowRight, Wand2, Mic, Music, Layers, Upload, ChevronDown, ChevronUp,
} from 'lucide-react'
import useProjectStore from '../../../stores/projectStore'
import { generateProposal } from '../../../services/reeditProposer'
import { parseSundogsReport } from '../../../services/reeditSundogsReport'
import { applyEdlToTimeline } from '../../../services/reeditEdlToTimeline'
import {
  loadCapabilities as loadProposalCapabilities,
  saveCapabilities as saveProposalCapabilities,
  CAPABILITY_DEFINITIONS,
  DEFAULT_CAPABILITIES,
} from '../../../services/reeditProposalCapabilities'
import { pickVisionModelId } from '../../../services/reeditCaptioner'
import SundogsDimensionSection, { DeltaPill } from '../sundogs/SundogsDimensionSection'
import { SUNDOGS_TECHNIQUES } from '../../../services/reeditSundogsReport'

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

  // Local form state. Pre-fill from existing proposal so a re-generation
  // keeps the user's last choices visible.
  const [targetDurationSec, setTargetDurationSec] = useState(
    proposal?.targetDurationSec ?? sourceVideo?.duration ?? 30
  )
  const [extraInstructions, setExtraInstructions] = useState(proposal?.extraInstructions || '')
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

  async function handleApply() {
    if (applying || edl.length === 0) return
    setApplying(true)
    setApplyOk(false)
    try {
      await applyEdlToTimeline()
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
  const edlRows = useMemo(() => {
    return edl.map((row, i) => ({
      ...row,
      index: i,
      sceneRef: scenes.find((s) => s.id === row.sourceSceneId) || null,
    }))
  }, [edl, scenes])

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

            {/* Extra instructions */}
            <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg p-3">
              <label className="text-[10px] uppercase tracking-wider text-sf-text-muted block mb-1">Extra instructions</label>
              <textarea
                value={extraInstructions}
                onChange={(e) => setExtraInstructions(e.target.value)}
                rows={3}
                placeholder="Required shots, tone, pacing, brand cues…"
                className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1.5 text-sm resize-none"
              />
            </div>
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
                value={targetDurationSec}
                onChange={(e) => setTargetDurationSec(Number(e.target.value) || 0)}
                className="bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-sm w-full"
              />
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

        {/* EDL */}
        {edl.length > 0 && (
          <section className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="flex items-center px-3 py-2 border-b border-sf-dark-700">
              <div className="text-xs font-medium">Edit decision list</div>
              <div className="ml-2 text-[10px] text-sf-text-muted">({edl.length} shots)</div>
              <div className="ml-auto flex items-center gap-2">
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
                        <div className="w-28 h-16 bg-black border border-sf-dark-800 rounded overflow-hidden flex items-center justify-center">
                          {thumb
                            ? <img src={thumb} alt="" className="w-full h-full object-cover"/>
                            : row.kind === 'placeholder'
                              ? <Wand2 size={18} className="text-fuchsia-400"/>
                              : <span className="text-[10px] text-sf-text-muted">—</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 align-top font-mono text-[10px] text-sf-text-muted">
                        <div>{formatTc(row.newTcIn)}</div>
                        <div>→ {formatTc(row.newTcOut)}</div>
                        {dur > 0 && <div className="text-sf-text-muted/70">{dur.toFixed(2)}s</div>}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        {row.kind === 'placeholder'
                          ? <span className="inline-flex items-center gap-1 text-fuchsia-300 text-[11px]"><Wand2 size={10}/> Generated</span>
                          : (row.sceneRef
                              ? <span className="text-sf-text-primary text-[11px]">Shot {row.sceneRef.id}</span>
                              : <span className="text-sf-text-muted text-[11px]">—</span>)
                        }
                      </td>
                      <td className="px-2 py-1.5 align-top text-[11px] text-sf-text-secondary leading-snug">
                        {row.note || row.rationale || ''}
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
    </div>
  )
}
