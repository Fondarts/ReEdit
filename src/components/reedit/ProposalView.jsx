import { useMemo, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, Save, RotateCcw,
  ArrowUp, ArrowDown, Trash2, CheckCircle2, Film,
} from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { generateProposal, PROPOSAL_METRICS } from '../../services/reeditProposer'
import { applyEdlToTimeline } from '../../services/reeditEdlToTimeline'

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

  const sourceVideo = currentProject?.sourceVideo
  const analysis = currentProject?.analysis
  const scenes = analysis?.scenes || []
  const savedProposal = currentProject?.proposal || null

  // Local draft copy. Includes the whole proposal envelope (rationale,
  // edl, metric, model). Inputs (brandBrief, metric) reflect the
  // last-used values so Re-generate doesn't silently pick up stale
  // choices from a previous session.
  const [draft, setDraft] = useState(savedProposal)
  const [brandBrief, setBrandBrief] = useState(savedProposal?.brandBrief || '')
  const [metric, setMetric] = useState(savedProposal?.metric || 'Comprehension')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)

  const [applying, setApplying] = useState(false)
  const [applyProgress, setApplyProgress] = useState({ current: 0, total: 0 })
  const [applyResult, setApplyResult] = useState(null)

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
      const proposal = await generateProposal({
        scenes,
        brandBrief,
        metric,
        totalDurationSec: sourceVideo.duration || null,
      })
      setDraft(proposal)
    } catch (err) {
      console.error('[reedit] proposal generation failed:', err)
      setError(err?.message || 'Proposal generation failed.')
    } finally {
      setGenerating(false)
    }
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
  const updateRationale = (rationale) => {
    setDraft((prev) => (prev ? { ...prev, rationale } : prev))
  }

  const saveDraft = async () => {
    if (!draft) return
    await saveProject({ proposal: { ...draft, brandBrief, metric, status: 'draft' } })
  }

  const discardDraft = () => {
    setDraft(savedProposal)
    setBrandBrief(savedProposal?.brandBrief || '')
    setMetric(savedProposal?.metric || 'Comprehension')
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
        onProgress: ({ index, total }) => {
          setApplyProgress({ current: index, total })
        },
      })
      await saveProject({
        proposal: {
          ...draft,
          brandBrief,
          metric,
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

  const selectedMetric = PROPOSAL_METRICS.find((m) => m.id === metric) || PROPOSAL_METRICS[0]
  const isDirty = draft && draft !== savedProposal
  const edl = draft?.edl || []
  const placeholderCount = edl.filter((r) => r.kind === 'placeholder').length
  const originalCount = edl.length - placeholderCount

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
                ? `${edl.length} edits (${originalCount} original · ${placeholderCount} new) · optimized for ${draft.metric} · ${draft.model}`
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
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
              {PROPOSAL_METRICS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMetric(m.id)}
                  className={`text-left p-3 rounded-lg border transition-colors
                    ${metric === m.id
                      ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                      : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                >
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-[10px] leading-snug mt-1 opacity-80">{m.blurb}</div>
                </button>
              ))}
            </div>

            <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">Brand brief (optional)</label>
            <textarea
              value={brandBrief}
              onChange={(e) => setBrandBrief(e.target.value)}
              placeholder="E.g. Nissan Armada, focus on brand presence in the first 5s, emphasize the Invisible Hood View as the hero feature, highlight towing capability and the 'most capable Armada ever' line."
              rows={3}
              className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent resize-none"
            />

            <div className="mt-4 flex items-center gap-3">
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
              <span className="text-[11px] text-sf-text-muted">{selectedMetric.blurb}</span>
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
                    <th className="text-left px-3 py-2 font-medium w-[100px]">Source</th>
                    <th className="text-left px-3 py-2 font-medium w-[72px]">In</th>
                    <th className="text-left px-3 py-2 font-medium w-[72px]">Out</th>
                    <th className="text-left px-3 py-2 font-medium w-[60px]">Dur</th>
                    <th className="text-left px-3 py-2 font-medium">Rationale</th>
                    <th className="text-left px-3 py-2 font-medium w-[108px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {edl.map((row, i) => {
                    const dur = (row.newTcOut || 0) - (row.newTcIn || 0)
                    const sourceScene = row.sourceSceneId ? sceneById.get(row.sourceSceneId) : null
                    return (
                      <tr key={`${row.index}-${i}`} className="border-t border-sf-dark-800 align-top">
                        <td className="px-3 py-2 text-sf-text-muted tabular-nums">{row.index}</td>
                        <td className="px-3 py-2"><KindBadge kind={row.kind} /></td>
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
                          </div>
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
    </div>
  )
}

export default ProposalView
