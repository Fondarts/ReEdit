/**
 * project:re-edit — Apply an approved EDL to the timeline.
 *
 * Populates the timeline with one clip per EDL row. Two rendering
 * realities shaped this module:
 *
 *   1. The shared Timeline.jsx filmstrip is `<video src={clip.url}>`
 *      for every tile, and getClipUrl() always prefers the asset's URL
 *      over the clip's stored URL. If every EDL row points at the same
 *      "full source video" asset, every filmstrip tile loads the exact
 *      same URL and shows the video's first frame — so all clips look
 *      identical regardless of their trimStart. The fix we rely on is
 *      to register a SEPARATE asset per scene, each with an HTML5
 *      Media Fragments URI (`#t=<tcIn>`) baked into its URL, which
 *      nudges the renderer's <video> element to seek to that scene's
 *      start frame on load.
 *
 *   2. ComfyStudio has no "black / color" clip primitive. Placeholder
 *      rows would otherwise leave confusing gaps. We render them as
 *      IMAGE clips backed by an inline SVG data URL with the rationale
 *      text burned in, so the timeline shows a readable "GENERATION
 *      NEEDED" card at each gap.
 *
 * Re-applying wipes any previously-registered reedit assets (they're
 * tagged in `settings.reedit*` so we can find them cheaply) so the
 * asset browser doesn't accumulate stale scene/placeholder entries
 * across iterations.
 */

import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { resolveActiveClipPath, sceneOriginalClipPath } from './reeditVideoAnalyzer'
import { loadCapabilitySettings } from './reeditCapabilitySettings'

// Translate a `row.reframe` into the clip.transform shape the timeline
// store expects. We don't touch crop* — zoom alone produces the visual
// "crop" effect when scale > 100 % and the position compensates for
// off-center anchors.
//
// Math: at scale S, a source pixel at normalised position (a, b) lives
// at canvas-coord ((a - 0.5) * S * W, (b - 0.5) * S * H) relative to
// the canvas centre (assuming the clip renders centred at position=0).
// To place that point AT the canvas centre, translate the clip by the
// negative of that offset:
//   positionX = -(a - 0.5) * S * W
//   positionY = -(b - 0.5) * S * H
// Earlier we used `(S - 1) * W` here, which under-translates by a factor
// of S / (S - 1) — at S = 1.8 the anchor only moved the viewport ~44 %
// of what it should, leaving the subject off-centre.
export function buildReframeTransform(reframe, canvasWidth, canvasHeight) {
  if (!reframe) return null
  const zoom = Math.max(1, Math.min(3, Number(reframe.zoom) || 1.2))
  const anchorX = Math.max(0, Math.min(1, Number(reframe.anchorX) ?? 0.5))
  const anchorY = Math.max(0, Math.min(1, Number(reframe.anchorY) ?? 0.5))
  const scalePct = Math.round(zoom * 100)
  const W = Number(canvasWidth) || 1920
  const H = Number(canvasHeight) || 1080
  return {
    scaleX: scalePct,
    scaleY: scalePct,
    scaleLinked: true,
    positionX: -(anchorX - 0.5) * zoom * W,
    positionY: -(anchorY - 0.5) * zoom * H,
  }
}

function toFileUrl(absolutePath) {
  let normalized = absolutePath.replace(/\\/g, '/')
  if (!normalized.startsWith('/')) normalized = '/' + normalized
  return `file://${normalized}`
}

// Encode a UTF-8 string to base64 for data URLs. `btoa()` alone rejects
// any codepoint above 0xFF, which the note field easily trips over
// (accents, quotes, em-dashes from copy/paste).
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)))
}

function escapeXml(str) {
  return String(str || '').replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ))
}

// Naive word-wrap that splits on spaces and caps at `maxChars` chars
// per line and `maxLines` lines total (with an ellipsis if truncated).
// Good enough for a 1–2 sentence note.
function wrapLines(text, maxChars = 34, maxLines = 5) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['(no description)']
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > maxChars) {
      if (cur) lines.push(cur)
      cur = w
    } else {
      cur = next
    }
    if (lines.length >= maxLines) break
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  if (words.length > lines.join(' ').split(/\s+/).length) {
    const last = lines[lines.length - 1] || ''
    lines[lines.length - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last) + '…'
  }
  return lines
}

