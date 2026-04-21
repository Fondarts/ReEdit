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

function buildPlaceholderSvgDataUrl({ note, index, width, height }) {
  const w = Math.max(480, width || 1920)
  const h = Math.max(270, height || 1080)
  const lines = wrapLines(note)
  const noteFontSize = Math.round(h * 0.045)
  const lineStep = Math.round(noteFontSize * 1.25)
  const noteStartY = Math.round(h * 0.52)
  const tspans = lines.map((line, i) => (
    `<tspan x="50%" dy="${i === 0 ? 0 : lineStep}">${escapeXml(line)}</tspan>`
  )).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
    <rect width="100%" height="100%" fill="#0b0b0e"/>
    <rect x="0" y="0" width="100%" height="${Math.max(6, Math.round(h * 0.012))}" fill="#f59e0b"/>
    <text x="50%" y="${Math.round(h * 0.28)}" fill="#f59e0b"
          font-family="Inter, system-ui, sans-serif" font-weight="700"
          font-size="${Math.round(h * 0.085)}" text-anchor="middle">GENERATION NEEDED</text>
    <text x="50%" y="${Math.round(h * 0.40)}" fill="#9ca3af"
          font-family="Inter, system-ui, sans-serif"
          font-size="${Math.round(h * 0.035)}" text-anchor="middle">shot ${index}</text>
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
  const clipOutputPath = `${projectDir.replace(/\\/g, '/')}/.reedit/clips/${scene.id}.mp4`
  const res = await window.electronAPI?.extractSceneClip?.({
    videoPath: sourceVideo.path,
    tcIn: Number(scene.tcIn) || 0,
    tcOut: Number(scene.tcOut) || (Number(scene.tcIn) + 0.5),
    outputPath: clipOutputPath,
  })
  if (!res?.success) {
    throw new Error(`Could not extract ${scene.id}: ${res?.error || 'unknown error'}`)
  }

  const duration = Math.max(0.1, Number(scene.tcOut) - Number(scene.tcIn))
  const hasAudio = sourceVideo.hasAudio !== false
  return assetsStore.addAsset({
    name: `${scene.id} · ${(sourceVideo.name || 'source').replace(/\.[^.]+$/, '')}`,
    url: toFileUrl(clipOutputPath),
    path: clipOutputPath,
    absolutePath: clipOutputPath,
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

export async function applyEdlToTimeline({ edl, scenes, sourceVideo, onProgress } = {}) {
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

    if (row.kind === 'placeholder') {
      const declaredGap = (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0)
      const gapDur = Math.max(0.5, declaredGap || 1.5)
      const asset = registerPlaceholderAsset(sourceVideo, row, gapDur)
      timelineStore.addClip(videoTrack.id, asset, cursor, null, {
        duration: gapDur,
        trimStart: 0,
        trimEnd: gapDur,
        saveHistory: false,
        selectAfterAdd: false,
      })
      cursor += gapDur
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

  onProgress?.({ index: total, total, done: true })
  return { placed, placeholdersPlaced, skippedMissingScene }
}
