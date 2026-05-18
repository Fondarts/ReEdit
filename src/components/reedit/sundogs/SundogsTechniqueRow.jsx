/**
 * One row inside a SundogsDimensionSection — renders a single
 * technique's value (whatever the Sundogs PDF printed: "+27%",
 * "Yes", "0% / 0% / 0%", "Original", etc.) + a coloured status pill
 * (good / evaluate). Intentionally dumb — parent decides which
 * techniques to render in which order.
 */
const STATUS_PILL = {
  good: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  evaluate: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
}

const STATUS_LABEL = {
  good: 'Good',
  evaluate: 'Evaluate',
}

export default function SundogsTechniqueRow({ id, technique }) {
  const status = technique?.status || 'evaluate'
  const value = technique?.value || ''
  return (
    <div className="flex items-start gap-2 py-1.5 text-[12px] leading-relaxed">
      <span className="font-mono text-[11px] text-sf-text-muted/80 min-w-[180px] truncate" title={id}>
        {id}
      </span>
      <span className="flex-1 text-sf-text-primary tabular-nums">
        {value || <span className="text-sf-text-muted italic">—</span>}
      </span>
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium uppercase tracking-wider shrink-0 ${STATUS_PILL[status] || STATUS_PILL.evaluate}`}
      >
        {STATUS_LABEL[status] || status}
      </span>
    </div>
  )
}