// Build the "GENERATION NEEDED" card as an SVG data URL sized to the
// source video's aspect. The sizing rule that matters: every font size
// is scaled off `min(w, h)` instead of `h`, otherwise a 1080×1920
// vertical source ends up with title text ~2900px wide trying to fit
// into a 1080-wide canvas and everything gets sliced off on the sides.
// Wrap width for the note also tightens on vertical aspects so the
// sentence fits within the visible column.
export function buildPlaceholderSvgDataUrl({ note, index, width, height }) {
  const w = Math.max(480, width || 1920)
  const h = Math.max(270, height || 1080)
  const isVertical = h > w
  // `base` is the smaller dimension — i.e. the "narrowest" axis. Sizing
  // fonts off it gives a consistent visual size across 16:9 landscape,
  // 1:1 square, and 9:16 vertical without any branching. Horizontal
  // sources look identical to before; vertical sources stop exploding.
  const base = Math.min(w, h)

  const maxChars = isVertical ? 22 : 34
  const maxLines = isVertical ? 8 : 5
  const lines = wrapLines(note, maxChars, maxLines)

  const titleSize = Math.round(base * 0.07)
  const subtitleSize = Math.round(base * 0.032)
  const noteFontSize = Math.round(base * 0.04)
  const lineStep = Math.round(noteFontSize * 1.3)
  const topBarH = Math.max(6, Math.round(base * 0.012))

  const titleY = Math.round(h * 0.28)
  const subtitleY = Math.round(h * 0.38)
  const noteStartY = Math.round(h * 0.50)

  const tspans = lines.map((line, i) => (
    `<tspan x="50%" dy="${i === 0 ? 0 : lineStep}">${escapeXml(line)}</tspan>`
  )).join('')

  // Explicit width/height attributes — without them some renderers
  // fall back to the SVG default 300×150 intrinsic size, and <img>
  // elements that aren't force-sized via CSS (ComfyStudio's preview
  // panel uses object-fit: contain from natural size) show the
  // placeholder shrunken in the middle of a larger black viewport
  // instead of filling the clip. Matching width/height to viewBox
  // keeps the natural aspect and lets `object-fit: cover` / `contain`
  // do the right thing downstream.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <rect width="100%" height="100%" fill="#0b0b0e"/>
    <rect x="0" y="0" width="100%" height="${topBarH}" fill="#f59e0b"/>
    <text x="50%" y="${titleY}" fill="#f59e0b"
          font-family="Inter, system-ui, sans-serif" font-weight="700"
          font-size="${titleSize}" text-anchor="middle">GENERATION NEEDED</text>
    <text x="50%" y="${subtitleY}" fill="#9ca3af"
          font-family="Inter, system-ui, sans-serif"
          font-size="${subtitleSize}" text-anchor="middle">shot ${index}</text>
    <text y="${noteStartY}" fill="#e5e7eb"
          font-family="Inter, system-ui, sans-serif"
          font-size="${noteFontSize}" text-anchor="middle">${tspans}</text>
  </svg>`
  return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`
}

// Per-scene sub-asset backed by an actual extracted MP4 in
// <project>/.reedit/clips/<scene-id>.mp4. We tried referencing the
// full source with trimStart + Media Fragments URIs (#t=<tcIn>), but
// Chromium ignores the fragment for <video> elements pointing at
// `file://` URLs — the timeline filmstrip ended up showing the same
// frame for every clip of the shared source. Extracting each scene to
// its own file makes the asset URL unique per scene, so the filmstrip
// works out of the box and playback needs no trim math.
async function registerSceneAsset(sourceVideo, scene, projectDir, edlRow = null, reframeTransform = null) {
  const assetsStore = useAssetsStore.getState()
  const originalPath = sceneOriginalClipPath(projectDir, scene)
  const activePath = resolveActiveClipPath(scene, projectDir)
  const isActiveOriginal = activePath === originalPath

  // For the active-is-original case we still re-extract so the sub-clip
  // is up to date (frame-accurate + duration-validated against the
  // source). For an optimized active version, the finished MP4 already
  // exists on disk — we just verify it and point the asset at it.
  let clipPath = activePath
  if (isActiveOriginal) {
    const res = await window.electronAPI?.extractSceneClip?.({
      videoPath: sourceVideo.path,
      tcIn: Number(scene.tcIn) || 0,
      tcOut: Number(scene.tcOut) || (Number(scene.tcIn) + 0.5),
      outputPath: originalPath,
    })
    if (!res?.success) {
      throw new Error(`Could not extract ${scene.id}: ${res?.error || 'unknown error'}`)
    }
    clipPath = res.path || originalPath
  } else {
    // Optimized version — confirm the file is still there; fall back to
    // extracting the original if it was deleted externally.
    try {
      const ex = await window.electronAPI?.exists?.(activePath)
      if (!ex) {
        const res = await window.electronAPI?.extractSceneClip?.({
          videoPath: sourceVideo.path,
          tcIn: Number(scene.tcIn) || 0,
          tcOut: Number(scene.tcOut) || (Number(scene.tcIn) + 0.5),
          outputPath: originalPath,
        })
        if (!res?.success) {
          throw new Error(`Could not extract ${scene.id}: ${res?.error || 'unknown error'}`)
        }
        clipPath = res.path || originalPath
      }
    } catch (err) {
      throw new Error(`Could not verify optimized clip for ${scene.id}: ${err.message}`)
    }
  }

  const duration = Math.max(0.1, Number(scene.tcOut) - Number(scene.tcIn))
  const hasAudio = sourceVideo.hasAudio !== false
  const activeVersion = scene.activeOptimizationVersion || null
  // Only stash the reframe transform when we're on the original
  // sub-clip. R-tagged optimized versions are already physically
  // cropped on disk — adding a zoom on top would double-crop.
  const isActiveVersionReframed = activeVersion && /^R/i.test(activeVersion)
  const effectiveDefaultTransform = reframeTransform && !isActiveVersionReframed
    ? reframeTransform
    : null
  return assetsStore.addAsset({
    name: `${scene.id}${activeVersion ? ` · ${activeVersion}` : ''} · ${(sourceVideo.name || 'source').replace(/\.[^.]+$/, '')}`,
    url: toFileUrl(clipPath),
    path: clipPath,
    absolutePath: clipPath,
    type: 'video',
    duration,
    fps: sourceVideo.fps,
    width: sourceVideo.width,
    height: sourceVideo.height,
    hasAudio,
    audioEnabled: hasAudio,
    isImported: true,
    settings: {
      duration,
      fps: sourceVideo.fps,
      width: sourceVideo.width,
      height: sourceVideo.height,
      // timelineStore.addClip reads this via asset.settings.defaultTransform
      // and bakes it into the new clip.transform. Passing a transform via
      // options.defaultTransform on addClip is silently ignored.
      defaultTransform: effectiveDefaultTransform,
      reeditSceneId: scene.id,
      reeditSceneTcIn: scene.tcIn,
      reeditSceneTcOut: scene.tcOut,
      reeditActiveVersion: activeVersion,
      // Tag the asset when the proposer wanted this shot re-framed
      // AND we're currently on the original sub-clip (no committed
      // reframe yet). The InspectorPanel uses this to decide whether
      // to show the "Commit reframe" button. When the active version
      // is an R-tagged optimization, the file is already reframed on
      // disk and the button is unnecessary.
      reeditReframePending: Boolean(
        edlRow?.reframe
        && !(activeVersion && /^R/i.test(activeVersion))
      ),
      reeditReframeHint: edlRow?.reframe || null,
      // Extend hint + pending flag mirror the reframe ones. Pending is
      // true while the scene still needs a commit (not yet E-tagged
      // active); the InspectorPanel uses it to surface the Commit
      // extend button and swapSceneActiveVersion uses the hint to
      // reapply the slow-down preview when toggling back to Original.
      reeditExtendPending: Boolean(
        edlRow?.extend
        && !(activeVersion && /^E/i.test(activeVersion))
      ),
      reeditExtendHint: edlRow?.extend || null,
    },
  })
}

