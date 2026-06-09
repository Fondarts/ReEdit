/**
 * Sundogs report panel — header (subject + overall score vs benchmark
 * + 4 dimension chips + Import / Replace button) plus 4 collapsible
 * dimension sections fed from the imported PDF. Lives in ProposalView
 * between the Capabilities row and the EDL table; renders only when
 * the user picks the Sundogs metric.
 *
 * Pure presentational — parent owns `report`, `importing`, `error`
 * and the file picker; we only call `onPickFile()` and render.
 */
import { useRef } from 'react'
import { FileText, Loader2, AlertCircle, Upload } from 'lucide-react'
import SundogsDimensionSection, { DeltaPill } from './SundogsDimensionSection'
import { SUNDOGS_TECHNIQUES } from '../../../services/reeditSundogsReport'

export default function SundogsReportPanel({
  report,
  importing,
  error,
  onPickFile, // (file: File) => void
  // Optional overrides — let callers reuse this panel for purposes
  // other than the original "client sent us a Sundogs PDF" flow
  // (e.g. importing a Sundogs PDF of the new cut in the Review tab).
  title = 'Sundogs report',
  emptyCopy = "Import the Sundogs Video Performance Analysis PDF the client sent. We'll feed its scores directly to the proposal LLM. Requires Gemini API key.",
}) {
  const inputRef = useRef(null)
  const has = Boolean(report)
  const m = report?.meta || {}
  const o = report?.overall || {}
  const headerBits = [m.brand && m.product ? `${m.brand} ${m.product}` : m.brand, m.contentType, Number.isFinite(m.durationSec) ? `${m.durationSec}s` : null]
    .filter(Boolean)

  const handleClick = () => {
    if (!importing) inputRef.current?.click()
  }
  const handleChange = (e) => {
    const file = e.target.files?.[0]
    if (file) onPickFile?.(file)
    // Reset so picking the same file twice in a row still fires onChange.
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={handleChange}
      />

      {/* Header */}
      <div className="flex items-start gap-3 px-3 py-2 border-b border-sf-dark-800">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <FileText className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-sm font-medium text-sf-text-primary">{title}</span>
            {has && Number.isFinite(o.finalScorePct) && Number.isFinite(o.benchmarkPct) && (
              <>
                <span className="text-[12px] text-sf-text-primary/90 tabular-nums">
                  {o.finalScorePct}% <span className="text-sf-text-muted">vs {o.benchmarkPct}% benchmark</span>
                </span>
              </>
            )}
            {has && report.fileName && (
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted/70 truncate">
                · {report.fileName}
              </span>
            )}
          </div>
          {has ? (
            <>
              {headerBits.length > 0 && (
                <div className="text-[12px] text-sf-text-muted mb-1.5">
                  {headerBits.join(' · ')}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                <DeltaPill delta={o.deltas?.attention} label="ATT" />
                <DeltaPill delta={o.deltas?.comprehension} label="COMP" />
                <DeltaPill delta={o.deltas?.persuasion} label="PERS" />
                <DeltaPill delta={o.deltas?.action} label="ACT" />
              </div>
            </>
          ) : (
            <div className="text-[12px] text-sf-text-muted">
              {emptyCopy}
            </div>
          )}
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary border border-sf-dark-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          onClick={handleClick}
          disabled={importing}
          title={has ? 'Replace with a different Sundogs PDF' : 'Pick the Sundogs PDF report'}
        >
          {importing
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Upload className="w-3.5 h-3.5" />}
          {has ? 'Replace' : 'Import Sundogs PDF'}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-rose-500/10 border-b border-rose-500/30 text-[12px] text-rose-300">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Body — 4 dimension sections + differentiation */}
      {has && (
        <div className="p-3 space-y-2">
          {/* Differentiation key elements (when present) */}
          {(report.differentiation?.scorePct != null || report.differentiation?.keyElements?.length > 0) && (
            <div className="rounded-md border border-sf-dark-800 bg-sf-dark-900/60 px-3 py-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-emerald-400/80">Differentiation</span>
                {Number.isFinite(report.differentiation?.scorePct) && (
                  <DeltaPill delta={report.differentiation.scorePct} />
                )}
              </div>
              {report.differentiation?.keyElements?.length > 0 && (
                <ul className="list-disc list-inside text-[12px] leading-relaxed text-sf-text-primary/90 space-y-0.5">
                  {report.differentiation.keyElements.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
            </div>
          )}

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
              { label: 'Branding · Overall', window: report.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'overall' },
              { label: 'Branding · Last 5s', window: report.comprehension?.branding, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_branding, deltaKey: 'last5' },
              { label: 'Product', window: report.comprehension?.product, techniqueIds: SUNDOGS_TECHNIQUES.comprehension_product, deltaKey: null },
            ]}
          />

          <SundogsDimensionSection
            name="Persuasion"
            headlineDelta={report.persuasion?.emotional?.deltas?.overall ?? o.deltas?.persuasion}
            windowEntries={[
              { label: 'Emotional · First 5s', window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'first5' },
              { label: 'Emotional · Overall', window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'overall' },
              { label: 'Emotional · Last 5s', window: report.persuasion?.emotional, techniqueIds: SUNDOGS_TECHNIQUES.persuasion, deltaKey: 'last5' },
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
      )}
    </div>
  )
}
