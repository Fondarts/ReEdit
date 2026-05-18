import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload, Film, Music, Mic, Image as ImageIcon, Video,
  Trash2, Loader2, AlertCircle, CheckCircle2,
} from 'lucide-react'
import useProjectStore from '../../../stores/projectStore'
import useTimelineStore from '../../../stores/timelineStore'
import { resetReeditProjectState } from '../../../services/reeditEdlToTimeline'

// Simple-mode Import view: one dropzone, one list of all imported assets,
// each tagged by category. Replaces the multi-section Advanced view. The
// VO/music stem split runs silently in the background after the Main
// video is set — the user doesn't see that machinery here.

const VIDEO_EXTS  = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']
const AUDIO_EXTS  = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac']
const IMAGE_EXTS  = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']

const CATEGORIES = [
  { id: 'main',         label: 'Main video',        icon: Video,     accent: 'text-sf-accent border-sf-accent/40 bg-sf-accent/10' },
  { id: 'extraFootage', label: 'Additional footage',icon: Film,      accent: 'text-sky-300 border-sky-500/30 bg-sky-500/5' },
  { id: 'music',        label: 'Music',             icon: Music,     accent: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/5' },
  { id: 'voiceover',    label: 'Voiceover',         icon: Mic,       accent: 'text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/5' },
  { id: 'graphics',     label: 'Graphics',          icon: ImageIcon, accent: 'text-amber-300 border-amber-500/30 bg-amber-500/5' },
]

const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]))

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Probe metadata in-renderer (same trick Advanced view uses).
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
      resolve({
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width:  video.videoWidth  || null,
        height: video.videoHeight || null,
      })
      cleanup()
    }
    video.onerror = () => { cleanup(); reject(new Error('Could not decode video metadata.')) }
    video.src = url
  })
}

// Best guess for what a freshly-dropped file should be tagged as. If
// there's no Main yet and the file is a video, default to Main; once a
// Main exists, additional videos default to extraFootage.
function suggestCategory(filename, hasMain) {
  const e = extOf(filename)
  if (VIDEO_EXTS.includes(e)) return hasMain ? 'extraFootage' : 'main'
  if (AUDIO_EXTS.includes(e)) return 'music'
  if (IMAGE_EXTS.includes(e)) return 'graphics'
  return null  // unknown — user will have to pick or we drop it
}

let uidCounter = 0
function uid() { uidCounter += 1; return `pending-${Date.now()}-${uidCounter}` }

