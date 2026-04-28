/**
 * project:re-edit — Generate-music panel.
 *
 * Drives the `generateMusic` capability. Lets the user author N music
 * drafts (genre + instruments + mood prompt, optional lyrics, duration,
 * key/bpm), synthesise each via ComfyUI's ACE-Step 1.5 workflow, and
 * pick one to drive the timeline's audio track.
 *
 * Shape of a draft on the project (persisted under `musicDrafts`):
 *   {
 *     id, createdAt,
 *     title, tags, lyrics, durationSec, bpm, language, keyscale,
 *     synthesis: {
 *       status: 'done'|'failed',
 *       audioPath: string,
 *       durationSec: number,
 *       seed, completedAt,
 *     } | null,
 *   }
 *
 * Persistence is controlled — the parent passes `drafts` + `selectedId`
 * + change handlers. Mirrors the GenerateVoiceoverPanel pattern.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertCircle, Wand2, Music2, Trash2, Play, Sparkles, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'

// Curated tag taxonomies. Same vocabulary stock-music libraries
// (Artlist, EpidemicSound) use to filter their catalogues — well
// understood by ACE-Step's text encoder because it was trained on
// captions written with the same conventions. The chip picker below
// lets the user assemble a prompt by clicking instead of typing, then
// adds free-text on top for fine detail.
const TAG_CATEGORIES = [
  {
    id: 'genre',
    label: 'Genre',
    tags: ['Acoustic', 'Ambient', 'Blues', 'Children', 'Cinematic', 'Classical', 'Corporate', 'Country', 'Electronic', 'Fantasy', 'Folk', 'Funk', 'Hip Hop', 'Holiday', 'Indie', 'Jazz', 'Latin', 'Lofi & Chill Beats', 'Lounge', 'Pop', 'Reggae', 'Retro', 'Rock', 'Singer-Songwriter', 'Soul & RnB', 'World', 'Worship'],
  },
  {
    id: 'mood',
    label: 'Mood',
    tags: ['Uplifting', 'Epic', 'Powerful', 'Exciting', 'Happy', 'Funny', 'Carefree', 'Hopeful', 'Love', 'Playful', 'Groovy', 'Sexy', 'Peaceful', 'Mysterious', 'Serious', 'Dramatic', 'Angry', 'Tense', 'Sad', 'Scary', 'Dark'],
  },
  {
    id: 'theme',
    label: 'Video Theme',
    tags: ['Business', 'Commercial', 'Documentary', 'Drone Shots', 'Education', 'Fashion', 'Food', 'Gaming', 'Industry', 'Intros & Logos', 'Landscape', 'Lifestyle', 'Medical', 'Nature', 'Party', 'Road Trip', 'Science', 'Slow Motion', 'Sport & Fitness', 'Technology', 'Time-Lapse', 'Trailer', 'Travel', 'Urban', 'Vlog', 'Weddings', 'Shorts'],
  },
  {
    id: 'instrument',
    label: 'Instrument',
    tags: ['Acoustic Drums', 'Acoustic Guitar', 'Backing Vocals', 'Bass', 'Bells', 'Brass', 'Claps & Snaps', 'Electric Guitar', 'Electronic Drums', 'Ethnic', 'Keys', 'Mandolin & Ukulele', 'Orchestra', 'Pads', 'Percussion', 'Piano', 'Special Wind Instruments', 'Strings', 'Synth', 'Vocal', 'Whistle', 'Woodwinds'],
  },
]

const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'fr', label: 'French' },
  { code: 'it', label: 'Italian' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Mandarin' },
]

// Diatonic key options — same enum the ACE-Step text encoder accepts.
const KEY_SCALES = (() => {
  const roots = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B']
  const out = []
  for (const q of ['major', 'minor']) {
    for (const r of roots) out.push(`${r} ${q}`)
  }
  return out
})()

export default function MusicPanel({
  drafts,
  selectedId,
  onChangeDrafts,
  onChangeSelectedId,
  capabilities,
  projectDir,
  defaultDurationSec,
}) {
  const [generating, setGenerating] = useState(null) // null | draftId currently rendering
  const [error, setError] = useState(null)
  // Tags selected from the chip picker. Combined with `freeText` at
  // synth time into a single comma-joined prompt the encoder consumes.
  const [selectedTags, setSelectedTags] = useState(() => new Set())
  const [freeText, setFreeText] = useState('')
  const [openCategories, setOpenCategories] = useState(() => new Set(['genre', 'mood']))
  const [lyrics, setLyrics] = useState('')
  const [language, setLanguage] = useState('en')
  const [keyscale, setKeyscale] = useState('C minor')
  const [bpm, setBpm] = useState(110)
  const [durationSec, setDurationSec] = useState(() => Math.max(8, Math.round(defaultDurationSec || 30)))
  const [synthState, setSynthState] = useState({}) // { [draftId]: { running, stage, elapsedSec, error } }

  const toggleTag = (tag) => {
    setSelectedTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }
  const toggleCategoryOpen = (id) => {
    setOpenCategories((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Build the final prompt the encoder gets: tags first (in the order
  // the user picked them is fine — order doesn't matter to ACE-Step's
  // text encoder), then any free-text additions.
  const composedPrompt = useMemo(() => {
    const parts = [...selectedTags]
    if (freeText.trim()) parts.push(freeText.trim())
    return parts.join(', ')
  }, [selectedTags, freeText])

  // Subscribe once to ComfyUI synth progress.
  useEffect(() => {
    if (!window.electronAPI?.onSynthesizeMusicProgress) return
    const off = window.electronAPI.onSynthesizeMusicProgress((payload) => {
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

  const handleGenerate = async () => {
    setError(null)
    if (!composedPrompt.trim()) {
      setError('Pick at least one tag (or type a description in the additional context box) before generating.')
      return
    }
    // Stage 1: create the draft locally so the UI shows it immediately
    // with a "synthesising" indicator, THEN kick off the ComfyUI run.
    const draft = {
      id: `music-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
      title: deriveTitleFromTags(composedPrompt),
      tags: composedPrompt,
      // Keep the structured pieces so the user can re-open a draft
      // later and see what they picked vs typed (UX polish).
      tagsSelected: [...selectedTags],
      tagsFreeText: freeText.trim(),
      lyrics: lyrics.trim(),
      durationSec: Math.max(8, Math.min(240, Number(durationSec) || 30)),
      bpm: Math.max(40, Math.min(220, Number(bpm) || 120)),
      language,
      keyscale,
      synthesis: null,
    }
    const next = [...drafts, draft]
    onChangeDrafts(next)
    if (!selectedId) onChangeSelectedId(draft.id)
    await runSynthesis(draft, next)
  }

  const runSynthesis = async (draft, currentDrafts) => {
    setGenerating(draft.id)
    setSynthState((prev) => ({ ...prev, [draft.id]: { running: true, stage: 'starting' } }))
    try {
      const res = await window.electronAPI.synthesizeMusic({
        draftId: draft.id,
        projectDir,
        tags: draft.tags,
        lyrics: draft.lyrics,
        durationSec: draft.durationSec,
        bpm: draft.bpm,
        language: draft.language,
        keyscale: draft.keyscale,
      })
      if (!res?.success) throw new Error(res?.error || 'Music synthesis failed.')
      const updated = currentDrafts.map((d) => d.id === draft.id ? {
        ...d,
        synthesis: {
          status: 'done',
          audioPath: res.audioPath,
          workflowJsonPath: res.workflowJsonPath || null,
          internalDurationSec: res.internalDuration || null,
          durationSec: res.durationSec,
          seed: res.seed,
          completedAt: new Date().toISOString(),
        },
      } : d)
      onChangeDrafts(updated)
      setSynthState((prev) => ({ ...prev, [draft.id]: { running: false, stage: 'done' } }))
    } catch (err) {
      console.error('[reedit] music synth failed:', err)
      setSynthState((prev) => ({ ...prev, [draft.id]: { running: false, stage: 'failed', error: err.message } }))
      setError(err.message || 'Music synthesis failed.')
    } finally {
      setGenerating(null)
    }
  }

  const handleResynth = async (draft) => {
    setError(null)
    await runSynthesis(draft, drafts)
  }

  const handleDelete = (id) => {
    const next = drafts.filter((d) => d.id !== id)
    onChangeDrafts(next)
    if (selectedId === id) onChangeSelectedId(next.length > 0 ? next[next.length - 1].id : null)
  }

  if (!capabilities?.generateMusic) return null

  return (
    <div className="space-y-3">
      {/* Form */}
      <div className="rounded border border-sf-dark-700 bg-sf-dark-950 p-3 space-y-3">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <label className="text-[11px] font-medium text-sf-text-muted uppercase tracking-wider">Style / genre</label>
            {selectedTags.size > 0 && (
              <>
                <span className="text-[10px] text-sf-text-muted">{selectedTags.size} tag{selectedTags.size === 1 ? '' : 's'} selected</span>
                <button
                  type="button"
                  onClick={() => setSelectedTags(new Set())}
                  className="ml-auto text-[10px] text-sf-text-muted hover:text-sf-text-primary underline"
                >
                  Clear all
                </button>
              </>
            )}
          </div>
          {/* Tag categories — collapsible chip pickers */}
          <div className="space-y-1.5">
            {TAG_CATEGORIES.map((cat) => {
              const open = openCategories.has(cat.id)
              const selectedInCat = cat.tags.filter((t) => selectedTags.has(t)).length
              return (
                <div key={cat.id} className="rounded border border-sf-dark-700 bg-sf-dark-900">
                  <button
                    type="button"
                    onClick={() => toggleCategoryOpen(cat.id)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sf-dark-800/40"
                  >
                    {open ? <ChevronUp className="w-3 h-3 text-sf-text-muted" /> : <ChevronDown className="w-3 h-3 text-sf-text-muted" />}
                    <span className="text-[11px] font-medium text-sf-text-secondary">{cat.label}</span>
                    {selectedInCat > 0 && (
                      <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-sf-accent/20 text-sf-accent border border-sf-accent/30">
                        {selectedInCat}
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="px-2.5 py-2 border-t border-sf-dark-700/60 flex flex-wrap gap-1.5">
                      {cat.tags.map((tag) => {
                        const isOn = selectedTags.has(tag)
                        return (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors
                              ${isOn
                                ? 'border-sf-accent bg-sf-accent text-white hover:bg-sf-accent/90'
                                : 'border-sf-dark-700 bg-sf-dark-950 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                          >
                            {tag}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          {/* Free-text addendum */}
          <div className="mt-2">
            <label className="block text-[10px] uppercase tracking-wider text-sf-text-muted mb-1">
              Additional context (optional)
            </label>
            <textarea
              rows={2}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder='e.g. "mid-tempo, building tension, warm analog synth pads, subtle percussion"'
              className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary placeholder:text-sf-text-muted/60 resize-none"
            />
          </div>
          {/* Live prompt preview — what the encoder actually receives */}
          {composedPrompt && (
            <div className="mt-2 rounded border border-sf-accent/20 bg-sf-accent/5 px-2 py-1.5 text-[11px] text-sf-text-secondary">
              <span className="text-[9px] uppercase tracking-wider text-sf-accent/80 mr-1.5">prompt</span>
              {composedPrompt}
            </div>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">
            Lyrics (optional — empty for instrumental)
          </label>
          <textarea
            rows={2}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="[Verse 1]&#10;..."
            className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5 text-sf-text-primary placeholder:text-sf-text-muted/60 resize-none"
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Duration</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={8}
                max={240}
                step={1}
                value={durationSec}
                onChange={(e) => setDurationSec(Math.max(8, Math.min(240, parseInt(e.target.value, 10) || 30)))}
                className="w-full text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-1 text-sf-text-primary"
              />
              <span className="text-[10px] text-sf-text-muted">s</span>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">BPM</span>
            <input
              type="number"
              min={40}
              max={220}
              step={1}
              value={bpm}
              onChange={(e) => setBpm(Math.max(40, Math.min(220, parseInt(e.target.value, 10) || 120)))}
              className="w-full text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-1 text-sf-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Key</span>
            <select
              value={keyscale}
              onChange={(e) => setKeyscale(e.target.value)}
              className="w-full text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-1 text-sf-text-primary"
            >
              {KEY_SCALES.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Language</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-full text-[11px] rounded border border-sf-dark-700 bg-sf-dark-900 px-1.5 py-1 text-sf-text-primary"
            >
              {SUPPORTED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={Boolean(generating)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-sf-accent text-white hover:bg-sf-accent/90 disabled:bg-sf-dark-700 disabled:text-sf-text-muted disabled:cursor-not-allowed"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {drafts.length === 0 ? 'Generate first track' : `Generate another track (${drafts.length} so far)`}
        </button>
        {error && (
          <div className="rounded border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-200 flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Drafts list */}
      {drafts.length === 0 ? (
        <div className="rounded border border-dashed border-sf-dark-700 bg-sf-dark-900/40 px-3 py-6 text-center text-xs text-sf-text-muted">
          No music drafts yet. Click <span className="text-sf-text-secondary">Generate first track</span>. First run takes ~3-6 min on a 4070 (model load + 8-step diffusion).
        </div>
      ) : (
        <div className="space-y-2">
          {drafts.map((draft, idx) => (
            <MusicDraftCard
              key={draft.id}
              draft={draft}
              index={idx + 1}
              selected={selectedId === draft.id}
              onSelect={() => onChangeSelectedId(draft.id)}
              onDelete={() => handleDelete(draft.id)}
              onResynth={() => handleResynth(draft)}
              synthState={synthState[draft.id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Build a 4-6 word title from the tags prompt — first phrase, capped.
// Avoids forcing the user to type a label when the prompt itself
// describes the track ("Cinematic synth, mid-tempo, warm" → "Cinematic
// Synth").
function deriveTitleFromTags(tags) {
  const t = String(tags || '').trim()
  if (!t) return `Music draft (${new Date().toLocaleTimeString()})`
  const firstPhrase = t.split(/[,.\n]/)[0].trim()
  const words = firstPhrase.split(/\s+/).slice(0, 5).join(' ')
  return words.replace(/\b\w/g, (c) => c.toUpperCase())
}

function MusicDraftCard({ draft, index, selected, onSelect, onDelete, onResynth, synthState }) {
  const synth = draft.synthesis
  const synthDone = synth?.status === 'done'
  const audioUrl = synthDone && synth.audioPath
    ? `comfystudio://${encodeURIComponent(synth.audioPath)}`
    : null
  const audioRef = useRef(null)
  const running = Boolean(synthState?.running)
  const failed = synthState?.stage === 'failed'

  const stageLabel = (() => {
    const stage = synthState?.stage
    if (!stage) return null
    if (stage === 'starting') return 'Starting…'
    if (stage === 'queued_submit') return 'Submitting workflow…'
    if (stage === 'queued') return 'Queued in ComfyUI…'
    if (stage === 'running') return `Rendering (ACE-Step)… ${synthState.elapsedSec ?? ''}s`
    if (stage === 'finalizing') return 'Finalising…'
    if (stage === 'done') return 'Done'
    if (stage === 'failed') return synthState.error || 'Synthesis failed'
    return stage
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
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-sf-text-primary truncate">
            {index}. {draft.title || 'Music draft'}
          </div>
          <div className="text-[11px] text-sf-text-muted truncate">
            {draft.durationSec}s · {draft.bpm} bpm · {draft.keyscale} · {draft.language}
            {synthDone ? ' · synthesised' : running ? ' · synthesising…' : failed ? ' · failed' : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onResynth}
          disabled={running}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors
            ${synthDone
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'
              : 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent hover:bg-sf-accent/20'}
            disabled:opacity-50 disabled:cursor-not-allowed`}
          title={synthDone ? 'Re-synthesise with the same params (new seed)' : 'Synthesise this draft'}
        >
          {running ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
          {running ? 'Synthesising…' : synthDone ? 'Re-synth' : 'Synthesise'}
        </button>
        {/* Reveal in Explorer/Finder — only enabled when synthesised.
            Clicking opens the project's music_generated dir with the
            MP3 highlighted; the workflow JSON sits next to it under
            <draftId>.workflow.json so the user can drag it back into
            ComfyUI to inspect or iterate. */}
        {synthDone && synth.audioPath && (
          <button
            type="button"
            onClick={() => window.electronAPI?.showItemInFolder?.(synth.audioPath)}
            className="p-1 rounded text-sf-text-muted hover:text-sf-accent hover:bg-sf-accent/10"
            title={`Reveal in file manager (also reveals workflow JSON sidecar)\n${synth.audioPath}`}
          >
            <ExternalLink size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="p-1 rounded text-sf-text-muted hover:text-red-300 hover:bg-red-500/10"
          title="Delete draft"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {(running || failed) && stageLabel && (
        <div className={`px-3 py-1.5 text-[11px] border-t ${failed ? 'border-red-500/30 bg-red-500/5 text-red-200' : 'border-sf-accent/20 bg-sf-accent/5 text-sf-accent'}`}>
          {stageLabel}
        </div>
      )}
      {audioUrl && (
        <div className="px-3 py-2 border-t border-sf-dark-700/60 space-y-1.5">
          <div className="flex items-center gap-2">
            <Music2 size={12} className="text-emerald-300/80 shrink-0" />
            <audio ref={audioRef} src={audioUrl} controls preload="metadata" className="h-7 flex-1" />
            {Number.isFinite(synth.durationSec) && (
              <span className="text-[10px] tabular-nums text-emerald-300/80 shrink-0">
                {synth.durationSec.toFixed(1)}s
              </span>
            )}
          </div>
          <WaveformViz audioPath={synth.audioPath} audioRef={audioRef} />
        </div>
      )}
    </div>
  )
}

// Lightweight waveform visualisation under the music draft player.
// Pulls bucketed peaks from the main process (ffmpeg-backed cache,
// shared with the timeline's waveform display) and draws them on a
// canvas. Played portion lights up emerald; unplayed stays grey.
// Click the canvas to seek the audio element.
function WaveformViz({ audioPath, audioRef, height = 40 }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [peaks, setPeaks] = useState([])
  const [progress, setProgress] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Pull peaks. 240 buckets is enough granularity at typical card
  // widths (~300-500 px) — denser than that and bars overlap.
  useEffect(() => {
    if (!audioPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await window.electronAPI?.getAudioWaveform?.(audioPath, { sampleCount: 240 })
        if (cancelled) return
        if (!res?.success || !Array.isArray(res.peaks)) {
          setError(res?.error || 'Could not load waveform.')
        } else {
          setPeaks(res.peaks)
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Waveform error.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [audioPath])

  // Sync the playhead with the audio element. We listen on
  // timeupdate (~4 Hz) + seeking (immediate) so the cursor tracks
  // both autoplay and manual scrubs.
  useEffect(() => {
    const audio = audioRef?.current
    if (!audio) return
    const onTime = () => {
      const dur = audio.duration
      if (!Number.isFinite(dur) || dur <= 0) return
      setProgress(audio.currentTime / dur)
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('seeking', onTime)
    audio.addEventListener('seeked', onTime)
    audio.addEventListener('loadedmetadata', onTime)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('seeking', onTime)
      audio.removeEventListener('seeked', onTime)
      audio.removeEventListener('loadedmetadata', onTime)
    }
  }, [audioRef])

  // Redraw the canvas when peaks or progress change. Devicepixel
  // ratio applied so the bars stay crisp on hi-DPI displays.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || peaks.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth * dpr
    const h = canvas.clientHeight * dpr
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    const peakMax = peaks.reduce((m, p) => Math.max(m, p), 0) || 1
    const barW = w / peaks.length
    const playX = progress * w
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i] / peakMax
      const barH = Math.max(1, p * (h - 2))
      const x = i * barW
      const y = (h - barH) / 2
      const isPlayed = x < playX
      // Emerald for played, neutral grey for unplayed — matches the
      // music card's existing emerald accents on the title row.
      ctx.fillStyle = isPlayed ? 'rgba(52, 211, 153, 0.95)' : 'rgba(82, 82, 91, 0.85)'
      ctx.fillRect(x, y, Math.max(1, barW - 1 * dpr), barH)
    }
    // Playhead line — only draw when actively in the middle of the
    // track (skip at 0 and at end so the canvas edges stay clean).
    if (progress > 0.001 && progress < 0.999) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.fillRect(playX - 0.5 * dpr, 0, 1 * dpr, h)
    }
  }, [peaks, progress])

  const handleClick = (e) => {
    const audio = audioRef?.current
    const container = containerRef.current
    if (!audio || !audio.duration || !container) return
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    audio.currentTime = Math.max(0, Math.min(audio.duration, (x / rect.width) * audio.duration))
  }

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="relative w-full bg-sf-dark-950 rounded overflow-hidden cursor-pointer hover:bg-sf-dark-900 transition-colors"
      style={{ height: `${height}px` }}
      title={error ? `Waveform: ${error}` : 'Click to seek'}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
      {loading && peaks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-sf-text-muted/60">
          loading waveform…
        </div>
      )}
      {error && peaks.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] text-amber-300/70">
          waveform unavailable
        </div>
      )}
    </div>
  )
}