// Register a single first-frame candidate as an IMAGE asset. Used
// when a placeholder has frame candidates but no final video yet —
// the timeline shows the selected (or latest) frame as a still for
// the row's duration so the user can preview the composition without
// committing to an i2v pass. Tagged distinctly so cleanup wipes it
// on re-apply.
function registerFrameAsset(sourceVideo, row, candidate) {
  const assetsStore = useAssetsStore.getState()
  const declaredGap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
  const duration = Math.max(0.5, declaredGap || 1.5)
  return assetsStore.addAsset({
    name: `GEN ${row.index} (frame ${String(candidate.id || '').slice(-8)})`,
    url: toFileUrl(candidate.path),
    path: candidate.path,
    absolutePath: candidate.path,
    type: 'image',
    width: candidate.width || sourceVideo?.width,
    height: candidate.height || sourceVideo?.height,
    isImported: false,
    settings: {
      duration,
      width: candidate.width || sourceVideo?.width,
      height: candidate.height || sourceVideo?.height,
      reeditPlaceholder: true,
      reeditFrameCandidate: true,
      reeditSceneIndex: row.index,
      reeditFrameId: candidate.id,
      reeditPrompt: candidate.prompt || row.note || '',
      reeditSeed: candidate.seed,
      genSpec: {
        prompt: candidate.prompt || row.note || '',
        durationS: duration,
        seed: candidate.seed,
      },
    },
  })
}

// Register a generated MP4 (from reeditGenerate.js) as a scene-like
// video asset. Mirrors registerSceneAsset's shape but with a distinct
// tag so cleanupStaleReeditAssets sweeps both on re-apply.
function registerGeneratedAsset(sourceVideo, row, generatedPath) {
  const assetsStore = useAssetsStore.getState()
  const gen = row.genSpec || {}
  const duration = Math.max(0.1, Number(gen.durationSec) || (Number(row.newTcOut) - Number(row.newTcIn)) || 1.5)
  return assetsStore.addAsset({
    name: `GEN ${row.index}: ${(row.note || 'new shot').slice(0, 40)}`,
    url: toFileUrl(generatedPath),
    path: generatedPath,
    absolutePath: generatedPath,
    type: 'video',
    duration,
    fps: gen.fps || sourceVideo?.fps || null,
    width: gen.width || sourceVideo?.width,
    height: gen.height || sourceVideo?.height,
    hasAudio: false,
    audioEnabled: false,
    isImported: true,
    settings: {
      duration,
      fps: gen.fps || sourceVideo?.fps || null,
      width: gen.width || sourceVideo?.width,
      height: gen.height || sourceVideo?.height,
      reeditGeneratedRowIndex: row.index,
      reeditGeneratedModel: gen.model || null,
      reeditGeneratedPrompt: gen.prompt || row.note || '',
      reeditGeneratedAt: gen.generatedAt || null,
    },
  })
}

