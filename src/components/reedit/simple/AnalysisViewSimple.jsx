import { useMemo, useRef, useState } from 'react'
import {
  Sparkles, Loader2, AlertCircle, PlayCircle, ImageIcon,
  Volume2, MessageSquare, Mic, Music as MusicIcon,
} from 'lucide-react'
import useProjectStore from '../../../stores/projectStore'
import { captionScenes, pickVisionModelId, analyzeOverallAd } from '../../../services/reeditCaptioner'

// Build comfystudio:// URL — same as toComfyUrl in AnalysisView (Advanced).
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
  return `${mm}:${String(ss).padStart(2, '0')}`
}

// Structured audio parts so each track type renders on its own line.
// Returns { vo, music, sfx, ambient, summary } — any field may be null.
// Field names match the captioner's schema (see AnalysisView for the
// authoritative reference):
//   audio.voiceover_transcript, audio.music, audio.sfx (array),
//   audio.ambient. Older captures may also emit { voiceover, summary }
//   so we fall back to those.
function audioParts(scene) {
  const a = scene?.videoAnalysis?.audio ?? scene?.structured?.audio
  if (!a) return null
  if (typeof a === 'string') {
    return a.trim() ? { summary: a.trim() } : null
  }
  const out = {}
  const vo = a.voiceover_transcript || a.voiceover
  if (vo && vo !== 'none') out.vo = vo
  if (a.music    && a.music    !== 'none') out.music = a.music
  if (Array.isArray(a.sfx) && a.sfx.length) {
    const items = a.sfx.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    if (items.length) out.sfx = items.join(', ')
  } else if (typeof a.sfx === 'string' && a.sfx && a.sfx !== 'none') {
    out.sfx = a.sfx
  }
  if (a.ambient && a.ambient !== 'none' && !out.music) out.ambient = a.ambient
  if (!out.vo && !out.music && !out.sfx && !out.ambient && a.summary) out.summary = a.summary
  if (Object.keys(out).length === 0) return null
  return out
}

// Audio summary as a single string (kept for legacy callers — current
// render uses audioParts directly).
function describeAudio(scene) {
  const parts = audioParts(scene)
  if (!parts) return null
  const out = []
  if (parts.vo)      out.push(`VO: ${parts.vo}`)
  if (parts.music)   out.push(`Music: ${parts.music}`)
  if (parts.sfx)     out.push(`SFX: ${parts.sfx}`)
  if (parts.ambient) out.push(`Ambient: ${parts.ambient}`)
  if (out.length === 0 && parts.summary) out.push(parts.summary)
  return out.length ? out.join(' · ') : null
}

// Structured graphics parts. The captioner emits a fixed schema —
// matches the same fields AnalysisView renders, so the two views show
// the same information. We do NOT walk arbitrary keys (older "permissive
// walk" pulled in schema-description strings that the LLM included in
// the response). Returns { text, textRole, logo, overlay } | null.
function graphicsParts(scene) {
  const g = scene?.videoAnalysis?.graphics ?? scene?.structured?.graphics
  if (!g) return null
  if (typeof g === 'string') {
    const s = g.trim()
    if (!s || s.toLowerCase() === 'none') return null
    return { overlay: s }
  }
  const out = {}
  if (g.text_content && g.text_content !== 'none') {
    out.text = g.text_content
    if (g.text_role && g.text_role !== 'none') out.textRole = g.text_role
  }
  if (g.logo_description && g.logo_description !== 'none') out.logo = g.logo_description
  if (g.other_graphics && g.other_graphics !== 'none') out.overlay = g.other_graphics
  return Object.keys(out).length ? out : null
}

function describeGraphics(scene) {
  const p = graphicsParts(scene)
  if (!p) return null
  const out = []
  if (p.text) {
    out.push(p.textRole ? `Text (${p.textRole}): "${p.text}"` : `Text: "${p.text}"`)
  }
  if (p.logo)    out.push(`Logo: ${p.logo}`)
  if (p.overlay) out.push(`Overlay: ${p.overlay}`)
  return out.length ? out.join(' · ') : null
}

