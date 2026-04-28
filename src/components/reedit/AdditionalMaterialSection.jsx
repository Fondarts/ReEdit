/**
 * project:re-edit — Additional material importer.
 *
 * Sits below the source-video drop zone in the Import view. Lets the
 * user import auxiliary assets the proposer / editor can pull from
 * later: extra footage (loose shots OR full ads we'll cut up), supers /
 * logos / graphics, music tracks, and voiceover audio.
 *
 * Storage: each file is COPIED into
 *   `<projectDir>/.reedit/additional/<category>/<sanitized-name>.<ext>`
 * (handled in main.js) and registered on
 *   `currentProject.additionalAssets[<category>] = AssetEntry[]`
 *
 * The renderer never reads the asset's metadata directly — main.js
 * probes via ffprobe and returns the entry. We just stage it on the
 * project and re-render.
 */

import { useState } from 'react'
import { Loader2, AlertCircle, Plus, Trash2, Film, Image as ImageIcon, Music, Mic, ExternalLink } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'

const CATEGORY_DEFS = [
  {
    id: 'extraFootage',
    label: 'Extra footage',
    blurb: 'Loose shots or other ads to recut',
    icon: Film,
    accent: 'border-sky-500/30 bg-sky-500/5 text-sky-300',
    iconAccent: 'text-sky-300',
    extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'],
  },
  {
    id: 'graphics',
    label: 'Graphics',
    blurb: 'Logos, supers, overlays',
    icon: ImageIcon,
    accent: 'border-amber-500/30 bg-amber-500/5 text-amber-300',
    iconAccent: 'text-amber-300',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'],
  },
  {
    id: 'music',
    label: 'Music',
    blurb: 'Replacement / additional tracks',
    icon: Music,
    accent: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300',
    iconAccent: 'text-emerald-300',
    extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac'],
  },
  {
    id: 'voiceover',
    label: 'Voiceover',
    blurb: 'Pre-recorded VO clips',
    icon: Mic,
    accent: 'border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-300',
    iconAccent: 'text-fuchsia-300',
    extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac'],
  },
]

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

