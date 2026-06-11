/**
 * Report-source settings section — choose where the ad performance report
 * comes from: an imported Sundogs PDF (default) or a Gemini-generated
 * analysis of the original video. See services/reeditReportSource.js.
 */

import { useState } from 'react'
import { FileText, Sparkles } from 'lucide-react'
import { getReportSource, setReportSource } from '../services/reeditReportSource'

const OPTIONS = [
  {
    id: 'sundogs',
    label: 'Sundogs',
    icon: FileText,
    blurb: 'Import the client-delivered Sundogs PDF in the Proposal tab. Gemini parses it and the official scores drive the proposal and the Review comparison.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    icon: Sparkles,
    blurb: 'No PDF needed. Generate a report from the Projects tab — Gemini watches the original video and produces strengths / weaknesses / opportunities with per-dimension scores. That report drives the proposal, and Review re-scores the new cut for a side-by-side comparison.',
  },
]

export default function ReportSourceSettingsSection() {
  const [source, setSource] = useState(() => getReportSource())

  const handlePick = (id) => {
    setSource(id)
    setReportSource(id)
  }

  return (
    <div className="space-y-3">
      {OPTIONS.map((opt) => {
        const Icon = opt.icon
        const isActive = source === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => handlePick(opt.id)}
            className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
              isActive
                ? 'border-sf-accent/50 bg-sf-accent/10'
                : 'border-sf-dark-700 bg-sf-dark-900/40 hover:border-sf-dark-600'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                isActive ? 'bg-sf-accent/15 text-sf-accent' : 'bg-sf-dark-800 text-sf-text-muted'
              }`}>
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-sf-text-primary">{opt.label}</span>
                  {isActive && <span className="text-[10px] uppercase tracking-wider text-sf-accent">Active</span>}
                </div>
                <p className="mt-1 text-[12px] text-sf-text-muted leading-relaxed">{opt.blurb}</p>
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
