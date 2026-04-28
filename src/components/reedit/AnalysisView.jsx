import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2, AlertCircle, PlayCircle, RotateCcw, Sparkles, StopCircle, Eye, EyeOff, Cpu, KeyRound, Wand2, CheckCircle2, RefreshCw, Lightbulb, ExternalLink, Trash2 } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import { captionScenes, pickVisionModelId, analyzeOverallAd } from '../../services/reeditCaptioner'
import { resolveActiveClipPath } from '../../services/reeditVideoAnalyzer'
import { useLlmSettings } from '../../hooks/useLlmSettings'
import { LLM_BACKENDS, BACKEND_LABELS, ANTHROPIC_MODELS, GEMINI_MODELS } from '../../services/reeditLlmClient'
import LlmSettingsModal from './LlmSettingsModal'
import OptimizeFootageCell, { shotHasGraphics, OPTIMIZE_STAGE_LABEL } from './OptimizeFootageCell'

// Build the comfystudio:// URL on the renderer. Mirrors what
// `media:getFileUrl` does in main.js (`encodeURIComponent(path)`), so
// we avoid a per-thumbnail IPC round trip when rendering the shot log.
// `version` is appended as `?v=<timestamp>` so re-running analysis
// (which overwrites `.reedit/scenes/scene-NNN.jpg` in place) produces
// a fresh URL and Chromium refetches instead of serving the previous
// run's cached bytes. The main-process handler strips the `?v=` part
// before opening the file, so the lookup still resolves cleanly.
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

// Per-row thumbnail footprint. We keep the HEIGHT constant across
// aspects so vertical videos don't blow up row heights; the WIDTH
// shrinks for vertical content. A 9:16 source ends up ~56px × 100,
// a 16:9 source ~178px × 100 — both read clearly at a glance.
const THUMB_HEIGHT = 100
// Hover preview caps the long edge at this many px so a 16:9 thumb
// doesn't cover half the screen and a 9:16 thumb stays readable.
const PREVIEW_LONG_EDGE = 420

// Renders the Description column: a rich visual description, then an
// Audio block (music + SFX + VO transcript), then a Graphics block
// (on-screen text, logos, overlays). Falls back to the single-line
// caption when the richer schema isn't available (e.g. the project was
// captioned with LM Studio / Claude before Gemini was wired up, or the
// Gemini run failed on this shot).
function DescriptionCell({ scene }) {
  const va = scene.videoAnalysis || null
  const struct = scene.structured || {}
  const visual = va?.visual || struct.visual || scene.caption || null

  // Audio comes from the analyzer directly or the adapted captioner
  // shape (toCaptionerShape in reeditCaptioner.js copies audio through).
  const audio = va?.audio ?? struct.audio ?? null
  const graphics = va?.graphics ?? null
  // Subject + Brand mark bboxes — the hero element's position in frame
  // and the separate, tighter brand-mark anchor (when a literal logo
  // is visible). Surfacing both lets the user verify at a glance what
  // the analyzer captured and whether reframes will land on the brand.
  const coordsFromBbox = (bbox) => {
    if (!bbox || !Array.isArray(bbox.box_2d) || bbox.box_2d.length < 4) return null
    const [ymin, xmin, ymax, xmax] = bbox.box_2d.map((n) => Number(n) / 1000)
    if (![ymin, xmin, ymax, xmax].every((v) => Number.isFinite(v))) return null
    return {
      cx: ((xmin + xmax) / 2).toFixed(2),
      cy: ((ymin + ymax) / 2).toFixed(2),
      w: (xmax - xmin).toFixed(2),
      h: (ymax - ymin).toFixed(2),
      label: bbox.label || 'subject',
    }
  }
  const subjectCoords = coordsFromBbox(va?.subject_bbox)
  const brandMarkCoords = coordsFromBbox(va?.brand_mark_bbox)

  if (!visual && !audio && !graphics && !subjectCoords && !brandMarkCoords) {
    return <span className="text-sf-text-muted italic">— (Run Caption all)</span>
  }

  const sfxText = Array.isArray(audio?.sfx) && audio.sfx.length
    ? audio.sfx.join(', ')
    : null
  const audioHasAnything = audio && (audio.music || sfxText || audio.voiceover_transcript || audio.ambient)
  const graphicsHasAnything = graphics && (
    graphics.text_content || graphics.logo_description || graphics.other_graphics
  )

  return (
    <div className="space-y-2">
      {visual && (
        <div className="text-sf-text-primary leading-snug">{visual}</div>
      )}

      {brandMarkCoords && (() => {
        const loose = Number(brandMarkCoords.w) > 0.3 || Number(brandMarkCoords.h) > 0.3
        return (
          <div className={`border-l-2 pl-2 space-y-0.5 ${loose ? 'border-amber-500/40' : 'border-emerald-500/30'}`}>
            <div className={`text-[9px] uppercase tracking-wider font-medium ${loose ? 'text-amber-300/80' : 'text-emerald-300/80'}`}>Brand mark{loose ? ' (loose bbox)' : ''}</div>
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">{brandMarkCoords.label} · </span>
              <span className={`font-mono ${loose ? 'text-amber-300' : 'text-emerald-300'}`}>[{brandMarkCoords.cx},{brandMarkCoords.cy}]</span>
              <span className="text-sf-text-muted"> (bbox {brandMarkCoords.w}×{brandMarkCoords.h})</span>
              {loose && (
                <span className="ml-1.5 text-amber-300/80 italic text-[10px]">
                  — bbox too loose for a reliable brand-focused reframe
                </span>
              )}
            </div>
          </div>
        )
      })()}
      {subjectCoords && (() => {
        // Flag loose bboxes so the user can tell when Gemini picked the
        // parent object (grille, whole car, the entire face) instead of
        // the tight subject element (logo, eye, badge). A bbox wider
        // than 0.3 on either axis will cause the parser to DROP any
        // REFRAME on this shot (see snapReframeToLogo in reeditProposer.js).
        const loose = Number(subjectCoords.w) > 0.3 || Number(subjectCoords.h) > 0.3
        return (
          <div className={`border-l-2 pl-2 space-y-0.5 ${loose ? 'border-amber-500/40' : 'border-sky-500/30'}`}>
            <div className={`text-[9px] uppercase tracking-wider font-medium ${loose ? 'text-amber-300/80' : 'text-sky-300/80'}`}>Subject{loose ? ' (loose bbox)' : ''}</div>
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">{subjectCoords.label} · </span>
              <span className={`font-mono ${loose ? 'text-amber-300' : 'text-sky-300'}`}>[{subjectCoords.cx},{subjectCoords.cy}]</span>
              <span className="text-sf-text-muted"> (bbox {subjectCoords.w}×{subjectCoords.h})</span>
              {loose && (
                <span className="ml-1.5 text-amber-300/80 italic text-[10px]">
                  — bbox too wide: any REFRAME on this shot will be auto-dropped
                </span>
              )}
            </div>
          </div>
        )
      })()}

      {audioHasAnything && (
        <div className="border-l-2 border-emerald-500/30 pl-2 space-y-0.5">
          <div className="text-[9px] uppercase tracking-wider text-emerald-300/80 font-medium">Audio</div>
          {audio.music && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">Music · </span>{audio.music}
            </div>
          )}
          {sfxText && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">SFX · </span>{sfxText}
            </div>
          )}
          {audio.voiceover_transcript && (
            <div className="text-[11px] text-sf-text-secondary leading-snug italic">
              <span className="text-sf-text-muted not-italic">VO · </span>&ldquo;{audio.voiceover_transcript}&rdquo;
            </div>
          )}
          {audio.ambient && !audio.music && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">Ambient · </span>{audio.ambient}
            </div>
          )}
        </div>
      )}

      {graphicsHasAnything && (
        <div className="border-l-2 border-amber-500/30 pl-2 space-y-0.5">
          <div className="text-[9px] uppercase tracking-wider text-amber-300/80 font-medium">Graphics</div>
          {graphics.text_content && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">Text{graphics.text_role && graphics.text_role !== 'none' ? ` (${graphics.text_role})` : ''} · </span>
              <span className="whitespace-pre-wrap">&ldquo;{graphics.text_content}&rdquo;</span>
            </div>
          )}
          {graphics.logo_description && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">Logo · </span>{graphics.logo_description}
            </div>
          )}
          {graphics.other_graphics && (
            <div className="text-[11px] text-sf-text-secondary leading-snug">
              <span className="text-sf-text-muted">Overlay · </span>{graphics.other_graphics}
            </div>
          )}
        </div>
      )}
    </div>
  )
}


