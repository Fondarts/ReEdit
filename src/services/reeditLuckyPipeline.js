/**
 * project:re-edit — Lucky pipeline orchestrator.
 *
 * The "I feel Lucky" UI mode bypasses the per-tab guided flow and runs
 * the whole pipeline (Caption → Stems → Optimize → Propose) in one go.
 * This service is the orchestrator: it sequences the same handlers the
 * Simple/Advanced views call per-step, persists partial state after each
 * stage so the user keeps work-in-progress if anything fails, and emits
 * progress events for the UI to render a step list.
 *
 * Failure handling: stops on the first hard error. The progress callback
 * is told what failed; the calling component is expected to surface it.
 * Per-scene optimize failures inside step 3 are logged but NOT fatal —
 * the proposal step still runs with whatever scenes we managed to clean
 * up. Detect / caption / propose failures are all fatal, because they
 * gate the next step on their output.
 *
 * Reusable surface: callers pass a `signal` ({ aborted: bool }) they can
 * flip to cancel between stages. We check it after every stage and before
 * every per-scene iteration.
 */

import useProjectStore from '../stores/projectStore'
import { captionScenes, pickVisionModelId, analyzeOverallAd } from './reeditCaptioner'
import { generateProposal } from './reeditProposer'
import { applyEdlToTimeline } from './reeditEdlToTimeline'
import { getActiveComfyIpcContext } from './localComfyConnection'

// Step ids the UI uses to render the progress list. Kept here so the
// orchestrator + the UI agree on the shape without an extra import dance.
// Order matters — the UI renders done/active/pending purely by index, so
// the orchestrator's emits must walk this array in sequence.
export const LUCKY_STEPS = [
  { id: 'detect',  label: 'Detect scenes' },
  { id: 'thumbs',  label: 'Extract thumbnails' },
  // 'analyze' = caption-every-shot + overall-ad-concept fused into one
  // step. Two LLM calls but the user thinks of it as a single "AI reads
  // your ad" beat, so we collapse them in the UI.
  { id: 'analyze', label: 'Analyzing' },
  { id: 'audio',   label: 'Optimizing audio' },
  { id: 'video',   label: 'Optimizing video' },
  { id: 'propose', label: 'Generate Sundogs proposal' },
]

// Tiny helper: throw if the abort flag has been flipped between stages.
// Callers see a regular Error and the UI shows "Cancelled" without an
// extra "did the user cancel?" boolean threading through every layer.
function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error('Cancelled by user.')
    err.aborted = true
    throw err
  }
}

// Tell if a scene's analyzer output reported any text/logo/overlay worth
// running VACE on. Mirrors the same conservative whitelist Simple uses in
// the UI — if the model emitted `none` or omitted the field we skip,
// otherwise we send it to optimize.
//
// End-card shots are excluded entirely: the graphic IS the shot in an
// end-card, so "removing" it would leave nothing. End-cards stay
// verbatim in the final cut.
function sceneHasOverlays(scene) {
  if (scene?.videoAnalysis?.is_end_card) return false
  const g = scene?.videoAnalysis?.graphics ?? scene?.structured?.graphics
  if (!g) return false
  if (typeof g === 'string') {
    const s = g.trim().toLowerCase()
    return s && s !== 'none'
  }
  const hasText  = g.text_content     && g.text_content     !== 'none'
  const hasLogo  = g.logo_description && g.logo_description !== 'none'
  const hasOther = g.other_graphics   && g.other_graphics   !== 'none'
  return Boolean(hasText || hasLogo || hasOther)
}

// Persist a partial project update via the store. Reused enough times
// that hand-rolling each call would clutter the orchestrator.
async function persist(updates) {
  const { saveProject } = useProjectStore.getState()
  await saveProject(updates)
}

// Read the current project fresh out of the store. We do this between
// stages because each stage mutates `analysis` / `sourceVideo` / etc. and
// stale closure copies would silently overwrite a later stage's work.
function readProject() {
  return useProjectStore.getState().currentProject
}

