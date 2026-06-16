/**
 * Review tab — two-column A/B between the original cut + Sundogs PDF
 * report on the left, and the new (edited) cut + an AI-generated review
 * using the same Sundogs framework on the right.
 *
 * The AI side carries a visible disclaimer that it's an INTERNAL
 * approximation, not a real Sundogs run. Wording: "Internal analysis —
 * Sundogs integration coming soon."
 *
 * Player + analysis are independent on each side: native `<video controls>`
 * for each video (so the user can scrub one without affecting the other),
 * and a separate vertically-scrolling panel below for the report data.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Sparkles, Loader2, AlertCircle, Info } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import useTimelineStore from '../../stores/timelineStore'
import SundogsReportPanel from './sundogs/SundogsReportPanel'
import SundogsDimensionSection, { DeltaPill } from './sundogs/SundogsDimensionSection'
import { SUNDOGS_TECHNIQUES, parseSundogsReport } from '../../services/reeditSundogsReport'
import { generateAiSundogsReview } from '../../services/reeditSundogsReview'
import { exportTimeline } from '../../services/exporter'
import AdReportPanel from './AdReportPanel'
import { isGeminiReportMode } from '../../services/reeditReportSource'
import { generateAdReport } from '../../services/reeditAdReport'

// Same helper the other views use to point a <video> at a project asset.
function toComfyUrl(filePath, version) {
  if (!filePath) return null
  const base = `comfystudio://${encodeURIComponent(filePath)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

// Fingerprint of the current timeline. Used to decide whether Evaluate
// should re-render the preview MP4 (timeline changed) or just re-run
// Gemini on the cached preview (timeline unchanged).
//
// Stays narrow on purpose — only fields that change the rendered pixels
// (clip identity, placement, trim, ordering). We deliberately DO NOT
// include `transform` / `adjustments` / `volume`: those are objects
// whose key ordering, default-value handling, and reference identity
// can flip between renders without any user-visible change. Including
// them was busting the cache on every Evaluate. Project fps/dims also
// go in because changing them invalidates the rendered file.
function computeTimelineFingerprint(clips, settings) {
  const minimal = (clips || []).map((c) => ({
    id: c.id,
    a: c.assetId || null,
    t: c.type || null,
    tr: c.trackId || null,
    s: Number((c.startTime || 0).toFixed(3)),
    d: Number((c.duration || 0).toFixed(3)),
    ts: Number((c.trimStart || 0).toFixed(3)),
    te: Number((c.trimEnd || 0).toFixed(3)),
  }))
  // Sort by track + start so reordering inside an array (without
  // changing the actual placement) doesn't show up as a "change".
  minimal.sort((a, b) =>
    String(a.tr || '').localeCompare(String(b.tr || '')) || a.s - b.s
  )
  return JSON.stringify({
    clips: minimal,
    fps: Number(settings?.fps) || 24,
    w: Number(settings?.width) || 1920,
    h: Number(settings?.height) || 1080,
  })
}

// Pick the "new cut" video path. Priority order:
//   1. `project.reviewPreview.path` — the auto-rendered preview this tab
//      writes when it first opens. Always freshest because we re-render
//      it whenever the user hits Regenerate.
//   2. The most-recently produced user-driven export (`project.exports[]`).
// We deliberately don't fall back to the source video — that would
// defeat the A/B purpose of this tab.
function pickNewCutPath(project) {
  const preview = project?.reviewPreview?.path
  if (preview) return preview
  const exports = Array.isArray(project?.exports) ? project.exports : []
  if (exports.length === 0) return null
  const sorted = [...exports].sort((a, b) => {
    const ta = new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime()
    return Number.isFinite(ta) ? ta : 0
  })
  return sorted[0]?.path || null
}

// Card with title bar + video player below. Used twice — once per column.
function VideoPlayerCard({ title, accent = 'text-sf-text-secondary', src, emptyHint }) {
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 overflow-hidden flex flex-col">
      <div className={`flex items-center justify-between px-3 py-1.5 border-b border-sf-dark-800 bg-sf-dark-900/80 text-[10px] uppercase tracking-wider ${accent}`}>
        <span>{title}</span>
      </div>
      <div className="bg-black aspect-video flex items-center justify-center">
        {src ? (
          <video
            key={src}
            src={src}
            controls
            preload="metadata"
            className="max-w-full max-h-full"
          />
        ) : (
          <div className="text-xs text-sf-text-muted px-4 text-center leading-snug">
            {emptyHint}
          </div>
        )}
      </div>
    </div>
  )
}

// Render of the Sundogs-shaped report body, reused for both the PDF
// report and the AI-generated one. Kept inline so we don't have to
// touch SundogsReportPanel just to give it a different header.
function ReportBody({ report }) {
  if (!report) return null
  const o = report.overall || {}
  return (
    <div className="p-3 space-y-2">
      <SundogsDimensionSection
        name="Attention"
        headlineDelta={report.attention?.deltas?.overall ?? o.deltas?.attention}
        windowEntries={[
          { label: 'First 5s', window: report.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'first5' },
          { label: 'Overall', window: report.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'overall' },
          { label: 'Last 5s', window: report.attention, techniqueIds: SUNDOGS_TECHNIQUES.attention, deltaKey: 'last5' },
        ]}
      />
      <SundogsDimensionSection
        name="Comprehension"
        headlineDelta={report.comprehension?.branding?.deltas?.overall ?? o.deltas?.comprehension}
        windowEntries={[
          { label: 'Branding · First 5s', window: report.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'first5' },
          { label: 'Branding · Overall',  window: report.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'overall' },
          { label: 'Branding · Last 5s',  window: report.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'last5' },
          { label: 'Product',             window: report.comprehension?.product,  techniqueIds: SUNDOGS_TECHNIQUES.comprehension_product, deltaKey: null },
        ]}
      />
      <SundogsDimensionSection
        name="Persuasion"
        headlineDelta={report.persuasion?.emotional?.deltas?.overall ?? o.deltas?.persuasion}
        windowEntries={[
          { label: 'Emotional · First 5s', window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'first5' },
          { label: 'Emotional · Overall',  window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'overall' },
          { label: 'Emotional · Last 5s',  window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'last5' },
        ]}
      />
      <SundogsDimensionSection
        name="Action"
        headlineDelta={report.action?.deltas?.overall ?? o.deltas?.action}
        windowEntries={[
          { label: 'Overall', window: report.action, techniqueIds: SUNDOGS_TECHNIQUES.action, deltaKey: 'overall' },
          { label: 'Last 5s', window: report.action, techniqueIds: SUNDOGS_TECHNIQUES.action, deltaKey: 'last5' },
        ]}
      />
    </div>
  )
}

// Right-hand AI review panel. Carries the "internal analysis" disclaimer,
// the Regenerate button, current pipeline stage (rendering / analyzing),
// error state, and the same report body the left side uses so the two
// columns line up visually.
function AiReviewPanel({ report, stage, progress, error, onEvaluate }) {
  const has = Boolean(report)
  const o = report?.overall || {}
  const busy = stage === 'rendering' || stage === 'analyzing'
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40">
      {/* Header */}
      <div className="flex items-start gap-3 px-3 py-2 border-b border-sf-dark-800">
        <Sparkles className="w-4 h-4 text-violet-300 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-medium text-sf-text-primary">AI review</span>
            {has && Number.isFinite(o.finalScorePct) && Number.isFinite(o.benchmarkPct) && (
              <span className="text-[12px] text-sf-text-primary/90 tabular-nums">
                {o.finalScorePct}% <span className="text-sf-text-muted">vs {o.benchmarkPct}% benchmark</span>
              </span>
            )}
          </div>
          {has ? (
            <div className="flex flex-wrap gap-1.5 mb-1">
              <DeltaPill delta={o.deltas?.attention} label="ATT" />
              <DeltaPill delta={o.deltas?.comprehension} label="COMP" />
              <DeltaPill delta={o.deltas?.persuasion} label="PERS" />
              <DeltaPill delta={o.deltas?.action} label="ACT" />
            </div>
          ) : (
            <div className="text-[12px] text-sf-text-muted">
              An in-house Gemini review of the new cut using the same four-dimension framework Sundogs uses.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onEvaluate}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary border border-sf-dark-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          title="Run the AI review. Re-renders the preview only if the timeline changed since the last evaluate."
        >
          {busy
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Sparkles className="w-3.5 h-3.5" />}
          Evaluate
        </button>
      </div>

      {/* Pipeline status — shown when actively rendering or analyzing. */}
      {stage === 'rendering' && (
        <div className="flex items-center gap-2 px-3 py-2 bg-sky-500/10 border-b border-sky-500/30 text-[12px] text-sky-200">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="flex-1">Rendering preview… {Number.isFinite(progress) ? `${Math.round(progress)}%` : ''}</span>
        </div>
      )}
      {stage === 'analyzing' && (
        <div className="flex items-center gap-2 px-3 py-2 bg-violet-500/10 border-b border-violet-500/30 text-[12px] text-violet-200">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="flex-1">Analyzing with Gemini…</span>
        </div>
      )}

      {/* "Internal analysis" disclaimer — visible whether or not the
          report exists so the user knows this isn't a real Sundogs run. */}
      <div className="flex items-start gap-2 px-3 py-2 bg-violet-500/10 border-b border-violet-500/30 text-[11px] text-violet-100">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          <span className="font-medium">Internal analysis</span> — Sundogs integration in the roadmap.
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-rose-500/10 border-b border-rose-500/30 text-[12px] text-rose-300">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {has && <ReportBody report={report} />}

      {!has && !error && !busy && (
        <div className="px-3 py-6 text-center text-[12px] text-sf-text-muted">
          The first time you open Review we render a preview of the timeline and analyze it automatically.
        </div>
      )}
    </div>
  )
}