function AnalysisView() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject = useProjectStore((s) => s.saveProject)

  const sourceVideo = currentProject?.sourceVideo
  const analysis = currentProject?.analysis
  const scenes = analysis?.scenes || []
  // Sub-tab inside the Analysis workspace: 'source' (the source-video
  // shot log + caption controls — the original view) vs 'additional'
  // (auxiliary material the user dropped in Import).
  const [section, setSection] = useState('source')

  // Hovered scene state for the fixed-position preview overlay. We
  // track the cursor-anchored rect so the preview can dodge off
  // either edge of the viewport without the DOM-reflow cost of
  // absolute-positioning inside the scrolling table.
  const [hover, setHover] = useState(null) // { url, rect, previewW, previewH }
  const [llmModalOpen, setLlmModalOpen] = useState(false)
  const { settings: llmSettings, update: updateLlmSettings } = useLlmSettings()

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

  // Per-scene re-caption: { [sceneId]: 'running' | 'error' }. Kept
  // separate from the batch `captioning` flag so one failing shot can
  // be retried without freezing the whole view.
  const [perSceneCaptioning, setPerSceneCaptioning] = useState({})

  // Overall ad analysis (concept / message / mood). Populated by the
  // "Understand the ad" button at the top of the shot log and persisted
  // into analysis.overall so it survives reloads.
  const [overallRunning, setOverallRunning] = useState(false)
  const [overallError, setOverallError] = useState(null)

  // Per-scene optimize state — keyed by sceneId, tracks the full
  // lifecycle of the VACE re-inpaint job (starting / generating_mask /
  // uploading / queued / running / done / error). The ComfyUI server
  // runs the jobs sequentially, but the UI allows multiple rows to be
  // queued; main.js emits progress events we fan out into this map.
  const [optimizeState, setOptimizeState] = useState({}) // { [sceneId]: { stage, ...details, outputPath?, error? } }
  // Per-scene preview (mask-only) state. Declared up here ABOVE the
  // early return below so React's hook order stays consistent across
  // renders — moving it after `if (!sourceVideo)` triggers the
  // "Rendered fewer hooks than expected" violation when the user
  // creates a new project (sourceVideo flips between null and an
  // object, changing the hook count between renders).
  const [previewState, setPreviewState] = useState({})
  useEffect(() => {
    const unsub = window.electronAPI?.onOptimizeFootageProgress?.((payload) => {
      if (!payload?.sceneId) return
      setOptimizeState((prev) => ({
        ...prev,
        [payload.sceneId]: { ...(prev[payload.sceneId] || {}), ...payload },
      }))
    })
    return () => { try { unsub?.() } catch (_) { /* ignore */ } }
  }, [])

  if (!sourceVideo) return <ImportPrompt />

  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null

  // Derive display dimensions from the source video's real aspect so
  // vertical 9:16 content gets a narrow tall thumb instead of being
  // letterboxed inside a fixed 16:9 cell. Fallback to 16:9 if we
  // somehow lost the dims (old projects, failed probe).
  const aspectRatio = (sourceVideo.width && sourceVideo.height)
    ? sourceVideo.width / sourceVideo.height
    : 16 / 9
  const isVertical = aspectRatio < 1
  const thumbW = Math.max(40, Math.round(THUMB_HEIGHT * aspectRatio))
  const previewH = isVertical ? PREVIEW_LONG_EDGE : Math.round(PREVIEW_LONG_EDGE / aspectRatio)
  const previewW = isVertical ? Math.round(PREVIEW_LONG_EDGE * aspectRatio) : PREVIEW_LONG_EDGE

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

      // Passed down to the captioner so the Gemini branch can extract
      // sub-clips from the source video for native-video analysis.
      // LM Studio / Claude ignore them (they still read the per-scene
      // thumbnail), so it's safe to always pass them.
      const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
      const sourceVideoPath = sourceVideo?.path || null

      const { scenes: updatedScenes } = await captionScenes(scenes, {
        modelId,
        signal: abortCtrl,
        sourceVideoPath,
        projectDir,
        onProgress: ({ index, total, error: perSceneErr }) => {
          setCaptionProgress({ current: index + 1, total, model: modelId })
          if (perSceneErr) {
            console.warn('[reedit] caption failed for scene', index, perSceneErr)
          }
        },
      })

      // Follow up with the overall ad-concept read. Gemini watches the
      // source video directly; LM Studio / Claude summarise from the
      // per-shot captions we just produced. If this fails we still save
      // the captions — the user can retry the overall pass via a re-run
      // without losing work. Wrapped in its own try so one backend
      // failure (e.g. source video >20 MB for Gemini inline) doesn't
      // discard the per-shot captions that just succeeded.
      setOverallRunning(true)
      setOverallError(null)
      let overall = null
      try {
        overall = await analyzeOverallAd(updatedScenes, { sourceVideoPath })
      } catch (err) {
        console.warn('[reedit] overall ad analysis failed (captions saved):', err)
        setOverallError(err?.message || String(err))
      } finally {
        setOverallRunning(false)
      }

      await saveProject({
        analysis: {
          ...(analysis || {}),
          scenes: updatedScenes,
          captionedAt: new Date().toISOString(),
          captionModel: modelId,
          overall: overall
            ? { ...overall, createdAt: new Date().toISOString() }
            : (analysis?.overall || null),
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
        // Backend-specific hint: LM Studio needs a model loaded, the
        // cloud backends need an API key. The error surface in the
        // view is otherwise identical, so a short conditional covers it.
        const backendHint = llmSettings?.backend === LLM_BACKENDS.LM_STUDIO
          ? ' Is LM Studio running with a vision model loaded?'
          : llmSettings?.backend === LLM_BACKENDS.ANTHROPIC
            ? ' Check that the Claude API key is valid in Settings → LLM.'
            : llmSettings?.backend === LLM_BACKENDS.GEMINI
              ? ' Check that the Gemini API key is valid and that the project has quota for gemini-2.5-flash video input.'
              : ''
        setCaptionError((err?.message || 'Captioning failed.') + backendHint)
      }
    } finally {
      setCaptioning(false)
      abortRef.current = null
    }
  }

  const cancelCaptioning = () => {
    if (abortRef.current) abortRef.current.aborted = true
  }

  // Re-caption a single scene. Reuses the same captionScenes() so both
  // backends (Gemini native-video and LM Studio / Claude frame) route
  // through one code path — we just pass a 1-element array. On success
  // we merge the updated scene back into analysis.scenes by id, so no
  // other scene's caption / error / videoAnalysis is touched.
  const runCaptionOne = async (scene) => {
    if (perSceneCaptioning[scene.id] === 'running' || captioning) return
    setPerSceneCaptioning((prev) => ({ ...prev, [scene.id]: 'running' }))
    try {
      const modelId = await pickVisionModelId()
      const projectDirLocal = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
      const sourceVideoPath = sourceVideo?.path || null
      const { scenes: updatedOne } = await captionScenes([scene], {
        modelId,
        sourceVideoPath,
        projectDir: projectDirLocal,
      })
      const updated = updatedOne?.[0]
      if (!updated) throw new Error('Re-caption returned no scene.')
      const nextScenes = scenes.map((s) => (s.id === scene.id ? updated : s))
      await saveProject({
        analysis: {
          ...(analysis || {}),
          scenes: nextScenes,
          captionedAt: new Date().toISOString(),
          captionModel: modelId,
        },
      })
      setPerSceneCaptioning((prev) => {
        const next = { ...prev }
        delete next[scene.id]
        return next
      })
    } catch (err) {
      console.error(`[reedit] re-caption failed for ${scene.id}`, err)
      setPerSceneCaptioning((prev) => ({ ...prev, [scene.id]: 'error' }))
      setCaptionError(`Re-caption for ${scene.id}: ${err?.message || String(err)}`)
    }
  }


  const runOptimizeFootage = async (scene) => {
    if (!projectDir) return
    const current = optimizeState[scene.id]
    // Re-click on an in-flight job is a no-op; re-click on a done/errored
    // run is allowed so the user can re-generate (new mask / seed / etc).
    if (current?.stage && !['done', 'error'].includes(current.stage)) return
    setOptimizeState((prev) => ({ ...prev, [scene.id]: { stage: 'starting' } }))
    try {
      const res = await window.electronAPI.optimizeFootage({
        scene: { id: scene.id, videoAnalysis: scene.videoAnalysis, caption: scene.caption },
        projectDir,
      })
      if (!res?.success) {
        setOptimizeState((prev) => ({ ...prev, [scene.id]: { stage: 'error', error: res?.error || 'Unknown error.' } }))
        return
      }
      setOptimizeState((prev) => ({ ...prev, [scene.id]: { stage: 'done', outputPath: res.outputPath, inProjectDir: res.inProjectDir, version: res.version } }))

      // Persist the new version into the shot's optimization stack and
      // mark it as active, so the next hover / re-caption / apply-to-
      // timeline consumes the optimized file instead of the original
      // sub-clip. The stack keeps every attempt around (by version tag),
      // allowing the dropdown in the Optimize column to jump back.
      const entry = {
        version: res.version,
        path: res.outputPath,
        vaceRawPath: res.vaceRawPath || null,
        model: res.model || null,
        composited: res.composited !== false,
        createdAt: new Date().toISOString(),
      }
      const nextScenes = (analysis?.scenes || []).map((s) => {
        if (s.id !== scene.id) return s
        const stack = Array.isArray(s.optimizations) ? s.optimizations.slice() : []
        // Replace in place if the same version tag already exists
        // (only possible when a re-run clobbers the file and reports
        // the same VNN). Otherwise append.
        const idx = stack.findIndex((o) => o.version === entry.version)
        if (idx >= 0) stack[idx] = entry
        else stack.push(entry)
        return { ...s, optimizations: stack, activeOptimizationVersion: entry.version }
      })
      await saveProject({
        analysis: { ...(analysis || {}), scenes: nextScenes },
      })
    } catch (err) {
      setOptimizeState((prev) => ({ ...prev, [scene.id]: { stage: 'error', error: err?.message || String(err) } }))
    }
  }

  // Switch the active optimized version for a scene. Passing `null`
  // reverts to the original sub-clip. Persists to the project so hover
  // / re-caption / apply-to-timeline immediately pick up the change.
  const setSceneActiveVersion = async (sceneId, version) => {
    const nextScenes = (analysis?.scenes || []).map((s) => {
      if (s.id !== sceneId) return s
      return { ...s, activeOptimizationVersion: version || null }
    })
    await saveProject({
      analysis: { ...(analysis || {}), scenes: nextScenes },
    })
  }

  // `previewState` is declared at the top of the component (above the
  // !sourceVideo early return) to keep the hook order stable. The
  // runner below mutates it via setPreviewState.
  const runPreviewMask = async (scene) => {
    if (!projectDir) return
    const current = previewState[scene.id]
    if (current?.stage === 'running') return
    setPreviewState((prev) => ({ ...prev, [scene.id]: { stage: 'running' } }))
    try {
      const res = await window.electronAPI.previewMask({
        scene: { id: scene.id, videoAnalysis: scene.videoAnalysis },
        projectDir,
      })
      if (!res?.success) {
        setPreviewState((prev) => ({ ...prev, [scene.id]: { stage: 'error', error: res?.error || 'Unknown error.' } }))
        return
      }
      setPreviewState((prev) => ({ ...prev, [scene.id]: { stage: 'done', maskPath: res.maskPath, blankPath: res.blankPath } }))
      // Reveal the mask in the OS file manager so the user can open it
      // in VLC / QuickTime without hunting through `.reedit/clips`.
      try { await window.electronAPI.showItemInFolder?.(res.maskPath) } catch (_) { /* ignore */ }
    } catch (err) {
      setPreviewState((prev) => ({ ...prev, [scene.id]: { stage: 'error', error: err?.message || String(err) } }))
    }
  }

  // Toggle a scene out of the pipeline without deleting it. Excluded
  // scenes stay visible in the shot log (so the user can compare / un-
  // exclude later) but are skipped by captioning, the proposal LLM,
  // and the Apply-to-timeline populator.
  const toggleSceneExcluded = async (sceneId) => {
    const nextScenes = scenes.map((s) => (
      s.id === sceneId ? { ...s, excluded: !s.excluded } : s
    ))
    await saveProject({
      analysis: { ...(analysis || {}), scenes: nextScenes },
    })
  }

  const hasCaptions = scenes.some((s) => s.caption || s.structured)
  const includedCount = scenes.filter((s) => !s.excluded).length
  const excludedCount = scenes.length - includedCount

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
              {excludedCount > 0 && (
                <span className="ml-2 text-amber-300/80">
                  · {includedCount} included / {excludedCount} excluded
                </span>
              )}
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
              title="Caption each shot and produce the overall ad read (concept / message / mood). One pass; runs against the active LLM backend."
            >
              <Sparkles className="w-3.5 h-3.5" />
              {hasCaptions ? 'Re-analyze' : 'Analyze'}
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

          {/* Engine chip — same unified dispatcher as Proposal. Shows
              the active backend and pops the LLM settings modal on
              click. Turns amber when a cloud backend is selected but
              no API key is set so the "Caption all" button isn't going
              to lead to a surprise error. */}
          {(() => {
            const backend = llmSettings.backend
            const missingAnthropicKey = backend === LLM_BACKENDS.ANTHROPIC && !llmSettings.anthropicApiKey
            const missingGeminiKey = backend === LLM_BACKENDS.GEMINI && !llmSettings.geminiApiKey
            const missingKey = missingAnthropicKey || missingGeminiKey
            const label = backend === LLM_BACKENDS.ANTHROPIC
              ? (ANTHROPIC_MODELS.find((m) => m.id === llmSettings.anthropicModel)?.label || 'Claude')
              : backend === LLM_BACKENDS.GEMINI
                ? (GEMINI_MODELS.find((m) => m.id === (llmSettings.geminiAnalysisModel || llmSettings.geminiModel))?.label || 'Gemini')
                : BACKEND_LABELS[LLM_BACKENDS.LM_STUDIO]
            return (
              <button
                type="button"
                onClick={() => setLlmModalOpen(true)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border transition-colors
                  ${missingKey
                    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                    : 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'}`}
                title="Switch engine, pick model, set API key"
              >
                {missingKey ? <KeyRound className="w-3.5 h-3.5" /> : <Cpu className="w-3.5 h-3.5" />}
                {label}
                {missingKey && <span className="text-[10px] opacity-80">· no key</span>}
              </button>
            )
          })()}
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
          {overallRunning
            ? 'Reading overall ad concept…'
            : `Analyzing scene ${captionProgress.current}/${captionProgress.total}`}
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

      {/* Overall-ad read. Produced as part of the Analyze pass (same
          button that captions each shot) so there's one action, not
          two. Persisted into analysis.overall; passed into the proposal
          prompt as an "original intent" block so the re-edit doesn't
          drift off the creative concept. Banner is display-only —
          re-running is just clicking Re-analyze. */}
      {analysis?.status === 'done' && (analysis?.overall || overallRunning || overallError) && (
        <div className="flex-shrink-0 border-b border-sf-dark-800 bg-sf-dark-900/40">
          <div className="px-6 py-3">
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
                <Lightbulb className="w-3.5 h-3.5 text-amber-300" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-sf-text-muted">Ad concept (as understood by the model)</h2>
                  {overallRunning && <Loader2 className="w-3 h-3 animate-spin text-sf-text-muted" />}
                </div>
                {overallError && (
                  <div className="text-[11px] text-sf-error flex items-start gap-1.5">
                    <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>{overallError}</span>
                  </div>
                )}
                {analysis?.overall && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5 text-[11px] leading-relaxed">
                    {analysis.overall.concept && (
                      <div className="md:col-span-2">
                        <span className="text-sf-text-muted">Concept: </span>
                        <span className="text-sf-text-primary">{analysis.overall.concept}</span>
                      </div>
                    )}
                    {analysis.overall.message && (
                      <div className="md:col-span-2">
                        <span className="text-sf-text-muted">Message: </span>
                        <span className="text-sf-text-primary">{analysis.overall.message}</span>
                      </div>
                    )}
                    {analysis.overall.mood && (
                      <div>
                        <span className="text-sf-text-muted">Mood: </span>
                        <span className="text-sf-text-secondary">{analysis.overall.mood}</span>
                      </div>
                    )}
                    {analysis.overall.target_audience && (
                      <div>
                        <span className="text-sf-text-muted">Audience: </span>
                        <span className="text-sf-text-secondary">{analysis.overall.target_audience}</span>
                      </div>
                    )}
                    {analysis.overall.brand_role && (
                      <div className="md:col-span-2">
                        <span className="text-sf-text-muted">Brand role: </span>
                        <span className="text-sf-text-secondary">{analysis.overall.brand_role}</span>
                      </div>
                    )}
                    {analysis.overall.narrative_arc && (
                      <div className="md:col-span-2">
                        <span className="text-sf-text-muted">Arc: </span>
                        <span className="text-sf-text-secondary">{analysis.overall.narrative_arc}</span>
                      </div>
                    )}
                    {analysis.overall.model && (
                      <div className="md:col-span-2 text-[10px] text-sf-text-muted/70 italic">
                        {analysis.overall.model}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sub-tabs (Source video / Additional assets) */}
      {(() => {
        const additional = currentProject?.additionalAssets || {}
        const additionalCount = ['extraFootage', 'graphics', 'music', 'voiceover'].reduce(
          (n, k) => n + (Array.isArray(additional[k]) ? additional[k].length : 0),
          0,
        )
        return (
          <div className="flex-shrink-0 flex items-center gap-1 px-6 pt-3 pb-3 border-b border-sf-dark-800">
            <button
              type="button"
              onClick={() => setSection('source')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors
                ${section === 'source'
                  ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                  : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500 text-sf-text-muted hover:text-sf-text-primary'}`}
            >
              <FileText className="w-3.5 h-3.5" />
              Source video
              <span className={`ml-1 text-[10px] ${section === 'source' ? 'text-sf-text-secondary' : 'text-sf-text-muted/70'}`}>
                {scenes.length} shot{scenes.length === 1 ? '' : 's'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSection('additional')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors
                ${section === 'additional'
                  ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                  : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500 text-sf-text-muted hover:text-sf-text-primary'}`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Additional assets
              <span className={`ml-1 text-[10px] ${section === 'additional' ? 'text-sf-text-secondary' : 'text-sf-text-muted/70'}`}>
                {additionalCount} item{additionalCount === 1 ? '' : 's'}
              </span>
            </button>
          </div>
        )
      })()}

      {/* Body — Source-video branch (current shot log) */}
      {section === 'source' && (
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
                <th className="text-left px-3 py-2 font-medium w-8">Use</th>
                <th className="text-left px-3 py-2 font-medium w-10">#</th>
                <th className="text-left px-3 py-2 font-medium" style={{ width: thumbW + 24 }}>Thumbnail</th>
                <th className="text-left px-3 py-2 font-medium w-[72px]">In</th>
                <th className="text-left px-3 py-2 font-medium w-[72px]">Out</th>
                <th className="text-left px-3 py-2 font-medium w-[60px]">Dur</th>
                <th className="text-left px-3 py-2 font-medium">Description</th>
                <th className="text-left px-3 py-2 font-medium w-[140px]">Brand</th>
                <th className="text-left px-3 py-2 font-medium w-[110px]">Emotion</th>
                <th className="text-left px-3 py-2 font-medium w-[90px]">Framing</th>
                <th className="text-left px-3 py-2 font-medium w-[90px]">Motion</th>
              </tr>
            </thead>
            <tbody>
              {scenes.map((scene) => {
                const thumbUrl = toComfyUrl(scene.thumbnail, analysis?.createdAt)
                const s = scene.structured || {}
                const excluded = Boolean(scene.excluded)
                return (
                  <tr
                    key={scene.id}
                    className={`border-t border-sf-dark-800 hover:bg-sf-dark-900/60 align-top transition-opacity ${excluded ? 'opacity-40' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => toggleSceneExcluded(scene.id)}
                        title={excluded ? 'Include scene (currently excluded)' : 'Exclude scene from captioning + proposal'}
                        className={`p-1 rounded transition-colors
                          ${excluded
                            ? 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
                            : 'text-sf-accent hover:bg-sf-accent/20'}`}
                      >
                        {excluded ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-sf-text-muted tabular-nums">{scene.index}</td>
                    <td className="px-3 py-2">
                      <div
                        className="rounded bg-sf-dark-800 overflow-hidden cursor-zoom-in"
                        style={{ width: thumbW, height: THUMB_HEIGHT }}
                        onMouseEnter={(e) => {
                          if (!thumbUrl) return
                          const rect = e.currentTarget.getBoundingClientRect()
                          // Prefer the ACTIVE clip for the scene — if
                          // the user selected an optimized version via
                          // the version dropdown, hover plays that one;
                          // otherwise the analyzer's cached original.
                          // Falls back to the static thumbnail if no
                          // clip has been materialised yet.
                          const activePath = projectDir
                            ? resolveActiveClipPath(scene, projectDir)
                            : scene.videoAnalysis?.clipPath
                          const videoUrl = activePath
                            ? toComfyUrl(activePath, scene.activeOptimizationVersion || analysis?.captionedAt || analysis?.createdAt)
                            : null
                          setHover({ url: thumbUrl, videoUrl, rect, previewW, previewH })
                        }}
                        onMouseLeave={() => setHover(null)}
                      >
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
                      <DescriptionCell scene={scene} />
                      {/* Per-scene error + retry. The batch "Caption all"
                          can skip a shot for several reasons (Gemini
                          safety filter, empty response, clip >20 MB,
                          MAX_TOKENS truncation); we surface the exact
                          reason and a single-click retry so the user
                          doesn't have to re-caption all 17 shots to fix
                          the one that failed. */}
                      {(scene.captionError || scene.videoAnalysisError) && (
                        <div className="mt-1.5 flex items-start gap-1.5 text-[10px]">
                          <AlertCircle className="w-3 h-3 text-sf-error flex-shrink-0 mt-0.5" />
                          <div className="flex-1 text-sf-error">
                            {scene.captionError || scene.videoAnalysisError}
                          </div>
                        </div>
                      )}
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={() => runCaptionOne(scene)}
                          disabled={captioning || perSceneCaptioning[scene.id] === 'running' || excluded}
                          title={excluded
                            ? 'Include the scene first to re-caption it.'
                            : (scene.caption || scene.videoAnalysis?.visual)
                              ? 'Re-caption just this shot (keeps the rest as-is).'
                              : 'Caption just this shot.'}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] transition-colors
                            ${perSceneCaptioning[scene.id] === 'running'
                              ? 'border-sf-dark-700 bg-sf-dark-800 text-sf-text-muted'
                              : 'border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary'}
                            ${excluded ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                          {perSceneCaptioning[scene.id] === 'running' ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3 h-3" />
                          )}
                          {(scene.caption || scene.videoAnalysis?.visual) ? 'Re-caption' : 'Caption'}
                        </button>
                      </div>
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
      )}

      {/* Body — Additional-assets branch (auxiliary material) */}
      {section === 'additional' && (
        <AdditionalAssetsTab onNavigate={() => { /* future — navigate to import */ }} />
      )}

      {/* Hover preview — fixed-positioned so it escapes the scrollable
          table. Positioned to the right of the thumb by default, but
          flips left if the preview would run off the viewport; clamped
          vertically so tall 9:16 previews don't clip off the top/bottom. */}
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
            {hover.videoUrl ? (
              // autoPlay + muted is the only combo browsers allow without
              // a user gesture. Loop so the shot replays as long as the
              // cursor stays over the thumbnail; the thumbnail image is
              // the poster so the preview doesn't flash black while the
              // first frame decodes.
              <video
                src={hover.videoUrl}
                poster={hover.url}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                className="w-full h-full object-cover"
              />
            ) : (
              <img src={hover.url} alt="" className="w-full h-full object-cover" />
            )}
          </div>
        )
      })()}

      <LlmSettingsModal
        isOpen={llmModalOpen}
        settings={llmSettings}
        onClose={() => setLlmModalOpen(false)}
        onSave={(patch) => {
          updateLlmSettings(patch)
          setLlmModalOpen(false)
        }}
      />
    </div>
  )
}

// Browse the imported additional material (extra footage / graphics
// / music / voiceover). Per-shot Analyze runs Gemini on each detected
// scene, persisting `videoAnalysis` + `caption` next to the scene
// metadata so the proposer can later pick from analysed shots when
// the `useAdditionalAssets` capability is on.
function AdditionalAssetsTab() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject = useProjectStore((s) => s.saveProject)
  const additional = currentProject?.additionalAssets || {}
  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null

  // Per-scene analyze state: { [sceneId]: { running, error } }. Local
  // — survives the panel staying mounted but doesn't persist (the
  // resulting videoAnalysis IS persisted on the scene).
  const [analyzeState, setAnalyzeState] = useState({})

  const handleDelete = async (categoryId, asset) => {
    if (!asset?.id) return
    try { await window.electronAPI?.deleteAdditionalAsset?.({ assetPath: asset.path }) } catch (_) { /* noop */ }
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    const next = {
      ...existing,
      [categoryId]: (existing[categoryId] || []).filter((a) => a.id !== asset.id),
    }
    await saveProject({ additionalAssets: next })
  }

  // Persist a videoAnalysis result back onto a specific scene of a
  // specific extraFootage asset. Keeps everything else immutable.
  const persistSceneAnalysis = async (assetId, sceneId, patch) => {
    const latest = useProjectStore.getState().currentProject
    const existing = latest?.additionalAssets || {}
    const list = existing.extraFootage || []
    const next = list.map((a) => {
      if (a.id !== assetId) return a
      const scenes = (a.scenes || []).map((s) => s.id === sceneId ? { ...s, ...patch } : s)
      return { ...a, scenes }
    })
    await saveProject({
      additionalAssets: { ...existing, extraFootage: next },
    })
  }

  const handleAnalyzeScene = async (asset, scene) => {
    if (!projectDir || !asset?.path || !scene?.id) return
    if (analyzeState[scene.id]?.running) return
    setAnalyzeState((prev) => ({ ...prev, [scene.id]: { running: true, error: null } }))
    try {
      const { analyzeSceneVideo } = await import('../../services/reeditVideoAnalyzer')
      const result = await analyzeSceneVideo(
        { id: scene.id, tcIn: scene.tcIn, tcOut: scene.tcOut },
        { sourceVideoPath: asset.path, projectDir },
      )
      // Derive a short caption from the visual field (or first sentence
      // of it) — keeps the card readable without forcing the user into
      // the structured payload.
      const caption = (typeof result.visual === 'string' && result.visual.trim())
        ? result.visual.trim().split(/[.!?](?:\s|$)/)[0].trim().slice(0, 200)
        : ''
      await persistSceneAnalysis(asset.id, scene.id, {
        videoAnalysis: result,
        caption,
        analyzedAt: new Date().toISOString(),
      })
      setAnalyzeState((prev) => ({ ...prev, [scene.id]: { running: false, error: null } }))
    } catch (err) {
      console.error('[reedit] analyze additional shot failed:', err)
      setAnalyzeState((prev) => ({ ...prev, [scene.id]: { running: false, error: err?.message || String(err) } }))
    }
  }

  const handleAnalyzeAllInAsset = async (asset) => {
    const scenes = Array.isArray(asset?.scenes) ? asset.scenes : []
    for (const scene of scenes) {
      if (scene.videoAnalysis) continue // skip already-analysed
      // eslint-disable-next-line no-await-in-loop
      await handleAnalyzeScene(asset, scene)
    }
  }

  // Analyse a single-clip extraFootage asset (no scene split — the
  // whole file is treated as one shot). Stores `videoAnalysis` +
  // `caption` directly on the asset entry rather than on a scene.
  const handleAnalyzeAsset = async (asset) => {
    if (!projectDir || !asset?.path || !asset?.id) return
    if (analyzeState[asset.id]?.running) return
    setAnalyzeState((prev) => ({ ...prev, [asset.id]: { running: true, error: null } }))
    try {
      const { analyzeSceneVideo } = await import('../../services/reeditVideoAnalyzer')
      // Synthesise a scene shape spanning the whole file. The analyser's
      // ensureSceneClip will extract a clip cached by the asset id.
      const result = await analyzeSceneVideo(
        { id: asset.id, tcIn: 0, tcOut: Number(asset.duration) || 0 },
        { sourceVideoPath: asset.path, projectDir },
      )
      const caption = (typeof result.visual === 'string' && result.visual.trim())
        ? result.visual.trim().split(/[.!?](?:\s|$)/)[0].trim().slice(0, 200)
        : ''
      const latest = useProjectStore.getState().currentProject
      const existing = latest?.additionalAssets || {}
      const list = existing.extraFootage || []
      const next = list.map((a) => a.id === asset.id
        ? { ...a, videoAnalysis: result, caption, analyzedAt: new Date().toISOString() }
        : a)
      await saveProject({
        additionalAssets: { ...existing, extraFootage: next },
      })
      setAnalyzeState((prev) => ({ ...prev, [asset.id]: { running: false, error: null } }))
    } catch (err) {
      console.error('[reedit] analyze asset failed:', err)
      setAnalyzeState((prev) => ({ ...prev, [asset.id]: { running: false, error: err?.message || String(err) } }))
    }
  }

  const sections = [
    { id: 'extraFootage', label: 'Extra footage', kind: 'video' },
    { id: 'graphics',     label: 'Graphics',      kind: 'image' },
    { id: 'music',        label: 'Music',         kind: 'audio' },
    { id: 'voiceover',    label: 'Voiceover',     kind: 'audio' },
  ]
  const totalItems = sections.reduce((n, s) => n + (additional[s.id]?.length || 0), 0)

  if (totalItems === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 p-6 max-w-md text-center">
          <Sparkles className="w-6 h-6 text-sf-text-muted mx-auto mb-3" />
          <h3 className="text-sm font-medium text-sf-text-primary mb-1">No additional material yet</h3>
          <p className="text-xs text-sf-text-muted leading-relaxed">
            Drop extra footage, graphics, music, or VO files in the <span className="text-sf-text-secondary">Import</span> tab. They'll show up here so you can analyse them and pull them into the proposal.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto px-6 py-6 space-y-6">
      {sections.map((sect) => {
        const items = additional[sect.id] || []
        if (items.length === 0) return null

        // Extra footage flattens scenes: an ad split into N shots
        // renders as N cards (one per detected scene); a loose clip
        // stays as a single card. Other categories stay 1:1 with
        // their imported file.
        const cards = []
        for (const asset of items) {
          if (sect.id === 'extraFootage' && Array.isArray(asset.scenes) && asset.scenes.length > 0) {
            asset.scenes.forEach((scene, idx) => cards.push({
              parent: asset,
              scene,
              sceneIndex: idx + 1,
              kind: 'video',
              key: scene.id,
            }))
          } else {
            cards.push({ parent: asset, scene: null, sceneIndex: 0, kind: sect.kind, key: asset.id })
          }
        }

        // Asset-level "Analyze remaining" — for extraFootage with at
        // least one shot still pending Gemini analysis. Covers both
        // multi-shot ads (any scene without videoAnalysis) and loose
        // single clips (asset itself without videoAnalysis).
        const assetsWithUnanalysed = sect.id === 'extraFootage'
          ? items.filter((a) => {
              if (Array.isArray(a.scenes) && a.scenes.length > 0) {
                return a.scenes.some((s) => !s.videoAnalysis)
              }
              return !a.videoAnalysis
            })
          : []

        return (
          <section key={sect.id}>
            <header className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-sf-text-primary">{sect.label}</h3>
              <span className="text-[10px] text-sf-text-muted">
                {items.length} file{items.length === 1 ? '' : 's'}
                {cards.length !== items.length && ` · ${cards.length} shot${cards.length === 1 ? '' : 's'}`}
              </span>
              {assetsWithUnanalysed.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    for (const a of assetsWithUnanalysed) {
                      if (Array.isArray(a.scenes) && a.scenes.length > 0) {
                        handleAnalyzeAllInAsset(a)
                      } else if (!a.videoAnalysis) {
                        handleAnalyzeAsset(a)
                      }
                    }
                  }}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-sf-accent/40 bg-sf-accent/10 text-sf-accent hover:bg-sf-accent/20"
                  title="Run Gemini analysis on every shot still missing one"
                >
                  <Sparkles className="w-3 h-3" />
                  Analyze remaining
                </button>
              )}
            </header>
            <div className={`grid gap-3 ${sect.kind === 'audio' ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4'}`}>
              {cards.map((card) => {
                // Resolve analyze wiring: scene cards talk to scene
                // entries; non-scene extraFootage cards (loose shots,
                // no scene split) analyse the whole asset.
                const isExtraFootage = sect.id === 'extraFootage'
                const stateKey = card.scene?.id || card.parent.id
                const onAnalyze = card.scene
                  ? () => handleAnalyzeScene(card.parent, card.scene)
                  : (isExtraFootage ? () => handleAnalyzeAsset(card.parent) : null)
                return (
                  <AdditionalAssetCard
                    key={card.key}
                    asset={card.parent}
                    scene={card.scene}
                    sceneIndex={card.sceneIndex}
                    kind={card.kind}
                    onDelete={() => handleDelete(sect.id, card.parent)}
                    onAnalyze={onAnalyze}
                    analyzing={Boolean(analyzeState[stateKey]?.running)}
                    analyzeError={analyzeState[stateKey]?.error}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function AdditionalAssetCard({ asset, scene, sceneIndex, kind, onDelete, onAnalyze, analyzing, analyzeError }) {
  const videoRef = useRef(null)
  const [hovering, setHovering] = useState(false)
  const url = asset.path ? `comfystudio://${encodeURIComponent(asset.path)}` : null
  const thumbUrl = scene?.thumbnail
    ? `comfystudio://${encodeURIComponent(scene.thumbnail)}?v=${asset.importedAt || ''}`
    : null
  const isScene = Boolean(scene)

  // Hover-to-play behaviour for scene cards: seek into the scene's
  // window and pause at scene end. The same handler also drives the
  // single-clip case when there's no scene split.
  useEffect(() => {
    const v = videoRef.current
    if (!v || kind !== 'video') return
    if (hovering) {
      try { v.currentTime = isScene ? Math.max(0, scene.tcIn) : 0 } catch (_) { /* noop */ }
      v.play().catch(() => { /* autoplay may reject */ })
    } else {
      v.pause()
      try { v.currentTime = isScene ? Math.max(0, scene.tcIn) : 0 } catch (_) { /* noop */ }
    }
  }, [hovering, isScene, scene, kind])

  // Stop playback when the cursor leaves OR the playhead crosses tcOut.
  useEffect(() => {
    if (!isScene || !hovering) return
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      if (v.currentTime >= scene.tcOut) {
        try { v.currentTime = scene.tcIn } catch (_) { /* noop */ }
        v.play().catch(() => { /* noop */ })
      }
    }
    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [hovering, isScene, scene])

  const detection = !isScene && asset.detectionStatus
  const detectionRunning = detection === 'running'
  const detectionFailed = detection === 'failed'

  const aspectStyle = asset.width && asset.height
    ? { aspectRatio: `${asset.width} / ${asset.height}` }
    : { aspectRatio: kind === 'image' ? '4 / 3' : '16 / 9' }

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 overflow-hidden flex flex-col">
      {kind === 'video' && url && (
        <div
          className="relative bg-black"
          style={aspectStyle}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <video
            ref={videoRef}
            src={url}
            poster={thumbUrl || undefined}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
          />
          {isScene && (
            <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-sf-text-secondary">
              shot {String(sceneIndex).padStart(2, '0')}
            </div>
          )}
          {detectionRunning && (
            <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-[11px] text-sf-accent">
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              Detecting shots…
            </div>
          )}
        </div>
      )}
      {kind === 'image' && url && (
        <img
          src={url}
          alt={asset.name}
          className="w-full h-auto bg-sf-dark-950"
          style={aspectStyle}
        />
      )}
      {kind === 'audio' && url && (
        <div className="p-3 bg-sf-dark-950">
          <audio src={url} controls preload="metadata" className="w-full h-8" />
        </div>
      )}
      <div className="p-2 flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-sf-text-primary truncate" title={asset.path}>
            {isScene
              ? `${asset.name} · shot ${sceneIndex}`
              : asset.name}
          </div>
          <div className="text-[10px] text-sf-text-muted">
            {isScene
              ? `${scene.duration.toFixed(1)}s · ${scene.tcIn.toFixed(1)}–${scene.tcOut.toFixed(1)}s`
              : (
                <>
                  {asset.duration ? `${asset.duration.toFixed(1)}s` : ''}
                  {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
                  {asset.fps ? ` · ${asset.fps.toFixed?.(1) ?? asset.fps} fps` : ''}
                </>
              )}
            {detectionFailed && (
              <span className="ml-1 text-amber-300" title={asset.detectionError || ''}>· detection failed</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.electronAPI?.showItemInFolder?.(asset.path)}
          className="p-1 rounded text-sf-text-muted hover:text-sf-accent"
          title="Reveal in file manager"
        >
          <ExternalLink className="w-3 h-3" />
        </button>
        {/* Delete only appears on the non-scene card so the user can't
            accidentally remove the whole imported file by clicking on
            a single detected shot. */}
        {!isScene && (
          <button
            type="button"
            onClick={onDelete}
            className="p-1 rounded text-sf-text-muted hover:text-red-300"
            title="Remove from project"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Analysis state row. Renders for scene cards AND for
          single-clip extra-footage cards (loose shots have no scene
          split — we analyse the whole asset). One of three states:
          unanalyzed → "Analyze" button; running → spinner;
          analyzed → caption snippet + a tiny re-analyze button. */}
      {(() => {
        const analysed = scene ? scene.videoAnalysis : (kind === 'video' ? asset.videoAnalysis : null)
        const caption = scene ? scene.caption : (kind === 'video' ? asset.caption : null)
        // Show the panel only when there's an onAnalyze handler — the
        // parent decides which card kinds get the Analyze affordance.
        if (!onAnalyze && !analysed) return null
        return (
          <div className="px-2 pb-2">
            {analysed ? (
              <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-300 shrink-0" />
                  <span className="text-[10px] uppercase tracking-wider text-emerald-300/90 font-medium">Analysed</span>
                  {onAnalyze && (
                    <button
                      type="button"
                      onClick={onAnalyze}
                      disabled={analyzing}
                      className="ml-auto p-0.5 rounded text-emerald-300/70 hover:text-emerald-200 disabled:opacity-50"
                      title="Re-analyze (overwrites current caption)"
                    >
                      {analyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                    </button>
                  )}
                </div>
                {caption && (
                  <div className="text-[10px] leading-snug text-sf-text-secondary line-clamp-3" title={caption}>
                    {caption}
                  </div>
                )}
              </div>
            ) : analyzing ? (
              <div className="rounded border border-sf-accent/30 bg-sf-accent/5 px-2 py-1.5 flex items-center gap-1.5 text-[11px] text-sf-accent">
                <Loader2 className="w-3 h-3 animate-spin" />
                Analysing with Gemini…
              </div>
            ) : (
              <button
                type="button"
                onClick={onAnalyze}
                disabled={!onAnalyze}
                className="w-full inline-flex items-center justify-center gap-1 px-2 py-1 rounded border border-sf-dark-700 bg-sf-dark-950 hover:border-sf-accent/40 hover:bg-sf-accent/5 text-[11px] text-sf-text-secondary hover:text-sf-text-primary"
                title="Send this shot to Gemini for caption + cinematography read"
              >
                <Sparkles className="w-3 h-3" />
                Analyze
              </button>
            )}
            {analyzeError && (
              <div className="mt-1 flex items-start gap-1 text-[10px] text-amber-300 leading-snug">
                <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{analyzeError}</span>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

export default AnalysisView
