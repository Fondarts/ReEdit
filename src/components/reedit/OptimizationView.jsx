/**
 * project:re-edit — Optimization tab.
 *
 * Two sections:
 *   1. **Video** — per-scene controls for the "remove on-screen graphics"
 *      pass (Wan VACE inpainting). Reuses <OptimizeFootageCell> from
 *      AnalysisView's old per-row column. Each scene with detected
 *      graphics gets its own optimize button + version dropdown; ran
 *      jobs persist on `scene.optimizations[]` so the dropdown survives
 *      reloads.
 *   2. **Audio** — original transcript display + the two voiceover
 *      capability toggles (mutually exclusive: use original VO stem OR
 *      generate a new one). Contains the original-VO segment picker
 *      (timing edits, lead pads, VAD snap) and the new VO drafts panel
 *      (Gemini script + F5-TTS synth).
 *
 * Persistence stays where it lived: scene optimizations on
 * `analysis.scenes[i].optimizations`, original-VO plan on
 * `proposal.voiceoverPlan`, generated-VO drafts on
 * `voiceoverDrafts.{drafts,selectedId}`. This view is purely a UI
 * relocation — the data flow into the proposer / timeline placer is
 * unchanged.
 */

import { useEffect, useRef, useState } from 'react'
import { Wand2, AudioLines, Volume2, Film, Music } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import {
  loadCapabilities as loadProposalCapabilities,
  saveCapabilities as saveProposalCapabilities,
  CAPABILITY_DEFINITIONS,
} from '../../services/reeditProposalCapabilities'
import { resolveActiveClipPath } from '../../services/reeditVideoAnalyzer'
import OptimizeFootageCell, { shotHasGraphics } from './OptimizeFootageCell'
import { OriginalVoiceoverPanel, GenerateVoiceoverPanel } from './VoiceoverPanels'
import MusicPanel from './MusicPanel'

// Build a comfystudio:// URL for the renderer. Same shape as
// AnalysisView's helper. `version` cache-busts so re-running optimize
// doesn't serve the previous run's bytes.
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
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function PrereqPrompt({ children }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-6 py-8 max-w-md text-center">
        <p className="text-sm text-sf-text-secondary leading-relaxed">{children}</p>
      </div>
    </div>
  )
}