// Tiny presentational helper used by the Ad-concept panel: label on top,
// value below. Each field gets its own accent color so they're scannable
// at a glance — message/mood/audience/brand/arc are different *kinds*
// of information, not interchangeable, so the colour helps the eye land
// on the right one immediately.
const FIELD_LABEL_COLORS = {
  Message:        'text-sky-300',
  Mood:           'text-fuchsia-300',
  Audience:       'text-emerald-300',
  'Brand role':   'text-amber-300',
  'Narrative arc':'text-violet-300',
}

function Field({ label, value, className = '' }) {
  const colorClass = FIELD_LABEL_COLORS[label] || 'text-sf-text-muted/80'
  return (
    <div className={className}>
      <div className={`text-[9px] uppercase tracking-wider mb-0.5 font-semibold ${colorClass}`}>{label}</div>
      <div className="text-sf-text-secondary">{value}</div>
    </div>
  )
}

function visualCaption(scene) {
  // Prefer the LLM-written caption, fall back to structured visual.
  if (scene?.caption) return scene.caption
  const v = scene?.videoAnalysis?.visual ?? scene?.structured?.visual
  if (typeof v === 'string') return v
  if (v?.summary) return v.summary
  return null
}

export default function AnalysisViewSimple() {
  const currentProject       = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject          = useProjectStore((s) => s.saveProject)

  const sourceVideo = currentProject?.sourceVideo
  const projectDir  = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
  const analysis    = currentProject?.analysis || null
  const scenes      = analysis?.scenes || []
  const overall     = analysis?.overall || null

  const [running, setRunning] = useState(false)
  const [phase, setPhase]     = useState('')
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [error, setError]     = useState(null)
  const abortRef = useRef({ aborted: false })

  const hasScenes = scenes.length > 0
  const hasCaptions = hasScenes && scenes.some((s) => visualCaption(s))

  // Detect scenes → extract thumbs → caption each → overall ad concept.
  // Sequential because each downstream step uses the previous step's
  // output. Errors at any stage surface inline; partial state is saved
  // (e.g. scenes + thumbs persist even if captioning fails on stage 3).
  async function runFullAnalysis() {
    if (running) return
    if (!sourceVideo?.path) { setError('Import a main video first.'); return }
    if (!projectDir) { setError('Project has no on-disk handle.'); return }
    setRunning(true)
    setError(null)
    abortRef.current = { aborted: false }

    let workingScenes = scenes
    try {
      // 1. Scene detection (skip if we already have scenes).
      if (workingScenes.length === 0) {
        setPhase('Detecting scenes…')
        const res = await window.electronAPI.detectScenes(sourceVideo.path, {
          threshold: 27,
          minSceneDurSec: 0.5,
          totalDurationSec: sourceVideo.duration || null,
        })
        if (!res?.success) throw new Error(res?.error || 'Scene detection failed.')
        const detected = Array.isArray(res.scenes) ? res.scenes : []
        if (detected.length === 0) throw new Error('No scenes detected.')

        const enriched = []
        for (let i = 0; i < detected.length; i++) {
          const scene = detected[i]
          setPhase(`Extracting thumbnails ${i + 1}/${detected.length}…`)
          const midpoint = Math.min(
            scene.tcIn + Math.min(1.0, (scene.tcOut - scene.tcIn) / 2),
            scene.tcOut - 0.05
          )
          const outputPath = `${projectDir.replace(/\\/g, '/')}/.reedit/scenes/${scene.id}.jpg`
          const thumbRes = await window.electronAPI.extractThumbnail({
            videoPath: sourceVideo.path,
            tcSec: midpoint,
            outputPath,
            width: 480,
          })
          enriched.push({
            ...scene,
            thumbnail: thumbRes?.success ? thumbRes.path : null,
            caption: null,
            structured: null,
          })
        }
        await saveProject({
          analysis: {
            status: 'done',
            createdAt: new Date().toISOString(),
            settings: { threshold: 27, minSceneDurSec: 0.5, detector: 'pyscenedetect-content' },
            scenes: enriched,
          },
        })
        workingScenes = enriched
      }

      // 2. Captioning (LLM per scene).
      setPhase('Picking vision model…')
      const modelId = await pickVisionModelId()
      setProgress({ current: 0, total: workingScenes.length })
      setPhase(`Captioning shots (${modelId})…`)

      const { scenes: captioned } = await captionScenes(workingScenes, {
        modelId,
        signal: abortRef.current,
        sourceVideoPath: sourceVideo.path,
        projectDir,
        onProgress: (p) => setProgress({ current: p?.current || 0, total: p?.total || workingScenes.length }),
      })
      workingScenes = captioned
      // Persist captioned scenes before running the overall step, so the
      // user keeps the captions even if the overall step blows up.
      await saveProject({
        analysis: {
          ...(useProjectStore.getState().currentProject?.analysis || {}),
          scenes: workingScenes,
          captionedAt: new Date().toISOString(),
          captionModel: modelId,
        },
      })

      // 3. Overall ad concept.
      setPhase('Analyzing overall ad concept…')
      const overallResult = await analyzeOverallAd(workingScenes, {
        sourceVideoPath: sourceVideo.path,
      })
      await saveProject({
        analysis: {
          ...(useProjectStore.getState().currentProject?.analysis || {}),
          overall: overallResult,
        },
      })
      setPhase('')
    } catch (err) {
      console.error('[reedit-simple] analysis failed:', err)
      setError(err?.message || 'Analysis failed.')
    } finally {
      setRunning(false)
    }
  }

  if (!sourceVideo) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Import a main video first.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="w-full px-8 py-8 space-y-6">

        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold mb-1">Analysis</h1>
            <p className="text-sm text-sf-text-muted truncate">{sourceVideo.name}</p>
          </div>
          <button
            onClick={runFullAnalysis}
            disabled={running}
            className="px-4 py-2 rounded bg-sf-accent hover:bg-sf-accent-hover text-white text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin"/> : <Sparkles size={14}/>}
            {running ? phase || 'Analyzing…' : (hasCaptions ? 'Re-analyze' : 'Analyze')}
          </button>
        </div>

        {running && progress.total > 0 && (
          <div className="text-xs text-sf-text-muted">
            {phase} — {progress.current} / {progress.total}
            <div className="h-1 mt-1 bg-sf-dark-800 rounded overflow-hidden">
              <div
                className="h-full bg-sf-accent transition-all"
                style={{ width: `${(progress.current / Math.max(1, progress.total)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-900/20 border border-red-500/40 text-red-300 text-sm p-3 rounded flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0"/>
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Ad concept panel — tidy two-row layout */}
        {overall ? (
          <div className="bg-sf-dark-900/60 border border-sf-dark-700 rounded-lg p-4 space-y-3">
            {/* Headline: concept on its own row */}
            {overall.concept && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-sf-text-muted mb-1">Ad concept</div>
                <p className="text-sm text-sf-text-primary leading-snug">{overall.concept}</p>
              </div>
            )}

            {/* Meta grid — short labels above values, fixed columns */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-2 text-[11px] leading-snug border-t border-sf-dark-700 pt-3">
              {overall.message && (
                <Field label="Message" value={overall.message} />
              )}
              {overall.mood && (
                <Field label="Mood" value={overall.mood} />
              )}
              {overall.target_audience && (
                <Field label="Audience" value={overall.target_audience} />
              )}
              {overall.brand_role && (
                <Field label="Brand role" value={overall.brand_role} />
              )}
              {overall.narrative_arc && (
                <Field label="Narrative arc" value={overall.narrative_arc} className="sm:col-span-2 lg:col-span-4" />
              )}
            </div>
          </div>
        ) : (
          <div className="bg-sf-dark-900/40 border border-dashed border-sf-dark-700 rounded-lg px-4 py-3 text-center text-xs text-sf-text-muted">
            {hasScenes
              ? 'Click Analyze to generate the ad concept.'
              : 'Click Analyze to detect shots and generate the ad concept.'}
          </div>
        )}

        {/* Storyboard */}
        <div>
          <div className="flex items-center mb-3">
            <h2 className="text-sm uppercase tracking-wide text-sf-text-muted">Storyboard</h2>
            {hasScenes && (
              <span className="ml-2 text-xs text-sf-text-muted">({scenes.length} shots)</span>
            )}
          </div>

          {!hasScenes ? (
            <div className="text-center text-sm text-sf-text-muted py-8 border border-dashed border-sf-dark-700 rounded">
              No shots yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              {scenes.map((s) => {
                const thumbUrl = s.thumbnail ? toComfyUrl(s.thumbnail, analysis?.captionedAt || analysis?.createdAt) : null
                const caption = visualCaption(s)
                const audio = audioParts(s)
                const gfx = graphicsParts(s)
                return (
                  <div key={s.id} className="bg-sf-dark-900/60 border border-sf-dark-700 rounded-lg overflow-hidden flex flex-col">
                    <div className="aspect-video bg-black relative">
                      {thumbUrl ? (
                        <img src={thumbUrl} alt="" className="w-full h-full object-contain"/>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-sf-text-muted text-xs">
                          <PlayCircle size={28}/>
                        </div>
                      )}
                      <div className="absolute bottom-1 left-1 text-[10px] font-mono bg-black/70 px-1.5 py-0.5 rounded">
                        {formatTc(s.tcIn)} → {formatTc(s.tcOut)}
                      </div>
                      {gfx && (
                        <div
                          title={describeGraphics(s) || 'Graphics'}
                          className="absolute top-1 right-1 inline-flex items-center gap-1 text-[10px] bg-amber-500/15 border border-amber-500/40 text-amber-200 px-1.5 py-0.5 rounded"
                        >
                          <ImageIcon size={10}/> Graphics
                        </div>
                      )}
                    </div>
                    <div className="p-2 text-[11px] space-y-1 flex-1">
                      {caption ? (
                        <div className="flex items-start gap-1.5">
                          <MessageSquare size={11} className="mt-0.5 shrink-0 text-sf-text-muted"/>
                          <div className="text-sf-text-primary line-clamp-2 leading-snug">{caption}</div>
                        </div>
                      ) : (
                        <div className="text-sf-text-muted italic">No caption yet.</div>
                      )}
                      {audio?.vo && (
                        <div className="flex items-start gap-1.5">
                          <Mic size={11} className="mt-0.5 shrink-0 text-fuchsia-300"/>
                          <div className="text-sf-text-secondary line-clamp-2 leading-snug">{audio.vo}</div>
                        </div>
                      )}
                      {audio?.music && (
                        <div className="flex items-start gap-1.5">
                          <MusicIcon size={11} className="mt-0.5 shrink-0 text-emerald-300"/>
                          <div className="text-sf-text-secondary line-clamp-2 leading-snug">{audio.music}</div>
                        </div>
                      )}
                      {audio?.sfx && (
                        <div className="flex items-start gap-1.5">
                          <Volume2 size={11} className="mt-0.5 shrink-0 text-sf-text-muted"/>
                          <div className="text-sf-text-muted line-clamp-2 leading-snug">
                            <span className="text-sf-text-muted/70">SFX: </span>{audio.sfx}
                          </div>
                        </div>
                      )}
                      {audio?.ambient && (
                        <div className="flex items-start gap-1.5">
                          <Volume2 size={11} className="mt-0.5 shrink-0 text-sf-text-muted"/>
                          <div className="text-sf-text-muted line-clamp-2 leading-snug">
                            <span className="text-sf-text-muted/70">Ambient: </span>{audio.ambient}
                          </div>
                        </div>
                      )}
                      {audio?.summary && !audio.vo && !audio.music && !audio.sfx && !audio.ambient && (
                        <div className="flex items-start gap-1.5">
                          <Volume2 size={11} className="mt-0.5 shrink-0 text-sf-text-muted"/>
                          <div className="text-sf-text-muted line-clamp-2 leading-snug">{audio.summary}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
