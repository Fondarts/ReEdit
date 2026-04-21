import { useState } from 'react'
import { Upload, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { resetReeditProjectState } from '../../services/reeditEdlToTimeline'

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
      await saveProject({ sourceVideo, analysis: null, proposal: null })
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
      className="flex-1 flex items-center justify-center bg-sf-dark-950 text-sf-text-primary p-8"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-lg w-full text-center">
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
          </div>
        )}
      </div>
    </div>
  )
}

export default ImportVideoView