export default function OptimizationView({ onNavigate }) {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectHandle = useProjectStore((s) => s.currentProjectHandle)
  const saveProject = useProjectStore((s) => s.saveProject)

  const sourceVideo = currentProject?.sourceVideo
  const analysis = currentProject?.analysis
  const projectDir = typeof currentProjectHandle === 'string' ? currentProjectHandle : null

  // Capability flags — same global localStorage as ProposalView. We
  // surface the audio toggles here since the audio-related decisions
  // (use original / generate new) live in this view now.
  const [capabilities, setCapabilities] = useState(() => loadProposalCapabilities())
  useEffect(() => {
    const onChange = (e) => setCapabilities(e.detail || loadProposalCapabilities())
    window.addEventListener('reedit-proposal-capabilities-changed', onChange)
    return () => window.removeEventListener('reedit-proposal-capabilities-changed', onChange)
  }, [])
  const toggleCapability = (id) => {
    const turningOn = !capabilities[id]
    const patch = { [id]: turningOn }
    if (turningOn && id === 'generateVoiceover') patch.useOriginalVoiceover = false
    if (turningOn && id === 'useOriginalVoiceover') patch.generateVoiceover = false
    if (turningOn && id === 'generateMusic') patch.useOriginalMusic = false
    if (turningOn && id === 'useOriginalMusic') patch.generateMusic = false
    const next = saveProposalCapabilities(patch)
    setCapabilities(next)
  }

  // Per-scene VACE optimize state — { [sceneId]: { stage, error, elapsedSec, ... } }
  const [optimizeState, setOptimizeState] = useState({})
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

  // Mask-only preview state — { [sceneId]: { stage: 'running'|'done'|'error', maskPath?, error? } }
  const [previewState, setPreviewState] = useState({})

  const runOptimizeFootage = async (scene) => {
    if (!projectDir) return
    const current = optimizeState[scene.id]
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
      // Persist into the optimization stack so the dropdown survives
      // reloads and the rest of the pipeline picks up the new active
      // version on hover / re-caption / Apply.
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

  const setSceneActiveVersion = async (sceneId, version) => {
    const nextScenes = (analysis?.scenes || []).map((s) => {
      if (s.id !== sceneId) return s
      return { ...s, activeOptimizationVersion: version || null }
    })
    await saveProject({
      analysis: { ...(analysis || {}), scenes: nextScenes },
    })
  }

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
      try { await window.electronAPI.showItemInFolder?.(res.maskPath) } catch (_) { /* ignore */ }
    } catch (err) {
      setPreviewState((prev) => ({ ...prev, [scene.id]: { stage: 'error', error: err?.message || String(err) } }))
    }
  }

  // Voiceover plan (capability `useOriginalVoiceover`) — persisted on
  // `proposal.voiceoverPlan` as before. We mirror it in component state
  // for snappy UI; saveProject is called on every change.
  const savedProposal = currentProject?.proposal || null
  const [voPlan, setVoPlan] = useState(() => ({
    autoEdit: savedProposal?.voiceoverPlan?.autoEdit !== false,
    segmentIds: Array.isArray(savedProposal?.voiceoverPlan?.segmentIds)
      ? savedProposal.voiceoverPlan.segmentIds
      : null,
    segmentEdits: savedProposal?.voiceoverPlan?.segmentEdits || {},
    segmentGaps: savedProposal?.voiceoverPlan?.segmentGaps || {},
    leadInSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadInSec)
      ? savedProposal.voiceoverPlan.leadInSec
      : 0.5,
    leadOutSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadOutSec)
      ? savedProposal.voiceoverPlan.leadOutSec
      : 0.3,
  }))

  // Project identity changes (open another project or import a new
  // source video) → resync local state from the freshly loaded data.
  const projectIdentity = (currentProject?.sourceVideo?.path || '') + '|' + (savedProposal?.createdAt || '')
  useEffect(() => {
    setVoPlan({
      autoEdit: savedProposal?.voiceoverPlan?.autoEdit !== false,
      segmentIds: Array.isArray(savedProposal?.voiceoverPlan?.segmentIds)
        ? savedProposal.voiceoverPlan.segmentIds
        : null,
      segmentEdits: savedProposal?.voiceoverPlan?.segmentEdits || {},
      segmentGaps: savedProposal?.voiceoverPlan?.segmentGaps || {},
      leadInSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadInSec)
        ? savedProposal.voiceoverPlan.leadInSec
        : 0.5,
      leadOutSec: Number.isFinite(savedProposal?.voiceoverPlan?.leadOutSec)
        ? savedProposal.voiceoverPlan.leadOutSec
        : 0.3,
    })
    setVoiceoverDrafts(Array.isArray(currentProject?.voiceoverDrafts?.drafts)
      ? currentProject.voiceoverDrafts.drafts
      : [])
    setSelectedVoiceoverDraftId(currentProject?.voiceoverDrafts?.selectedId || null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectIdentity])

  // Persist the voPlan on every change. We piggy-back on the existing
  // proposal field — no schema migration needed, the proposal apply
  // path keeps reading from the same place.
  const handleChangeVoPlan = (next) => {
    setVoPlan(next)
    saveProject({
      proposal: { ...(savedProposal || {}), voiceoverPlan: next },
    })
  }

  // Generated VO drafts — same persistence path as before
  // (`voiceoverDrafts.{drafts,selectedId}` on the project root).
  const [voiceoverDrafts, setVoiceoverDrafts] = useState(() => Array.isArray(currentProject?.voiceoverDrafts?.drafts)
    ? currentProject.voiceoverDrafts.drafts
    : [])
  const [selectedVoiceoverDraftId, setSelectedVoiceoverDraftId] = useState(() => currentProject?.voiceoverDrafts?.selectedId || null)
  const persistVoiceoverDrafts = (nextDrafts, nextSelectedId) => {
    setVoiceoverDrafts(nextDrafts)
    saveProject({
      voiceoverDrafts: {
        drafts: nextDrafts,
        selectedId: nextSelectedId !== undefined ? nextSelectedId : selectedVoiceoverDraftId,
      },
    })
  }
  const persistSelectedVoiceoverDraftId = (id) => {
    setSelectedVoiceoverDraftId(id)
    saveProject({
      voiceoverDrafts: { drafts: voiceoverDrafts, selectedId: id },
    })
  }

  // Target duration for the script writer prompt. Pulled from the
  // saved proposal so an existing project's choice carries over; falls
  // back to source duration so a fresh project still has a budget the
  // writer can use.
  const targetDurationSec = savedProposal?.targetDurationSec
    || sourceVideo?.duration
    || 30

  // Active sub-tab (Video / Audio) inside the Optimization workspace.
  // Local state — survives tab-flicker because OptimizationView itself
  // is mounted with display:none.
  const [section, setSection] = useState('video')

  if (!sourceVideo) {
    return (
      <PrereqPrompt>
        Import a video first. Go to the <button type="button" onClick={() => onNavigate?.('import')} className="text-sf-accent hover:underline">Import</button> tab.
      </PrereqPrompt>
    )
  }
  if (!analysis || !Array.isArray(analysis.scenes) || analysis.scenes.length === 0) {
    return (
      <PrereqPrompt>
        Run scene detection + analysis first. Go to the <button type="button" onClick={() => onNavigate?.('analysis')} className="text-sf-accent hover:underline">Analysis</button> tab and run the pipeline so the optimizer has shots and a transcript to work with.
      </PrereqPrompt>
    )
  }

  const aspectRatio = (sourceVideo.width && sourceVideo.height)
    ? sourceVideo.width / sourceVideo.height
    : 16 / 9
  const scenes = analysis.scenes

  const optimizableScenes = scenes.filter((s) => !s.excluded && shotHasGraphics(s))
  const totalScenes = scenes.filter((s) => !s.excluded).length

  const overall = analysis?.overall || null
  const voSegments = Array.isArray(overall?.voiceover_segments) ? overall.voiceover_segments : []
  const fullTranscript = voSegments.map((s) => s?.text).filter(Boolean).join(' ')

  // VO mode collapses the two mutually-exclusive capability flags into
  // a single dropdown value: 'none' / 'original' / 'generate'.
  const voMode = capabilities.generateVoiceover
    ? 'generate'
    : capabilities.useOriginalVoiceover
      ? 'original'
      : 'none'
  const setVoMode = (mode) => {
    const next = saveProposalCapabilities({
      useOriginalVoiceover: mode === 'original',
      generateVoiceover: mode === 'generate',
    })
    setCapabilities(next)
  }
  const voModeBlurb = ({
    none: 'Audio track will be silent for VO. Music will still play.',
    original: 'Reuse the isolated VO stem from the source ad. Pick segments and tweak timing below.',
    generate: 'Have Gemini draft a fresh script and synthesise it via ComfyUI cloning the source speaker.',
  })[voMode]

  // Music mode mirrors the VO triplet — same UX pattern.
  const musicMode = capabilities.generateMusic
    ? 'generate'
    : capabilities.useOriginalMusic
      ? 'original'
      : 'none'
  const setMusicMode = (mode) => {
    const next = saveProposalCapabilities({
      useOriginalMusic: mode === 'original',
      generateMusic: mode === 'generate',
    })
    setCapabilities(next)
  }
  const musicModeBlurb = ({
    none: 'Music track will be silent. Use this when the visuals or VO carry the energy alone.',
    original: 'Layer the isolated music stem from the source ad on the timeline.',
    generate: 'Generate a fresh track via ComfyUI (ACE-Step 1.5) — describe genre + mood + optional lyrics.',
  })[musicMode]

  // Music drafts persist on the project under `musicDrafts.{drafts, selectedId}`.
  const musicDrafts = Array.isArray(currentProject?.musicDrafts?.drafts)
    ? currentProject.musicDrafts.drafts
    : []
  const selectedMusicDraftId = currentProject?.musicDrafts?.selectedId || null
  const persistMusicDrafts = (nextDrafts) => {
    saveProject({
      musicDrafts: { drafts: nextDrafts, selectedId: selectedMusicDraftId },
    })
  }
  const persistSelectedMusicDraftId = (id) => {
    saveProject({
      musicDrafts: { drafts: musicDrafts, selectedId: id },
    })
  }

  // Original VO stem URL — drives the play button next to the transcript.
  const stemPath = sourceVideo?.stems?.vocalsPath || null
  const stemUrl = stemPath ? `comfystudio://${encodeURIComponent(stemPath)}` : null

  return (
    <div className="flex-1 flex flex-col bg-sf-dark-950 text-sf-text-primary overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-sf-dark-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-sf-dark-800 border border-sf-dark-700 flex items-center justify-center">
            <Wand2 className="w-4 h-4 text-sf-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Optimization</h1>
            <p className="text-xs text-sf-text-muted truncate max-w-[560px]">
              Per-shot footage cleanup + voiceover decisions before drafting the proposal
            </p>
          </div>
        </div>
      </div>

      {/* Sub-tabs (Video / Audio) — pill row right below the header */}
      <div className="flex-shrink-0 flex items-center gap-1 px-6 pt-3 pb-3 border-b border-sf-dark-800">
        {[
          { id: 'video', label: 'Video', icon: Film, count: `${optimizableScenes.length}/${totalScenes}` },
          { id: 'audio', label: 'Audio', icon: AudioLines, count: voSegments.length > 0 ? `${voSegments.length} segs` : 'no transcript' },
        ].map((t) => {
          const active = section === t.id
          const Icon = t.icon
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSection(t.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors
                ${active
                  ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                  : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500 text-sf-text-muted hover:text-sf-text-primary'}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              <span className={`ml-1 text-[10px] ${active ? 'text-sf-text-secondary' : 'text-sf-text-muted/70'}`}>{t.count}</span>
            </button>
          )
        })}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {section === 'video' && (
          <section>
            <header className="mb-3 max-w-3xl">
              <h2 className="text-sm font-semibold mb-1 text-sf-text-primary">Per-shot cleanup</h2>
              <p className="text-xs text-sf-text-muted leading-relaxed">
                Wan VACE removes on-screen text, logos, and other graphics from a shot so the timeline can use a clean version downstream. Each run produces a versioned MP4 (V01, V02, …); the dropdown picks which version Apply uses for that shot. Hover any card to play the source clip.
              </p>
            </header>

            {optimizableScenes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-sf-dark-700 bg-sf-dark-900/40 px-4 py-6 text-sm text-sf-text-muted">
                No included shots have detectable graphics. If you expected some, re-run Analysis with a fresh caption pass — Gemini may have missed text or logos in low-contrast frames.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {optimizableScenes.map((scene) => (
                  <OptimizeShotCard
                    key={scene.id}
                    scene={scene}
                    aspectRatio={aspectRatio}
                    analysisVersion={analysis?.createdAt}
                    projectDir={projectDir}
                    state={optimizeState[scene.id]}
                    previewState={previewState[scene.id]}
                    onRun={() => runOptimizeFootage(scene)}
                    onPreview={() => runPreviewMask(scene)}
                    onSetActiveVersion={setSceneActiveVersion}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {section === 'audio' && (
          <section>
            {/* Original transcript with embedded play button. The
                <audio controls> element exposes play/pause/scrubber/
                volume natively — cheap and ergonomic. Hidden when no
                stem has been separated yet. */}
            <div className="mb-4 rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Volume2 className="w-3.5 h-3.5 text-sf-text-muted" />
                <span className="text-xs uppercase tracking-wider text-sf-text-muted font-medium">Original VO transcript</span>
                {stemUrl && (
                  <audio
                    src={stemUrl}
                    controls
                    preload="metadata"
                    className="ml-auto h-7 max-w-[320px]"
                    title="Listen to the isolated VO stem (Demucs output)"
                  />
                )}
              </div>
              {fullTranscript ? (
                <p className="text-[12px] leading-relaxed text-sf-text-secondary italic">
                  &ldquo;{fullTranscript}&rdquo;
                </p>
              ) : (
                <p className="text-[12px] italic text-sf-text-muted">
                  No voiceover transcript captured yet. Run <button type="button" onClick={() => onNavigate?.('analysis')} className="text-sf-accent hover:underline">Analysis → Analyze</button> so Gemini can transcribe the source ad.
                </p>
              )}
            </div>

            {/* Two-column layout: Voiceover controls + Music placeholder */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              {/* LEFT — Voiceover */}
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3">
                <div className="flex items-center gap-2 mb-3">
                  <AudioLines className="w-3.5 h-3.5 text-sf-text-muted" />
                  <span className="text-xs uppercase tracking-wider text-sf-text-muted font-medium">Voiceover</span>
                </div>
                <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">Mode</label>
                <select
                  value={voMode}
                  onChange={(e) => setVoMode(e.target.value)}
                  className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-950 px-2 py-1.5 text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  <option value="original">Use original voiceover</option>
                  <option value="generate">Generate new voiceover</option>
                  <option value="none">No voiceover</option>
                </select>
                <p className="text-[11px] text-sf-text-muted mt-1.5 mb-3 leading-relaxed">{voModeBlurb}</p>

                {voMode === 'original' && (
                  <OriginalVoiceoverPanel
                    analysis={analysis}
                    voPlan={voPlan}
                    onChangeVoPlan={handleChangeVoPlan}
                    proposerPickedIds={savedProposal?.voiceoverPlan?.segmentIds}
                    capabilities={capabilities}
                    targetDurationSec={targetDurationSec}
                    sourceVideo={sourceVideo}
                  />
                )}
                {voMode === 'generate' && (
                  <GenerateVoiceoverPanel
                    analysis={analysis}
                    drafts={voiceoverDrafts}
                    selectedId={selectedVoiceoverDraftId}
                    onChangeDrafts={(next) => persistVoiceoverDrafts(next)}
                    onChangeSelectedId={(id) => persistSelectedVoiceoverDraftId(id)}
                    targetDurationSec={targetDurationSec}
                    capabilities={capabilities}
                    sourceVideo={sourceVideo}
                    projectDir={projectDir}
                  />
                )}
              </div>

              {/* RIGHT — Music. Same dropdown UX as VO: pick a mode
                  (none / original / generate) and the matching panel
                  surfaces below. Generate uses ACE-Step 1.5 in ComfyUI. */}
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 p-3">
                <div className="flex items-center gap-2 mb-3">
                  <Music className="w-3.5 h-3.5 text-sf-text-muted" />
                  <span className="text-xs uppercase tracking-wider text-sf-text-muted font-medium">Music</span>
                </div>
                <label className="block text-[11px] font-medium text-sf-text-muted uppercase tracking-wider mb-1">Mode</label>
                <select
                  value={musicMode}
                  onChange={(e) => setMusicMode(e.target.value)}
                  className="w-full text-sm rounded border border-sf-dark-700 bg-sf-dark-950 px-2 py-1.5 text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  <option value="original">Use original music</option>
                  <option value="generate">Generate new music</option>
                  <option value="none">No music</option>
                </select>
                <p className="text-[11px] text-sf-text-muted mt-1.5 mb-3 leading-relaxed">{musicModeBlurb}</p>

                {musicMode === 'original' && (
                  <div className="rounded border border-sf-dark-700 bg-sf-dark-950 p-2">
                    {sourceVideo?.stems?.musicPath ? (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-sf-text-muted">Stem</span>
                        <audio
                          src={`comfystudio://${encodeURIComponent(sourceVideo.stems.musicPath)}`}
                          controls
                          preload="metadata"
                          className="h-7 flex-1"
                        />
                      </div>
                    ) : (
                      <p className="text-[11px] italic text-sf-text-muted">
                        Music stem not separated yet. Run Demucs in the Import tab to extract it.
                      </p>
                    )}
                  </div>
                )}
                {musicMode === 'generate' && (
                  <MusicPanel
                    drafts={musicDrafts}
                    selectedId={selectedMusicDraftId}
                    onChangeDrafts={persistMusicDrafts}
                    onChangeSelectedId={persistSelectedMusicDraftId}
                    capabilities={capabilities}
                    projectDir={projectDir}
                    defaultDurationSec={targetDurationSec}
                  />
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// Per-shot card for the Video sub-tab. Top half is the source clip in
// the project's aspect ratio — paused on a still by default; hovering
// triggers playback (muted, loop within range). Bottom half holds the
// graphics blurb + the OptimizeFootageCell controls (Optimize button +
// version dropdown + Regenerate-mask button).
function OptimizeShotCard({
  scene,
  aspectRatio,
  analysisVersion,
  projectDir,
  state,
  previewState,
  onRun,
  onPreview,
  onSetActiveVersion,
}) {
  const videoRef = useRef(null)
  const [hovering, setHovering] = useState(false)
  const [posterErr, setPosterErr] = useState(false)

  // Resolve the active clip (optimized version if any, else the cached
  // `<projectDir>/.reedit/clips/<sceneId>.mp4` stub). Without projectDir
  // we fall back to whatever path the analyzer cached on the scene.
  const activePath = projectDir
    ? resolveActiveClipPath(scene, projectDir)
    : scene.videoAnalysis?.clipPath || null
  const videoUrl = activePath
    ? toComfyUrl(activePath, scene.activeOptimizationVersion || analysisVersion || '')
    : null
  const posterUrl = scene.thumbnail ? toComfyUrl(scene.thumbnail, analysisVersion) : null

  // Hover lifecycle: load + play the inline video on enter; pause +
  // rewind on leave so the next hover starts from the head and the
  // <video> doesn't keep buffering when offscreen.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (hovering) {
      try { v.currentTime = 0 } catch (_) { /* noop on Chromium pre-load */ }
      v.play().catch(() => { /* autoplay may reject — user can still click */ })
    } else {
      v.pause()
      try { v.currentTime = 0 } catch (_) { /* noop */ }
    }
  }, [hovering])

  const g = scene.videoAnalysis?.graphics || {}
  const graphicsBlurb = [
    g.text_content && `text: "${String(g.text_content).slice(0, 80)}"`,
    g.logo_description && `logo: ${g.logo_description}`,
    g.other_graphics && `other: ${g.other_graphics}`,
  ].filter(Boolean).join(' · ') || (g.has_text_on_screen ? 'on-screen text' : g.has_logo ? 'logo' : 'graphics detected')

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 overflow-hidden flex flex-col">
      <div
        className="relative bg-black"
        style={{ aspectRatio: String(aspectRatio) }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            poster={!posterErr && posterUrl ? posterUrl : undefined}
            muted
            playsInline
            loop
            preload="metadata"
            className="w-full h-full object-cover"
            onError={() => setPosterErr(true)}
          />
        ) : posterUrl ? (
          <img src={posterUrl} alt={scene.id} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">
            no clip
          </div>
        )}
        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-mono text-sf-text-secondary">
          {scene.id} · {formatTc(scene.tcIn)}-{formatTc(scene.tcOut)}
        </div>
      </div>
      <div className="p-3 flex flex-col gap-2 flex-1">
        <p className="text-[11px] leading-relaxed text-sf-text-secondary">
          {graphicsBlurb}
        </p>
        <OptimizeFootageCell
          scene={scene}
          state={state}
          onRun={onRun}
          previewState={previewState}
          onPreview={onPreview}
          onSetActiveVersion={onSetActiveVersion}
          disabled={!projectDir}
        />
      </div>
    </div>
  )
}