export default function ImportVideoViewSimple({ onVideoImported }) {
  const currentProject       = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject          = useProjectStore((s) => s.saveProject)

  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
  const main       = currentProject?.sourceVideo || null
  const additional = currentProject?.additionalAssets || {}

  const [pending, setPending] = useState([])   // [{id, path, name, size, category}]
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState([])     // per-pending or general
  const [confirmedMain, setConfirmedMain] = useState(false)

  const triedSeparateRef = useRef(null)        // path we already kicked off stems for

  // Kick off Demucs stem separation in the background once we have a
  // main video. The user never sees this — it's just here so downstream
  // steps (analysis VO/music separation) have the WAV files ready when
  // they get to that part of the pipeline.
  useEffect(() => {
    if (!main?.path || !projectDir) return
    if (triedSeparateRef.current === main.path) return
    if (main.stems?.vocalsPath && main.stems?.musicPath) return
    triedSeparateRef.current = main.path
    if (!window?.electronAPI?.separateStems) return
    window.electronAPI.separateStems({
      sourceVideoPath: main.path,
      projectDir,
    }).then(async (res) => {
      if (!res?.success) return
      // Persist the stem paths onto sourceVideo so AnalysisView can
      // pick them up. Mirror the field names Advanced uses.
      const latest = useProjectStore.getState().currentProject
      const sv = latest?.sourceVideo
      if (!sv || sv.path !== main.path) return  // user already replaced it
      await saveProject({
        sourceVideo: {
          ...sv,
          stems: {
            vocalsPath: res.vocalsPath,
            musicPath:  res.musicPath,
            model:      res.model,
            generatedAt: new Date().toISOString(),
          },
        },
      })
    }).catch(() => { /* silent — non-blocking */ })
  }, [main?.path, projectDir, saveProject, main?.stems?.vocalsPath, main?.stems?.musicPath])

  // ---------- import flows ----------

  async function importAsMain(absolutePath, displayName) {
    if (!window?.electronAPI) throw new Error('Electron bridge missing.')
    const urlForProbe = await window.electronAPI.getFileUrl(absolutePath)
    const [{ duration, width, height }, probe] = await Promise.all([
      readVideoDimensionsFromUrl(urlForProbe),
      window.electronAPI.getVideoFps(absolutePath).catch(() => null),
    ])
    const sourceVideo = {
      name: displayName,
      path: absolutePath,
      duration, width, height,
      fps: probe?.success ? (probe.fps || null) : null,
      hasAudio: probe?.success ? Boolean(probe.hasAudio) : null,
      videoCodec: probe?.success ? (probe.videoCodec || null) : null,
      audioCodec: probe?.success ? (probe.audioCodec || null) : null,
      importedAt: new Date().toISOString(),
    }
    // Importing a new main wipes analysis + proposal — same contract as
    // the Advanced view. The user is intentionally starting over.
    resetReeditProjectState()

    const latest = useProjectStore.getState().currentProject
    const resolvedFps = Number.isFinite(sourceVideo.fps) && sourceVideo.fps > 0
      ? sourceVideo.fps
      : (latest?.settings?.fps || 24)
    const projectSettings = {
      ...(latest?.settings || {}),
      width:  sourceVideo.width  || latest?.settings?.width,
      height: sourceVideo.height || latest?.settings?.height,
      fps: resolvedFps,
      aspectRatio: (sourceVideo.width && sourceVideo.height)
        ? `${sourceVideo.width}:${sourceVideo.height}`
        : (latest?.settings?.aspectRatio || '16:9'),
    }
    await saveProject({
      sourceVideo,
      analysis: null,
      proposal: null,
      settings: projectSettings,
    })
    try { useTimelineStore.getState().setTimelineFps?.(resolvedFps) } catch (_) { /* ignore */ }
    setConfirmedMain(true)
  }

  async function importAsAdditional(absolutePath, categoryId) {
    if (!window?.electronAPI) throw new Error('Electron bridge missing.')
    if (!projectDir) throw new Error('Project has no on-disk handle yet.')
    const res = await window.electronAPI.importAdditionalAsset({
      sourcePath: absolutePath,
      category: categoryId,
      projectDir,
    })
    if (!res?.success || !res.asset) {
      throw new Error(res?.error || 'Import failed.')
    }
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    const list = existing[categoryId] || []
    await saveProject({
      additionalAssets: {
        ...existing,
        [categoryId]: [...list, res.asset],
      },
    })
  }

  async function confirmAll() {
    if (busy || pending.length === 0) return
    setBusy(true)
    const newErrors = []
    // Order: Main video first so the rest don't accidentally land in a
    // project still pointing at the old main.
    const ordered = [...pending].sort((a, b) => (a.category === 'main' ? -1 : 0) - (b.category === 'main' ? -1 : 0))
    for (const item of ordered) {
      try {
        if (!item.category) {
          newErrors.push({ id: item.id, msg: `${item.name}: pick a category first.` })
          continue
        }
        if (item.category === 'main') {
          await importAsMain(item.path, item.name)
        } else {
          await importAsAdditional(item.path, item.category)
        }
      } catch (err) {
        newErrors.push({ id: item.id, msg: `${item.name}: ${err?.message || 'failed'}` })
      }
    }
    setBusy(false)
    setErrors(newErrors)
    // Drop the items that succeeded; keep failed ones in the pending list.
    const failedIds = new Set(newErrors.map((e) => e.id))
    setPending((prev) => prev.filter((p) => failedIds.has(p.id)))
    if (newErrors.length === 0) {
      // Smooth transition: if a Main video was imported just now, kick
      // the parent so it can flip to the Analysis tab.
      const justImportedMain = ordered.some((i) => i.category === 'main')
      if (justImportedMain) onVideoImported?.()
    }
  }

  function addFilesToPending(fileList) {
    const arr = Array.from(fileList || [])
    if (arr.length === 0) return
    const hasMain = !!main || pending.some((p) => p.category === 'main')
    const next = []
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i]
      const isMainCandidate = !hasMain && i === 0 && VIDEO_EXTS.includes(extOf(f.name))
      const cat = isMainCandidate
        ? 'main'
        : suggestCategory(f.name, hasMain || next.some((p) => p.category === 'main'))
      next.push({
        id: uid(),
        path: f.path,
        name: f.name,
        size: f.size,
        category: cat,
      })
    }
    setPending((p) => [...p, ...next])
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    if (!e.dataTransfer?.files) return
    addFilesToPending(e.dataTransfer.files)
  }

  const handleBrowse = async () => {
    if (busy) return
    const allExts = [...new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS])]
    const selected = await window.electronAPI?.selectFile?.({
      title: 'Import files',
      filters: [{ name: 'Media', extensions: allExts }],
      multiple: true,
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    addFilesToPending(paths.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() || 'file',
      size: 0,
    })))
  }

  function setItemCategory(id, category) {
    setPending((prev) => prev.map((p) => p.id === id ? { ...p, category } : p))
  }

  function dropPending(id) {
    setPending((prev) => prev.filter((p) => p.id !== id))
  }

  // ---------- confirmed assets list ----------

  // Flatten everything into one display list, grouped logically.
  const allConfirmed = useMemo(() => {
    const items = []
    if (main) {
      items.push({
        category: 'main', name: main.name, path: main.path,
        size: 0,
        meta: [main.width && main.height ? `${main.width}×${main.height}` : null,
               main.fps ? `${main.fps.toFixed(2)} fps` : null,
               main.duration ? `${main.duration.toFixed(1)}s` : null]
               .filter(Boolean).join(' · '),
      })
    }
    for (const c of ['extraFootage', 'music', 'voiceover', 'graphics']) {
      for (const a of (additional[c] || [])) {
        items.push({
          category: c, id: a.id, name: a.name || a.path, path: a.path,
          size: a.size || 0,
          meta: a.duration ? `${a.duration.toFixed(1)}s` : '',
        })
      }
    }
    return items
  }, [main, additional])

  async function deleteAsset(category, item) {
    if (category === 'main') {
      // Clear main: same as a fresh import. We don't delete the file on
      // disk — the source might be the user's only copy.
      resetReeditProjectState()
      await saveProject({ sourceVideo: null, analysis: null, proposal: null })
      triedSeparateRef.current = null
      return
    }
    try {
      await window.electronAPI?.deleteAdditionalAsset?.({ assetPath: item.path })
    } catch (_) { /* ignore; we still drop the record */ }
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    await saveProject({
      additionalAssets: {
        ...existing,
        [category]: (existing[category] || []).filter((a) => a.id !== item.id),
      },
    })
  }

  // ---------- render ----------

  if (!projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Open or create a project first.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="w-full px-8 py-8 space-y-6">

        <div>
          <h1 className="text-xl font-semibold mb-1">Import</h1>
          <p className="text-sm text-sf-text-muted">
            Drop your files here and tag each one. One project, one main video; everything else is reference material.
          </p>
        </div>

        {/* Dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors
            ${dragOver
              ? 'border-sf-accent bg-sf-accent/5'
              : 'border-sf-dark-700 bg-sf-dark-900/60'}`}
        >
          <Upload size={36} className="mx-auto text-sf-text-muted mb-2" />
          <div className="text-base font-medium mb-1">Drop videos, audio, or graphics here</div>
          <div className="text-xs text-sf-text-muted mb-4">
            Mix and match — we'll tag each file by type and you can change it before adding.
          </div>
          <button
            onClick={handleBrowse}
            disabled={busy}
            className="inline-flex items-center gap-2 px-4 py-2 rounded bg-sf-accent hover:bg-sf-accent-hover text-white text-sm disabled:opacity-50"
          >
            <Upload size={14}/> Browse files
          </button>
        </div>

        {/* Pending list (drafts before confirmation) */}
        {pending.length > 0 && (
          <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="flex items-center px-4 py-2 border-b border-sf-dark-700 text-xs uppercase text-sf-text-muted">
              <span>Ready to add</span>
              <span className="ml-2 text-[10px] text-sf-text-muted">({pending.length})</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setPending([])}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded border border-sf-dark-700 hover:bg-sf-dark-800 disabled:opacity-50"
                >
                  Clear
                </button>
                <button
                  onClick={confirmAll}
                  disabled={busy || pending.some((p) => !p.category)}
                  className="text-xs px-3 py-1 rounded bg-sf-accent hover:bg-sf-accent-hover text-white flex items-center gap-1 disabled:opacity-50"
                >
                  {busy && <Loader2 size={12} className="animate-spin"/>}
                  {busy ? 'Adding…' : `Add ${pending.length} to project`}
                </button>
              </div>
            </div>
            <ul>
              {pending.map((p) => {
                const def = p.category ? CAT_BY_ID[p.category] : null
                const Icon = def?.icon || AlertCircle
                const error = errors.find((e) => e.id === p.id)
                return (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2 border-b border-sf-dark-800 last:border-b-0">
                    <Icon size={16} className={def?.iconAccent || 'text-sf-text-muted'}/>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{p.name}</div>
                      {error && <div className="text-xs text-red-400">{error.msg}</div>}
                    </div>
                    <div className="text-xs text-sf-text-muted w-20 text-right">{formatBytes(p.size)}</div>
                    <select
                      value={p.category || ''}
                      onChange={(e) => setItemCategory(p.id, e.target.value || null)}
                      disabled={busy}
                      className="bg-sf-dark-800 border border-sf-dark-700 rounded text-xs px-2 py-1"
                    >
                      <option value="">— pick —</option>
                      {CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => dropPending(p.id)}
                      disabled={busy}
                      title="Remove"
                      className="text-sf-text-muted hover:text-red-400 p-1 disabled:opacity-50"
                    >
                      <Trash2 size={14}/>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {/* Confirmed assets list */}
        <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
          <div className="flex items-center px-4 py-2 border-b border-sf-dark-700 text-xs uppercase text-sf-text-muted">
            Project assets
            <span className="ml-2 text-[10px] text-sf-text-muted">({allConfirmed.length})</span>
            {confirmedMain && (
              <span className="ml-3 text-[10px] text-sf-accent inline-flex items-center gap-1">
                <CheckCircle2 size={10}/> ready to analyze
              </span>
            )}
          </div>
          {allConfirmed.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-sf-text-muted">
              No assets yet. Drop files above to start.
            </div>
          ) : (
            <ul>
              {allConfirmed.map((it, idx) => {
                const def = CAT_BY_ID[it.category]
                const Icon = def?.icon || Film
                return (
                  <li key={`${it.category}-${it.id || it.path}-${idx}`} className="flex items-center gap-3 px-4 py-2 border-b border-sf-dark-800 last:border-b-0">
                    <Icon size={16} className={def?.iconAccent || 'text-sf-text-muted'}/>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{it.name}</div>
                      <div className="text-xs text-sf-text-muted truncate">{it.meta}</div>
                    </div>
                    <span className={`text-[10px] uppercase px-2 py-0.5 rounded border ${def?.accent || 'border-sf-dark-700 text-sf-text-muted'}`}>
                      {def?.label || it.category}
                    </span>
                    <button
                      onClick={() => deleteAsset(it.category, it)}
                      title="Remove from project"
                      className="text-sf-text-muted hover:text-red-400 p-1"
                    >
                      <Trash2 size={14}/>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {main && (
          <div className="text-xs text-sf-text-muted text-center">
            Next: head over to <span className="text-sf-text-primary">Analysis</span> to see the storyboard.
          </div>
        )}
      </div>
    </div>
  )
}