// Run PySceneDetect on a freshly-imported extraFootage asset, extract
// a thumbnail per detected scene, and persist the result back onto
// the asset entry. Skip when only one scene is found (loose shots
// stay as a single clip; multi-shot ads explode into N cards). Mutates
// the project via saveProject so the panel re-renders as soon as the
// data lands.
//
// Status flow on the asset entry:
//   undefined              — not detected yet (initial state)
//   detectionStatus='running' — currently running
//   detectionStatus='done'    — finished; `scenes` populated (or empty if single-shot)
//   detectionStatus='failed'  — failed; `detectionError` set, asset still usable
async function detectShotsForExtraFootage(asset) {
  if (!asset?.id || !asset?.path) return
  const { saveProject, currentProject } = useProjectStore.getState()
  const projectDir = useProjectStore.getState().currentProjectHandle
  if (typeof projectDir !== 'string') return

  // Stage 1 — mark running so the UI can show a spinner.
  const stamp = (patch) => {
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets?.extraFootage || []
    const next = existing.map((a) => a.id === asset.id ? { ...a, ...patch } : a)
    return saveProject({
      additionalAssets: { ...(latest?.additionalAssets || {}), extraFootage: next },
    })
  }
  await stamp({ detectionStatus: 'running', detectionError: null })

  let detectRes
  try {
    detectRes = await window.electronAPI.detectScenes(asset.path, {})
  } catch (err) {
    await stamp({ detectionStatus: 'failed', detectionError: err?.message || 'Scene detection failed.' })
    return
  }
  if (!detectRes?.success) {
    await stamp({ detectionStatus: 'failed', detectionError: detectRes?.error || 'Scene detection failed.' })
    return
  }
  const rawScenes = Array.isArray(detectRes.scenes) ? detectRes.scenes : []

  // Single-shot ad / loose shot → leave the asset as-is; UI renders
  // one card backed by the parent file. Empty scenes array signals
  // detection ran but didn't split.
  if (rawScenes.length <= 1) {
    await stamp({ detectionStatus: 'done', scenes: [] })
    return
  }

  // Multi-shot ad → extract a thumbnail per scene at its tcIn (with a
  // small offset to avoid black-on-cut frames). Thumbnails live next
  // to the source file under
  //   <projectDir>/.reedit/additional/extraFootage/<assetId>/scene-NNN.jpg
  const sanitizedId = String(asset.id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
  const thumbDir = `${projectDir.replace(/\\/g, '/')}/.reedit/additional/extraFootage/${sanitizedId}`
  const scenes = []
  for (let i = 0; i < rawScenes.length; i++) {
    const s = rawScenes[i]
    const tcIn = Number(s.tcIn) || 0
    const tcOut = Number(s.tcOut) || tcIn + 1
    const sceneId = `${asset.id}-scene-${String(i + 1).padStart(3, '0')}`
    const thumbPath = `${thumbDir}/${String(i + 1).padStart(3, '0')}.jpg`
    // Offset 0.05 s into the scene so we don't grab the exact cut
    // frame (often black or motion-blurred).
    const sampleAt = Math.min(tcIn + 0.05, (tcIn + tcOut) / 2)
    let thumbnail = null
    try {
      const tres = await window.electronAPI.extractThumbnail({
        videoPath: asset.path,
        tcSec: sampleAt,
        outputPath: thumbPath,
        width: 480,
      })
      if (tres?.success) thumbnail = tres.path
    } catch (_) { /* thumbnail is best-effort */ }
    scenes.push({
      id: sceneId,
      tcIn,
      tcOut,
      duration: Math.max(0.05, tcOut - tcIn),
      thumbnail,
    })
  }
  await stamp({ detectionStatus: 'done', scenes })
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function AdditionalMaterialSection() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject = useProjectStore((s) => s.saveProject)

  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
  const additional = currentProject?.additionalAssets || {}

  // Per-category in-flight state. Each is a count — we increment when
  // an import starts and decrement when it finishes so the UI can show
  // a spinner while a multi-file drop is being processed.
  const [busy, setBusy] = useState({}) // { [categoryId]: number }
  const [errors, setErrors] = useState({}) // { [categoryId]: string }
  const [dragOver, setDragOver] = useState(null)

  if (!projectDir) {
    return (
      <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 p-4 text-sm text-sf-text-muted text-center">
        Save the project first to enable additional-material imports.
      </div>
    )
  }

  const importFiles = async (categoryId, fileEntries) => {
    if (!Array.isArray(fileEntries) || fileEntries.length === 0) return
    const def = CATEGORY_DEFS.find((c) => c.id === categoryId)
    if (!def) return

    setErrors((prev) => ({ ...prev, [categoryId]: null }))
    setBusy((prev) => ({ ...prev, [categoryId]: (prev[categoryId] || 0) + fileEntries.length }))

    const accepted = fileEntries.filter((f) => def.extensions.includes(extOf(f.name)))
    const rejected = fileEntries.filter((f) => !def.extensions.includes(extOf(f.name)))
    if (rejected.length > 0) {
      setErrors((prev) => ({
        ...prev,
        [categoryId]: `Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'}: ${rejected.map((f) => f.name).join(', ')}`,
      }))
    }

    const newEntries = []
    for (const file of accepted) {
      if (!file.path) continue // can happen on web — no OS path
      try {
        const res = await window.electronAPI.importAdditionalAsset({
          sourcePath: file.path,
          category: categoryId,
          projectDir,
        })
        if (res?.success && res.asset) {
          newEntries.push(res.asset)
        } else {
          setErrors((prev) => ({ ...prev, [categoryId]: res?.error || `Could not import ${file.name}.` }))
        }
      } catch (err) {
        setErrors((prev) => ({ ...prev, [categoryId]: err?.message || `Could not import ${file.name}.` }))
      }
    }

    if (newEntries.length > 0) {
      const latest = useProjectStore.getState().currentProject
      const existing = latest?.additionalAssets || {}
      const next = {
        ...existing,
        [categoryId]: [...(existing[categoryId] || []), ...newEntries],
      }
      await saveProject({ additionalAssets: next })
    }

    setBusy((prev) => {
      const remaining = (prev[categoryId] || 0) - fileEntries.length
      return { ...prev, [categoryId]: Math.max(0, remaining) }
    })

    // For extra footage: kick off scene detection asynchronously.
    // A loose-shot file resolves to a single scene (no split); a full
    // ad resolves to N scenes that show up as independent shot cards.
    // Errors are non-fatal — the asset stays usable as a single clip.
    if (categoryId === 'extraFootage') {
      for (const entry of newEntries) {
        detectShotsForExtraFootage(entry).catch((err) => {
          console.warn('[reedit] scene detect failed for', entry.name, err)
        })
      }
    }
  }

  const handleBrowse = async (categoryId) => {
    const def = CATEGORY_DEFS.find((c) => c.id === categoryId)
    if (!def) return
    try {
      const selected = await window.electronAPI?.selectFile?.({
        title: `Import ${def.label.toLowerCase()}`,
        filters: [{ name: def.label, extensions: def.extensions }],
        multiple: true,
      })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      // selectFile only returns paths, so synthesise minimal File-shaped
      // entries the importFiles handler can consume. The browse path
      // skips the rejected-extension filter because the dialog already
      // restricted to the allowed list.
      const entries = paths.map((p) => ({ name: p.split(/[\\/]/).pop() || 'file', path: p }))
      await importFiles(categoryId, entries)
    } catch (err) {
      setErrors((prev) => ({ ...prev, [categoryId]: err?.message || 'Could not open file picker.' }))
    }
  }

  const handleDrop = async (categoryId, e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(null)
    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length === 0) return
    // File objects from a drop expose `path` in Electron only.
    const entries = files.map((f) => ({ name: f.name, path: f.path }))
    if (entries.some((f) => !f.path)) {
      setErrors((prev) => ({ ...prev, [categoryId]: 'Drag-and-drop is only supported in the desktop app.' }))
      return
    }
    await importFiles(categoryId, entries)
  }

  const handleDelete = async (categoryId, asset) => {
    if (!asset?.id) return
    try {
      await window.electronAPI?.deleteAdditionalAsset?.({ assetPath: asset.path })
    } catch (_) { /* best effort */ }
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    const next = {
      ...existing,
      [categoryId]: (existing[categoryId] || []).filter((a) => a.id !== asset.id),
    }
    await saveProject({ additionalAssets: next })
  }

  return (
    <div className="text-left">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-sf-text-primary mb-1">Additional material <span className="text-xs font-normal text-sf-text-muted ml-1.5">optional</span></h2>
        <p className="text-xs text-sf-text-muted leading-relaxed">
          Drop extra footage, graphics, music, or voiceover here. They get analysed in the Analysis tab and become available to the proposer when the <span className="font-mono text-sf-text-secondary">Use additional assets</span> capability is on.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {CATEGORY_DEFS.map((def) => {
          const Icon = def.icon
          const items = additional[def.id] || []
          const isBusy = (busy[def.id] || 0) > 0
          const err = errors[def.id]
          const dragging = dragOver === def.id
          return (
            <div
              key={def.id}
              onDragOver={(e) => { e.preventDefault(); setDragOver(def.id) }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => handleDrop(def.id, e)}
              className={`rounded-lg border bg-sf-dark-900 transition-colors
                ${dragging ? 'border-sf-accent bg-sf-accent/5' : 'border-sf-dark-700'}`}
            >
              <div className={`px-3 py-2 border-b border-sf-dark-800 flex items-center gap-2 rounded-t-lg ${def.accent}`}>
                <Icon className={`w-4 h-4 ${def.iconAccent}`} />
                <span className="text-xs font-semibold uppercase tracking-wider">{def.label}</span>
                <span className="text-[10px] text-sf-text-muted/80 ml-auto">{items.length} item{items.length === 1 ? '' : 's'}</span>
              </div>
              <div className="p-3 space-y-2">
                <p className="text-[11px] text-sf-text-muted">{def.blurb}</p>
                <button
                  type="button"
                  onClick={() => handleBrowse(def.id)}
                  disabled={isBusy}
                  className={`w-full rounded border-2 border-dashed py-3 text-[11px] transition-colors
                    ${dragging
                      ? 'border-sf-accent bg-sf-accent/5 text-sf-text-primary'
                      : 'border-sf-dark-700 hover:border-sf-dark-500 text-sf-text-muted'}
                    ${isBusy ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                >
                  {isBusy ? (
                    <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Importing…</span>
                  ) : dragging ? (
                    'Release to import'
                  ) : (
                    <span className="inline-flex items-center gap-1.5"><Plus className="w-3 h-3" /> Drop or browse · {def.extensions.slice(0, 4).join(', ')}{def.extensions.length > 4 ? '…' : ''}</span>
                  )}
                </button>
                {err && (
                  <div className="flex items-start gap-1.5 text-[10px] text-amber-300 leading-snug">
                    <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{err}</span>
                  </div>
                )}
                {items.length > 0 && (
                  <ul className="space-y-1">
                    {items.map((asset) => (
                      <li key={asset.id} className="flex items-center gap-1.5 text-[11px] rounded border border-sf-dark-800 bg-sf-dark-950 px-2 py-1">
                        <span className="text-sf-text-primary truncate flex-1" title={asset.path}>{asset.name}</span>
                        <span className="text-[10px] text-sf-text-muted/80 shrink-0">
                          {asset.duration ? `${asset.duration.toFixed(1)}s` : ''}
                          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => window.electronAPI?.showItemInFolder?.(asset.path)}
                          className="p-0.5 rounded text-sf-text-muted hover:text-sf-accent"
                          title="Reveal in file manager"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(def.id, asset)}
                          className="p-0.5 rounded text-sf-text-muted hover:text-red-300"
                          title="Remove"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
