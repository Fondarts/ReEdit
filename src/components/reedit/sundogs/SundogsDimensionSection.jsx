/**
 * One dimension of the Sundogs report (Attention / Comprehension /
 * Persuasion / Action). Renders the dimension's headline delta vs
 * benchmark and a collapsible body with its windows (first5 / overall /
 * last5 or just `overall` for Product, or `overall` + `last5` for
 * Action) — each window lists doWell / couldExplore + the technique
 * rows.
 *
 * Parent passes a normalised `windowEntries` array of
 * `{ label, window, techniqueIds, deltaKey }` so this component
 * doesn't have to branch on dimension shape. `deltaKey` says which
 * key of `window.deltas` to render in the window header pill (e.g.
 * 'first5' / 'overall' / 'last5'); when null, no pill is shown
 * (Product window has no deltas).
 */
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import SundogsTechniqueRow from './SundogsTechniqueRow'

// Same colour ramp as the technique status pills, but driven by a
// signed % delta instead of a string. Green = above benchmark,
// amber = on benchmark / mild gap, rose = below benchmark.
function deltaPillClass(delta) {
  if (!Number.isFinite(delta)) return 'bg-sf-dark-700/60 text-sf-text-muted border-sf-dark-600'
  if (delta >= 5) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  if (delta >= -5) return 'bg-amber-500/15 text-amber-300 border-amber-500/30'
  return 'bg-rose-500/15 text-rose-300 border-rose-500/30'
}

function formatDelta(delta) {
  if (!Number.isFinite(delta)) return '—'
  if (delta === 0) return 'On'
  return `${delta > 0 ? '+' : ''}${delta}%`
}

export function DeltaPill({ delta, label }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium tabular-nums shrink-0 ${deltaPillClass(delta)}`}>
      {label && <span className="opacity-70">{label}</span>}
      {formatDelta(delta)}
    </span>
  )
}

export default function SundogsDimensionSection({
  name, // 'Attention' | 'Comprehension' | 'Persuasion' | 'Action'
  headlineDelta, // % delta the parent picked as the dimension's headline (typically the overall window)
  windowEntries, // Array<{ label, window, techniqueIds, deltaKey }>
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-sf-dark-700 rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-sf-dark-900 hover:bg-sf-dark-800 transition text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-sf-text-muted shrink-0" />
          : <ChevronRight className="w-4 h-4 text-sf-text-muted shrink-0" />}
        <span className="text-sm font-medium text-sf-text-primary shrink-0">{name}</span>
        <DeltaPill delta={headlineDelta} />
      </button>
      {open && (
        <div className="px-3 py-2 space-y-3 bg-sf-dark-950/40">
          {windowEntries.map((entry) => (
            <DimensionWindow key={entry.label} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}

function DimensionWindow({ entry }) {
  const { label, window: w, techniqueIds, deltaKey } = entry
  if (!w) return null
  const knownTechs = techniqueIds.filter((id) => w.techniques?.[id])
  const extraTechs = Object.keys(w.techniques || {}).filter((id) => !techniqueIds.includes(id))
  const allTechs = [...knownTechs, ...extraTechs]
  const delta = deltaKey ? w.deltas?.[deltaKey] : null
  const showDeltaPill = Number.isFinite(delta)
  const hasContent = w.doWell?.length > 0 || w.couldExplore?.length > 0 || allTechs.length > 0
  if (!showDeltaPill && !hasContent) return null
  return (
    <div className="border border-sf-dark-800 rounded-md bg-sf-dark-900/60 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-sf-text-muted">{label}</span>
        {showDeltaPill && <DeltaPill delta={delta} />}
      </div>
      {(w.doWell?.length > 0 || w.couldExplore?.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2 text-[12px] leading-relaxed">
          {w.doWell?.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-0.5">What you do well</div>
              <ul className="list-disc list-inside text-sf-text-primary/90 space-y-0.5">
                {w.doWell.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {w.couldExplore?.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-amber-400/80 mb-0.5">What you could explore</div>
              <ul className="list-disc list-inside text-sf-text-primary/90 space-y-0.5">
                {w.couldExplore.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {allTechs.length > 0 && (
        <div className="border-t border-sf-dark-800 pt-1.5">
          {allTechs.map((id) => (
            <SundogsTechniqueRow key={id} id={id} technique={w.techniques[id]} />
          ))}
        </div>
      )}
    </div>
  )
}
