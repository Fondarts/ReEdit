import { useRef, useState } from 'react'
import { FileText, Loader2, AlertCircle, PlayCircle, RotateCcw, Sparkles, StopCircle } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { captionScenes, pickVisionModelId } from '../../services/reeditCaptioner'

// Build the comfystudio:// URL on the renderer. This mirrors what
// `media:getFileUrl` does in main.js (`encodeURIComponent(path)`), so we
// can avoid a per-thumbnail IPC round trip when rendering the shot log.
function toComfyUrl(filePath) {
  if (!filePath) return null
  return `comfystudio://${encodeURIComponent(filePath)}`
}

function formatTc(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  const cs = Math.floor((s - Math.floor(s)) * 100)
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function ImportPrompt() {
  return (
    <div className="flex-1 flex items-center justify-center bg-sf-dark-950 text-sf-text-primary p-8">
      <div className="max-w-md text-center text-sm text-sf-text-muted">
        Import a video first in the <span className="text-sf-text-primary">Import</span> tab.
      </div>
    </div>
  )
}

function Chip({ children, tone = 'neutral' }) {
  if (!children) return <span className="text-sf-text-muted text-[10px] italic">—</span>
  const toneClass = {
    neutral: 'bg-sf-dark-800 text-sf-text-secondary border-sf-dark-700',
    brand: 'bg-amber-500/10 text-amber-200 border-amber-500/30',
    emotion: 'bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-500/30',
    framing: 'bg-sky-500/10 text-sky-200 border-sky-500/30',
    movement: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30',
  }[tone] || 'bg-sf-dark-800 text-sf-text-secondary border-sf-dark-700'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] whitespace-nowrap ${toneClass}`}>
      {children}
    </span>
  )
}

function AnalysisView() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject = useProjectStore((s) => s.saveProject)

  const sourceVideo = currentProject?.sourceVideo
  const analysis = currentProject?.analysis
  const scenes = analysis?.scenes || []

  const [running, setRunning] = useState(false)
  const [progressMsg, setProgressMsg] = useState('')
  const [error, setError] = useState(null)

  // Captioning runs independently from scene detection — you can have
  // scenes without captions, then caption them later, then re-caption
  // individuals without losing everything.
  const [captioning, setCaptioning] = useState(false)
  const [captionProgress, setCaptionProgress] = useState({ current: 0, total: 0, model: '' })
  const [captionError, setCaptionError] = useState(null)
  const abortRef = useRef(null)

  if (!sourceVideo) return <ImportPrompt />

  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null

  const runAnalysis = async () => {
    if (running) return
    if (!projectDir) {
      setError('Analysis requires the desktop build (project path not available in web mode).')
      return
    }
    setRunning(true)
    setError(null)
    setProgressMsg('Detecting scenes…')

    try {
      // Threshold semantics changed when we swapped FFmpeg's `scene`
      // filter for PySceneDetect's ContentDetector: the former takes a
      // 0–1 frame-diff value (default ~0.4), the latter takes a 0–100
      // HSL-space delta (default 27). Lower = more sensitive for both.
      const res = await window.electronAPI.detectScenes(sourceVideo.path, {
        threshold: 27,
        minSceneDurSec: 0.5,
        totalDurationSec: sourceVideo.duration || null,
      })
      if (!res?.success) throw new Error(res?.error || 'Scene detection failed.')
      const detected = Array.isArray(res.scenes) ? res.scenes : []
      if (detected.length === 0) throw new Error('No scenes detected.')

      const enrichedScenes = []
      for (let i = 0; i < detected.length; i++) {
        const scene = detected[i]
        setProgressMsg(`Extracting thumbnails ${i + 1}/${detected.length}…`)
        // Thumb-seek halfway into the scene avoids cut-frame motion blur
        // while staying close enough to be representative. Capped at
        // tcIn + 1s for very long scenes where the middle may drift off
        // what the cut was "about".
        const midpoint = Math.min(scene.tcIn + Math.min(1.0, (scene.tcOut - scene.tcIn) / 2), scene.tcOut - 0.05)
        // Forward slashes work on Windows too — the Node path APIs in
        // main.js normalize them. Keeping slashes avoids JSON escaping
        // headaches when the path round-trips through the project file.
        const outputPath = `${projectDir.replace(/\\/g, '/')}/.reedit/scenes/${scene.id}.jpg`
        const thumbRes = await window.electronAPI.extractThumbnail({
          videoPath: sourceVideo.path,
          tcSec: midpoint,
          outputPath,
          width: 480,
        })
        enrichedScenes.push({
          ...scene,
          thumbnail: thumbRes?.success ? thumbRes.path : null,
          caption: null,
          structured: null,
        })
      }

      setProgressMsg('Saving…')
      await saveProject({
        analysis: {
          status: 'done',
          createdAt: new Date().toISOString(),
          settings: { threshold: 27, minSceneDurSec: 0.5, detector: 'pyscenedetect-content' },
          scenes: enrichedScenes,
        },
      })
      setProgressMsg('')
    } catch (err) {
      console.error('[reedit] analysis failed:', err)
      setError(err?.message || 'Analysis failed.')
    } finally {
      setRunning(false)
    }
  }

  const runCaptioning = async () => {
    if (captioning || scenes.length === 0) return
    setCaptioning(true)
    setCaptionError(null)
    setCaptionProgress({ current: 0, total: scenes.length, model: '' })

    const abortCtrl = { aborted: false }
    abortRef.current = abortCtrl

    try {
      // Resolve the model up front so we can show it in the progress
      // strip — gives the user an early signal that a sensible vision
      // model was picked before the per-scene loop starts hitting it.
      const modelId = await pickVisionModelId()
      setCaptionProgress({ current: 0, total: scenes.length, model: modelId })

      const { scenes: updatedScenes } = await captionScenes(scenes, {
        modelId,
        signal: abortCtrl,
        onProgress: ({ index, total, error: perSceneErr }) => {
          setCaptionProgress({ current: index + 1, total, model: modelId })
          if (perSceneErr) {
            console.warn('[reedit] caption failed for scene', index, perSceneErr)
          }
        },
      })

      await saveProject({
        analysis: {
          ...(analysis || {}),
          scenes: updatedScenes,
          captionedAt: new Date().toISOString(),
          captionModel: modelId,
        },
      })
    } catch (err) {
      if (err?.code === 'aborted') {
        // Partial progress is already in scene state via per-iteration
        // saves? (no — we save at the end). Leave untouched for now;
        // user can re-run and the loop will overwrite.
        console.info('[reedit] captioning aborted by user.')
      } else {
        console.error('[reedit] captioning failed:', err)
        setCaptionError(err?.message || 'Captioning failed. Is LM Studio running with a vision model loaded?')
      }
    } finally {
      setCaptioning(false)
      abortRef.current = null
    }
  }

  const cancelCaptioning = () => {
    if (abortRef.current) abortRef.current.aborted = true
  }

  const hasCaptions = scenes.some((s) => s.caption || s.structured)

  return (
    <div className="flex-1 flex flex-col bg-sf-dark-950 text-sf-text-primary overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-sf-dark-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-sf-dark-800 border border-sf-dark-700 flex items-center justify-center">
            <FileText className="w-4 h-4 text-sf-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Analysis</h1>
            <p className="text-xs text-sf-text-muted truncate max-w-[560px]">
              {sourceVideo.name} · {sourceVideo.width}×{sourceVideo.height}
              {sourceVideo.fps ? ` · ${(sourceVideo.fps.toFixed?.(2) ?? sourceVideo.fps)} fps` : ''}
              {sourceVideo.duration ? ` · ${sourceVideo.duration.toFixed(1)}s` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {analysis?.status === 'done' && !running && (
            <button
              type="button"
              onClick={runAnalysis}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
              title="Re-run scene detection"
              disabled={captioning}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Re-run scenes
            </button>
          )}
          {analysis?.status !== 'done' && (
            <button
              type="button"
              onClick={runAnalysis}
              disabled={running}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors
                ${running
                  ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
              {running ? (progressMsg || 'Running…') : 'Run analysis'}
            </button>
          )}

          {analysis?.status === 'done' && !captioning && (
            <button
              type="button"
              onClick={runCaptioning}
              disabled={running}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors
                ${hasCaptions
                  ? 'border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'
                  : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
              title="Generate visual descriptions via LM Studio"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {hasCaptions ? 'Re-caption all' : 'Caption all'}
            </button>
          )}
          {captioning && (
            <button
              type="button"
              onClick={cancelCaptioning}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-error/40 bg-sf-error/10 hover:bg-sf-error/20 text-sf-error transition-colors"
            >
              <StopCircle className="w-3.5 h-3.5" />
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Status strip while running */}
      {running && progressMsg && (
        <div className="flex-shrink-0 px-6 py-2 text-xs text-sf-text-muted border-b border-sf-dark-800 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          {progressMsg}
        </div>
      )}
      {captioning && (
        <div className="flex-shrink-0 px-6 py-2 text-xs text-sf-text-muted border-b border-sf-dark-800 flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" />
          Captioning scene {captionProgress.current}/{captionProgress.total}
          {captionProgress.model && (
            <span className="text-sf-text-muted/70">· {captionProgress.model}</span>
          )}
        </div>
      )}
      {error && (
        <div className="flex-shrink-0 px-6 py-2 text-xs text-sf-error border-b border-sf-dark-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {captionError && (
        <div className="flex-shrink-0 px-6 py-2 text-xs text-sf-error border-b border-sf-dark-800 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>{captionError}</span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {scenes.length === 0 && !running && !error && (
          <div className="h-full flex items-center justify-center text-sm text-sf-text-muted">
            No scenes yet — click <span className="mx-1 px-1.5 py-0.5 rounded bg-sf-dark-800 text-sf-text-primary">Run analysis</span> to detect cuts.
          </div>
        )}

        {scenes.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-sf-dark-900 text-sf-text-muted uppercase tracking-wider z-10">
              <tr>
                <th className="text-left px-3 py-2 font-medium w-10">#</th>
                <th className="text-left px-3 py-2 font-medium w-[200px]">Thumbnail</th>
                <th className="text-left px-3 py-2 font-medium w-[72px]">In</th>
                <th className="text-left px-3 py-2 font-medium w-[72px]">Out</th>
                <th className="text-left px-3 py-2 font-medium w-[60px]">Dur</th>
                <th className="text-left px-3 py-2 font-medium">Visual</th>
                <th className="text-left px-3 py-2 font-medium w-[140px]">Brand</th>
                <th className="text-left px-3 py-2 font-medium w-[110px]">Emotion</th>
                <th className="text-left px-3 py-2 font-medium w-[90px]">Framing</th>
                <th className="text-left px-3 py-2 font-medium w-[90px]">Motion</th>
              </tr>
            </thead>
            <tbody>
              {scenes.map((scene) => {
                const thumbUrl = toComfyUrl(scene.thumbnail)
                const s = scene.structured || {}
                return (
                  <tr key={scene.id} className="border-t border-sf-dark-800 hover:bg-sf-dark-900/60 align-top">
                    <td className="px-3 py-2 text-sf-text-muted tabular-nums">{scene.index}</td>
                    <td className="px-3 py-2">
                      <div className="w-[180px] aspect-video rounded bg-sf-dark-800 overflow-hidden">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">no thumb</div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{formatTc(scene.tcIn)}</td>
                    <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{formatTc(scene.tcOut)}</td>
                    <td className="px-3 py-2 tabular-nums text-sf-text-secondary">{scene.duration?.toFixed?.(1) ?? '—'}s</td>
                    <td className="px-3 py-2 text-sf-text-primary leading-snug">
                      {scene.caption || s.visual || (
                        <span className="text-sf-text-muted italic">— (Run Caption all)</span>
                      )}
                      {scene.captionError && (
                        <div className="mt-1 text-[10px] text-sf-error">Caption failed: {scene.captionError}</div>
                      )}
                    </td>
                    <td className="px-3 py-2"><Chip tone="brand">{s.brand}</Chip></td>
                    <td className="px-3 py-2"><Chip tone="emotion">{s.emotion}</Chip></td>
                    <td className="px-3 py-2"><Chip tone="framing">{s.framing}</Chip></td>
                    <td className="px-3 py-2"><Chip tone="movement">{s.movement}</Chip></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default AnalysisView
