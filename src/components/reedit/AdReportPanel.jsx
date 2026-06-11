/**
 * AdReportPanel — renders a Gemini ad report (see reeditAdReport.js):
 * per-dimension score bars + Strengths / Weaknesses / Opportunities.
 *
 * Three call sites, one component:
 *   - Import tab: pass `onGenerate` to show the "Generate report" button
 *     and the empty/loading/error states.
 *   - Review (original column): read-only, no `onGenerate`.
 *   - Review (new-cut column): pass `compareTo={originalReport}` to draw
 *     a delta pill next to each score.
 */

import { Sparkles, Loader2, AlertCircle, TrendingUp, TrendingDown, Minus, Lightbulb } from 'lucide-react'
import { AD_REPORT_DIMENSIONS } from '../../services/reeditAdReport'
import { DeltaPill } from './sundogs/SundogsDimensionSection'

function scoreColor(score) {
  if (score == null) return 'bg-sf-dark-600'
  if (score >= 75) return 'bg-emerald-500'
  if (score >= 55) return 'bg-amber-400'
  return 'bg-rose-500'
}

function ScoreRow({ label, hint, score, compareScore }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score))
  const delta = (score != null && compareScore != null) ? (score - compareScore) : null
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-sf-text-secondary" title={hint}>{label}</span>
        <div className="flex items-center gap-2">
          {delta != null && <DeltaPill delta={delta} />}
          <span className="text-[11px] tabular-nums text-sf-text-primary w-7 text-right">{score ?? '—'}</span>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-sf-dark-800 overflow-hidden">
        <div className={`h-full rounded-full ${scoreColor(score)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function BulletList({ icon: Icon, title, items, tone }) {
  if (!items?.length) return null
  return (
    <div className="space-y-1.5">
      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-medium ${tone}`}>
        <Icon className="w-3 h-3" />
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((b, i) => (
          <li key={i} className="text-[11px] text-sf-text-secondary leading-snug pl-3 relative">
            <span className="absolute left-0 top-1.5 w-1 h-1 rounded-full bg-sf-text-muted/50" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function AdReportPanel({
  report,
  compareTo = null,
  generating = false,
  error = null,
  onGenerate = null,
  title = 'Ad report (Gemini)',
  emptyCopy = 'Let Gemini watch the original video and produce a strengths / weaknesses / opportunities read with per-dimension scores. This report drives the new edit.',
}) {
  const cmpScores = compareTo?.scores || null

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-violet-300" />
          <span className="text-sm font-medium text-sf-text-primary">{title}</span>
        </div>
        {onGenerate && (
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] bg-sf-accent hover:bg-sf-accent/90 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing…</>
              : <><Sparkles className="w-3.5 h-3.5" /> {report ? 'Regenerate report' : 'Generate report'}</>}
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-[11px] text-sf-error">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span className="leading-snug break-words">{error}</span>
        </div>
      )}

      {!report && !generating && !error && (
        <p className="text-[11px] text-sf-text-muted leading-relaxed">{emptyCopy}</p>
      )}

      {generating && !report && (
        <div className="flex items-center gap-2 text-[11px] text-sf-text-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Gemini is watching the video…
        </div>
      )}

      {report && (
        <>
          {/* Overall + meta header */}
          <div className="flex items-end justify-between gap-3 pb-2 border-b border-sf-dark-800">
            <div className="min-w-0">
              {(report.meta?.brand || report.meta?.product) && (
                <div className="text-[11px] text-sf-text-muted truncate">
                  {report.meta?.brand || ''}{report.meta?.product ? ` · ${report.meta.product}` : ''}
                </div>
              )}
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted mt-0.5">Overall score</div>
            </div>
            <div className="flex items-center gap-2">
              {cmpScores?.overall != null && report.scores?.overall != null && (
                <DeltaPill delta={report.scores.overall - cmpScores.overall} />
              )}
              <span className="text-2xl font-semibold tabular-nums text-sf-text-primary leading-none">
                {report.scores?.overall ?? '—'}
              </span>
            </div>
          </div>

          {/* Per-dimension score bars */}
          <div className="space-y-2.5">
            {AD_REPORT_DIMENSIONS.map((d) => (
              <ScoreRow
                key={d.key}
                label={d.label}
                hint={d.hint}
                score={report.scores?.[d.key]}
                compareScore={cmpScores?.[d.key]}
              />
            ))}
          </div>

          {report.summary && (
            <p className="text-[11px] text-sf-text-secondary leading-relaxed italic border-l-2 border-sf-dark-700 pl-2.5">
              {report.summary}
            </p>
          )}

          {/* Strengths / Weaknesses / Opportunities */}
          <div className="space-y-3 pt-1">
            <BulletList icon={TrendingUp} title="Strengths" items={report.strengths} tone="text-emerald-400/90" />
            <BulletList icon={TrendingDown} title="Weaknesses" items={report.weaknesses} tone="text-rose-400/90" />
            <BulletList icon={Lightbulb} title="Opportunities" items={report.opportunities} tone="text-amber-300/90" />
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-sf-text-muted pt-1 border-t border-sf-dark-800">
            <Minus className="w-2.5 h-2.5" />
            AI performance estimate · {report.model || 'gemini'} · not a substitute for media testing
          </div>
        </>
      )}
    </div>
  )
}
