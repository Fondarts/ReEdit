import { useState } from 'react'
import { Download, ChevronDown, Loader2 } from 'lucide-react'
import PreviewPanel from '../../PreviewPanel'
import TransportControls from '../../TransportControls'
import Timeline from '../../Timeline'
import ResizeHandle from '../../ResizeHandle'
import useProjectStore from '../../../stores/projectStore'

// Build a comfystudio:// URL for an absolute path. Mirrors the helper
// used in AnalysisView / ProposalViewSimple so the asset protocol is
// consistent across the app.
function toComfyUrl(filePath) {
  if (!filePath) return null
  return `comfystudio://${encodeURIComponent(filePath)}`
}

// Side-by-side "before / after" preview area in Simple mode. The left
// side stays the live edit preview (driven by the timeline cursor); the
// right side gets its own <video controls> wired to the source-video
// path so the user can A/B against the original without rewiring the
// transport. Native browser controls are intentional: it's a quick
// reference player, not the editing surface.
function OriginalSourcePreview() {
  const sourceVideo = useProjectStore((s) => s.currentProject?.sourceVideo)
  const src = toComfyUrl(sourceVideo?.path)
  return (
    <div className="h-full w-full flex flex-col bg-sf-dark-950">
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-sf-dark-700 bg-sf-dark-900 text-[10px] uppercase tracking-wider text-sf-text-muted">
        Original
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center">
        {src ? (
          <video
            key={src}
            src={src}
            controls
            preload="metadata"
            className="max-h-full max-w-full"
          />
        ) : (
          <div className="text-xs text-sf-text-muted">No source video.</div>
        )}
      </div>
    </div>
  )
}