/**
 * Run the whole Lucky pipeline.
 *
 * @param {object} opts
 * @param {(step: string, extra?: object) => void} opts.onProgress
 *   Fired with `step` from LUCKY_STEPS plus optional `{ current, total, message }`.
 *   The same `step` may fire multiple times during a stage (e.g. per-scene
 *   progress for caption / optimize).
 * @param {{ aborted: boolean }} [opts.signal] Cooperative cancel flag.
 * @param {object} [opts.extra] Extra knobs:
 *   - targetDurationSec: re-edit length goal (default = source duration)
 *   - extraInstructions: free-form steering for the proposer
 *
 * @returns {Promise<{proposal: object, optimizedSceneCount: number}>}
 *   The persisted project's proposal + how many scenes were sent to VACE.
 *   The proposal itself is also written into `project.proposal` so the
 *   Proposal tab picks it up without further plumbing.
 */
/**
 * @param {object} opts
 * @param {object} [opts.caps] Per-run capability flags from the Auto
 *   tab's "Allow:" checkboxes. Shape:
 *     { optimize: bool, reframe: bool, generate: bool, color: bool }
 *   - `optimize`: when false, the "Optimizing video" step is skipped
 *     entirely (no VACE pass on shots with overlays).
 *   - `reframe` / `generate` / `color`: forwarded into the proposer's
 *     `capabilities` object so the LLM is allowed (or not) to emit
 *     REFRAME / placeholder / COLOR directives.
 *   Falls back to "everything on" so an old caller that doesn't pass
 *   caps keeps the previous behaviour.
 */
