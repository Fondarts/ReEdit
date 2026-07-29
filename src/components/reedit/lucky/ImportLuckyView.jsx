/**
 * project:re-edit — "I feel Lucky" Import view.
 *
 * One-page flow: drop assets, attach the Sundogs PDF, press Go. Under the
 * hood it reuses the same per-asset import handlers the Simple view uses
 * (importAsMain / importAsAdditional via the electronAPI) plus the same
 * Sundogs PDF parser the Proposal view already wires up — no second
 * source of truth. The Go button delegates to `runLuckyPipeline`, which
 * walks the same handlers Simple/Advanced trigger one-tab-at-a-time.
 *
 * During the run we show a step list with spinner / check / X states so
 * the user has something concrete to look at; first hard error stops the
 * run and surfaces the message inline (no toast). On success we call
 * `onProposalReady`, which the App routes to switching to the Proposal
 * tab (Lucky mode hides everything in between).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Upload, Film, Music, Mic, Image as ImageIcon, Video,
  Trash2, Loader2, AlertCircle, CheckCircle2, Dice5,
  FileText, XCircle, Circle, Sparkles,
} from 'lucide-react'
import useProjectStore from '../../../stores/projectStore'
import useTimelineStore from '../../../stores/timelineStore'
import useLuckyRunStore from '../../../stores/luckyRunStore'
import { resetReeditProjectState } from '../../../services/reeditEdlToTimeline'
import { parseSundogsReport, SUNDOGS_REPORT_ACCEPT } from '../../../services/reeditSundogsReport'
import { isGeminiReportMode } from '../../../services/reeditReportSource'
import { runLuckyPipeline, LUCKY_STEPS } from '../../../services/reeditLuckyPipeline'

// Asset categorisation — kept in lock-step with ImportVideoViewSimple so
// that a project saved by the Lucky view loads cleanly into Simple /
// Advanced and vice versa.
const VIDEO_EXTS  = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']
const AUDIO_EXTS  = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus', 'aac']
const IMAGE_EXTS  = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']

const CATEGORIES = [
  { id: 'main',         label: 'Main video',         icon: Video,     accent: 'text-sf-accent border-sf-accent/40 bg-sf-accent/10' },
  { id: 'extraFootage', label: 'Additional footage', icon: Film,      accent: 'text-sky-300 border-sky-500/30 bg-sky-500/5' },
  { id: 'music',        label: 'Music',              icon: Music,     accent: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/5' },
  { id: 'voiceover',    label: 'Voiceover',          icon: Mic,       accent: 'text-fuchsia-300 border-fuchsia-500/30 bg-fuchsia-500/5' },
  { id: 'graphics',     label: 'Graphics',           icon: ImageIcon, accent: 'text-amber-300 border-amber-500/30 bg-amber-500/5' },
]
const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]))

function extOf(name) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}
function suggestCategory(filename, hasMain) {
  const e = extOf(filename)
  if (VIDEO_EXTS.includes(e)) return hasMain ? 'extraFootage' : 'main'
  if (AUDIO_EXTS.includes(e)) return 'music'
  if (IMAGE_EXTS.includes(e)) return 'graphics'
  return null
}
let uidCounter = 0
function uid() { uidCounter += 1; return `pending-${Date.now()}-${uidCounter}` }

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

// Step status badge for the progress list during a Lucky run.
function StepIcon({ status }) {
  if (status === 'done')    return <CheckCircle2 className="w-4 h-4 text-emerald-400" />
  if (status === 'active')  return <Loader2 className="w-4 h-4 text-sf-accent animate-spin" />
  if (status === 'error')   return <XCircle className="w-4 h-4 text-rose-400" />
  return <Circle className="w-4 h-4 text-sf-text-muted/40" />
}

export default function ImportLuckyView({ onProposalReady }) {
  const currentProject       = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject          = useProjectStore((s) => s.saveProject)

  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
  const main       = currentProject?.sourceVideo || null
  const additional = currentProject?.additionalAssets || {}
  const sundogsReport = currentProject?.sundogsReport || null
  // Gemini report-source mode: no PDF needed — the pipeline auto-generates
  // the ad report from the video. The Go gate drops the PDF requirement.
  const geminiMode = isGeminiReportMode()

  // ─── Pending asset list (before the user confirms the drop)
  const [pending, setPending]   = useState([])
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy]         = useState(false)
  const [errors, setErrors]     = useState([])

  // ─── Sundogs PDF state. Reuses parseSundogsReport (Gemini-only) and
  // persists onto the project so a reload picks the report back up.
  const [importingReport, setImportingReport] = useState(false)
  const [reportError, setReportError]         = useState(null)
  const pdfInputRef = useRef(null)

  // Per-run capability ticks. Persisted in localStorage so the user
  // doesn't have to re-pick them every time. Defaults match the
  // safest Auto behaviour: optimize on (clean overlays), everything
  // else off (no AI fills, no reframes, no color grade) — the user
  // opts in to creative liberties.
  const AUTO_CAPS_KEY = 'reedit.auto.caps.v1'
  const [autoCaps, setAutoCaps] = useState(() => {
    try {
      const raw = localStorage.getItem(AUTO_CAPS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        return {
          optimize: parsed?.optimize !== false,
          reframe:  Boolean(parsed?.reframe),
          generate: Boolean(parsed?.generate),
          color:    Boolean(parsed?.color),
        }
      }
    } catch { /* ignore */ }
    return { optimize: true, reframe: false, generate: false, color: false }
  })
  const toggleAutoCap = (key) => {
    setAutoCaps((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try { localStorage.setItem(AUTO_CAPS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  // Strict-duration preference. Shared with Simple / Advanced via the
  // same localStorage key so the toggle persists across surfaces.
  // Default ON: Auto uses the source-video length as the target by
  // default, and the user expectation is "give me a re-edit that's the
  // same length", not "give me something approximately that length".
  const [strictDuration, setStrictDurationState] = useState(() => {
    try { return JSON.parse(localStorage.getItem('reedit.proposal.strictDuration.v1') ?? 'true') !== false }
    catch { return true }
  })
  const setStrictDuration = (val) => {
    setStrictDurationState(val)
    try { localStorage.setItem('reedit.proposal.strictDuration.v1', JSON.stringify(val)) } catch { /* ignore */ }
  }

  // ─── Lucky run state — held in a Zustand store (not local state) so
  // it survives unmounting the view. Switching to Advanced mid-run and
  // back used to wipe the progress list because the component remounted
  // with fresh useState defaults; reading from a singleton fixes that.
  const running     = useLuckyRunStore((s) => s.running)
  const cancelling  = useLuckyRunStore((s) => s.cancelling)
  const stepState   = useLuckyRunStore((s) => s.stepState)
  const stepDetail  = useLuckyRunStore((s) => s.stepDetail)
  const runError    = useLuckyRunStore((s) => s.runError)
  const luckyStart  = useLuckyRunStore((s) => s.startRun)
  const luckyUpdate = useLuckyRunStore((s) => s.updateStep)
  const luckyFinishOk    = useLuckyRunStore((s) => s.finishRunOk)
  const luckyFinishError = useLuckyRunStore((s) => s.finishRunError)
  const luckyAbort       = useLuckyRunStore((s) => s.abortRun)

  // Background: kick off Demucs once a main video is in place. Same trick
  // ImportVideoViewSimple does — the Lucky pipeline will hit the same
  // saved stems instead of re-running them.
  const triedSeparateRef = useRef(null)
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
      const latest = useProjectStore.getState().currentProject
      const sv = latest?.sourceVideo
      if (!sv || sv.path !== main.path) return
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
    }).catch(() => { /* silent — pipeline re-runs separately if missing */ })
  }, [main?.path, projectDir, saveProject, main?.stems?.vocalsPath, main?.stems?.musicPath])

  // ─── Confirmed asset list shown below the dropzone.
  const allConfirmed = useMemo(() => {
    const items = []
    if (main) {
      items.push({
        category: 'main', name: main.name, path: main.path, size: 0,
        meta: [
          main.width && main.height ? `${main.width}×${main.height}` : null,
          main.fps ? `${main.fps.toFixed(2)} fps` : null,
          main.duration ? `${main.duration.toFixed(1)}s` : null,
        ].filter(Boolean).join(' · '),
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

  // ───────── Asset import handlers (copy of ImportVideoViewSimple) ─────────

  const importAsMain = useCallback(async (absolutePath, displayName) => {
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
  }, [saveProject])

  const importAsAdditional = useCallback(async (absolutePath, categoryId) => {
    if (!window?.electronAPI) throw new Error('Electron bridge missing.')
    if (!projectDir) throw new Error('Project has no on-disk handle yet.')
    const res = await window.electronAPI.importAdditionalAsset({
      sourcePath: absolutePath,
      category: categoryId,
      projectDir,
    })
    if (!res?.success || !res.asset) throw new Error(res?.error || 'Import failed.')
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    const list = existing[categoryId] || []
    await saveProject({
      additionalAssets: {
        ...existing,
        [categoryId]: [...list, res.asset],
      },
    })
  }, [projectDir, saveProject])

  const confirmAll = useCallback(async () => {
    if (busy || pending.length === 0) return
    setBusy(true)
    const newErrors = []
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
    const failedIds = new Set(newErrors.map((e) => e.id))
    setPending((prev) => prev.filter((p) => failedIds.has(p.id)))
  }, [busy, pending, importAsMain, importAsAdditional])

  const addFilesToPending = useCallback((fileList) => {
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
      next.push({ id: uid(), path: f.path, name: f.name, size: f.size, category: cat })
    }
    setPending((p) => [...p, ...next])
  }, [main, pending])

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
      path: p, name: p.split(/[\\/]/).pop() || 'file', size: 0,
    })))
  }
  const setItemCategory = (id, category) => {
    setPending((prev) => prev.map((p) => p.id === id ? { ...p, category } : p))
  }
  const dropPending = (id) => setPending((prev) => prev.filter((p) => p.id !== id))

  const deleteAsset = async (category, item) => {
    if (category === 'main') {
      resetReeditProjectState()
      await saveProject({ sourceVideo: null, analysis: null, proposal: null })
      triedSeparateRef.current = null
      return
    }
    try { await window.electronAPI?.deleteAdditionalAsset?.({ assetPath: item.path }) }
    catch (_) { /* ignore */ }
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    await saveProject({
      additionalAssets: {
        ...existing,
        [category]: (existing[category] || []).filter((a) => a.id !== item.id),
      },
    })
  }

  // ───────── Sundogs PDF picker ─────────

  const handlePickPdf = () => { if (!importingReport) pdfInputRef.current?.click() }
  const handlePdfChange = async (e) => {
    const file = e.target.files?.[0]
    if (pdfInputRef.current) pdfInputRef.current.value = ''
    if (!file) return
    setImportingReport(true)
    setReportError(null)
    try {
      const report = await parseSundogsReport({ file })
      await saveProject({ sundogsReport: report })
    } catch (err) {
      console.error('[reedit-lucky] Sundogs PDF import failed:', err)
      setReportError(err?.message || 'Sundogs PDF import failed.')
    } finally {
      setImportingReport(false)
    }
  }

  // ───────── Lucky run ─────────

  // Gate the Go button: project handle + Sundogs PDF + SOMETHING that can
  // become a main video (already confirmed, or a pending row tagged
  // "main"). We deliberately don't require `main` to already be confirmed —
  // Auto mode promises a single button, so Go auto-confirms any pending
  // drops before kicking off the pipeline below.
  const pendingMain = pending.find((p) => p.category === 'main')
  const willHaveMain = Boolean(main) || Boolean(pendingMain)
  const allPendingCategorised = pending.every((p) => p.category)
  const goDisabled =
    !projectDir
    || (!geminiMode && !sundogsReport)
    || running
    || !willHaveMain
    || !allPendingCategorised

  const startRun = async () => {
    if (goDisabled) return
    // Flip the global store into "run started" mode. Resets stepState,
    // stepDetail, runError, abortFlag — same shape the local-state
    // version used to set, but in one action.
    luckyStart()

    // ─── 0. Auto-confirm anything still in the pending tray. The single-
    // button promise of Auto mode means we can't ask the user to click
    // "Add to project" first — but we still surface failures inline so
    // a bad asset doesn't silently disappear.
    if (pending.length > 0) {
      const ordered = [...pending].sort((a, b) => (a.category === 'main' ? -1 : 0) - (b.category === 'main' ? -1 : 0))
      const newErrors = []
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
      const failedIds = new Set(newErrors.map((e) => e.id))
      setPending((prev) => prev.filter((p) => failedIds.has(p.id)))
      setErrors(newErrors)
      if (newErrors.length > 0) {
        luckyFinishError(`Couldn't import ${newErrors.length} asset${newErrors.length === 1 ? '' : 's'}: ${newErrors[0].msg}`)
        return
      }
    }

    // The store-level `updateStep` action does the index-based painting
    // (every emit re-walks LUCKY_STEPS to set done/active/pending in
    // one shot). The view stays a thin wrapper.
    const signal = useLuckyRunStore.getState().abortFlag
    try {
      await runLuckyPipeline({
        signal,
        caps: autoCaps,
        extra: { strictDuration },
        onProgress: (step, payload) => luckyUpdate(step, payload),
      })
      luckyFinishOk()
      onProposalReady?.()
    } catch (err) {
      console.error('[reedit-lucky] pipeline failed:', err)
      luckyFinishError(err?.message || 'Pipeline failed.')
    }
  }

  const cancelRun = () => {
    // Flip the cooperative-cancel flag so the pipeline throws at the
    // next checkAbort boundary, AND fire a best-effort interrupt at
    // the Comfy server so any in-flight generation aborts immediately
    // instead of running its full duration. On local Comfy this kills
    // the current job (e.g. a VACE optimize pass that would otherwise
    // burn 1-3 minutes per shot); on Comfy Cloud it's a documented
    // no-op and we still rely on the cooperative cancel.
    luckyAbort()
    import('../../../services/comfyui').then(({ comfyui }) => {
      comfyui.interrupt?.()
    }).catch(() => { /* ignore — cancel is best-effort */ })
  }

  // ───────── Render ─────────

  if (!projectDir) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-sm text-sf-text-muted">
        Open or create a project first.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="w-full max-w-4xl mx-auto px-8 py-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold mb-1 flex items-center gap-2">
            <Dice5 className="w-5 h-5 text-sf-accent" /> Auto
          </h1>
          <p className="text-sm text-sf-text-muted">
            {geminiMode
              ? 'Drop the main video and we\'ll do the rest: detection, captioning, overlay cleanup, a Gemini ad report, and a graded proposal — all in one go.'
              : 'Drop the main video, attach the Sundogs report, and we\'ll do the rest: detection, captioning, overlay cleanup, and a Sundogs-graded proposal — all in one go.'}
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
            One main video is required. Music, voiceover, extra footage and graphics are optional.
          </div>
          <button
            onClick={handleBrowse}
            disabled={busy || running}
            className="inline-flex items-center gap-2 px-4 py-2 rounded bg-sf-accent hover:bg-sf-accent-hover text-white text-sm disabled:opacity-50"
          >
            <Upload size={14}/> Browse files
          </button>
        </div>

        {/* Pending list */}
        {pending.length > 0 && (
          <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="flex items-center px-4 py-2 border-b border-sf-dark-700 text-xs uppercase text-sf-text-muted">
              <span>Ready to add</span>
              <span className="ml-2 text-[10px] text-sf-text-muted">({pending.length})</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => setPending([])}
                  disabled={busy || running}
                  className="text-xs px-2 py-1 rounded border border-sf-dark-700 hover:bg-sf-dark-800 disabled:opacity-50"
                >Clear</button>
                <button
                  onClick={confirmAll}
                  disabled={busy || running || pending.some((p) => !p.category)}
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
                    <Icon size={16} className="text-sf-text-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{p.name}</div>
                      {error && <div className="text-xs text-red-400">{error.msg}</div>}
                    </div>
                    <select
                      value={p.category || ''}
                      onChange={(e) => setItemCategory(p.id, e.target.value || null)}
                      disabled={busy || running}
                      className="bg-sf-dark-800 border border-sf-dark-700 rounded text-xs px-2 py-1"
                    >
                      <option value="">— pick —</option>
                      {CATEGORIES.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => dropPending(p.id)}
                      disabled={busy || running}
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

        {/* Confirmed assets */}
        {allConfirmed.length > 0 && (
          <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="flex items-center px-4 py-2 border-b border-sf-dark-700 text-xs uppercase text-sf-text-muted">
              Project assets
              <span className="ml-2 text-[10px] text-sf-text-muted">({allConfirmed.length})</span>
              {main && (
                <span className="ml-3 text-[10px] text-sf-accent inline-flex items-center gap-1">
                  <CheckCircle2 size={10}/> main video ready
                </span>
              )}
            </div>
            <ul>
              {allConfirmed.map((it, idx) => {
                const def = CAT_BY_ID[it.category]
                const Icon = def?.icon || Film
                return (
                  <li key={`${it.category}-${it.id || it.path}-${idx}`} className="flex items-center gap-3 px-4 py-2 border-b border-sf-dark-800 last:border-b-0">
                    <Icon size={16} className="text-sf-text-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate">{it.name}</div>
                      <div className="text-xs text-sf-text-muted truncate">{it.meta}</div>
                    </div>
                    <span className={`text-[10px] uppercase px-2 py-0.5 rounded border ${def?.accent || 'border-sf-dark-700 text-sf-text-muted'}`}>
                      {def?.label || it.category}
                    </span>
                    <button
                      onClick={() => deleteAsset(it.category, it)}
                      disabled={running}
                      title="Remove from project"
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

        {/* Gemini report-source mode: no PDF gate. The pipeline generates
            the ad report from the video as its first analysis step, so
            there's nothing to attach — just a heads-up. */}
        {geminiMode ? (
          <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg px-4 py-3 flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-violet-300 mt-0.5 shrink-0" />
            <div className="text-xs text-sf-text-muted">
              <span className="text-sm font-medium text-sf-text-primary">Ad report — auto-generated</span>
              <div className="mt-0.5">
                Auto mode will analyze the video with Gemini and grade the proposal against the resulting strengths / weaknesses / opportunities report. No PDF needed.
                <span className="text-sf-text-muted/70"> Requires Gemini API key.</span>
              </div>
            </div>
          </div>
        ) : (
        /* Sundogs report gate — required to enable the Go button.
           Accepts PDF, an image of the report, or a text export. */
        <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
          <input
            ref={pdfInputRef}
            type="file"
            accept={SUNDOGS_REPORT_ACCEPT}
            className="hidden"
            onChange={handlePdfChange}
          />
          <div className="flex items-start gap-3 px-4 py-3">
            <FileText className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-sf-text-primary mb-0.5">
                Sundogs report {sundogsReport && <span className="text-xs text-emerald-400 ml-1">✓ loaded</span>}
              </div>
              {sundogsReport ? (
                <div className="text-xs text-sf-text-muted truncate">
                  {[sundogsReport.meta?.brand, sundogsReport.meta?.product, sundogsReport.fileName]
                    .filter(Boolean).join(' · ')}
                  {Number.isFinite(sundogsReport.overall?.finalScorePct) && (
                    <span className="ml-2 text-sf-text-primary/80">
                      {sundogsReport.overall.finalScorePct}% vs {sundogsReport.overall.benchmarkPct}% benchmark
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-sf-text-muted">
                  Auto mode grades the proposal against the Sundogs PDF. Attach it before pressing Go.
                  <span className="text-sf-text-muted/70"> Requires Gemini API key.</span>
                </div>
              )}
              {reportError && (
                <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-rose-300">
                  <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{reportError}</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handlePickPdf}
              disabled={importingReport || running}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-sf-dark-800 hover:bg-sf-dark-700 text-sf-text-primary border border-sf-dark-600 disabled:opacity-50 shrink-0"
            >
              {importingReport
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Upload className="w-3.5 h-3.5" />}
              {sundogsReport ? 'Replace' : 'Import PDF'}
            </button>
          </div>
        </div>
        )}

        {/* Allow: which creative liberties the pipeline can take on
            this run. Off by default (apart from Optimize) so an
            unattended Go produces the safest possible re-edit.
            Persisted in localStorage. Compact one-row layout — tooltip
            on hover carries the longer explanation. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-sf-text-secondary">
          <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Allow:</span>
          {[
            { id: 'optimize', label: 'Optimize footage',   tip: 'Clean overlays / graphics from shots (VACE).' },
            { id: 'reframe',  label: 'Reframe',            tip: 'Zoom / pan within aspect to land beats.' },
            { id: 'generate', label: 'Footage generation', tip: 'AI-generated placeholder shots (Kling / Grok / Vidu / Seedance).' },
            { id: 'color',    label: 'Color correction',   tip: 'Per-shot color grade adjustments.' },
          ].map((row) => (
            <label
              key={row.id}
              title={row.tip}
              className={`inline-flex items-center gap-1.5 cursor-pointer ${running ? 'opacity-60 cursor-not-allowed' : ''}`}
            >
              <input
                type="checkbox"
                checked={Boolean(autoCaps[row.id])}
                disabled={running}
                onChange={() => toggleAutoCap(row.id)}
                className="accent-sf-accent"
              />
              <span>{row.label}</span>
            </label>
          ))}
          {/* Strict duration — separated visually from the Allow row by
              a small dot since it controls timing tolerance, not what
              the pipeline is allowed to do. Same compact row to avoid
              adding another layout block. */}
          <span className="text-sf-text-muted/40 select-none">·</span>
          <label
            title="Force the EDL to land within ±3% of the target duration (instead of ±15%) and retry up to 2× if it doesn't. Target = source-video length."
            className={`inline-flex items-center gap-1.5 cursor-pointer ${running ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <input
              type="checkbox"
              checked={strictDuration}
              disabled={running}
              onChange={(e) => setStrictDuration(e.target.checked)}
              className="accent-sf-accent"
            />
            <span>Strict duration</span>
          </label>
        </div>

        {/* Go / cancel */}
        <div className="flex items-center justify-center pt-2">
          {!running ? (
            <button
              type="button"
              onClick={startRun}
              disabled={goDisabled}
              className="inline-flex items-center gap-3 px-8 py-3 rounded-xl bg-sf-accent hover:bg-sf-accent-hover text-white font-semibold text-base shadow-lg disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                !willHaveMain ? 'Drop a main video first.'
                : !sundogsReport ? 'Attach the Sundogs PDF first.'
                : !allPendingCategorised ? 'Pick a category for every dropped file.'
                : 'Run the full pipeline.'
              }
            >
              <Dice5 className="w-5 h-5" />
              Go
            </button>
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={cancelRun}
                disabled={cancelling}
                className="inline-flex items-center gap-2 px-5 py-2 rounded-lg border border-sf-dark-600 hover:bg-sf-dark-800 text-sf-text-primary text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
              {cancelling && (
                <span className="text-[11px] text-sf-text-muted">
                  Waiting for the current step to yield — long generations may take a moment to abort.
                </span>
              )}
            </div>
          )}
        </div>

        {/* Step list — visible during/after a run */}
        {(running || Object.keys(stepState).length > 0) && (
          <div className="bg-sf-dark-900/40 border border-sf-dark-700 rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b border-sf-dark-700 text-xs uppercase text-sf-text-muted">
              Pipeline
            </div>
            <ul>
              {LUCKY_STEPS.map((s) => {
                const status = stepState[s.id] || 'pending'
                const detail = stepDetail[s.id] || ''
                const isActive = status === 'active'
                return (
                  <li key={s.id} className="flex items-start gap-3 px-4 py-2 border-b border-sf-dark-800 last:border-b-0">
                    <div className="pt-0.5"><StepIcon status={status} /></div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm ${isActive ? 'text-sf-text-primary' : status === 'done' ? 'text-sf-text-secondary' : status === 'error' ? 'text-rose-300' : 'text-sf-text-muted'}`}>
                        {s.label}
                      </div>
                      {detail && (
                        <div className="text-xs text-sf-text-muted/80 truncate">{detail}</div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            {runError && (
              <div className="flex items-start gap-2 px-4 py-3 bg-rose-500/10 border-t border-rose-500/30 text-[13px] text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{runError}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
