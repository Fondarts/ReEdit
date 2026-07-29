import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Small scrub timeline over the source video for picking a reference
 * frame. Sits next to the t2i "Generate first frame" flow in the
 * placeholder modal — for a fill that has to cut against real footage, a
 * frame OF that footage carries the actual grade, lens and subject, which
 * a text prompt can't reproduce.
 *
 * Preview and capture are deliberately two different mechanisms: the
 * <video> element is only ever a viewfinder, and the frame that gets
 * saved is re-extracted by ffmpeg at the same timecode at native
 * resolution. Reading pixels back off the element would be both lower
 * res and liable to canvas-tainting under the custom media protocol.
 *
 * Ticks mark the shot boundaries from the analysis, so the user can line
 * up on the shots the fill sits between rather than hunting blindly.
 */

function fmtTc(sec) {
  if (!Number.isFinite(sec)) return '0:00.00'
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

export default function SourceFramePicker({
  sourceVideo,
  scenes = [],
  // Where to park the playhead on first open — normally the timecode of
  // the shot the placeholder is adjacent to.
  initialTcSec = 0,
  busy = false,
  onCapture, // (tcSec) => Promise<void> | void
}) {
  const videoRef = useRef(null)
  const [tcSec, setTcSec] = useState(initialTcSec)
  const [duration, setDuration] = useState(Number(sourceVideo?.durationSec) || 0)
  const [ready, setReady] = useState(false)

  const src = sourceVideo?.path
    ? `comfystudio://${encodeURIComponent(sourceVideo.path)}`
    : null

  // Seek the viewfinder whenever the playhead moves. Guarded on readiness
  // so an early seek doesn't get dropped before metadata lands.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !ready) return
    if (Math.abs((el.currentTime || 0) - tcSec) > 0.005) {
      try { el.currentTime = tcSec } catch { /* seek raced a reload */ }
    }
  }, [tcSec, ready])

  useEffect(() => {
    setTcSec(Number.isFinite(initialTcSec) ? initialTcSec : 0)
  }, [initialTcSec])

  const handleLoaded = () => {
    const el = videoRef.current
    if (!el) return
    if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
    setReady(true)
    try { el.currentTime = tcSec } catch { /* ignore */ }
  }

  const clamp = (v) => Math.max(0, Math.min(duration || 0, v))
  const step = (delta) => setTcSec((prev) => clamp(prev + delta))

  // One tick per shot boundary, as a % of the timeline width.
  const ticks = useMemo(() => {
    if (!duration) return []
    return (scenes || [])
      .map((s) => Number(s?.tcIn))
      .filter((t) => Number.isFinite(t) && t > 0 && t < duration)
      .map((t) => ({ t, pct: (t / duration) * 100 }))
  }, [scenes, duration])

  // Frame step size — real frames when we know the rate, else a small
  // constant so the buttons still do something sensible.
  const frameStep = Number(sourceVideo?.fps) > 0 ? 1 / Number(sourceVideo.fps) : 0.04

  if (!src) {
    return (
      <p className="text-xs text-sf-text-muted">
        No source video on this project — import one to pick a reference frame from it.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-950/60 p-2.5 space-y-2">
      <div className="flex items-start gap-3">
        {/* Viewfinder */}
        <div className="relative rounded overflow-hidden bg-black shrink-0" style={{ width: 220 }}>
          <video
            ref={videoRef}
            src={src}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={handleLoaded}
            className="w-full h-auto block"
          />
          <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white/90 text-[9px] font-mono pointer-events-none">
            {fmtTc(tcSec)}
          </div>
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-[11px] text-sf-text-secondary leading-snug">
            Scrub the source and grab a real frame to use as the reference. Best when the
            fill has to match footage that&apos;s already in the cut — it carries the actual
            lighting, grade and subject.
          </p>

          {/* Scrub track + shot ticks */}
          <div className="relative pt-1">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(tcSec, duration || 0)}
              onChange={(e) => setTcSec(clamp(parseFloat(e.target.value)))}
              disabled={!duration}
              className="w-full accent-sf-accent"
              aria-label="Source video position"
            />
            <div className="relative h-2 mt-0.5">
              {ticks.map(({ t, pct }) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTcSec(clamp(t))}
                  title={`Shot starts at ${fmtTc(t)} — click to snap`}
                  className="absolute top-0 w-px h-2 bg-sf-text-muted/50 hover:bg-sf-accent"
                  style={{ left: `${pct}%` }}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => step(-frameStep)}
                disabled={!duration || busy}
                title="Previous frame"
                className="p-1 rounded border border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => step(frameStep)}
                disabled={!duration || busy}
                title="Next frame"
                className="p-1 rounded border border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:text-sf-text-primary hover:border-sf-dark-500 disabled:opacity-40"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] text-sf-text-muted font-mono ml-1">
                {fmtTc(tcSec)} / {fmtTc(duration)}
              </span>
            </div>

            <button
              type="button"
              onClick={() => onCapture?.(tcSec)}
              disabled={!duration || busy}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                ${!duration || busy
                  ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                  : 'border border-sf-accent/50 bg-sf-accent/10 text-sf-text-primary hover:bg-sf-accent/20'}`}
            >
              {busy
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Crosshair className="w-3.5 h-3.5" />}
              {busy ? 'Grabbing…' : 'Use this frame'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