// Register the Demucs-separated stem WAV as an audio asset so it can
// sit on an audio track under the re-edit. We stamp `reeditStemKind`
// in settings so `cleanupStaleReeditAssets` wipes old stem assets on
// re-apply without touching the user's own audio uploads.
function registerStemAsset(sourceVideo, stemPath, kind, durationSec) {
  const assetsStore = useAssetsStore.getState()
  const labels = { music: 'Music (original stem)', vo: 'VO (original stem)' }
  return assetsStore.addAsset({
    name: labels[kind] || `Stem (${kind})`,
    url: toFileUrl(stemPath),
    path: stemPath,
    absolutePath: stemPath,
    type: 'audio',
    duration: durationSec,
    hasAudio: true,
    audioEnabled: true,
    isImported: true,
    settings: {
      duration: durationSec,
      reeditStemKind: kind,
      reeditSourceVideoPath: sourceVideo?.path || null,
    },
  })
}

function registerPlaceholderAsset(sourceVideo, row, durationSec) {
  const assetsStore = useAssetsStore.getState()
  const url = buildPlaceholderSvgDataUrl({
    note: row.note,
    index: row.index,
    width: sourceVideo?.width,
    height: sourceVideo?.height,
  })
  return assetsStore.addAsset({
    name: `GEN ${row.index}: ${(row.note || 'new shot').slice(0, 40)}`,
    url,
    type: 'image',
    duration: durationSec,
    width: sourceVideo?.width,
    height: sourceVideo?.height,
    isImported: false,
    settings: {
      duration: durationSec,
      width: sourceVideo?.width,
      height: sourceVideo?.height,
      reeditPlaceholder: true,
      reeditSceneIndex: row.index,
      genSpec: {
        prompt: row.note,
        durationS: durationSec,
      },
    },
  })
}

// Remove reedit-owned assets from a prior apply so re-applying doesn't
// stack duplicates in the asset browser. We only touch assets tagged
// with our own markers — user-added assets stay put.
function cleanupStaleReeditAssets() {
  const assetsStore = useAssetsStore.getState()
  const stale = (assetsStore.assets || []).filter((a) => (
    a?.settings?.reeditSceneId
    || a?.settings?.reeditPlaceholder
    || a?.settings?.reeditFrameCandidate
    || a?.settings?.reeditGeneratedRowIndex != null
    || a?.settings?.reeditStemKind
  ))
  for (const asset of stale) {
    try { assetsStore.removeAsset(asset.id) } catch (_) { /* ignore */ }
  }
}

/**
 * Live-swap the clip on the timeline for a given scene to point at a
 * different optimization version, WITHOUT re-applying the whole EDL.
 * Called right after a Commit reframe finishes (auto-swap to the new
 * R-tagged MP4) and from the InspectorPanel's version toggle (user
 * wants to compare original preview vs committed upscale).
 *
 *   version === null              → original sub-clip, reframe preview
 *                                   transform re-applied if the scene
 *                                   had a reframe hint.
 *   version starts with 'R'       → physical reframed MP4, identity
 *                                   transform (the file is already
 *                                   cropped — zoom on top would
 *                                   double-crop).
 *   version starts with 'V' (VACE)→ same framing as original, identity
 *                                   transform still works if we want
 *                                   to compare graphics-removed vs.
 *                                   the raw shot.
 *
 * Returns true when something was swapped on the timeline; false when
 * the scene has no asset on-timeline yet (caller should re-apply the
 * EDL to materialise it).
 */
export function swapSceneActiveVersion({ sceneId, version, scene, projectDir, canvasWidth, canvasHeight }) {
  if (!sceneId) return false
  const assetsStore = useAssetsStore.getState()
  const timelineStore = useTimelineStore.getState()
  const projectStore = useProjectStore.getState()
  const liveScene = scene || projectStore.currentProject?.analysis?.scenes?.find((s) => s.id === sceneId)
  if (!liveScene) return false

  const entry = version ? (liveScene.optimizations || []).find((o) => o.version === version) : null
  const newPath = entry?.path || sceneOriginalClipPath(projectDir || projectStore.currentProjectHandle, liveScene)
  if (!newPath) return false

  // Locate the reedit asset this scene binds to. registerSceneAsset
  // tags it with reeditSceneId + stores the reframe / extend hints,
  // so we can reconstruct the preview transform + slow-down speed
  // without the original EDL row.
  const asset = (assetsStore.assets || []).find((a) => a?.settings?.reeditSceneId === sceneId)
  if (!asset) return false

  const reframeHint = asset.settings?.reeditReframeHint || null
  const extendHint = asset.settings?.reeditExtendHint || null
  const isReframeActive = version && /^R/i.test(version)
  const isExtendActive = version && /^E/i.test(version)
  // Transform only applies on top of the original sub-clip. R-tagged
  // outputs are physically cropped (zoom on top would double-crop).
  // E-tagged outputs use the original framing so the reframe transform
  // could in theory still apply — but if both were set, the user would
  // have committed both sequentially anyway, so we drop it for any
  // optimized version for simplicity.
  const effectiveDefaultTransform = (!version && reframeHint)
    ? buildReframeTransform(
        reframeHint,
        canvasWidth || timelineStore.timelineWidth || timelineStore.width,
        canvasHeight || timelineStore.timelineHeight || timelineStore.height,
      )
    : null

  const newUrl = toFileUrl(newPath)
  assetsStore.updateAsset(asset.id, {
    url: newUrl,
    path: newPath,
    absolutePath: newPath,
    settings: {
      ...asset.settings,
      reeditActiveVersion: version || null,
      reeditReframePending: Boolean(reframeHint && !isReframeActive),
      reeditExtendPending: Boolean(extendHint && !isExtendActive),
      defaultTransform: effectiveDefaultTransform,
    },
  })

  // Apply the new baseline transform + speed to every clip referencing
  // this asset. VideoLayerRenderer reads `asset.url` as the source of
  // truth, so updating the asset above is enough to swap the played
  // MP4; transforms and speed live on the clip itself and need an
  // explicit override — otherwise toggling original→R01 would leave
  // the zoom from the preview pass sitting on top of an already-cropped
  // file, and toggling original→E01 would leave the slow-down sitting
  // on top of an already-extended MP4.
  const clips = (timelineStore.clips || []).filter((c) => c.assetId === asset.id)
  const baselineTransform = {
    positionX: 0, positionY: 0,
    scaleX: 100, scaleY: 100, scaleLinked: true,
    rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
    flipH: false, flipV: false,
    cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
    blendMode: 'normal', blur: 0,
    ...(effectiveDefaultTransform || {}),
  }
  // Decide the speed for each clip. When an extend hint exists AND we
  // are on the Original (no version), slow the source down so the
  // visible timeline span matches sceneDur + extendSec. When we're on
  // an E-tagged version the extended MP4 IS the final length at native
  // speed, so reset to 1.
  const sceneDur = Math.max(0.1, Number(liveScene.tcOut) - Number(liveScene.tcIn))
  const extendSec = extendHint?.seconds ? Number(extendHint.seconds) : 0
  const previewSpeed = (!version && extendSec > 0)
    ? sceneDur / (sceneDur + extendSec)
    : 1
  for (const clip of clips) {
    timelineStore.updateClipTransform?.(clip.id, baselineTransform, false)
    if (clip.type === 'video') {
      timelineStore.updateClipSpeed?.(clip.id, previewSpeed, false)
    }
  }
  return true
}

