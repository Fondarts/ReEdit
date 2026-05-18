import PreviewPanel from '../../PreviewPanel'
import TransportControls from '../../TransportControls'
import Timeline from '../../Timeline'
import ResizeHandle from '../../ResizeHandle'

// Simple-mode editor: just the player and the timeline. No left panel,
// no inspector, no DopeSheet, no toolbar to add things. The user gets a
// no-op-friendly surface to review the proposed cut and scrub through
// it. They can flip to Advanced any time to get the full Resolve-style
// layout back.
//
// Props are passed in from App so timeline-height persistence + audio-
// generate modal access keep working without duplicating layout state.
export default function EditorSimple({
  timelineHeight,
  onTimelineResize,
  onOpenAudioGenerate,
}) {
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Preview — fills the upper area edge to edge */}
      <div className="flex-1 min-h-0 min-w-0">
        <PreviewPanel />
      </div>

      {/* Resizable divider between Preview and Timeline */}
      <ResizeHandle direction="vertical" onResize={onTimelineResize} />

      {/* Bottom: Transport + Timeline (no DopeSheet switcher in Simple) */}
      <div style={{ height: timelineHeight }} className="flex-shrink-0 w-full flex flex-col min-h-0">
        <div className="flex-shrink-0 w-full flex items-center justify-center">
          <TransportControls />
        </div>
        <div className="flex-1 min-h-0 border-t border-sf-dark-700">
          <Timeline onOpenAudioGenerate={onOpenAudioGenerate} hideToolbar />
        </div>
      </div>
    </div>
  )
}