// Pad a number to N digits (zeroed). Used by the CMX-3600 timecode
// formatter — EDLs are picky about HH:MM:SS:FF being exact width.
function pad2(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0') }

// Convert seconds → HH:MM:SS:FF using the project's fps. Frames cap
// at fps-1 so a value of fps gets rounded up to the next second.
function secsToTcCmx(sec, fps) {
  const safeFps = Math.max(1, Math.round(Number(fps) || 24))
  const totalFrames = Math.max(0, Math.round(Number(sec || 0) * safeFps))
  const ff = totalFrames % safeFps
  const s = Math.floor(totalFrames / safeFps)
  const ss = s % 60
  const mm = Math.floor(s / 60) % 60
  const hh = Math.floor(s / 3600)
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`
}

// Helper: derive a CMX-3600 reel name (8 chars, upper alphanumeric,
// padded with spaces) from any string. Falls back to a default when
// the input has no alphanumerics.
function reelFromString(raw, fallback) {
  const cleaned = String(raw || '').replace(/[^A-Z0-9]/gi, '').toUpperCase()
  return (cleaned.slice(0, 8) || fallback).padEnd(8, ' ').slice(0, 8)
}

// Helper: basename of a filesystem path (cross-platform).
function basename(p) {
  if (!p) return ''
  return String(p).replace(/\\/g, '/').split('/').pop()
}

// Render a CMX-3600 EDL from the project's current proposal.
//
// Multi-source aware: each EDL row picks the right media file based
// on the row's state —
//   - Optimized scene → the VACE output mp4 (own reel + filename)
//   - Placeholder with a generated fill → the i2v output mp4
//   - Placeholder without a fill → a synthetic "needs replacement"
//     reel so Premiere shows the row as offline media to swap in
//   - Plain original shot → the source video, source-TC into the
//     scene's tcIn range
// Premiere uses `* FROM CLIP NAME:` as the displayed bin name AND
// to relink media (matched alongside reel name). Notes / rationale
// land on a separate `* COMMENT:` line so they don't pollute the
// clip identity.
//
// Audio: after every video event we emit a single continuous A2
// event for the music stem (lasts the whole new-cut duration) and
// per-segment A1 events for the original VO based on the proposer's
// voiceoverPlan (segmentIds + segmentGaps), so the rough VO timing
// in Premiere matches what the in-app preview produced.
function renderEdlCmx({
  proposal,
  scenes,
  sourceVideo,
  fills,
  voSegments,
  fps,
}) {
  const edl = Array.isArray(proposal?.edl) ? proposal.edl : []
  const sceneById = new Map((scenes || []).map((s) => [s.id, s]))
  const segById   = new Map((Array.isArray(voSegments) ? voSegments : []).map((s) => [s.id, s]))

  const sourceFilename = basename(sourceVideo?.path) || 'SOURCE.MP4'
  const sourceReel = reelFromString(sourceFilename.replace(/\.[^.]+$/, ''), 'SOURCE')

  const lines = []
  lines.push(`TITLE: ${proposal?.title || 'Kissd ReEdit Proposal'}`)
  lines.push('FCM: NON-DROP FRAME')
  lines.push('')
  // Debug header — lets us see what the exporter actually found when
  // a track ends up missing. Comments are ignored by NLEs but visible
  // when opening the .edl in a text editor.
  lines.push('* === KISSD REEDIT EXPORT DIAGNOSTICS ===')
  lines.push(`* source video       : ${sourceVideo?.path || '(missing)'}`)
  lines.push(`* music stem         : ${sourceVideo?.stems?.musicPath || '(none — music track will not be emitted)'}`)
  lines.push(`* vocals stem        : ${sourceVideo?.stems?.vocalsPath || '(none — VO track will not be emitted)'}`)
  lines.push(`* voiceoverPlan ids  : ${Array.isArray(proposal?.voiceoverPlan?.segmentIds) ? proposal.voiceoverPlan.segmentIds.length : 0}`)
  lines.push(`* voSegments avail.  : ${Array.isArray(voSegments) ? voSegments.length : 0}`)
  lines.push(`* fills entries      : ${fills ? Object.keys(fills).length : 0}`)
  lines.push('* ========================================')
  lines.push('')

  // Resolve which media file each EDL row actually references. Same
  // priority order the timeline applier uses (optimized > original
  // for shots; fill > synthetic for placeholders).
  const resolveMedia = (row, idx) => {
    if (row.kind === 'placeholder') {
      // Match reeditFills' id scheme exactly: `placeholder-<ARRAY_INDEX>`
      // where ARRAY_INDEX is the 0-based position of the row inside the
      // EDL array (NOT row.index, which the proposer fills 1-based).
      // reeditFills.js does `placeholderIdFor({ ...row, index: i })`
      // with `i` = for-loop counter, so the file on disk is named
      // `placeholder-9.mp4` for the 10th EDL row (idx === 9).
      const pid = row.fillId || `placeholder-${idx}`
      const fill = fills?.[pid]
      if (fill?.path) {
        return {
          filename: basename(fill.path),
          reel: reelFromString(`AIFILL${idx + 1}`, 'AIFILL'),
          srcStart: 0,
          kind: 'fill',
        }
      }
      return {
        filename: `PLACEHOLDER_${String(idx + 1).padStart(2, '0')}.MP4`,
        reel: reelFromString(`AIFILL${idx + 1}`, 'AIFILL'),
        srcStart: 0,
        kind: 'placeholder',
      }
    }
    const sceneRef = row.sourceSceneId ? sceneById.get(row.sourceSceneId) : null
    if (!sceneRef) {
      return { filename: sourceFilename, reel: sourceReel, srcStart: 0, kind: 'original' }
    }
    const activeVersion = sceneRef.activeOptimizationVersion || sceneRef.activeOptimization
    if (activeVersion && Array.isArray(sceneRef.optimizations)) {
      const entry = sceneRef.optimizations.find((o) => o?.version === activeVersion)
      const optPath = entry?.path || entry?.outputPath
      if (optPath) {
        return {
          filename: basename(optPath),
          // One reel per optimized scene — `OPT` + scene index. Same
          // scene reused across multiple rows therefore gets the
          // same reel, which is what we want.
          reel: reelFromString(`OPT${sceneRef.id}`, 'OPT'),
          srcStart: 0,
          kind: 'optimized',
        }
      }
    }
    return {
      filename: sourceFilename,
      reel: sourceReel,
      srcStart: Number(sceneRef.tcIn) || 0,
      kind: 'original',
    }
  }

  // ─── Video events ─────────────────────────────────────────────
  edl.forEach((row, idx) => {
    const media = resolveMedia(row, idx)
    const evt = String(idx + 1).padStart(3, '0')
    const recIn = secsToTcCmx(Number(row.newTcIn) || 0, fps)
    const recOut = secsToTcCmx(Number(row.newTcOut) || 0, fps)
    const dur = Math.max(0, (Number(row.newTcOut) || 0) - (Number(row.newTcIn) || 0))
    const srcIn = secsToTcCmx(media.srcStart, fps)
    const srcOut = secsToTcCmx(media.srcStart + dur, fps)
    // CMX-3600 event line: "EVT  REEL     V     C        SRCIN SRCOUT RECIN RECOUT"
    lines.push(`${evt}  ${media.reel} V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}`)
    lines.push(`* FROM CLIP NAME: ${media.filename}`)
    if (row.note) {
      const flatNote = String(row.note).replace(/[\r\n]+/g, ' ').slice(0, 240)
      lines.push(`* COMMENT: ${flatNote}`)
    }
    if (media.kind === 'placeholder') lines.push('* AI-GENERATED PLACEHOLDER — REPLACE BEFORE FINALIZING')
    else if (media.kind === 'fill')   lines.push('* AI-GENERATED FILL (i2v output) — REVIEW BEFORE FINALIZING')
    else if (media.kind === 'optimized') lines.push('* OPTIMIZED CLIP (graphics removed via VACE)')
  })

  // Total new-cut duration so the audio events know where to stop.
  const totalDur = edl.reduce((acc, r) => Math.max(acc, Number(r.newTcOut) || 0), 0)

  // ─── Audio: music ─────────────────────────────────────────────
  // One continuous A2 event spanning the whole new cut. The Demucs
  // music stem is the same length as the source video, so source TC
  // starts at 0 and we trust Premiere to truncate at the end of the
  // file if the new cut is longer than the source music.
  let audioEvt = edl.length + 1
  const musicPath = sourceVideo?.stems?.musicPath
  if (musicPath && totalDur > 0) {
    const evt = String(audioEvt++).padStart(3, '0')
    const reel = reelFromString('MUSIC', 'MUSIC')
    const recIn  = secsToTcCmx(0, fps)
    const recOut = secsToTcCmx(totalDur, fps)
    // A2 channel = audio track 2. Premiere imports it as a separate
    // audio track sibling to V/A1.
    lines.push(`${evt}  ${reel} A2    C        ${recIn} ${recOut} ${recIn} ${recOut}`)
    lines.push(`* FROM CLIP NAME: ${basename(musicPath)}`)
    lines.push('* DEMUCS-SEPARATED MUSIC STEM')
  }

  // ─── Audio: VO segments ───────────────────────────────────────
  // Two branches:
  //   (a) Proposer left a voiceoverPlan with segmentIds → emit one
  //       A1 event per segment using the plan's gaps. Matches what
  //       the in-app preview produced.
  //   (b) No plan (older projects, manual proposal where VO never
  //       got picked, plan was empty): emit ONE continuous A1
  //       event covering the whole new cut so the editor still has
  //       the VO track available in Premiere instead of dropping
  //       it on the floor.
  const vocalsPath = sourceVideo?.stems?.vocalsPath
  const voPlan = proposal?.voiceoverPlan || null
  const planSegIds = (voPlan && Array.isArray(voPlan.segmentIds)) ? voPlan.segmentIds : []
  const voReel = reelFromString('VO', 'VO')
  if (vocalsPath && totalDur > 0 && planSegIds.length > 0) {
    let voCursor = 0
    let emittedAny = false
    for (const segId of planSegIds) {
      const seg = segById.get(segId)
      if (!seg) continue
      const gap = Number(voPlan.segmentGaps?.[segId]) || 0
      voCursor += Math.max(0, gap)
      const segDur = Math.max(0, (Number(seg.endSec) || 0) - (Number(seg.startSec) || 0))
      if (segDur <= 0) continue
      const remaining = totalDur - voCursor
      if (remaining <= 0.05) break
      const placedDur = Math.min(segDur, remaining)
      const evt = String(audioEvt++).padStart(3, '0')
      const srcIn  = secsToTcCmx(Number(seg.startSec) || 0, fps)
      const srcOut = secsToTcCmx((Number(seg.startSec) || 0) + placedDur, fps)
      const recIn  = secsToTcCmx(voCursor, fps)
      const recOut = secsToTcCmx(voCursor + placedDur, fps)
      lines.push(`${evt}  ${voReel} A1    C        ${srcIn} ${srcOut} ${recIn} ${recOut}`)
      lines.push(`* FROM CLIP NAME: ${basename(vocalsPath)}`)
      if (seg.text) {
        const flatText = String(seg.text).replace(/[\r\n]+/g, ' ').slice(0, 200)
        lines.push(`* COMMENT: VO "${flatText}"`)
      }
      voCursor += placedDur
      emittedAny = true
    }
    // If the plan resolved to zero playable events (every id missing
    // from the segment list), drop into the continuous fallback below.
    if (!emittedAny) {
      // fall through
      const evt = String(audioEvt++).padStart(3, '0')
      const recIn  = secsToTcCmx(0, fps)
      const recOut = secsToTcCmx(totalDur, fps)
      lines.push(`${evt}  ${voReel} A1    C        ${recIn} ${recOut} ${recIn} ${recOut}`)
      lines.push(`* FROM CLIP NAME: ${basename(vocalsPath)}`)
      lines.push('* DEMUCS-SEPARATED VO STEM (continuous — plan had no resolvable segments)')
    }
  } else if (vocalsPath && totalDur > 0) {
    // No plan at all. Emit one continuous VO event so the editor in
    // Premiere can still hear / re-place the original voiceover.
    const evt = String(audioEvt++).padStart(3, '0')
    const recIn  = secsToTcCmx(0, fps)
    const recOut = secsToTcCmx(totalDur, fps)
    lines.push(`${evt}  ${voReel} A1    C        ${recIn} ${recOut} ${recIn} ${recOut}`)
    lines.push(`* FROM CLIP NAME: ${basename(vocalsPath)}`)
    lines.push('* DEMUCS-SEPARATED VO STEM (continuous — no voiceoverPlan in proposal)')
  }

  return lines.join('\n') + '\n'
}

// Simple-mode editor: two previews side by side (edited cut on the
// left, original on the right) plus the timeline below. No left panel,
// no inspector, no DopeSheet, no toolbar to add things. The user gets
// an A/B-friendly surface to review the proposed cut against the
// untouched source. They can flip to Advanced any time to get the full
// Resolve-style layout back.
//
// Props are passed in from App so timeline-height persistence + audio-
// generate modal access keep working without duplicating layout state.
export default function EditorSimple({
  timelineHeight,
  onTimelineResize,
  onOpenAudioGenerate,
}) {
  // Pull current project state for the export action. We deliberately
  // don't subscribe to the full project here — only the fields the
  // export reads — so unrelated edits don't re-render the editor.
  const proposal      = useProjectStore((s) => s.currentProject?.proposal || null)
  const scenes        = useProjectStore((s) => s.currentProject?.analysis?.scenes || [])
  const sourceVideo   = useProjectStore((s) => s.currentProject?.sourceVideo || null)
  // Generated i2v fills keyed by placeholderId — the EDL exporter
  // points placeholder rows at these files when they exist.
  const fills         = useProjectStore((s) => s.currentProject?.fills || null)
  // VO segments from the per-shot Gemini analysis pass. Drives the
  // EDL's A1 audio events when the proposer has a voiceoverPlan.
  const voSegments    = useProjectStore((s) => s.currentProject?.analysis?.overall?.voiceover_segments || null)
  const projectName   = useProjectStore((s) => s.currentProject?.name || 'project')
  const projectFps    = useProjectStore((s) => s.currentProject?.settings?.fps || 24)
  const projectHandle = useProjectStore((s) => s.currentProjectHandle)

  const [exporting, setExporting] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportNote, setExportNote] = useState(null)

  const canExport = Array.isArray(proposal?.edl) && proposal.edl.length > 0

  // Generic export-and-save helper. Writes `content` (string) to a path
  // the user picks via the native save dialog, defaulting under the
  // project folder so files land near the rest of the project artefacts.
  async function exportToFile({ content, defaultName, extension, label }) {
    if (!window.electronAPI?.saveFileDialog || !window.electronAPI?.writeFile) {
      setExportNote('Export needs the desktop build (no save-dialog in web mode).')
      return
    }
    setExporting(true)
    setExportNote(null)
    try {
      const defaultPath = typeof projectHandle === 'string'
        ? await window.electronAPI.pathJoin(projectHandle, defaultName)
        : defaultName
      const target = await window.electronAPI.saveFileDialog({
        title: `Export ${label}`,
        defaultPath,
        filters: [{ name: label, extensions: [extension] }],
      })
      if (!target) return    // user cancelled
      const res = await window.electronAPI.writeFile(target, content, { encoding: 'utf-8' })
      if (!res?.success) throw new Error(res?.error || 'Write failed.')
      setExportNote(`Saved → ${target}`)
    } catch (err) {
      setExportNote(`Export failed: ${err?.message || String(err)}`)
    } finally {
      setExporting(false)
      setExportMenuOpen(false)
    }
  }

  const handleExportJson = () => {
    // JSON keeps every field we know — referenceFrame, reframe,
    // colorAdjustments, extend, voLines via the analysis link, etc.
    // Round-trippable into the app for sharing or external edits.
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      project: projectName,
      fps: projectFps,
      rationale: proposal?.rationale || null,
      edl: proposal?.edl || [],
    }
    const safeName = String(projectName || 'project').replace(/[^a-zA-Z0-9._-]+/g, '_')
    exportToFile({
      content: JSON.stringify(payload, null, 2),
      defaultName: `${safeName}_edl.json`,
      extension: 'json',
      label: 'EDL (JSON)',
    })
  }

  const handleExportCmx = () => {
    const content = renderEdlCmx({ proposal, scenes, sourceVideo, fills, voSegments, fps: projectFps })
    const safeName = String(projectName || 'project').replace(/[^a-zA-Z0-9._-]+/g, '_')
    exportToFile({
      content,
      defaultName: `${safeName}.edl`,
      extension: 'edl',
      label: 'CMX-3600 EDL',
    })
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Top: two-up preview area. Left = edited cut (PreviewPanel —
          driven by the timeline cursor + transport). Right = original
          source video with native <video controls> for independent
          scrubbing. Equal-width split; both columns hide their overflow
          so a wide video letterboxes instead of pushing the layout. */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-row">
        <div className="flex-1 min-h-0 min-w-0 relative">
          {/* Tiny "Edit" tag so the user can read the split at a glance —
              same uppercase style as the Original column below. */}
          <div className="absolute top-1 left-1 z-10 px-2 py-0.5 rounded bg-black/55 text-[10px] uppercase tracking-wider text-sf-text-muted pointer-events-none">
            Edit
          </div>
          <PreviewPanel />
        </div>
        <div className="w-px h-full bg-sf-dark-700" />
        <div className="flex-1 min-h-0 min-w-0">
          <OriginalSourcePreview />
        </div>
      </div>

      {/* Resizable divider between Preview and Timeline */}
      <ResizeHandle direction="vertical" onResize={onTimelineResize} />

      {/* Bottom: Transport + Timeline (no DopeSheet switcher in Simple) */}
      <div style={{ height: timelineHeight }} className="flex-shrink-0 w-full flex flex-col min-h-0">
        {/* Transport row + Export-EDL split-button. Transport stays
            visually centred; the export action sits on the right
            edge so it doesn't fight the play controls for attention. */}
        <div className="flex-shrink-0 w-full flex items-center px-3">
          <div className="flex-1" />
          <div className="flex-shrink-0">
            <TransportControls />
          </div>
          <div className="flex-1 flex items-center justify-end gap-2 relative">
            {exportNote && (
              <span className="text-[10px] text-sf-text-muted truncate max-w-[280px]" title={exportNote}>
                {exportNote}
              </span>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={!canExport || exporting}
                title={canExport
                  ? 'Export the current EDL as JSON or CMX-3600'
                  : 'Generate + apply a proposal first to populate the EDL.'}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] font-medium bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-700 text-sf-text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {exporting
                  ? <Loader2 className="w-3 h-3 animate-spin"/>
                  : <Download className="w-3 h-3"/>}
                Export EDL
                <ChevronDown className="w-3 h-3 text-sf-text-muted" />
              </button>
              {exportMenuOpen && canExport && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-56 py-1 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl"
                  onMouseLeave={() => setExportMenuOpen(false)}
                >
                  <button
                    type="button"
                    onClick={handleExportJson}
                    className="w-full text-left px-3 py-2 text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
                  >
                    <div className="font-medium">JSON (.json)</div>
                    <div className="text-[10px] text-sf-text-muted leading-snug">Full schema — round-trippable, includes notes + reframe + color + fills metadata.</div>
                  </button>
                  <div className="h-px bg-sf-dark-600 my-0.5 mx-2" />
                  <button
                    type="button"
                    onClick={handleExportCmx}
                    className="w-full text-left px-3 py-2 text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors"
                  >
                    <div className="font-medium">CMX-3600 (.edl)</div>
                    <div className="text-[10px] text-sf-text-muted leading-snug">Industry-standard EDL — opens in Resolve, Premiere, Avid. Notes land as <span className="font-mono">* FROM CLIP NAME</span> comments.</div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 border-t border-sf-dark-700">
          <Timeline onOpenAudioGenerate={onOpenAudioGenerate} hideToolbar />
        </div>
      </div>
    </div>
  )
}