export default function ReviewView() {
  const currentProject       = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject          = useProjectStore((s) => s.saveProject)

  const sourceVideo   = currentProject?.sourceVideo
  const sundogsReport = currentProject?.sundogsReport || null
  // A second Sundogs PDF the user can attach for the NEW cut — they
  // rendered the new edit, ran it through Sundogs externally, and want
  // to compare the real scoring against (or alongside) our AI review.
  // Persisted as its own field so importing it doesn't clobber the
  // original-cut report that the proposer is keyed on.
  const newCutReport  = currentProject?.sundogsReportNewCut || null
  const aiReview      = currentProject?.aiSundogsReview || null
  const reviewPreview = currentProject?.reviewPreview || null
  // Gemini report-source mode: the original ad report (from the Projects
  // tab) and the new-cut ad report (re-scored here on Evaluate). When the
  // toggle is 'gemini' these replace the Sundogs PDF columns.
  const geminiMode    = isGeminiReportMode()
  const adReport       = currentProject?.adReport || null
  const adReportNewCut = currentProject?.adReportNewCut || null

  // PDF picker state for the new-cut report. Mirrors the lucky / proposal
  // import flows (parse via Gemini → save under its own project field).
  const [importingNewCut, setImportingNewCut] = useState(false)
  const [newCutImportError, setNewCutImportError] = useState(null)

  const handlePickNewCutPdf = async (file) => {
    if (!file) return
    setImportingNewCut(true)
    setNewCutImportError(null)
    try {
      const report = await parseSundogsReport({ file })
      await saveProject({ sundogsReportNewCut: report })
    } catch (err) {
      console.error('[reedit] new-cut Sundogs PDF import failed:', err)
      setNewCutImportError(err?.message || 'Sundogs PDF import failed.')
    } finally {
      setImportingNewCut(false)
    }
  }

  const newCutPath = useMemo(() => pickNewCutPath(currentProject), [currentProject])

  // Pipeline stage drives the inline banner inside AiReviewPanel.
  //   idle      → nothing running
  //   rendering → exporter is producing the preview MP4
  //   analyzing → Gemini is scoring the rendered MP4
  //   error     → handleEvaluate threw; surface the message
  const [stage, setStage] = useState('idle')
  const [renderProgress, setRenderProgress] = useState(0)
  const [error, setError] = useState(null)
  // First-time auto-run guard. Without this React's StrictMode would
  // fire the mount effect twice in dev and we'd start two renders.
  const autoRanRef = useRef(false)

  // Clear the error banner when the project switches.
  useEffect(() => {
    setError(null)
    autoRanRef.current = false
  }, [currentProject?.name])

  // Render a preview of the current timeline to a deterministic path
  // under the project. Reused by both auto-run and the manual
  // Regenerate button.
  //
  // Why we don't render at full project resolution: Gemini's inline
  // video upload caps at ~19 MB and its tokenizer charges per frame at
  // full resolution. Downscaling the preview to ~720p with a high CRF
  // keeps the file well under that limit and drops the token cost
  // enough that 500-rate explosions on the Gemini side become rare.
  // The user still has the real-resolution export from the Export tab
  // when they need the deliverable.
  const renderPreview = async () => {
    if (!currentProjectHandle || typeof currentProjectHandle !== 'string') {
      throw new Error('Project folder unavailable — cannot render preview.')
    }
    const settings = currentProject?.settings || {}
    const fps = Number(settings.fps) || 24
    // Fit-inside 1280×720 preserving aspect. Audio stays on — Sundogs
    // dimensions (Attention / Comprehension / Persuasion) lean on VO
    // + music cues, so stripping it would skew the AI review.
    const srcW = Number(settings.width)  || 1920
    const srcH = Number(settings.height) || 1080
    const aspect = srcW / srcH
    let width, height
    if (aspect >= 1280 / 720) {
      width = Math.min(1280, srcW)
      height = Math.round(width / aspect / 2) * 2
    } else {
      height = Math.min(720, srcH)
      width = Math.round(height * aspect / 2) * 2
    }
    const previewDir = await window.electronAPI.pathJoin(currentProjectHandle, '.reedit')
    await window.electronAPI.createDirectory(previewDir)
    const outputPath = await window.electronAPI.pathJoin(previewDir, 'review_preview.mp4')

    setRenderProgress(0)
    await exportTimeline(
      {
        fps, width, height,
        format: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        qualityMode: 'crf',
        crf: 28,                  // ~720p @ CRF 28 keeps 30s ads well under 10 MB
        preset: 'fast',
        audioBitrateKbps: 96,
        includeAudio: true,
        useCachedRenders: true,
        outputPath,               // bypasses the save dialog
        filename: 'review_preview',
      },
      ({ progress }) => {
        if (Number.isFinite(progress)) setRenderProgress(progress)
      }
    )

    // Stash the timeline fingerprint with the preview so a later
    // Evaluate click can skip rendering when nothing changed.
    const tlState = useTimelineStore.getState()
    const fingerprint = computeTimelineFingerprint(tlState.clips, settings)
    await saveProject({
      reviewPreview: {
        path: outputPath,
        createdAt: new Date().toISOString(),
        fingerprint,
      },
    })
    return outputPath
  }

  // Evaluate = render + analyze pipeline. The render step is skipped
  // when the cached preview's fingerprint matches the live timeline —
  // saves multiple minutes when the user only wants to re-run Gemini
  // (e.g. the previous AI call 500ed and they want to retry, or they
  // tweaked the Sundogs report rather than the timeline).
  const handleEvaluate = async () => {
    if (stage === 'rendering' || stage === 'analyzing') return
    setError(null)
    try {
      let previewPath = reviewPreview?.path
      const liveFingerprint = computeTimelineFingerprint(
        useTimelineStore.getState().clips,
        currentProject?.settings || {},
      )
      const cachedFingerprint = reviewPreview?.fingerprint
      const needsRender = !previewPath || cachedFingerprint !== liveFingerprint
      if (needsRender) {
        // Leave a trail in the console so the user can see *why* we
        // didn't reuse the cached preview when they expected to. Most
        // common reason in practice: the preview was rendered before
        // we started persisting the fingerprint, so `cachedFingerprint`
        // is `undefined` on first Evaluate. The next render will store
        // a real fingerprint and subsequent Evaluates skip rendering.
        const reason = !previewPath
          ? 'no cached preview path'
          : !cachedFingerprint
            ? 'cached preview has no fingerprint (rendered before fingerprinting landed)'
            : 'timeline changed since last render'
        console.log(`[ReviewView] re-rendering preview: ${reason}`)
        console.log('  cached fingerprint:', cachedFingerprint)
        console.log('  live fingerprint:  ', liveFingerprint)
        setStage('rendering')
        previewPath = await renderPreview()
      } else {
        console.log('[ReviewView] reusing cached preview — timeline unchanged.')
      }
      setStage('analyzing')
      if (geminiMode) {
        // Gemini report-source mode: re-score the new cut on the same
        // axes as the original ad report so the two are comparable.
        const newReport = await generateAdReport({
          videoPath: previewPath,
          originalReport: adReport,
          taskHint: 'review',
        })
        await saveProject({ adReportNewCut: newReport })
      } else {
        const review = await generateAiSundogsReview({
          videoPath: previewPath,
          originalReport: sundogsReport,
        })
        await saveProject({ aiSundogsReview: review })
      }
      setStage('idle')
    } catch (err) {
      console.error('[reedit] AI review pipeline failed:', err)
      // Translate the raw Gemini error into something actionable.
      // 500s mean the model service is hiccuping — invite a retry rather
      // than making the user re-read the stacktrace.
      let msg = err?.message || 'AI review pipeline failed.'
      if (/Gemini API 5\d\d/.test(msg)) {
        msg = `Gemini is overloaded right now (${msg.replace(/^.*Gemini API /, 'HTTP ')}). Wait a few seconds and click Evaluate again — the preview MP4 is cached so retries are cheap.`
      }
      setError(msg)
      setStage('idle')
    }
  }

  // Auto-run the pipeline the first time the user opens Review on a
  // project that doesn't have a preview + review yet. The clipsExist
  // check keeps it from firing on empty projects where the export
  // would just produce a black frame.
  const clipsCount = useTimelineStore((s) => s.clips?.length || 0)
  useEffect(() => {
    if (autoRanRef.current) return
    if (!currentProject) return
    if (stage !== 'idle') return
    if (clipsCount === 0) return
    const alreadyDone = geminiMode ? Boolean(adReportNewCut) : Boolean(aiReview)
    if (alreadyDone && reviewPreview?.path) return  // already done
    autoRanRef.current = true
    // Fire-and-forget; handleEvaluate manages its own state.
    handleEvaluate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.name, clipsCount, geminiMode, Boolean(aiReview), Boolean(adReportNewCut), Boolean(reviewPreview?.path)])

  if (!currentProject) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Open a project to use Review.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1600px] mx-auto p-6">
        <div className="mb-4">
          <h1 className="text-base font-semibold text-sf-text-primary mb-0.5">Review</h1>
          <p className="text-xs text-sf-text-muted">
            Side-by-side check of the original cut vs. the new cut, with their respective Sundogs analyses.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ─── Left column: original ─── */}
          <div className="space-y-3">
            <VideoPlayerCard
              title="Original cut"
              accent="text-amber-300"
              src={toComfyUrl(sourceVideo?.path)}
              emptyHint="No source video imported yet."
            />
            {geminiMode ? (
              adReport ? (
                <AdReportPanel report={adReport} title="Ad report — original" />
              ) : (
                <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 p-6 text-center text-[12px] text-sf-text-muted">
                  <Sparkles className="w-5 h-5 mx-auto mb-2 text-violet-400/70" />
                  <div>No Gemini ad report yet. Generate it from the Projects tab to populate this side.</div>
                </div>
              )
            ) : sundogsReport ? (
              <SundogsReportPanel
                report={sundogsReport}
                importing={false}
                error={null}
                onPickFile={() => { /* swapping the PDF from here would
                  steamroll the original; do that from the Proposal tab */ }}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 p-6 text-center text-[12px] text-sf-text-muted">
                <FileText className="w-5 h-5 mx-auto mb-2 text-amber-400/70" />
                <div>No Sundogs PDF imported. Drop it from the Proposal tab to populate this side.</div>
              </div>
            )}
          </div>

          {/* ─── Right column: new cut ─── */}
          <div className="space-y-3">
            <VideoPlayerCard
              title="New cut"
              accent="text-violet-300"
              src={toComfyUrl(newCutPath, reviewPreview?.createdAt)}
              emptyHint={stage === 'rendering'
                ? `Rendering preview… ${Math.round(renderProgress)}%`
                : 'Preview will render automatically.'}
            />
            {/* Optional second Sundogs PDF — the real one for the NEW cut.
                Mirrors the left column's panel so the user can A/B two
                real Sundogs reports (original vs new) when they take the
                exported new cut back to Sundogs externally. Sits right
                under the player (same slot the original-cut report
                occupies on the left column) so the layouts mirror each
                other; the AI review then sits below as a secondary
                surface. */}
            {geminiMode ? (
              <AdReportPanel
                report={adReportNewCut}
                compareTo={adReport}
                generating={stage === 'rendering' || stage === 'analyzing'}
                error={error}
                onGenerate={handleEvaluate}
                title="Ad report — new cut"
                emptyCopy="Click below to render a preview of the new cut and re-score it on the same axes as the original — the deltas show where the re-edit improved (or regressed)."
              />
            ) : (
              <>
                <SundogsReportPanel
                  report={newCutReport}
                  importing={importingNewCut}
                  error={newCutImportError}
                  onPickFile={handlePickNewCutPdf}
                  title="Sundogs report (new cut)"
                  emptyCopy="Already ran the new cut through Sundogs? Drop the resulting PDF here to compare the official scoring against the AI review below."
                />
                <AiReviewPanel
                  report={aiReview}
                  stage={stage}
                  progress={renderProgress}
                  error={error}
                  onEvaluate={handleEvaluate}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
