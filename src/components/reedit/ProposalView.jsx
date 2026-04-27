import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, Save, RotateCcw,
  ArrowUp, ArrowDown, Trash2, CheckCircle2, Film, Wand2, Eye, EyeOff,
  Pencil, Plus, Cpu, KeyRound, ExternalLink, Video, Image as ImageIcon,
  Play, Pause,
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

// Read-only display of the overall ad concept produced by the Analysis
// tab's "Analyze" pass. This REPLACES the free-text brand-brief input:
// the LLM now conditions on the structured strategist read rather than
// whatever the user wrote by hand, so the re-edit stays aligned with
// what the model actually understood the ad to be about. If no
// analysis has been run, we surface a prompt to go back and run it.
function AdConceptPanel({ analysis, onNavigate }) {
  const overall = analysis?.overall || null
  const hasContent = overall && (
    overall.concept || overall.message || overall.mood
    || overall.target_audience || overall.brand_role || overall.narrative_arc
  )
  return (
    <div>
      <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">
        Ad concept
        <span className="text-sf-text-muted/70 normal-case ml-2">
          {hasContent
            ? 'from Analysis · fed into the LLM prompt'
            : 'run Analyze first to capture this'}
        </span>
      </label>
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm min-h-[102px]">
        {hasContent ? (
          <div className="space-y-1.5 text-[12px] leading-relaxed">
            {overall.concept && (
              <div>
                <span className="text-sf-text-muted">Concept · </span>
                <span className="text-sf-text-primary">{overall.concept}</span>
              </div>
            )}
            {overall.message && (
              <div>
                <span className="text-sf-text-muted">Message · </span>
                <span className="text-sf-text-primary">{overall.message}</span>
              </div>
            )}
            {(overall.mood || overall.target_audience) && (
              <div className="text-[11px] text-sf-text-secondary">
                {overall.mood && <><span className="text-sf-text-muted">Mood · </span>{overall.mood}</>}
                {overall.mood && overall.target_audience && <span className="mx-2 text-sf-text-muted">·</span>}
                {overall.target_audience && <><span className="text-sf-text-muted">Audience · </span>{overall.target_audience}</>}
              </div>
            )}
            {overall.brand_role && (
              <div className="text-[11px] text-sf-text-secondary">
                <span className="text-sf-text-muted">Brand role · </span>{overall.brand_role}
              </div>
            )}
            {overall.narrative_arc && (
              <div className="text-[11px] text-sf-text-secondary">
                <span className="text-sf-text-muted">Arc · </span>{overall.narrative_arc}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-sf-text-muted italic leading-relaxed">
            No ad concept yet. Go to <button
              type="button"
              onClick={() => onNavigate?.('analysis')}
              className="text-sf-accent hover:text-sf-accent-hover underline underline-offset-2"
            >Analysis</button> and click <span className="text-sf-text-primary">Analyze</span> so
            the model captures the ad&apos;s concept, message and mood. That read is what guides the
            proposal.
          </div>
        )}
      </div>
    </div>
  )
}

// Resolve a segment's effective timing (Gemini's value with any
// user-edited override applied). Edits live on voPlan.segmentEdits to
// keep the analyzer's data canonical — re-running Analyze refreshes
// the originals, edits stay attached to the proposal. Global lead-in
// / lead-out pads are layered on top: they shift the START earlier
// and the END later so we capture the full word at each boundary
// (Gemini reliably arrives 0.3-0.7 s late on phrase starts).
function resolveSegment(seg, voPlan) {
  const edit = voPlan?.segmentEdits?.[seg.id]
  const baseStart = Number.isFinite(edit?.startSec) ? edit.startSec : Number(seg.startSec)
  const baseEnd = Number.isFinite(edit?.endSec) ? edit.endSec : Number(seg.endSec)
  const leadIn = Math.max(0, Number(voPlan?.leadInSec) || 0)
  const leadOut = Math.max(0, Number(voPlan?.leadOutSec) || 0)
  return {
    ...seg,
    startSec: Math.max(0, baseStart - leadIn),
    endSec: Math.max(baseStart - leadIn + 0.05, baseEnd + leadOut),
    rawStartSec: baseStart,
    rawEndSec: baseEnd,
    edited: Boolean(edit && (edit.startSec != null || edit.endSec != null)),
  }
}

// Single-row UI for one VO segment: optional checkbox (manual mode),
// editable startSec / endSec inputs, play preview, and the transcript
// text. The play preview is what makes timestamp tuning fast — click,
// hear what's there, type a correction, click again to verify.
function VoiceoverSegmentRow({ seg, selected, autoEdit, voPlan, onToggle, onEdit, stemUrl }) {
  const audioRef = useRef(null)
  const stopTimerRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const resolved = resolveSegment(seg, voPlan)
  const segDur = Math.max(0, resolved.endSec - resolved.startSec)

  useEffect(() => () => {
    // Cleanup on unmount: stop audio + clear the auto-stop timer.
    if (audioRef.current) audioRef.current.pause()
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
  }, [])

  const handlePreview = (e) => {
    e.stopPropagation()
    if (!stemUrl) return
    if (playing) {
      // Toggle off: stop and reset.
      audioRef.current?.pause()
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      setPlaying(false)
      return
    }
    if (!audioRef.current) {
      audioRef.current = new Audio(stemUrl)
      audioRef.current.preload = 'auto'
      audioRef.current.addEventListener('ended', () => setPlaying(false))
    }
    const a = audioRef.current
    try {
      a.currentTime = Math.max(0, resolved.startSec)
    } catch (_) { /* ignore — autoplay-restricted browsers throw here */ }
    a.play().then(() => {
      setPlaying(true)
      // Hard-stop at endSec so the user only hears this segment, not
      // the trailing audio of the next phrase.
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
      stopTimerRef.current = setTimeout(() => {
        if (audioRef.current) audioRef.current.pause()
        setPlaying(false)
      }, Math.max(80, segDur * 1000))
    }).catch(() => setPlaying(false))
  }

  const handleStartEdit = (e) => {
    const v = parseFloat(e.target.value)
    if (Number.isFinite(v)) onEdit({ startSec: v })
  }
  const handleEndEdit = (e) => {
    const v = parseFloat(e.target.value)
    if (Number.isFinite(v)) onEdit({ endSec: v })
  }

  return (
    <div
      className={`flex items-start gap-2 rounded px-1.5 py-1 ${
        selected ? 'text-sf-text-primary' : 'text-sf-text-muted line-through opacity-60'
      } ${autoEdit ? '' : 'hover:bg-sf-dark-800'}`}
    >
      {!autoEdit && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-1.5 w-3.5 h-3.5 accent-sf-accent flex-shrink-0"
        />
      )}
      <button
        type="button"
        onClick={handlePreview}
        disabled={!stemUrl}
        className={`mt-0.5 flex-shrink-0 w-6 h-6 flex items-center justify-center rounded border transition-colors
          ${stemUrl
            ? (playing
                ? 'border-sf-accent bg-sf-accent/20 text-sf-accent'
                : 'border-sf-dark-700 bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-secondary hover:text-sf-text-primary')
            : 'border-sf-dark-700 bg-sf-dark-800 text-sf-text-muted/50 cursor-not-allowed'}`}
        title={stemUrl ? 'Play this segment from the VO stem to verify timing' : 'VO stem not separated yet (run Stems in Import)'}
      >
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
      </button>
      <div className="flex-shrink-0 flex items-center gap-1 mt-0.5">
        <input
          type="number"
          step={0.1}
          min={0}
          value={resolved.rawStartSec.toFixed(1)}
          onChange={handleStartEdit}
          className="w-14 px-1 py-0.5 text-[10px] tabular-nums rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
          title="Segment start (seconds, before lead-in pad)"
        />
        <span className="text-[10px] text-sf-text-muted">→</span>
        <input
          type="number"
          step={0.1}
          min={0}
          value={resolved.rawEndSec.toFixed(1)}
          onChange={handleEndEdit}
          className="w-14 px-1 py-0.5 text-[10px] tabular-nums rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
          title="Segment end (seconds, before lead-out pad)"
        />
        {resolved.edited && (
          <span className="text-[9px] text-sf-accent" title="Timing edited from analyzer's original">·</span>
        )}
      </div>
      <div className="flex-1 text-[11px] leading-relaxed mt-0.5">
        &ldquo;{seg.text}&rdquo;
        {seg.role && seg.role !== 'line' && (
          <span className="ml-1.5 text-[9px] uppercase tracking-wider text-sf-text-muted">
            {seg.role}
          </span>
        )}
      </div>
    </div>
  )
}

// Voiceover script panel — shows the segmented VO transcript that
// Gemini captured at the overall-analysis step. Gemini's timestamps
// are notoriously imprecise; we expose them as editable inputs and
// add a per-segment preview button so the user can audibly verify
// each range and correct any hallucinations before Apply.
function VoiceoverPanel({ analysis, voPlan, onChangeVoPlan, proposerPickedIds, capabilities, targetDurationSec, sourceVideo }) {
  const segments = analysis?.overall?.voiceover_segments
  const usableSegments = Array.isArray(segments) ? segments : []
  if (!capabilities?.useOriginalVoiceover) return null

  if (usableSegments.length === 0) {
    return (
      <div>
        <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider mb-2">
          Voiceover script
          <span className="text-sf-text-muted/70 normal-case ml-2">needs overall analysis</span>
        </label>
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-[12px] text-sf-text-muted italic min-h-[80px] leading-relaxed">
          No VO transcript yet. Go to Analysis and click <span className="text-sf-text-primary">Analyze</span> so
          Gemini can segment the voiceover into phrases. Until then the full VO stem plays as a
          single unedited clip on the timeline.
        </div>
      </div>
    )
  }

  const autoEdit = voPlan?.autoEdit !== false
  const manualSelected = Array.isArray(voPlan?.segmentIds) ? new Set(voPlan.segmentIds) : null
  const proposerSet = proposerPickedIds ? new Set(proposerPickedIds) : null
  const isSelected = (seg) => {
    if (!autoEdit) return manualSelected ? manualSelected.has(seg.id) : true
    if (proposerSet) return proposerSet.has(seg.id)
    return true
  }
  const toggleSeg = (segId) => {
    if (autoEdit) return
    const current = Array.isArray(voPlan.segmentIds)
      ? voPlan.segmentIds
      : usableSegments.map((s) => s.id)
    const next = current.includes(segId)
      ? current.filter((id) => id !== segId)
      : [...current, segId]
    onChangeVoPlan({ ...voPlan, segmentIds: next })
  }
  const setAuto = (next) => {
    const segmentIds = next
      ? voPlan.segmentIds
      : (proposerPickedIds || usableSegments.map((s) => s.id))
    onChangeVoPlan({ ...voPlan, autoEdit: next, segmentIds })
  }
  const editSeg = (segId, patch) => {
    const prevEdits = voPlan?.segmentEdits || {}
    const merged = { ...(prevEdits[segId] || {}), ...patch }
    onChangeVoPlan({
      ...voPlan,
      segmentEdits: { ...prevEdits, [segId]: merged },
    })
  }
  const resetAllEdits = () => {
    onChangeVoPlan({ ...voPlan, segmentEdits: {}, leadInSec: 0.5, leadOutSec: 0.3 })
  }
  const hasEdits = voPlan?.segmentEdits && Object.keys(voPlan.segmentEdits).length > 0
  const leadInSec = Number.isFinite(voPlan?.leadInSec) ? voPlan.leadInSec : 0.5
  const leadOutSec = Number.isFinite(voPlan?.leadOutSec) ? voPlan.leadOutSec : 0.3
  const setLeadIn = (v) => onChangeVoPlan({ ...voPlan, leadInSec: Math.max(0, Math.min(2, v)) })
  const setLeadOut = (v) => onChangeVoPlan({ ...voPlan, leadOutSec: Math.max(0, Math.min(2, v)) })

  // Voice-activity-detection — snaps each segment's start to the
  // closest energy onset detected in the VO stem. We DON'T decode the
  // audio ourselves: the main-process waveform service (ffmpeg) has
  // already produced bucketed RMS peaks for the file, accurate to
  // ~7 ms per bucket on a 30 s clip. Reusing those peaks dodges two
  // problems:
  //   1. fetch() doesn't work on `comfystudio://` URLs, which is what
  //      the stem ships as in Electron — fetching would throw.
  //   2. Spinning a fresh AudioContext on top of the player's existing
  //      one can race the renderer into a blank state.
  const [vadRunning, setVadRunning] = useState(false)
  const [vadError, setVadError] = useState(null)
  const runVadSnap = async () => {
    if (!stemPath || vadRunning) return
    setVadRunning(true)
    setVadError(null)
    try {
      // Ask main for high-resolution peaks. 4096 buckets over a 30 s
      // file = 7.3 ms granularity, plenty for word onsets.
      const result = (typeof window !== 'undefined' && window.electronAPI?.getAudioWaveform)
        ? await window.electronAPI.getAudioWaveform(stemPath, { sampleCount: 4096 })
        : null
      if (!result || result.success === false || !Array.isArray(result.peaks) || result.peaks.length === 0) {
        throw new Error(result?.error || 'Could not extract waveform peaks for the VO stem.')
      }
      const peaks = result.peaks
      const decodedDuration = Number(result.duration) || 0
      if (decodedDuration <= 0) throw new Error('Waveform service returned zero duration.')
      const secsPerBucket = decodedDuration / peaks.length

      // Onsets = rising edges where the bucketed peak crosses the
      // threshold from below. 8 % of the global peak is a robust
      // speech-vs-silence cutoff for vocals stems (Demucs already
      // strips music + room tone).
      const peakMax = peaks.reduce((m, p) => (p > m ? p : m), 0)
      if (peakMax <= 0) throw new Error('Waveform looks silent.')
      const threshold = peakMax * 0.08
      const onsets = []
      for (let i = 1; i < peaks.length; i++) {
        if (peaks[i - 1] < threshold && peaks[i] >= threshold) {
          onsets.push(i * secsPerBucket)
        }
      }
      if (onsets.length === 0) {
        setVadError('No clear speech onsets detected — try lowering the lead-in or checking the stem.')
        return
      }

      // For each segment, snap startSec to the closest onset within
      // ±1.5 s. We don't touch endSec — lead-out pad handles trailing
      // consonants well enough.
      const newEdits = { ...(voPlan?.segmentEdits || {}) }
      let snappedCount = 0
      for (const seg of usableSegments) {
        const target = Number(seg.startSec)
        if (!Number.isFinite(target)) continue
        let best = null
        let bestDelta = Infinity
        for (const onset of onsets) {
          const delta = Math.abs(onset - target)
          if (delta > 1.5) continue
          if (delta < bestDelta) {
            bestDelta = delta
            best = onset
          }
        }
        if (best != null && bestDelta > 0.05) {
          newEdits[seg.id] = {
            ...(newEdits[seg.id] || {}),
            startSec: Math.round(best * 10) / 10,
          }
          snappedCount++
        }
      }
      onChangeVoPlan({ ...voPlan, segmentEdits: newEdits })
      if (snappedCount === 0) {
        setVadError('Onsets found but already match Gemini\'s timestamps — nothing to snap.')
      }
    } catch (err) {
      console.error('[reedit] VAD snap failed:', err)
      setVadError(err?.message || String(err) || 'Voice-activity scan failed.')
    } finally {
      setVadRunning(false)
    }
  }
  const selectedSum = usableSegments.reduce((acc, seg) => {
    if (!isSelected(seg)) return acc
    const r = resolveSegment(seg, voPlan)
    return acc + Math.max(0, r.endSec - r.startSec)
  }, 0)

  // The VO stem URL drives the per-segment preview. We resolve it the
  // same way the timeline does — comfystudio:// for the absolute path.
  const stemPath = sourceVideo?.stems?.vocalsPath || null
  const stemUrl = stemPath ? `comfystudio://${encodeURIComponent(stemPath)}` : null

  return (
    <div className="md:col-span-2">
      <div className="flex items-center gap-3 mb-2">
        <label className="block text-xs font-medium text-sf-text-muted uppercase tracking-wider">
          Voiceover script
          <span className="text-sf-text-muted/70 normal-case ml-2">
            {autoEdit ? 'Gemini trims to fit' : 'manual selection'} · {usableSegments.length} segment{usableSegments.length === 1 ? '' : 's'} · ~{selectedSum.toFixed(1)}s selected{targetDurationSec ? ` / ${targetDurationSec.toFixed(1)}s target` : ''}
            {hasEdits && <span className="text-sf-accent ml-2">· timing edits applied</span>}
          </span>
        </label>
        {hasEdits && (
          <button
            type="button"
            onClick={resetAllEdits}
            className="text-[10px] text-sf-text-muted hover:text-sf-text-primary underline"
            title="Discard all your timestamp tweaks and use Gemini's originals"
          >
            Reset edits
          </button>
        )}
        <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none text-[11px] text-sf-text-secondary">
          <input
            type="checkbox"
            checked={autoEdit}
            onChange={(e) => setAuto(e.target.checked)}
            className="w-3.5 h-3.5 accent-sf-accent"
          />
          Let Gemini auto-edit VO
        </label>
      </div>
      <div className="flex items-center gap-3 mb-1.5 flex-wrap">
        <div className="text-[10px] text-sf-text-muted italic leading-relaxed flex-1 min-w-[200px]">
          Gemini&apos;s timestamps tend to arrive 0.3–0.7 s late on phrase starts. The lead pads
          below extend each cut so the first / last word survives. Hit play to verify, or
          run <span className="text-sf-text-secondary">Snap to speech</span> to align starts to
          actual energy onsets in the stem.
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-sf-text-muted">
          <span title="How much earlier each segment starts on the timeline. Pad before the spoken word.">Lead-in</span>
          <input
            type="number" step={0.1} min={0} max={2}
            value={leadInSec.toFixed(1)}
            onChange={(e) => setLeadIn(parseFloat(e.target.value))}
            className="w-12 px-1 py-0.5 text-[10px] tabular-nums rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
          />
          <span>s</span>
          <span className="ml-1.5" title="How much later each segment ends. Catches trailing consonants and breaths.">Lead-out</span>
          <input
            type="number" step={0.1} min={0} max={2}
            value={leadOutSec.toFixed(1)}
            onChange={(e) => setLeadOut(parseFloat(e.target.value))}
            className="w-12 px-1 py-0.5 text-[10px] tabular-nums rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-secondary focus:outline-none focus:border-sf-accent"
          />
          <span>s</span>
        </div>
        <button
          type="button"
          onClick={runVadSnap}
          disabled={!stemUrl || vadRunning}
          className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors
            ${vadRunning
              ? 'border-sf-dark-700 bg-sf-dark-800 text-sf-text-muted'
              : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent hover:bg-sf-accent/20'}
            ${!stemUrl ? 'opacity-50 cursor-not-allowed' : ''}`}
          title={stemUrl
            ? 'Decodes the VO stem and snaps each segment start to the nearest energy onset (±1.5 s window). Best fix for systematic drift.'
            : 'VO stem not separated yet — run Stems in Import first.'}
        >
          {vadRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
          Snap to speech
        </button>
      </div>
      {vadError && (
        <div className="text-[10px] text-amber-300 mb-1.5">{vadError}</div>
      )}
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-2 py-2 space-y-1 max-h-[260px] overflow-y-auto">
        {usableSegments.map((seg) => (
          <VoiceoverSegmentRow
            key={seg.id}
            seg={seg}
            selected={isSelected(seg)}
            autoEdit={autoEdit}
            voPlan={voPlan}
            stemUrl={stemUrl}
            onToggle={() => toggleSeg(seg.id)}
            onEdit={(patch) => editSeg(seg.id, patch)}
          />
        ))}
      </div>
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

// Split a row's free-text note into the structured directives the
// proposer writes (REFRAME / COLOR / EXTEND / AUDIO music / AUDIO vo)
// plus the leftover rationale prose. Two-pass: first locate each
// directive's block (everything after the keyword until the next
// directive or EOL), then parse its params separately. This is more
// robust than trying to capture everything with one regex — the LLM
// is loose about where it places colons (e.g. `REFRAME: zoom=X:
// rationale` vs `REFRAME zoom=X anchor=y,z: rationale`).
function splitRationaleDirectives(note) {
  const raw = String(note || '').trim()
  if (!raw) return { directives: [], rationale: '' }
  const directives = []
  // Regex groups: full block text that follows the directive keyword,
  // up to the next directive or EOL. We then mine params from the
  // block string with standalone regexes — no ordering assumptions.
  const DIRECTIVE_BOUNDARY = '(?=(?:\\s+(?:REFRAME|EXTEND|COLOR|AUDIO)\\b)|$)'
  const blockMatchers = [
    { type: 'audio-vo', re: new RegExp(`\\bAUDIO\\s+vo\\b([\\s\\S]*?)${DIRECTIVE_BOUNDARY}`, 'i') },
    { type: 'audio-music', re: new RegExp(`\\bAUDIO\\s+music\\b([\\s\\S]*?)${DIRECTIVE_BOUNDARY}`, 'i') },
    { type: 'reframe', re: new RegExp(`\\bREFRAME\\b([\\s\\S]*?)${DIRECTIVE_BOUNDARY}`, 'i') },
    { type: 'extend', re: new RegExp(`\\bEXTEND\\b([\\s\\S]*?)${DIRECTIVE_BOUNDARY}`, 'i') },
    { type: 'color', re: new RegExp(`\\bCOLOR\\b([\\s\\S]*?)${DIRECTIVE_BOUNDARY}`, 'i') },
  ]
  // Consume directives from a scratch copy of the note. Each matched
  // directive gets replaced with spaces so later regexes don't re-hit
  // it and so the "remaining rationale prose" calc at the end is clean.
  let remaining = raw
  for (const { type, re } of blockMatchers) {
    const m = re.exec(remaining)
    if (!m) continue
    const block = m[1] || ''
    // Mine params by type. Rationale is whatever's left after stripping
    // params + leading colons/whitespace.
    let params = ''
    let rationale = block
    let missingAnchor = false
    if (type === 'reframe') {
      const zoom = /zoom\s*=\s*([\d.]+)/i.exec(block)
      const anchor = /anchor\s*=\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(block)
      const parts = []
      if (zoom) parts.push(`zoom=${zoom[1]}`)
      if (anchor) parts.push(`anchor=${anchor[1]},${anchor[2]}`)
      params = parts.join(' ')
      missingAnchor = !!zoom && !anchor && parseFloat(zoom[1]) > 1.0
      rationale = block
        .replace(/zoom\s*=\s*[\d.]+/gi, '')
        .replace(/anchor\s*=\s*[\d.]+\s*,\s*[\d.]+/gi, '')
    } else if (type === 'extend') {
      const sec = /([+\-]?[\d.]+)\s*s?\b/.exec(block)
      if (sec) params = `+${parseFloat(sec[1]).toFixed(1)}s`
      rationale = block.replace(/[+\-]?[\d.]+\s*s?\b/, '')
    } else if (type === 'color') {
      // Color params run `key=value` pairs (saturation=+10 contrast=+15 ...)
      // up until the first prose sentence. We grab every key=value pair
      // at the head of the block, then the rest is the rationale.
      const head = /^[\s:]*((?:[a-zA-Z_]+\s*=\s*[+\-]?[\d.]+\s*)+)/i.exec(block)
      if (head) {
        params = head[1].trim().replace(/\s+/g, ' ')
        rationale = block.slice(head[0].length)
      }
    } else if (type === 'audio-vo') {
      // VO can be a quoted line; extract it as the params if present.
      const quoted = /"([^"]*)"/.exec(block)
      if (quoted) {
        params = `"${quoted[1]}"`
        rationale = block.replace(/"[^"]*"/, '')
      }
    }
    // else audio-music: everything is rationale, no params.
    rationale = rationale.replace(/^[\s:.]+/, '').replace(/[\s:.]+$/, '').trim()
    directives.push({ type, params, rationale, missingAnchor })
    // Replace the matched region with spaces so the "remaining" pass
    // for leftover prose is accurate.
    remaining = remaining.slice(0, m.index) + ' '.repeat(m[0].length) + remaining.slice(m.index + m[0].length)
  }
  const leftover = remaining.replace(/\s+/g, ' ').trim()
  return { directives, rationale: leftover }
}

const DIRECTIVE_TONE = {
  reframe: { label: 'REFRAME', tone: 'bg-sf-accent/10 text-sf-accent border-sf-accent/30' },
  extend: { label: 'EXTEND', tone: 'bg-purple-500/10 text-purple-300 border-purple-500/30' },
  color: { label: 'COLOR', tone: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30' },
  'audio-music': { label: 'MUSIC', tone: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' },
  'audio-vo': { label: 'VO', tone: 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30' },
}

// Render the parsed directives as stacked labeled lines. Sits above
// the raw-note textarea so the user can scan the structured breakdown
// and still edit the free text if they want to tweak something.
function RationaleBreakdown({ note }) {
  const { directives, rationale } = useMemo(() => splitRationaleDirectives(note), [note])
  if (directives.length === 0 && !rationale) return null
  return (
    <div className="flex flex-col gap-1">
      {directives.map((d, i) => {
        const meta = DIRECTIVE_TONE[d.type] || { label: d.type.toUpperCase(), tone: 'bg-sf-dark-800 text-sf-text-secondary border-sf-dark-700' }
        return (
          <div key={`${d.type}-${i}`} className="flex items-start gap-1.5 text-[11px] leading-snug">
            <span className={`inline-flex flex-shrink-0 items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold tracking-wider ${meta.tone}`}>
              {meta.label}
            </span>
            <div className="flex-1 text-sf-text-primary">
              {d.params && (
                <span className="text-sf-text-muted font-mono text-[10px] mr-1.5">{d.params}</span>
              )}
              {d.rationale || <span className="italic text-sf-text-muted">(no rationale)</span>}
              {/* A reframe with zoom but no anchor degenerates into a
                  symmetric center-crop; surface the warning inline so
                  the user can either edit the note to add an anchor or
                  know they're looking at a weaker reframe than the
                  LLM described. */}
              {d.missingAnchor && (
                <span className="ml-1.5 inline-flex items-center gap-0.5 px-1 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[9px]">
                  <AlertCircle className="w-2.5 h-2.5" />
                  no anchor — defaulted to center
                </span>
              )}
            </div>
          </div>
        )
      })}
      {rationale && (
        <div className="text-[11px] text-sf-text-secondary italic leading-snug pl-1">
          {rationale}
        </div>
      )}
    </div>
  )
}

// Per-row rationale cell: chips by default, with a pencil toggle that
// swaps in an editable textarea when the user wants to tweak the raw
// note. Keeping the textarea hidden by default removes the visual
// duplication between the parsed breakdown and the raw source text —
// they say the same thing, so showing both at the same time reads as
// "this is printed twice".
function NoteCell({ note, onChange }) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="group relative">
      {editing ? (
        <div className="flex flex-col gap-1">
          <textarea
            value={note}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full text-[11px] rounded border border-sf-accent/60 bg-sf-dark-900 px-1.5 py-1 text-sf-text-primary resize-y focus:outline-none font-mono leading-relaxed"
            placeholder="—"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-[10px] px-1.5 py-0.5 rounded border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
              title="Close editor. Changes are already saved as you typed."
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-1.5">
          <div className="flex-1 min-w-0">
            <RationaleBreakdown note={note} />
            {!note && (
              <span className="text-sf-text-muted italic text-[11px]">—</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-shrink-0 p-1 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Edit raw note"
          >
            <Pencil className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
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

  // Voiceover plan — which VO segments (from analysis.overall.voiceover_segments)
  // end up on the timeline, and whether the user has taken manual control.
  //   autoEdit: true  → the proposer picks the subset that fits the target
  //                    duration; the UI shows the result read-only.
  //   autoEdit: false → user toggles individual segments in / out; their
  //                    picks override the proposer and land verbatim.
  // `segmentIds` only applies when autoEdit is off; empty array means
  // no manual selection yet (show all enabled by default).
  const [voPlan, setVoPlan] = useState(() => ({
    autoEdit: savedProposal?.voiceoverPlan?.autoEdit !== false,
    segmentIds: Array.isArray(savedProposal?.voiceoverPlan?.segmentIds)
      ? savedProposal.voiceoverPlan.segmentIds
      : null,
    // Per-segment timing overrides (user edits) and global lead pads.
    // 0.5 s lead-in / 0.3 s lead-out are conservative defaults that
    // catch the typical Gemini-timestamp drift without bleeding into
    // the previous / next phrase on most ads. The user can dial them
    // in the VO panel.
    segmentEdits: savedProposal?.voiceoverPlan?.segmentEdits || {},
    leadInSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadInSec)
      ? savedProposal.voiceoverPlan.leadInSec
      : 0.5,
    leadOutSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadOutSec)
      ? savedProposal.voiceoverPlan.leadOutSec
      : 0.3,
  }))

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
        // Creative strategist's read of the original ad, produced by the
        // Analyze pass in AnalysisView. Drives the "preserve original
        // intent" block in the prompt so the proposer doesn't drift off
        // concept while chasing the target metric.
        adConcept: currentProject?.analysis?.overall || null,
        // Time-stamped VO segments + current user plan. When the user has
        // Auto-edit on, the proposer picks which segments make the cut
        // and returns the list in `proposal.voiceoverPlan`. When Auto is
        // off, the user's picks bypass the LLM entirely via voPlanOverride.
        voSegments: currentProject?.analysis?.overall?.voiceover_segments || null,
        voPlanOverride: voPlan,
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
    await saveProject({ proposal: { ...draft, brandBrief, metric, useGeneratedVideos, voiceoverPlan: voPlan, status: 'draft' } })
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
      // Effective VO plan at Apply time. Layered merge:
      //   1. Start from the proposer's plan (segment selection if Auto)
      //      OR an empty object (user is in Manual).
      //   2. Overlay the user-side knobs (lead pads, per-segment
      //      timing edits) from the live `voPlan`. Those live in the UI
      //      and don't survive the proposer round-trip otherwise — the
      //      LLM doesn't know about leadInSec / leadOutSec / segmentEdits,
      //      so without this overlay the timeline would build VO clips
      //      with Gemini's raw (already-late) timestamps.
      //   3. In Manual mode the user's segmentIds always win.
      const baseFromDraft = (voPlan.autoEdit === false) ? {} : (draft.voiceoverPlan || {})
      const effectiveVoPlan = {
        ...baseFromDraft,
        autoEdit: voPlan.autoEdit,
        leadInSec: voPlan.leadInSec,
        leadOutSec: voPlan.leadOutSec,
        segmentEdits: voPlan.segmentEdits,
        ...(voPlan.autoEdit === false ? { segmentIds: voPlan.segmentIds } : {}),
      }
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
        voiceoverSegments: currentProject?.analysis?.overall?.voiceover_segments || null,
        voiceoverPlan: effectiveVoPlan,
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
              <AdConceptPanel analysis={analysis} onNavigate={onNavigate} />
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
              <VoiceoverPanel
                analysis={analysis}
                voPlan={voPlan}
                onChangeVoPlan={setVoPlan}
                proposerPickedIds={draft?.voiceoverPlan?.segmentIds}
                capabilities={capabilities}
                targetDurationSec={targetDurationSec}
                sourceVideo={sourceVideo}
              />
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
                          <NoteCell
                            note={row.note || ''}
                            onChange={(v) => updateNote(i, v)}
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
