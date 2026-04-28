/**
 * project:re-edit — Voiceover panels.
 *
 * Two top-level panels migrated from ProposalView:
 *   - <OriginalVoiceoverPanel> — drives the `useOriginalVoiceover`
 *     capability. Lets the user pick which segments of the source ad's
 *     VO get reused, edit per-segment timestamps, snap to speech, and
 *     dial lead-in / lead-out pads.
 *   - <GenerateVoiceoverPanel> — drives the `generateVoiceover`
 *     capability. Drafts new scripts via Gemini, persists them on the
 *     project, edits inline, and synthesises each via F5-TTS in
 *     ComfyUI cloning the source speaker's voice.
 *
 * Both panels are CONTROLLED — the parent (OptimizationView) owns the
 * persisted state (`voiceoverPlan`, `voiceoverDrafts`, `selectedId`)
 * and saves on every meaningful change. We keep only transient UI
 * state in the components themselves (preview-playing flags, in-flight
 * synth progress, form fields).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, Wand2, Sparkles, Trash2, Play, Pause, Mic, Users } from 'lucide-react'
import { KOKORO_VOICES, KOKORO_LANGUAGE_ORDER, defaultKokoroVoiceForLanguage } from '../../services/kokoroVoices'

// Single segment timing math: applies user-edited starts/ends if any,
// then expands by leadIn / leadOut. Lead pads grow each segment a touch
// earlier and later because Gemini's timestamps consistently arrive
// late on phrase starts.
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

function VoiceoverSegmentRow({ seg, selected, autoEdit, voPlan, onToggle, onEdit, stemUrl }) {
  const audioRef = useRef(null)
  const stopTimerRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const resolved = resolveSegment(seg, voPlan)
  const segDur = Math.max(0, resolved.endSec - resolved.startSec)

  useEffect(() => () => {
    if (audioRef.current) audioRef.current.pause()
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
  }, [])

  const handlePreview = (e) => {
    e.stopPropagation()
    if (!stemUrl) return
    if (playing) {
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
    try { a.currentTime = Math.max(0, resolved.startSec) } catch (_) { /* noop */ }
    a.play().then(() => {
      setPlaying(true)
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

export function OriginalVoiceoverPanel({ analysis, voPlan, onChangeVoPlan, proposerPickedIds, capabilities, targetDurationSec, sourceVideo }) {
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
  // closest energy onset in the VO stem. Reuses the main-process
  // waveform service (ffmpeg) for high-resolution peaks instead of
  // decoding in the renderer.
  const [vadRunning, setVadRunning] = useState(false)
  const [vadError, setVadError] = useState(null)
  const stemPath = sourceVideo?.stems?.vocalsPath || null
  const stemUrl = stemPath ? `comfystudio://${encodeURIComponent(stemPath)}` : null
  const runVadSnap = async () => {
    if (!stemPath || vadRunning) return
    setVadRunning(true)
    setVadError(null)
    try {
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

  return (
    <div>
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

export function GenerateVoiceoverPanel({
  analysis,
  drafts,
  selectedId,
  onChangeDrafts,
  onChangeSelectedId,
  targetDurationSec,
  capabilities,
  sourceVideo,
  projectDir,
}) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  // Pre-fill tone with the mood Gemini extracted in the overall ad
  // analysis (analysis.overall.mood — usually 3-6 words like "warm,
  // nostalgic, quietly aspirational"). Saves the user from typing it
  // by hand every time; they can still edit / clear before generating.
  const [tone, setTone] = useState(() => analysis?.overall?.mood || '')
  const [extraInstructions, setExtraInstructions] = useState('')
  // F5-TTS quality knobs surfaced from the synth handler. NFE (16-64)
  // is the dominant lever for sharpness; speed is a post-process
  // time-stretch (>1.0 = slower / more deliberate). Panel-level state
  // — applied to whichever draft the user clicks Synthesise on next.
  const [nfeSteps, setNfeSteps] = useState(48)
  const [speed, setSpeed] = useState(1.0)
  // Voice source: clone the original speaker (F5-TTS) or pick a Kokoro
  // preset voice. Default to clone — preserves prior behaviour.
  const [voiceMode, setVoiceMode] = useState('clone')
  const [kokoroVoice, setKokoroVoice] = useState('af_heart')
  // Target ad duration that the script writer plans the VO around.
  // Pre-fills from the project's target (set in Proposal) but the user
  // can override here so they can iterate on the script without
  // bouncing to the Proposal tab. Drives word budget AND segment count
  // in the writer prompt.
  const [draftTargetDurationSec, setDraftTargetDurationSec] = useState(
    () => Math.max(4, Math.round(targetDurationSec || 15)),
  )
  const [language, setLanguage] = useState(drafts.length > 0 ? drafts[drafts.length - 1].language : 'en')
  const [collapsed, setCollapsed] = useState(false)
  const [synthState, setSynthState] = useState({})
  const expandedDraftRef = useRef(null)

  const overall = analysis?.overall || null
  const originalTranscript = useMemo(() => {
    const segs = Array.isArray(overall?.voiceover_segments) ? overall.voiceover_segments : []
    return segs.map((s) => s?.text).filter(Boolean).join(' ')
  }, [overall?.voiceover_segments])

  const handleGenerate = async () => {
    setError(null)
    setGenerating(true)
    try {
      const { generateVoiceoverScriptDraft } = await import('../../services/reeditScriptWriter')
      const draft = await generateVoiceoverScriptDraft({
        adConcept: overall,
        originalTranscript,
        targetDurationSec: draftTargetDurationSec,
        language,
        tone: tone.trim(),
        extraInstructions: extraInstructions.trim(),
        previousDrafts: drafts,
      })
      const next = [...drafts, draft]
      onChangeDrafts(next)
      if (!selectedId) onChangeSelectedId(draft.id)
      expandedDraftRef.current = draft.id
    } catch (err) {
      console.error('[reedit] script generation failed:', err)
      setError(err?.message || 'Script generation failed.')
    } finally {
      setGenerating(false)
    }
  }

  const handleDeleteDraft = (id) => {
    const next = drafts.filter((d) => d.id !== id)
    onChangeDrafts(next)
    if (selectedId === id) onChangeSelectedId(next.length > 0 ? next[next.length - 1].id : null)
  }

  const handleEditSegment = (draftId, segId, patch) => {
    const next = drafts.map((d) => {
      if (d.id !== draftId) return d
      return {
        ...d,
        segments: d.segments.map((s) => (s.id === segId ? { ...s, ...patch } : s)),
        synthesis: d.synthesis ? null : d.synthesis,
      }
    })
    onChangeDrafts(next)
  }

  useEffect(() => {
    if (!window.electronAPI?.onSynthesizeVoiceoverProgress) return
    const off = window.electronAPI.onSynthesizeVoiceoverProgress((payload) => {
      const { draftId, stage, ...rest } = payload || {}
      if (!draftId) return
      setSynthState((prev) => ({
        ...prev,
        [draftId]: {
          ...(prev[draftId] || {}),
          running: stage !== 'done' && stage !== 'failed',
          stage,
          ...rest,
        },
      }))
    })
    return () => { try { off && off() } catch (_) { /* noop */ } }
  }, [])

  const handleSynthesize = async (draft) => {
    setError(null)
    // Branch by mode: clone needs the source VO stem; Kokoro doesn't.
    let voiceRef = null
    if (voiceMode === 'clone') {
      const stems = sourceVideo?.stems
      if (!stems?.vocalsPath) {
        setError('Voice cloning needs the original VO stem. Run Demucs separation in the Import view first, or switch to "Pick a voice".')
        return
      }
      const { pickVoiceReferenceWindow } = await import('../../services/reeditScriptWriter')
      const window_ = pickVoiceReferenceWindow(analysis?.overall?.voiceover_segments)
      if (!window_) {
        setError('Could not pick a clean reference window from the original VO. Make sure the overall analysis ran successfully, or switch to "Pick a voice".')
        return
      }
      voiceRef = {
        audioPath: stems.vocalsPath,
        startSec: window_.startSec,
        endSec: window_.endSec,
        transcript: window_.transcript,
      }
    } else if (voiceMode === 'kokoro') {
      if (!kokoroVoice) {
        setError('Pick a Kokoro voice from the dropdown before synthesising.')
        return
      }
    }
    setSynthState((prev) => ({
      ...prev,
      [draft.id]: { running: true, stage: 'starting', totalSegments: draft.segments.length },
    }))
    try {
      const res = await window.electronAPI.synthesizeVoiceover({
        draftId: draft.id,
        projectDir,
        segments: draft.segments.map((s) => ({ id: s.id, text: s.text, role: s.role })),
        voiceMode,
        ...(voiceMode === 'clone' ? { voiceRef } : {}),
        ...(voiceMode === 'kokoro' ? { kokoroVoice } : {}),
        language: draft.language || 'en',
        nfeSteps,
        speed,
      })
      if (!res?.success) throw new Error(res?.error || 'Synthesis failed.')
      // Persist the voice choice on the draft so re-synth (or just
      // reading the draft later) knows which voice produced the audio.
      const updated = drafts.map((d) => d.id === draft.id ? {
        ...d,
        synthesis: {
          status: 'done',
          completedAt: new Date().toISOString(),
          segmentAudio: res.segmentAudio || {},
          combinedAudioPath: res.combinedAudioPath || null,
          combinedDurationSec: res.combinedDurationSec || null,
          voiceRef: res.voiceRef || null,
          voiceMode,
          kokoroVoice: voiceMode === 'kokoro' ? kokoroVoice : null,
        },
      } : d)
      onChangeDrafts(updated)
      setSynthState((prev) => ({ ...prev, [draft.id]: { running: false, stage: 'done' } }))
    } catch (err) {
      console.error('[reedit] VO synthesis failed:', err)
      setSynthState((prev) => ({ ...prev, [draft.id]: { running: false, stage: 'failed', error: err.message } }))
      setError(err.message || 'Synthesis failed.')
    }
  }

  const blocked = !capabilities?.generateVoiceover
  if (blocked) {
    return (
      <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 p-4 text-sm text-sf-text-muted">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={14} className="text-sf-text-muted" />
          <span className="font-medium">Generate new voiceover (capability off)</span>
        </div>
        <p>Enable <span className="font-mono text-sf-text-secondary">Generate new voiceover</span> in the Capabilities section to draft a fresh script with Gemini and synthesise it via ComfyUI.</p>
      </div>
    )
  }

  const noOverall = !overall || (!overall.concept && !overall.message)

  return (
    <div className="rounded-lg border border-sf-accent/30 bg-sf-accent/5 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={14} className="text-sf-accent" />
            <span className="text-sm font-semibold text-sf-text-primary">Voiceover script</span>
            <span className="text-[10px] uppercase tracking-wider text-sf-accent/80 bg-sf-accent/15 border border-sf-accent/30 rounded px-1.5 py-0.5">new</span>
          </div>
          <p className="text-xs text-sf-text-muted">
            Have Gemini draft a fresh script using the ad's concept and mood. Generate as many takes as you want, edit any segment inline, then pick the one the proposer should plan around.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="text-xs text-sf-text-muted hover:text-sf-text-primary"
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed && (
        <>
          {noOverall && (
            <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Run the overall ad analysis first (Analysis tab → "Analyze") so Gemini has the concept and mood to write from.
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">
                Target ad duration
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  max={120}
                  step={1}
                  value={draftTargetDurationSec}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10)
                    if (Number.isFinite(v)) setDraftTargetDurationSec(Math.max(5, Math.min(120, v)))
                  }}
                  className="w-20 text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary"
                />
                <span className="text-xs text-sf-text-muted">seconds</span>
                <span className="text-[10px] text-sf-text-muted/70 ml-auto">
                  ~{draftTargetDurationSec <= 12 ? '2' : draftTargetDurationSec <= 22 ? '2-3' : draftTargetDurationSec <= 35 ? '3-4' : draftTargetDurationSec <= 50 ? '4-6' : '6-8'} segs
                </span>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary"
              >
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="pt">Portuguese</option>
                <option value="fr">French</option>
                <option value="it">Italian</option>
                <option value="de">German</option>
                <option value="ja">Japanese</option>
                <option value="zh">Chinese (Mandarin)</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">Tone (optional)</label>
              <input
                type="text"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="e.g. drier, more cinematic, less salesy"
                className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary placeholder:text-sf-text-muted/60"
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">Extra instructions (optional)</label>
            <textarea
              rows={2}
              value={extraInstructions}
              onChange={(e) => setExtraInstructions(e.target.value)}
              placeholder="e.g. open with a question, keep the brand name out of the first line"
              className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary placeholder:text-sf-text-muted/60 resize-none"
            />
          </div>

          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || noOverall}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-sf-accent text-white hover:bg-sf-accent/90 disabled:bg-sf-dark-700 disabled:text-sf-text-muted disabled:cursor-not-allowed"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {drafts.length === 0 ? 'Generate first draft' : `Generate another draft (${drafts.length} so far)`}
            </button>
            {drafts.length > 0 && (
              <span className="text-xs text-sf-text-muted">Selected draft drives the proposal.</span>
            )}
          </div>

          {/* Voice source row — clone the source speaker (F5-TTS) or
              pick a Kokoro preset voice. Kokoro doesn't need the VO
              stem so this works even on projects without Demucs. */}
          <div className="mb-3 px-3 py-2 rounded border border-sf-dark-700 bg-sf-dark-900/60 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider text-sf-text-muted font-medium shrink-0">Voice</span>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-sf-text-secondary cursor-pointer">
                <input
                  type="radio"
                  name="voiceMode"
                  checked={voiceMode === 'clone'}
                  onChange={() => setVoiceMode('clone')}
                  className="accent-sf-accent"
                />
                <Mic className="w-3 h-3" />
                Clone original speaker
              </label>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-sf-text-secondary cursor-pointer">
                <input
                  type="radio"
                  name="voiceMode"
                  checked={voiceMode === 'kokoro'}
                  onChange={() => setVoiceMode('kokoro')}
                  className="accent-sf-accent"
                />
                <Users className="w-3 h-3" />
                Pick a voice
              </label>
              <span className="ml-auto text-[10px] italic text-sf-text-muted/80">
                {voiceMode === 'clone'
                  ? 'F5-TTS clones the source VO speaker'
                  : 'Kokoro-TTS — 50+ preset voices'}
              </span>
            </div>
            {voiceMode === 'kokoro' && (
              <KokoroVoicePicker value={kokoroVoice} onChange={setKokoroVoice} />
            )}
          </div>

          {/* Synthesis quality knobs. NFE only matters for the clone
              path (F5-TTS); Kokoro is one-shot inference. Speed is
              applied either way. */}
          <div className="flex items-center gap-4 mb-3 px-3 py-2 rounded border border-sf-dark-700 bg-sf-dark-900/60">
            <span className="text-[10px] uppercase tracking-wider text-sf-text-muted font-medium shrink-0">Synthesis</span>
            {voiceMode === 'clone' && (
              <label className="flex items-center gap-2 text-[11px] text-sf-text-muted">
                <span className="shrink-0" title="Number of denoising steps F5-TTS runs per segment. Higher = sharper / less artifacts, slower. Default 32.">Quality</span>
                <input
                  type="range"
                  min={16}
                  max={64}
                  step={4}
                  value={nfeSteps}
                  onChange={(e) => setNfeSteps(parseInt(e.target.value, 10))}
                  className="w-24 accent-sf-accent"
                />
                <span className="font-mono text-sf-text-secondary tabular-nums w-14 text-right">{nfeSteps} steps</span>
              </label>
            )}
            <label className="flex items-center gap-2 text-[11px] text-sf-text-muted">
              <span className="shrink-0" title="Post-process time-stretch on the synthesised audio. >1.0 = slower / more deliberate read; <1.0 = faster / more energy.">Speed</span>
              <input
                type="range"
                min={0.85}
                max={1.20}
                step={0.05}
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                className="w-24 accent-sf-accent"
              />
              <span className="font-mono text-sf-text-secondary tabular-nums w-12 text-right">{speed.toFixed(2)}×</span>
            </label>
            {voiceMode === 'clone' && (
              <span className="ml-auto text-[10px] italic text-sf-text-muted/80">
                {nfeSteps >= 56 ? 'sharper, slower render' : nfeSteps <= 24 ? 'faster, draft quality' : 'balanced'}
              </span>
            )}
          </div>

          {error && (
            <div className="mb-3 rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-200 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {drafts.length === 0 ? (
            <div className="rounded border border-dashed border-sf-dark-700 bg-sf-dark-900/40 px-3 py-6 text-center text-xs text-sf-text-muted">
              No drafts yet. Click <span className="text-sf-text-secondary">Generate first draft</span> to start.
            </div>
          ) : (
            <div className="space-y-2">
              {drafts.map((draft, idx) => (
                <ScriptDraftCard
                  key={draft.id}
                  draft={draft}
                  index={idx + 1}
                  selected={selectedId === draft.id}
                  onSelect={() => onChangeSelectedId(draft.id)}
                  onDelete={() => handleDeleteDraft(draft.id)}
                  onEditSegment={(segId, patch) => handleEditSegment(draft.id, segId, patch)}
                  onSynthesize={() => handleSynthesize(draft)}
                  synthState={synthState[draft.id]}
                  defaultExpanded={expandedDraftRef.current === draft.id}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ScriptDraftCard({ draft, index, selected, onSelect, onDelete, onEditSegment, onSynthesize, synthState, defaultExpanded }) {
  const [expanded, setExpanded] = useState(Boolean(defaultExpanded))
  const totalSpokenSec = useMemo(() => {
    const words = draft.segments.reduce((sum, s) => sum + (s.text || '').trim().split(/\s+/).filter(Boolean).length, 0)
    return words / 2.4
  }, [draft.segments])
  const totalGapSec = draft.segments.reduce((sum, s) => sum + (Number(s.gapBeforeSec) || 0), 0)
  const totalTimelineSec = totalSpokenSec + totalGapSec
  const langLabel = (() => {
    const map = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', it: 'Italian', de: 'German', ja: 'Japanese', zh: 'Mandarin' }
    return map[draft.language] || draft.language
  })()
  const synthDone = draft.synthesis?.status === 'done'
  const synthRunning = synthState?.running
  const synthFailed = synthState?.stage === 'failed'

  const stageLabel = (() => {
    if (!synthState) return null
    const { stage, index: si, total, segId } = synthState
    if (stage === 'extracting_reference') return 'Extracting voice reference…'
    if (stage === 'uploading_reference') return 'Uploading reference to ComfyUI…'
    if (stage === 'segment_starting') return `Synthesising segment ${si}/${total}${segId ? ` (${segId})` : ''}…`
    if (stage === 'segment_running') return `Rendering segment${segId ? ` ${segId}` : ''}… ${synthState.elapsedSec ?? ''}s`
    if (stage === 'segment_done') return `Segment ${si}/${total} done`
    if (stage === 'starting') return 'Starting…'
    if (stage === 'done') return 'All segments synthesised'
    if (stage === 'failed') return synthState.error || 'Synthesis failed'
    return stage || null
  })()

  return (
    <div className={`rounded border ${selected ? 'border-sf-accent bg-sf-accent/10' : 'border-sf-dark-700 bg-sf-dark-900/60'} overflow-hidden`}>
      <div className="px-3 py-2 flex items-center gap-2">
        <input
          type="radio"
          checked={selected}
          onChange={onSelect}
          className="cursor-pointer"
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left text-sm text-sf-text-primary hover:text-white"
        >
          <span className="font-medium">{index}. {draft.title || 'Draft'}</span>
          <span className="ml-2 text-[11px] text-sf-text-muted">
            {draft.segments.length} segs · ~{totalTimelineSec.toFixed(1)}s · {langLabel}
            {synthDone ? ' · synthesised' : ''}
          </span>
        </button>
        <button
          type="button"
          onClick={onSynthesize}
          disabled={synthRunning}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors
            ${synthDone
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
              : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent hover:bg-sf-accent/20'}
            disabled:opacity-50 disabled:cursor-not-allowed`}
          title={synthDone ? 'Re-synthesise (overwrites existing audio)' : 'Synthesise voiceover'}
        >
          {synthRunning ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          {synthRunning ? 'Synthesising…' : synthDone ? 'Re-synth' : 'Synthesise'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded text-sf-text-muted hover:text-red-300 hover:bg-red-500/10"
          title="Delete draft"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {(stageLabel && (synthRunning || synthFailed)) && (
        <div className={`px-3 py-1.5 text-[11px] border-t ${synthFailed ? 'border-red-500/30 bg-red-500/5 text-red-200' : 'border-sf-accent/20 bg-sf-accent/5 text-sf-accent'}`}>
          {stageLabel}
        </div>
      )}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-sf-dark-700/60 space-y-2">
          {draft.rationale && (
            <p className="text-[11px] italic text-sf-text-muted">{draft.rationale}</p>
          )}
          {/* Single combined WAV — what the timeline placer drops onto
              the audio track. The per-segment text editors below let
              you tweak words / roles / gaps; re-synth produces a fresh
              combined file. */}
          {draft.synthesis?.combinedAudioPath ? (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/5">
              <span className="text-[10px] uppercase tracking-wider text-emerald-300/90 font-medium shrink-0">Final mix</span>
              <audio
                src={`comfystudio://${encodeURIComponent(draft.synthesis.combinedAudioPath)}`}
                controls
                preload="metadata"
                className="h-7 flex-1"
              />
              {Number.isFinite(draft.synthesis.combinedDurationSec) && (
                <span className="text-[10px] tabular-nums text-emerald-300/80 shrink-0">
                  {draft.synthesis.combinedDurationSec.toFixed(1)}s
                </span>
              )}
            </div>
          ) : (
            // Legacy fallback: drafts synthesised before we started
            // emitting the combined WAV only have per-segment files.
            // Show a row of mini-players so the user can still preview,
            // and nudge a re-synth so the timeline placer gets a clean
            // single asset.
            (() => {
              const segAudio = draft.synthesis?.segmentAudio || {}
              const hasAny = draft.segments.some((s) => segAudio[s.id]?.path)
              if (!hasAny) return null
              return (
                <div className="flex flex-col gap-1.5 px-2 py-1.5 rounded border border-amber-500/30 bg-amber-500/5">
                  <div className="text-[10px] uppercase tracking-wider text-amber-300/90 font-medium">
                    Per-segment audio (legacy) — re-synth to get a single combined mix
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft.segments.map((seg, i) => {
                      const path = segAudio[seg.id]?.path
                      if (!path) return null
                      return (
                        <div key={seg.id} className="flex items-center gap-1.5">
                          <span className="text-[10px] text-sf-text-muted shrink-0">#{i + 1}</span>
                          <audio
                            src={`comfystudio://${encodeURIComponent(path)}`}
                            controls
                            preload="metadata"
                            className="h-6 max-w-[200px]"
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()
          )}
          {draft.segments.map((seg, i) => (
            <ScriptSegmentEditor
              key={seg.id}
              seg={seg}
              index={i + 1}
              onChange={(patch) => onEditSegment(seg.id, patch)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ScriptSegmentEditor({ seg, index, onChange }) {
  return (
    <div className="rounded border border-sf-dark-700 bg-sf-dark-950 p-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">#{index}</span>
        <select
          value={seg.role}
          onChange={(e) => onChange({ role: e.target.value })}
          className="text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-0.5 text-sf-text-secondary"
        >
          <option value="line">line</option>
          <option value="question">question</option>
          <option value="tagline">tagline</option>
          <option value="legal">legal</option>
        </select>
        <label className="ml-auto inline-flex items-center gap-1 text-[10px] text-sf-text-muted">
          gap before
          <input
            type="number"
            min={0}
            max={20}
            step={0.1}
            value={Number(seg.gapBeforeSec) || 0}
            onChange={(e) => onChange({ gapBeforeSec: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
            className="w-14 text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-0.5 text-sf-text-secondary"
          />
          <span>s</span>
        </label>
      </div>
      <textarea
        rows={2}
        value={seg.text}
        onChange={(e) => onChange({ text: e.target.value })}
        className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1 text-sf-text-primary resize-none"
      />
    </div>
  )
}

// Kokoro voice picker — three-tier filter (language → gender → voice).
// Reads the curated KOKORO_VOICES catalog, groups voices the same way
// the picker is rendered, and surfaces the human-readable `vibe` next
// to each name so the user can pick without clicking through every
// voice. The selection emits a single Kokoro voice id (e.g. 'af_bella').
function KokoroVoicePicker({ value, onChange }) {
  const selected = KOKORO_VOICES.find((v) => v.id === value) || KOKORO_VOICES[0]
  const [lang, setLang] = useState(selected.languageLabel)
  const [gender, setGender] = useState(selected.gender)
  // Filter the catalog by current language + gender. If the picked
  // gender has no voices in this language (rare — French male is the
  // only such case), gracefully fall back to whichever gender exists.
  const inLang = useMemo(
    () => KOKORO_VOICES.filter((v) => v.languageLabel === lang),
    [lang],
  )
  const availableGenders = useMemo(
    () => Array.from(new Set(inLang.map((v) => v.gender))),
    [inLang],
  )
  const effectiveGender = availableGenders.includes(gender) ? gender : (availableGenders[0] || 'female')
  const filtered = inLang.filter((v) => v.gender === effectiveGender)

  // When the user changes language / gender, auto-pick the first
  // matching voice so the dropdown never sits in an inconsistent state.
  useEffect(() => {
    if (filtered.length === 0) return
    if (!filtered.some((v) => v.id === value)) {
      onChange(filtered[0].id)
    }
  }, [filtered, value, onChange])

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Language</span>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="text-[11px] rounded border border-sf-dark-700 bg-sf-dark-950 px-2 py-1 text-sf-text-primary"
        >
          {KOKORO_LANGUAGE_ORDER.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Gender</span>
        <select
          value={effectiveGender}
          onChange={(e) => setGender(e.target.value)}
          className="text-[11px] rounded border border-sf-dark-700 bg-sf-dark-950 px-2 py-1 text-sf-text-primary"
        >
          {availableGenders.map((g) => (
            <option key={g} value={g}>{g === 'female' ? 'Female' : 'Male'}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Voice</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="text-[11px] rounded border border-sf-dark-700 bg-sf-dark-950 px-2 py-1 text-sf-text-primary"
        >
          {filtered.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {v.vibe}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