/**
 * Called when the user swaps the source video. Anything on a video
 * track is derived from (and scoped to) the old source — leaving it
 * behind just confuses the Editor view once the new analysis runs.
 * We clear ALL video-track clips, not just ones we know we placed,
 * because reedit-owned clips from pre-refactor builds may not have
 * our tagging yet, and a stale clip surviving the import is worse
 * than dropping a user edit that's already orphaned. Audio tracks
 * and assets NOT tagged by us stay put (user-added music, VOs).
 */
export function resetReeditProjectState() {
  const timelineStore = useTimelineStore.getState()

  const videoTrackIds = new Set(
    (timelineStore.tracks || [])
      .filter((t) => t.type === 'video')
      .map((t) => t.id)
  )
  const videoClipIds = (timelineStore.clips || [])
    .filter((c) => videoTrackIds.has(c.trackId))
    .map((c) => c.id)
  for (const clipId of videoClipIds) {
    try { timelineStore.removeClip(clipId) } catch (_) { /* ignore */ }
  }

  cleanupStaleReeditAssets()
}

export async function applyEdlToTimeline({
  edl,
  scenes,
  sourceVideo,
  onProgress,
  useGeneratedVideos = true,
  capabilities = null,
  voiceoverSegments = null,
  voiceoverPlan = null,
} = {}) {
  if (!Array.isArray(edl) || edl.length === 0) {
    throw new Error('EDL is empty.')
  }
  if (!sourceVideo?.path) {
    throw new Error('No source video available — import a video first.')
  }

  const projectDir = useProjectStore.getState().currentProjectHandle
  if (typeof projectDir !== 'string') {
    throw new Error('Apply to timeline requires the desktop build (project path needed for clip extraction).')
  }

  const timelineStore = useTimelineStore.getState()
  const sceneById = new Map((scenes || []).map((s) => [s.id, s]))

  const videoTrack = (timelineStore.tracks || []).find((t) => t.type === 'video')
  if (!videoTrack) {
    throw new Error('No video track found in the timeline.')
  }

  // Clear clips and stale reedit-owned assets from the previous Apply
  // before laying down the new pass. Two passes:
  //
  //   1. Wipe ALL clips from the primary video track. The re-edit
  //      owns the full sequence on that track, and any stray user
  //      clip would just land in the middle of our new layout anyway.
  //   2. Wipe reedit-owned clips from EVERY audio track. Stem clips
  //      (music / VO) carry `reeditStemKind` on their asset settings
  //      and need to be removed so they don't stack on top of the new
  //      pass. User-placed audio clips (their own music, SFX, etc.)
  //      stay put. We don't delete the audio tracks themselves — the
  //      user may have created them intentionally; takeAudioTrack()
  //      below will reuse whichever ones are now empty.
  const assetsSnapshot = useAssetsStore.getState().assets || []
  const reeditAssetIds = new Set(
    assetsSnapshot
      .filter((a) => (
        a?.settings?.reeditSceneId
        || a?.settings?.reeditPlaceholder
        || a?.settings?.reeditFrameCandidate
        || a?.settings?.reeditGeneratedRowIndex != null
        || a?.settings?.reeditStemKind
      ))
      .map((a) => a.id)
  )
  const clipsToRemove = (timelineStore.clips || [])
    .filter((c) => c.trackId === videoTrack.id || reeditAssetIds.has(c.assetId))
    .map((c) => c.id)
  for (const clipId of clipsToRemove) {
    timelineStore.removeClip(clipId)
  }
  cleanupStaleReeditAssets()

  // We deliberately ignore the LLM's newTcIn/newTcOut values when
  // placing clips. Qwen2.5-VL routinely claims a row needs 2.8s of
  // screen time while pointing at a 0.7s source scene — honoring the
  // larger duration would require speed-ramping the clip, and honoring
  // the shorter source while jumping the cursor by the larger declared
  // duration leaves gaps. The LLM's useful output is the SEQUENCE and
  // RATIONALE of scenes; the durations we use are the source scenes'
  // natural lengths, packed flush from t=0. Placeholder rows reserve
  // their declared duration (or a sane default) so the "gap" is
  // actually a visible card instead of a confusing empty stretch.
  let cursor = 0
  let placed = 0
  let skippedMissingScene = 0
  let placeholdersPlaced = 0
  const total = edl.length
  // Earliest VO-bearing shot in the re-edit's SOURCE timing. We start
  // the VO stem from that point so the user doesn't get 5 s of dead
  // air at the head just because the first source shot predates the
  // first VO line. VO lands as a SINGLE continuous clip (not split
  // per-shot) — the narrative of the VO is its own thing, independent
  // of how the video is reshuffled. If the user wants sync, they can
  // split the clip manually in the timeline.
  let earliestVoSourceTc = null

  // Canvas dimensions drive the position math for reframe (see
  // buildReframeTransform). Timeline-level settings win over the
  // project root since the user may have picked a different aspect
  // for this sequence specifically.
  const canvasW = timelineStore.timelineWidth || timelineStore.width || sourceVideo.width || 1920
  const canvasH = timelineStore.timelineHeight || timelineStore.height || sourceVideo.height || 1080

  for (let i = 0; i < edl.length; i++) {
    const row = edl[i]
    onProgress?.({ index: i, total, row })
    const reframeTransform = buildReframeTransform(row?.reframe, canvasW, canvasH)

    // Honor per-row exclusion — the user has said "don't put this on
    // the timeline" without deleting the row from the EDL. Nothing
    // lands, cursor doesn't advance.
    if (row?.excluded) {
      continue
    }

    if (row.kind === 'placeholder') {
      const declaredGap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
      // Clamp to the user's per-placeholder max duration. The setting
      // lives in Settings → Capabilities → Footage generation. The
      // proposer is supposed to honour it but local models sometimes
      // overshoot; clipping here too guarantees the UI preview matches
      // what would actually get generated.
      const maxGenDur = Math.max(0.5, Number(loadCapabilitySettings()?.footageGeneration?.maxDurationSec) || 4)
      const gapDur = Math.min(maxGenDur, Math.max(0.5, declaredGap || 1.5))
      // `useGeneratedVideos: false` lets the user preview / ship the
      // re-edit with the frame stills instead of the AI-generated
      // motion — handy when the i2v output feels off but the
      // composition of the chosen first frame is still good. The
      // video files stay on disk and the toggle is fully reversible.
      const generatedPath = useGeneratedVideos ? row.genSpec?.generatedPath : null
      const candidates = Array.isArray(row.genSpec?.frameCandidates) ? row.genSpec.frameCandidates : []

      // Helper — applies the row's COLOR directive (if any) to the clip
      // the branch just added. Same merge semantics as the original-row
      // path so the three placeholder variants stay consistent.
      const applyRowColor = (clip) => {
        if (clip?.id && row.colorAdjustments) {
          timelineStore.updateClipAdjustments(clip.id, row.colorAdjustments, false)
        }
      }
      if (generatedPath) {
        // i2v already produced an MP4 — drop it in as a real video
        // clip. The generated duration may differ slightly from the
        // EDL row's declared gap; honor the clip's actual length via
        // trimEnd so playback doesn't try to read past EOF.
        const actualDur = Math.max(0.1, Number(row.genSpec?.durationSec) || gapDur)
        const asset = registerGeneratedAsset(sourceVideo, row, generatedPath)
        const clip = timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: actualDur,
          trimStart: 0,
          trimEnd: actualDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
        applyRowColor(clip)
        cursor += actualDur
      } else if (candidates.length > 0) {
        // Frames exist but no video yet — use the selected (or latest)
        // candidate as a still on the timeline so the user can
        // preview the composition before committing to an i2v pass.
        // Dropping a still-image placeholder is a much better
        // preview than the generic "GENERATION NEEDED" card because
        // it already shows the specific shot they liked.
        const selected = candidates.find((c) => c?.id === row.genSpec?.selectedFrameId)
          || candidates[candidates.length - 1]
        const asset = registerFrameAsset(sourceVideo, row, selected)
        const clip = timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: gapDur,
          trimStart: 0,
          trimEnd: gapDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
        applyRowColor(clip)
        cursor += gapDur
      } else {
        const asset = registerPlaceholderAsset(sourceVideo, row, gapDur)
        const clip = timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: gapDur,
          trimStart: 0,
          trimEnd: gapDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
        applyRowColor(clip)
        cursor += gapDur
      }
      placeholdersPlaced++
      continue
    }
    const scene = sceneById.get(row.sourceSceneId)
    if (!scene) {
      skippedMissingScene++
      continue
    }

    const sceneDur = Math.max(0.1, Number(scene.tcOut) - Number(scene.tcIn))
    // Pass the reframe transform through to the asset itself — the
    // timeline store reads it from asset.settings.defaultTransform when
    // building the clip's transform. registerSceneAsset drops it again
    // on its own if the scene's active version is already R-tagged.
    const asset = await registerSceneAsset(sourceVideo, scene, projectDir, row, reframeTransform)

    // Extend preview: if the proposer requested `EXTEND +Xs:` and the
    // scene isn't already on a committed E-tagged version, slow the
    // clip down so the visible duration on the timeline matches the
    // requested new length. The store recomputes `clip.duration` as
    // `sourceSpan / speed` — so speed = sceneDur / (sceneDur + extendSec)
    // gives us sceneDur + extendSec of visible time on the timeline.
    // Once the user runs Commit extend, the swap helper resets speed=1
    // against the real extended MP4.
    const activeVersion = scene.activeOptimizationVersion || null
    const shouldApplyExtendPreview = Boolean(
      row?.extend?.seconds
      && !(activeVersion && /^E/i.test(activeVersion))
    )
    const extendSec = shouldApplyExtendPreview ? Number(row.extend.seconds) : 0
    const visibleSceneDur = sceneDur + extendSec

    // The sub-clip file starts at t=0 and already contains only the
    // scene range, so trimStart/trimEnd address the extracted file,
    // not the original source. We pass the native sceneDur as the
    // clip's source span; updateClipSpeed below takes care of stretching
    // the visible timeline span when an extend preview is active.
    const newClip = timelineStore.addClip(videoTrack.id, asset, cursor, null, {
      duration: sceneDur,
      trimStart: 0,
      trimEnd: sceneDur,
      saveHistory: false,
      selectAfterAdd: false,
    })
    if (newClip?.id && shouldApplyExtendPreview && extendSec > 0) {
      const previewSpeed = sceneDur / visibleSceneDur
      timelineStore.updateClipSpeed(newClip.id, previewSpeed, false)
    }
    // Apply color correction when the proposer annotated this row with
    // a COLOR directive (only possible when the colorCorrection
    // capability was enabled). The store merges partial adjustment
    // updates into the clip's existing adjustments object, so passing
    // only the keys the LLM chose leaves every other axis at its
    // neutral default. No-op when `row.colorAdjustments` is null.
    if (newClip?.id && row.colorAdjustments) {
      timelineStore.updateClipAdjustments(newClip.id, row.colorAdjustments, false)
    }
    // Track the earliest source-tcIn among shots that had a VO
    // transcript. Used below as the start offset for the single VO
    // stem clip — skips any dead air before the first VO line.
    const sceneHadVo = Boolean(scene?.videoAnalysis?.audio?.voiceover_transcript)
    if (sceneHadVo) {
      const tcIn = Number(scene.tcIn)
      if (Number.isFinite(tcIn) && (earliestVoSourceTc == null || tcIn < earliestVoSourceTc)) {
        earliestVoSourceTc = tcIn
      }
    }
    cursor += visibleSceneDur
    placed++
  }

  // Layer Demucs-separated stems on top of the assembled re-edit when
  // the proposer was granted the matching capability. Music and VO are
  // laid down differently:
  //
  //   MUSIC  — one long clip from 0. Music bed works best as a
  //            continuous track; splitting it per-shot creates audible
  //            seams in any score.
  //
  //   VO     — per-shot clips sourced from the SAME stem, but each one
  //            plays the source range the corresponding original shot
  //            came from. This keeps the VO consistent with the
  //            Gemini-captured transcript: if the analyzer said shot
  //            `scene-004` (source tc 5.44–6.44) carries VO "...materials.",
  //            then wherever that shot lands on the new timeline, the
  //            VO plays that exact 1s slice of the stem — NOT whatever
  //            the stem had at the new timeline position. Placeholders
  //            have no source range → VO track stays silent for them.
  const stems = sourceVideo?.stems || null
  const stemNaturalDur = Math.max(0.1, Number(sourceVideo?.duration) || 0)
  const totalReeditDur = cursor > 0 ? cursor : stemNaturalDur

  // Grab existing audio tracks once so we can pick off-the-shelf ones
  // before creating new ones. Fresh projects ship with a single
  // "Audio 1" that's empty — we're happy to reuse it for Music.
  const takeAudioTrack = () => {
    const state = useTimelineStore.getState()
    const audioTracks = (state.tracks || []).filter((t) => t.type === 'audio')
    const empty = audioTracks.find((t) => !(state.clips || []).some((c) => c.trackId === t.id))
    if (empty) return empty
    return state.addTrack('audio', { channels: 'stereo' })
  }

  const stemsPlaced = []

  // Music: single continuous clip.
  if (stems && capabilities?.useOriginalMusic && stems.musicPath) {
    const clipDur = Math.max(0.1, Math.min(totalReeditDur, stemNaturalDur))
    const track = takeAudioTrack()
    const asset = registerStemAsset(sourceVideo, stems.musicPath, 'music', stemNaturalDur)
    useTimelineStore.getState().addClip(track.id, asset, 0, null, {
      duration: clipDur,
      trimStart: 0,
      trimEnd: clipDur,
      saveHistory: false,
      selectAfterAdd: false,
    })
    stemsPlaced.push('music')
  }

  // VO: driven by the voiceover plan when we have one (segmented from
  // Gemini's overall analysis, either auto-picked by the proposer or
  // manually curated by the user), else fallback to a single
  // continuous clip from the first VO line onwards.
  if (stems && capabilities?.useOriginalVoiceover && stems.vocalsPath) {
    const rawSegments = Array.isArray(voiceoverSegments) ? voiceoverSegments : []
    // Apply user-edited timestamps + global lead pads. The analyzer's
    // values stay canonical on `analysis.overall`; per-segment edits
    // ride on the proposal (`voiceoverPlan.segmentEdits`) so re-running
    // Analyze doesn't blow them away. The lead pads (leadInSec /
    // leadOutSec on voiceoverPlan) extend every segment a touch
    // earlier and later because Gemini's timestamps consistently
    // arrive ~0.3-0.7 s late on phrase starts.
    const edits = voiceoverPlan?.segmentEdits || {}
    const leadIn = Math.max(0, Number(voiceoverPlan?.leadInSec) || 0)
    const leadOut = Math.max(0, Number(voiceoverPlan?.leadOutSec) || 0)
    const segments = rawSegments.map((s) => {
      const e = edits[s.id]
      const baseStart = e && Number.isFinite(e.startSec) ? e.startSec : Number(s.startSec)
      const baseEnd = e && Number.isFinite(e.endSec) ? e.endSec : Number(s.endSec)
      return {
        ...s,
        startSec: Math.max(0, baseStart - leadIn),
        endSec: Math.max(baseStart - leadIn + 0.05, baseEnd + leadOut),
      }
    })
    const planIds = Array.isArray(voiceoverPlan?.segmentIds) ? voiceoverPlan.segmentIds : null
    const segmentsById = new Map(segments.map((s) => [s.id, s]))
    // Selected segments stay in the ORDER THE PLAN LISTS THEM — the
    // proposer can reorder if needed (though the current prompt tells
    // it to preserve the original order, we honour whatever it returns
    // so future re-prompts can swap lines around). Drop unknown ids.
    const picked = planIds
      ? planIds.map((id) => segmentsById.get(id)).filter(Boolean)
      : segments
    if (picked.length > 0) {
      // Concatenate the picked segments back-to-back on the timeline
      // (no inter-segment pauses). Each clip trims the stem to just
      // that segment's range, so sentences stay intact and dropped
      // segments leave no audio residue. The user can nudge gaps by
      // dragging clips in the timeline after apply. We also clamp the
      // running cursor to `totalReeditDur` so the VO never extends
      // past the end of the visible video — if the picked segments add
      // up to more speech than the re-edit can hold, the last one gets
      // truncated rather than spilling into silence.
      const track = takeAudioTrack()
      const asset = registerStemAsset(sourceVideo, stems.vocalsPath, 'vo', stemNaturalDur)
      const tlStore = useTimelineStore.getState()
      let voCursor = 0
      for (const seg of picked) {
        const fullSegDur = Math.max(0.05, Number(seg.endSec) - Number(seg.startSec))
        if (!Number.isFinite(fullSegDur) || fullSegDur <= 0) continue
        // Stop placing once we've filled the re-edit window. Trim the
        // tail segment so it ends exactly at totalReeditDur.
        const remaining = totalReeditDur - voCursor
        if (remaining <= 0.05) break
        const segDur = Math.min(fullSegDur, remaining)
        tlStore.addClip(track.id, asset, voCursor, null, {
          duration: segDur,
          trimStart: Number(seg.startSec),
          trimEnd: Number(seg.startSec) + segDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
        voCursor += segDur
      }
      stemsPlaced.push('vo')
    } else {
      // Fallback when the project has no VO segmentation yet (pre-
      // schema-update analyses, or VO transcript wasn't captured):
      // one long clip trimmed to start at the earliest VO-bearing
      // shot's source tcIn, so the user hears the VO but with the
      // original pacing of the source ad.
      const trimStart = Number.isFinite(earliestVoSourceTc) ? Math.max(0, earliestVoSourceTc) : 0
      const availableStem = Math.max(0.1, stemNaturalDur - trimStart)
      const clipDur = Math.max(0.1, Math.min(totalReeditDur, availableStem))
      const track = takeAudioTrack()
      const asset = registerStemAsset(sourceVideo, stems.vocalsPath, 'vo', stemNaturalDur)
      useTimelineStore.getState().addClip(track.id, asset, 0, null, {
        duration: clipDur,
        trimStart,
        trimEnd: trimStart + clipDur,
        saveHistory: false,
        selectAfterAdd: false,
      })
      stemsPlaced.push('vo')
    }
  }

  onProgress?.({ index: total, total, done: true })
  return { placed, placeholdersPlaced, skippedMissingScene, stemsPlaced }
}
