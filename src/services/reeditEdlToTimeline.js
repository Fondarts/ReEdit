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
async function registerSceneAsset(sourceVideo, scene, projectDir) {
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
      reeditSceneId: scene.id,
      reeditSceneTcIn: scene.tcIn,
      reeditSceneTcOut: scene.tcOut,
      reeditActiveVersion: activeVersion,
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

export async function applyEdlToTimeline({ edl, scenes, sourceVideo, onProgress, useGeneratedVideos = true, capabilities = null } = {}) {
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
  // before laying down the new pass. User-added assets are preserved;
  // only the ones we tagged ourselves get removed.
  const existingClipIds = (timelineStore.clips || [])
    .filter((c) => c.trackId === videoTrack.id)
    .map((c) => c.id)
  for (const clipId of existingClipIds) {
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

  for (let i = 0; i < edl.length; i++) {
    const row = edl[i]
    onProgress?.({ index: i, total, row })

    // Honor per-row exclusion — the user has said "don't put this on
    // the timeline" without deleting the row from the EDL. Nothing
    // lands, cursor doesn't advance.
    if (row?.excluded) {
      continue
    }

    if (row.kind === 'placeholder') {
      const declaredGap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
      const gapDur = Math.max(0.5, declaredGap || 1.5)
      // `useGeneratedVideos: false` lets the user preview / ship the
      // re-edit with the frame stills instead of the AI-generated
      // motion — handy when the i2v output feels off but the
      // composition of the chosen first frame is still good. The
      // video files stay on disk and the toggle is fully reversible.
      const generatedPath = useGeneratedVideos ? row.genSpec?.generatedPath : null
      const candidates = Array.isArray(row.genSpec?.frameCandidates) ? row.genSpec.frameCandidates : []

      if (generatedPath) {
        // i2v already produced an MP4 — drop it in as a real video
        // clip. The generated duration may differ slightly from the
        // EDL row's declared gap; honor the clip's actual length via
        // trimEnd so playback doesn't try to read past EOF.
        const actualDur = Math.max(0.1, Number(row.genSpec?.durationSec) || gapDur)
        const asset = registerGeneratedAsset(sourceVideo, row, generatedPath)
        timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: actualDur,
          trimStart: 0,
          trimEnd: actualDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
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
        timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: gapDur,
          trimStart: 0,
          trimEnd: gapDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
        cursor += gapDur
      } else {
        const asset = registerPlaceholderAsset(sourceVideo, row, gapDur)
        timelineStore.addClip(videoTrack.id, asset, cursor, null, {
          duration: gapDur,
          trimStart: 0,
          trimEnd: gapDur,
          saveHistory: false,
          selectAfterAdd: false,
        })
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
    const asset = await registerSceneAsset(sourceVideo, scene, projectDir)

    // The sub-clip file starts at t=0 and already contains only the
    // scene range, so trimStart/trimEnd address the extracted file,
    // not the original source. addClip uses them to set the clip's
    // visible duration on the timeline.
    timelineStore.addClip(videoTrack.id, asset, cursor, null, {
      duration: sceneDur,
      trimStart: 0,
      trimEnd: sceneDur,
      saveHistory: false,
      selectAfterAdd: false,
    })
    cursor += sceneDur
    placed++
  }

  // Layer Demucs-separated stems on top of the assembled re-edit when
  // the proposer was granted the matching capability. The stems are
  // derived from the SOURCE video — so their natural length matches
  // sourceVideo.duration, not the re-edit's total `cursor`. If the
  // re-edit is shorter we truncate the stem; if it's longer (because
  // placeholders were added), the stem plays its full length once and
  // the remainder stays silent. For ads this is almost always "re-edit
  // equals or is shorter than source", so the simple truncate is right.
  const stems = sourceVideo?.stems || null
  const stemPlacements = []
  if (stems && capabilities?.useOriginalMusic && stems.musicPath) {
    stemPlacements.push({ kind: 'music', path: stems.musicPath })
  }
  if (stems && capabilities?.useOriginalVoiceover && stems.vocalsPath) {
    stemPlacements.push({ kind: 'vo', path: stems.vocalsPath })
  }
  const stemsPlaced = []
  if (stemPlacements.length > 0) {
    const totalReeditDur = cursor > 0 ? cursor : (Number(sourceVideo.duration) || 0)
    const stemNaturalDur = Math.max(0.1, Number(sourceVideo.duration) || totalReeditDur)
    // Use min of the two so we never ask the renderer to play past the
    // stem's EOF nor past the edit's end.
    const clipDur = Math.max(0.1, Math.min(totalReeditDur, stemNaturalDur))

    // Grab existing audio tracks once so we can pick off-the-shelf ones
    // before creating new ones. Fresh projects ship with a single
    // "Audio 1" that's empty — we're happy to reuse it for Music.
    const takeAudioTrack = () => {
      const state = useTimelineStore.getState()
      const audioTracks = (state.tracks || []).filter((t) => t.type === 'audio')
      // Prefer a completely empty track to avoid clobbering user audio;
      // fall back to creating a new one.
      const empty = audioTracks.find((t) => !(state.clips || []).some((c) => c.trackId === t.id))
      if (empty) return empty
      return state.addTrack('audio', { channels: 'stereo' })
    }

    for (const placement of stemPlacements) {
      const track = takeAudioTrack()
      const asset = registerStemAsset(sourceVideo, placement.path, placement.kind, stemNaturalDur)
      useTimelineStore.getState().addClip(track.id, asset, 0, null, {
        duration: clipDur,
        trimStart: 0,
        trimEnd: clipDur,
        saveHistory: false,
        selectAfterAdd: false,
      })
      stemsPlaced.push(placement.kind)
    }
  }

  onProgress?.({ index: total, total, done: true })
  return { placed, placeholdersPlaced, skippedMissingScene, stemsPlaced }
}