export async function runLuckyPipeline({ onProgress, signal, extra = {}, caps } = {}) {
  // Normalise + default caps. The renderer-side flag is the source of
  // truth; we never look at the persisted `project.capabilities` here
  // because the user explicitly tick-boxed these RIGHT NOW.
  const effectiveCaps = {
    optimize: caps?.optimize !== false,    // default true (back-compat)
    reframe: Boolean(caps?.reframe),
    generate: Boolean(caps?.generate),
    color: Boolean(caps?.color),
  }
  const emit = (step, payload) => {
    try { onProgress?.(step, payload || {}) } catch (_) { /* never let UI bugs kill the pipeline */ }
  }

  let project = readProject()
  if (!project) throw new Error('No project open.')
  const sourceVideo = project.sourceVideo
  // The on-disk path lives on the store, not inside the project object —
  // mirror the pattern the Simple views use (`currentProjectHandle` is a
  // string in Electron, a FileSystemDirectoryHandle on the web).
  const handle = useProjectStore.getState().currentProjectHandle
  const projectDir = typeof handle === 'string' ? handle : null
  if (!sourceVideo?.path) throw new Error('Import a main video first.')
  if (!projectDir) {
    throw new Error('Project has no on-disk handle — save the project first.')
  }
  if (!project.sundogsReport) {
    throw new Error('Auto mode needs a Sundogs PDF report. Upload it in the Import tab before pressing Go.')
  }

  const projectDirFwd = projectDir.replace(/\\/g, '/')

  // ─── 1. Detect scenes (skip if we already have a shot log persisted)
  let scenes = project.analysis?.scenes || []
  if (scenes.length === 0) {
    emit('detect', { message: 'Splitting the video into shots…' })
    const res = await window.electronAPI.detectScenes(sourceVideo.path, {
      threshold: 27,
      minSceneDurSec: 0.5,
      totalDurationSec: sourceVideo.duration || null,
    })
    if (!res?.success) throw new Error(res?.error || 'Scene detection failed.')
    const detected = Array.isArray(res.scenes) ? res.scenes : []
    if (detected.length === 0) throw new Error('No scenes detected in the source video.')
    checkAbort(signal)

    // ─── 2. Thumbnails — one per scene at the visual midpoint.
    emit('thumbs', { current: 0, total: detected.length })
    const enriched = []
    for (let i = 0; i < detected.length; i++) {
      checkAbort(signal)
      const scene = detected[i]
      emit('thumbs', { current: i + 1, total: detected.length })
      const midpoint = Math.min(
        scene.tcIn + Math.min(1.0, (scene.tcOut - scene.tcIn) / 2),
        scene.tcOut - 0.05
      )
      const outputPath = `${projectDirFwd}/.reedit/scenes/${scene.id}.jpg`
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
    await persist({
      analysis: {
        status: 'done',
        createdAt: new Date().toISOString(),
        settings: { threshold: 27, minSceneDurSec: 0.5, detector: 'pyscenedetect-content' },
        scenes: enriched,
      },
    })
    scenes = enriched
  } else {
    emit('detect', { message: `Reusing ${scenes.length} previously detected shots.` })
    emit('thumbs', { message: 'Thumbnails already in place.' })
  }
  checkAbort(signal)

  // ─── 3. Analyze: caption every shot + overall ad concept.
  // Two LLM calls fused into a single UI step. We still split the work
  // internally — captions per scene first (the proposer needs them as
  // structured shot data), then one overall pass on top.
  const captionsAlreadyDone = scenes.every((s) => s?.caption || s?.videoAnalysis || s?.structured)
  if (!captionsAlreadyDone) {
    emit('analyze', { message: 'Picking vision model…' })
    const modelId = await pickVisionModelId()
    emit('analyze', { current: 0, total: scenes.length, message: `Captioning shots with ${modelId}…` })
    const { scenes: captioned } = await captionScenes(scenes, {
      modelId,
      signal,
      sourceVideoPath: sourceVideo.path,
      projectDir,
      onProgress: (p) => emit('analyze', {
        current: p?.current || 0,
        total: p?.total || scenes.length,
        message: `Captioning shots with ${modelId}…`,
      }),
    })
    scenes = captioned
    await persist({
      analysis: {
        ...(readProject()?.analysis || {}),
        scenes,
        captionedAt: new Date().toISOString(),
        captionModel: modelId,
      },
    })
  } else {
    emit('analyze', { message: 'Captions already in place — reusing.' })
  }
  checkAbort(signal)

  // Overall ad concept on top of the captioned scenes. Same UI step.
  let overall = project.analysis?.overall || readProject()?.analysis?.overall || null
  if (!overall) {
    emit('analyze', { message: 'Reading overall ad concept…' })
    overall = await analyzeOverallAd(scenes, { sourceVideoPath: sourceVideo.path })
    await persist({
      analysis: { ...(readProject()?.analysis || {}), overall },
    })
  } else {
    emit('analyze', { message: 'Ad concept already in place.' })
  }
  checkAbort(signal)

  // ─── 5. Stems (Demucs). The Simple Import view kicks this off in the
  // background when a video is first imported, so we usually arrive here
  // with `sourceVideo.stems` already populated. We run it on demand only
  // if the previous run hasn't finished yet.
  const liveSourceVideo = readProject()?.sourceVideo
  const needStems = !liveSourceVideo?.stems?.vocalsPath || !liveSourceVideo?.stems?.musicPath
  if (needStems && window?.electronAPI?.separateStems) {
    emit('audio', { message: 'Separating voiceover from music…' })
    const stemRes = await window.electronAPI.separateStems({
      sourceVideoPath: sourceVideo.path,
      projectDir,
    })
    if (stemRes?.success) {
      const sv = readProject()?.sourceVideo
      if (sv && sv.path === sourceVideo.path) {
        await persist({
          sourceVideo: {
            ...sv,
            stems: {
              vocalsPath: stemRes.vocalsPath,
              musicPath: stemRes.musicPath,
              model: stemRes.model,
              generatedAt: new Date().toISOString(),
            },
          },
        })
      }
    } else {
      // Stems failure is non-fatal — proposer can still run without them
      // (the voiceover will just be the mixed source audio). Surface it
      // through the progress callback so the user can see what happened.
      emit('audio', { message: `Stem separation skipped (${stemRes?.error || 'unknown error'}).` })
    }
  } else {
    emit('audio', { message: 'Stems already separated.' })
  }
  checkAbort(signal)

  // ─── 6. Optimize footage on scenes that the caption step flagged with
  // overlays. We loop here in the renderer (the IPC is per-scene). Each
  // call mutates `project.scenes[i].optimizations[]`, so we re-read the
  // scenes after each iteration to keep our local copy in sync.
  // Skip entirely when the user un-ticked "Optimize footage" in the
  // Auto tab's Allow: row.
  const optimizeTargets = effectiveCaps.optimize
    ? scenes.filter((s) => sceneHasOverlays(s)).map((s) => s.id)
    : []
  let optimizedCount = 0
  if (!effectiveCaps.optimize) {
    emit('video', { message: 'Skipped — Optimize footage was un-ticked in Allow:.' })
  }
  if (optimizeTargets.length > 0) {
    emit('video',{ current: 0, total: optimizeTargets.length, message: `${optimizeTargets.length} shots need overlay cleanup.` })
    for (let i = 0; i < optimizeTargets.length; i++) {
      checkAbort(signal)
      const sceneId = optimizeTargets[i]
      const liveScene = (readProject()?.analysis?.scenes || []).find((s) => s.id === sceneId)
      if (!liveScene) continue
      emit('video',{ current: i + 1, total: optimizeTargets.length, message: `Cleaning shot ${sceneId}…` })
      try {
        const res = await window.electronAPI.optimizeFootage({
          scene: liveScene,
          projectDir,
          ...getActiveComfyIpcContext(),
        })
        if (res?.success) {
          optimizedCount += 1
          // Persist the new optimization version onto the scene. The IPC
          // returns a `version` + `outputPath`; we store the whole thing
          // so the Proposal step and the Optimization tab agree on the
          // active take.
          const updatedScenes = (readProject()?.analysis?.scenes || []).map((s) => {
            if (s.id !== sceneId) return s
            const prevOpts = Array.isArray(s.optimizations) ? s.optimizations : []
            // Field names matter — the rest of the codebase
            // (resolveActiveClipPath, EDL applier, hover preview) reads
            // `entry.path` and `scene.activeOptimizationVersion`. The
            // earlier `outputPath` / `activeOptimization` shape was
            // silently ignored, which is why optimized scenes kept
            // showing the original (graphic-bearing) clip downstream.
            return {
              ...s,
              optimizations: [
                ...prevOpts,
                {
                  version: res.version,
                  path: res.outputPath,
                  model: res.modelId || null,
                  createdAt: new Date().toISOString(),
                  workflowJsonPath: res.workflowJsonPath || null,
                },
              ],
              activeOptimizationVersion: res.version,
            }
          })
          await persist({ analysis: { ...(readProject()?.analysis || {}), scenes: updatedScenes } })
        } else {
          emit('video',{ current: i + 1, total: optimizeTargets.length, message: `Skipped ${sceneId}: ${res?.error || 'optimize failed'}` })
        }
      } catch (err) {
        // Per-scene VACE failures are not fatal for the whole run — we
        // log and continue. The proposer is happy with the source clip
        // for scenes that didn't optimize.
        emit('video',{ current: i + 1, total: optimizeTargets.length, message: `Skipped ${sceneId}: ${err?.message || 'optimize failed'}` })
      }
    }
  } else {
    emit('video',{ message: 'No shots flagged as needing overlay cleanup.' })
  }
  checkAbort(signal)

  // ─── 7. Generate Sundogs-graded proposal. Lucky mode is opinionated
  // about the metric here (we required the PDF on the Go button) so we
  // hardcode `metric: 'Sundogs'` and feed the parsed report.
  emit('propose', { message: 'Asking Gemini for the re-edit plan…' })
  const liveProject = readProject()
  const finalScenes = liveProject?.analysis?.scenes || scenes
  const proposal = await generateProposal({
    scenes: finalScenes,
    brandBrief: liveProject?.brandBrief || '',
    extraInstructions: extra.extraInstructions || '',
    metric: 'Sundogs',
    modelId: undefined,
    totalDurationSec: sourceVideo.duration || null,
    targetDurationSec: Number.isFinite(extra.targetDurationSec)
      ? extra.targetDurationSec
      : (sourceVideo.duration || null),
    criteria: undefined,
    // Map Auto's Allow: ticks onto the proposer's capability schema.
    // Audio stems stay on by default (Auto always wants the original
    // VO + music available); AI VO/music generation is force-OFF —
    // Auto explicitly does not synthesise new audio.
    capabilities: {
      ...(liveProject?.capabilities || {}),
      footageReframe: effectiveCaps.reframe,
      footageGeneration: effectiveCaps.generate,
      colorCorrection: effectiveCaps.color,
      useOriginalVoiceover: true,
      useOriginalMusic: true,
      useAdditionalAssets: true,
      // Hard-disable AI audio generation in Auto. The user can flip
      // these on from the Proposal tab if they ever want them; the
      // unattended Auto flow never spins up F5-TTS / ACE-Step.
      generateVoiceover: false,
      generateMusic: false,
    },
    sourceVideoPath: sourceVideo.path,
    adConcept: liveProject?.analysis?.overall || overall,
    voSegments: liveProject?.voSegments || {},
    voPlanOverride: null,
    generatedVoiceover: null,
    generatedMusic: null,
    additionalAssets: liveProject?.additionalAssets || {},
    sundogsReport: liveProject?.sundogsReport,
    // Forward the user's strict-duration preference. The caller
    // (ImportLuckyView) reads the same localStorage key the Simple /
    // Advanced views use, so the toggle is consistent across all 3
    // surfaces.
    strictDuration: Boolean(extra.strictDuration),
  })
  await persist({ proposal })

  // Auto-apply the EDL to the timeline so the Review tab (the next
  // surface the user sees) can render its preview immediately. Failing
  // to apply isn't fatal — the user can still manually Apply from the
  // Proposal tab; we surface the error in the run UI.
  try {
    const liveAfter = readProject()
    // Re-read `sourceVideo` from the live project — the Demucs step
    // above persists `sourceVideo.stems = { vocalsPath, musicPath }`
    // INTO the project, but the local `sourceVideo` const captured at
    // the top of this function is the pre-Demucs snapshot. Passing the
    // stale closure makes the EDL applier see `sourceVideo.stems ===
    // undefined` and silently skip both the VO + music tracks (the
    // music/vo branches in reeditEdlToTimeline.js gate on `stems`).
    const liveSourceVideo = liveAfter?.sourceVideo || sourceVideo
    await applyEdlToTimeline({
      edl: proposal.edl,
      scenes: liveAfter?.analysis?.scenes || finalScenes,
      sourceVideo: liveSourceVideo,
      useGeneratedVideos: false,
      capabilities: {
        ...(liveAfter?.capabilities || {}),
        footageReframe: effectiveCaps.reframe,
        footageGeneration: effectiveCaps.generate,
        colorCorrection: effectiveCaps.color,
        useOriginalVoiceover: true,
        useOriginalMusic: true,
        useAdditionalAssets: true,
        generateVoiceover: false,
        generateMusic: false,
      },
      voiceoverSegments: liveAfter?.analysis?.overall?.voiceover_segments || null,
      voiceoverPlan: null,
      generatedVoiceover: null,
      generatedMusic: null,
      additionalAssets: liveAfter?.additionalAssets || {},
      fills: liveAfter?.fills || null,
    })
  } catch (err) {
    // Surfaced through the progress callback rather than thrown — the
    // proposal itself was generated successfully, so the user can fix
    // the apply error from the Proposal tab without losing work.
    emit('propose', { message: `Proposal ready but auto-apply to timeline failed: ${err?.message || 'unknown error'}. Open Proposal to retry.` })
  }

  return { proposal, optimizedSceneCount: optimizedCount }
}
