import { useEffect, useState } from 'react'
import { Upload, Loader2, CheckCircle2, AlertCircle, Mic, Music, ExternalLink, RotateCcw } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import useTimelineStore from '../../stores/timelineStore'
import { resetReeditProjectState } from '../../services/reeditEdlToTimeline'
import AdditionalMaterialSection from './AdditionalMaterialSection'

// Renderer-side metadata check via the HTML5 <video> element. This runs
// through Chromium's demuxer, which covers the same formats the app will
// play back anyway, so if the file reads here it will play in the timeline
// too. Anything it rejects is caught in the catch below.
const SUPPORTED_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function readVideoDimensionsFromUrl(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    const cleanup = () => {
      video.removeAttribute('src')
      try { video.load() } catch (_) { /* ignore */ }
    }
    video.onloadedmetadata = () => {
      const result = {
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      }
      cleanup()
      resolve(result)
    }
    video.onerror = () => {
      cleanup()
      reject(new Error('Could not decode video metadata.'))
    }
    video.src = url
  })
}

function ImportVideoView({ onVideoImported }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  const saveProject = useProjectStore((s) => s.saveProject)
  const currentProject = useProjectStore((s) => s.currentProject)
  const existing = currentProject?.sourceVideo

  // Shared import path. `urlForProbe` is what the <video> element reads,
  // `absolutePath` is what we persist (stable across sessions, unlike
  // blob: URLs). For the drop case we already have a File object so we
  // can skip the protocol round-trip; for the dialog case there is no
  // File, only the absolute path, so we go through the comfystudio://
  // protocol to load it.
  const importWithMetadata = async ({ absolutePath, urlForProbe, displayName }) => {
    setLoading(true)
    setError(null)
    try {
      const [{ duration, width, height }, probe] = await Promise.all([
        readVideoDimensionsFromUrl(urlForProbe),
        window.electronAPI?.getVideoFps?.(absolutePath).catch(() => null),
      ])

      const sourceVideo = {
        name: displayName,
        path: absolutePath,
        duration,
        width,
        height,
        fps: probe?.success ? (probe.fps || null) : null,
        hasAudio: probe?.success ? Boolean(probe.hasAudio) : null,
        videoCodec: probe?.success ? (probe.videoCodec || null) : null,
        audioCodec: probe?.success ? (probe.audioCodec || null) : null,
        importedAt: new Date().toISOString(),
      }

      // Any import event — same file or new — resets the whole
      // downstream pipeline. Import acts as a "start over with this
      // video" entry point; preserving analysis/proposal across an
      // import was a half-measure that broke as soon as an earlier
      // import run had partially updated state. If the user wants to
      // keep their shot log, they stay on the Analysis tab rather
      // than re-entering Import. The cost of a mistaken re-drop is
      // a minute of re-captioning; the cost of silently-stale state
      // is invisible bugs, so we favor the former.
      resetReeditProjectState()

      // Overwrite project.settings with the video's real dimensions
      // and fps. ComfyStudio's New-Project dialog asks for these
      // up-front (it was built as an animatic tool where you pick
      // canvas size before dragging stills in), but in the re-edit
      // flow we don't know any of it until the user imports. Making
      // import authoritative means the canvas, timeline fps, and
      // aspect ratio all track the source clip automatically.
      const latestProject = useProjectStore.getState().currentProject
      const resolvedFps = Number.isFinite(sourceVideo.fps) && sourceVideo.fps > 0
        ? sourceVideo.fps
        : (latestProject?.settings?.fps || 24)
      const projectSettings = {
        ...(latestProject?.settings || {}),
        width: sourceVideo.width || latestProject?.settings?.width,
        height: sourceVideo.height || latestProject?.settings?.height,
        fps: resolvedFps,
        aspectRatio: (sourceVideo.width && sourceVideo.height)
          ? `${sourceVideo.width}:${sourceVideo.height}`
          : (latestProject?.settings?.aspectRatio || '16:9'),
      }

      await saveProject({
        sourceVideo,
        analysis: null,
        proposal: null,
        settings: projectSettings,
      })

      // The timeline store caches fps separately (used for frame-aligned
      // snapping when placing clips); nudge it to match so the editor's
      // frame ruler and any future clip placements speak the same fps
      // as the source video.
      try {
        useTimelineStore.getState().setTimelineFps?.(resolvedFps)
      } catch (_) { /* non-fatal */ }

      onVideoImported?.()
    } catch (err) {
      console.error('[reedit] import failed:', err)
      setError(err?.message || 'Unable to import this video.')
    } finally {
      setLoading(false)
    }
  }

  const handleBrowse = async () => {
    if (loading) return
    setError(null)
    try {
      const selected = await window.electronAPI?.selectFile?.({
        title: 'Import commercial',
        filters: [{ name: 'Video', extensions: SUPPORTED_EXTS }],
        multiple: false,
      })
      if (!selected) return
      const absolutePath = Array.isArray(selected) ? selected[0] : selected
      const displayName = absolutePath.split(/[\\/]/).pop() || 'video'
      const urlForProbe = await window.electronAPI?.getFileUrl?.(absolutePath)
      if (!urlForProbe) throw new Error('Could not resolve video URL.')
      await importWithMetadata({ absolutePath, urlForProbe, displayName })
    } catch (err) {
      console.error('[reedit] browse failed:', err)
      setError(err?.message || 'Unable to open file picker.')
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    if (!loading) setDragOver(true)
  }

  const handleDragLeave = () => setDragOver(false)

  const handleDrop = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (loading) return
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    if (!SUPPORTED_EXTS.includes(extOf(file.name))) {
      setError(`Unsupported format: ${file.name}`)
      return
    }
    // Electron exposes the OS path on the File object; the web fallback
    // has no such guarantee, so bail explicitly instead of silently
    // persisting a blob that won't survive a reload.
    const absolutePath = file.path
    if (!absolutePath) {
      setError('Drop is only supported in the desktop app. Use the Browse button instead.')
      return
    }
    const urlForProbe = URL.createObjectURL(file)
    try {
      await importWithMetadata({ absolutePath, urlForProbe, displayName: file.name })
    } finally {
      URL.revokeObjectURL(urlForProbe)
    }
  }

  return (
    <div
      className="flex-1 flex flex-col items-center bg-sf-dark-950 text-sf-text-primary p-8 overflow-y-auto"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-lg w-full text-center mb-8">
        <div className="w-16 h-16 rounded-full bg-sf-dark-800 border border-sf-dark-700 flex items-center justify-center mx-auto mb-6">
          {loading ? (
            <Loader2 className="w-7 h-7 text-sf-accent animate-spin" />
          ) : existing ? (
            <CheckCircle2 className="w-7 h-7 text-emerald-400" />
          ) : (
            <Upload className="w-7 h-7 text-sf-accent" />
          )}
        </div>
        <h1 className="text-2xl font-semibold mb-2">Import video</h1>
        <p className="text-sm text-sf-text-muted mb-8">
          Drop the original commercial here. project:re-edit will detect scenes, build a shot log, and draft an improvement proposal before opening the timeline.
        </p>

        <button
          type="button"
          onClick={handleBrowse}
          disabled={loading}
          className={`block w-full rounded-xl border-2 border-dashed transition-colors p-10 text-sm
            ${dragOver
              ? 'border-sf-accent bg-sf-accent/5 text-sf-text-primary'
              : 'border-sf-dark-700 hover:border-sf-dark-500 text-sf-text-muted'}
            ${loading ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {loading
            ? 'Reading video…'
            : dragOver
              ? 'Release to import'
              : 'Drop a video here, or click to browse'}
        </button>

        {error && (
          <div className="mt-4 flex items-start gap-2 text-xs text-sf-error text-left">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {existing && !loading && !error && (
          <div className="mt-6 text-left text-xs rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-4 space-y-1">
            <div className="text-sf-text-primary font-medium truncate">{existing.name}</div>
            <div className="text-sf-text-muted">
              {existing.width}×{existing.height}
              {existing.fps ? ` · ${existing.fps.toFixed ? existing.fps.toFixed(2) : existing.fps} fps` : ''}
              {existing.duration ? ` · ${existing.duration.toFixed(1)}s` : ''}
              {existing.hasAudio === false ? ' · no audio' : ''}
            </div>
            <button
              type="button"
              onClick={handleBrowse}
              className="mt-2 text-sf-accent hover:underline"
            >
              Replace with another video
            </button>

            <AudioStemsSection sourceVideo={existing} saveProject={saveProject} />
          </div>
        )}
      </div>

      {/* Additional material — only renders once a source video has
          been imported. Rationale: until the project has a source we
          haven't picked an aspect ratio / fps, and an isolated extra
          asset has nothing to attach to anyway. The section sits in
          its own wider container (~max-w-4xl) since the source-video
          dropzone is intentionally narrow but the 4-category grid
          benefits from the breathing room. */}
      {existing && (
        <div className="max-w-4xl w-full">
          <AdditionalMaterialSection />
        </div>
      )}
    </div>
  )
}

// Stage labels for the progress indicator. Keep them short — the
// section is narrow. Unknown stages render verbatim so we don't lose
// unexpected events emitted by the script.
const STEM_STAGE_LABEL = {
  starting: 'Starting…',
  device: 'Selecting device…',
  extracting: 'Extracting audio…',
  separating: 'Separating (Demucs)…',
  demucs: 'Separating (Demucs)…',
  demucs_progress: 'Separating (Demucs)…',
  finalizing: 'Finalising…',
  done: 'Done',
}

function AudioStemsSection({ sourceVideo, saveProject }) {
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null

  const stems = sourceVideo?.stems || null
  const [stage, setStage] = useState(null)
  const [stageMessage, setStageMessage] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    const unsub = window.electronAPI?.onSeparateStemsProgress?.((payload) => {
      if (!payload?.stage) return
      setStage(payload.stage)
      if (payload.message) setStageMessage(payload.message)
    })
    return () => { try { unsub?.() } catch (_) { /* ignore */ } }
  }, [])

  const running = stage && stage !== 'done' && stage !== 'error'

  if (sourceVideo?.hasAudio === false) {
    return (
      <div className="mt-4 pt-3 border-t border-sf-dark-800 text-sf-text-muted">
        Source has no audio — nothing to separate.
      </div>
    )
  }

  if (!projectDir) {
    // Web builds / unsaved projects don't have a disk-backed handle to
    // write stems into. Surface that instead of silently failing.
    return (
      <div className="mt-4 pt-3 border-t border-sf-dark-800 text-sf-text-muted">
        Save the project first to enable audio stem separation.
      </div>
    )
  }

  const runSeparate = async () => {
    if (running) return
    setError(null)
    setStage('starting')
    setStageMessage('')
    try {
      const res = await window.electronAPI.separateStems({
        sourceVideoPath: sourceVideo.path,
        projectDir,
      })
      if (!res?.success) {
        setStage('error')
        setError(res?.error || 'Unknown error.')
        return
      }
      setStage('done')
      // Persist into the project so opening it later finds the stems
      // without re-running the 5-20 min demucs pass.
      const nextStems = {
        vocalsPath: res.vocalsPath,
        musicPath: res.musicPath,
        model: res.model || 'htdemucs',
        generatedAt: new Date().toISOString(),
      }
      await saveProject({ sourceVideo: { ...sourceVideo, stems: nextStems } })
    } catch (err) {
      setStage('error')
      setError(err?.message || String(err))
    }
  }

  const reveal = (p) => {
    if (!p) return
    try { window.electronAPI?.showItemInFolder?.(p) } catch (_) { /* ignore */ }
  }

  // Done state: show the two files + reveal + re-run.
  if (stems && stage !== 'error') {
    return (
      <div className="mt-4 pt-3 border-t border-sf-dark-800 space-y-2">
        <div className="flex items-center gap-1.5 text-sf-text-secondary uppercase tracking-wider text-[10px]">
          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
          Audio stems ready
          <span className="normal-case text-sf-text-muted ml-2">· {stems.model || 'htdemucs'}</span>
        </div>
        <StemRow icon={<Mic className="w-3 h-3" />} label="VO" path={stems.vocalsPath} onReveal={reveal} />
        <StemRow icon={<Music className="w-3 h-3" />} label="Music" path={stems.musicPath} onReveal={reveal} />
        <button
          type="button"
          onClick={runSeparate}
          disabled={running}
          className="inline-flex items-center gap-1 text-[10px] text-sf-text-muted hover:text-sf-text-primary mt-1"
          title="Regenerate the stems (useful if the source audio changed)"
        >
          <RotateCcw className="w-3 h-3" />
          {running ? (STEM_STAGE_LABEL[stage] || stage) : 'Re-run'}
        </button>
      </div>
    )
  }

  // Running or idle state (no stems yet).
  return (
    <div className="mt-4 pt-3 border-t border-sf-dark-800 space-y-2">
      <div className="text-sf-text-secondary uppercase tracking-wider text-[10px]">Audio stems</div>
      {running ? (
        <div className="inline-flex items-center gap-1.5 text-sf-text-secondary">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{STEM_STAGE_LABEL[stage] || stage}</span>
          {stageMessage && stage !== 'done' && (
            <span className="text-sf-text-muted text-[10px] truncate max-w-[220px]" title={stageMessage}>
              · {stageMessage}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={runSeparate}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-primary hover:border-sf-accent/60 transition-colors"
          title="Run Demucs locally to split the source audio into VO (vocals) and Music stems."
        >
          <Mic className="w-3.5 h-3.5" />
          Separate stems (VO + Music)
        </button>
      )}
      {stage === 'error' && error && (
        <div className="flex items-start gap-1.5 text-sf-error">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span className="text-[10px] leading-snug break-words">{error}</span>
        </div>
      )}
    </div>
  )
}

function StemRow({ icon, label, path, onReveal }) {
  if (!path) return null
  const fname = path.split(/[\\/]/).pop()
  return (
    <div className="flex items-center gap-2">
      <span className="text-sf-text-muted">{icon}</span>
      <span className="text-sf-text-primary font-medium w-10">{label}</span>
      <span className="text-sf-text-muted truncate flex-1" title={path}>{fname}</span>
      <button
        type="button"
        onClick={() => onReveal(path)}
        className="inline-flex items-center gap-0.5 text-sf-accent hover:underline text-[10px]"
        title="Reveal in file manager"
      >
        <ExternalLink className="w-3 h-3" />
        Reveal
      </button>
    </div>
  )
}

export default ImportVideoView
