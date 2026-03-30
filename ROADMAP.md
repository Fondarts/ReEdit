# ComfyStudio Roadmap

ComfyStudio is evolving into an AI-native editing and generation environment built around ComfyUI.

The goal is simple: make it easier to go from idea to edit to finished output inside one tool.

This roadmap reflects our current priorities. It will continue to evolve as we ship features, test workflows, and get feedback from real users.

## Current Direction

Our focus is split across three major areas:

1. Core editing polish
2. Expanded generation workflows
3. Higher-level creative tooling, including music video generation

Near-term execution note:

We want to handle the next editing improvements one at a time. The goal is to ship, test, and stabilize each feature before moving to the next one so bugs stay manageable and the workflow gets better in clear steps instead of large batches.

## What Already Exists

ComfyStudio already includes a strong foundation that we want to keep improving:

- Timeline-based editing
- Asset browser and preview workflow
- Cut at playhead
- Marquee selection
- Audio waveforms
- Track management
- Text layers and inspector controls
- Local and cloud ComfyUI workflow support
- Built-in workflow dependency checks
- Director Mode and guided generation flows

The roadmap below focuses on making these systems faster, deeper, and more production-friendly.

## Phase 1: Core Editing Polish

These are the highest-priority editing improvements aimed at making the editor feel faster, tighter, and more professional for day-to-day use.

- Cut through all tracks at the playhead
- Select everything from the playhead to the end of the timeline
- Visual fade in and fade out controls directly on audio clips
- Capture a still frame from the preview window into project assets
- Improve clip movement and timeline precision
- Continue tightening overall editing speed and usability

### Current Step-by-Step Editing Queue

The items below are intended to be handled sequentially, not all at once.

1. Linked audio and video clip pairs
   Import clips with audio as linked video/audio pairs by default, keep them in sync while moving, and add timeline `Link` / `Unlink` actions for selected clips with assignable hotkeys.
2. Timeline scroll, zoom, and playhead follow
   Let the scroll wheel move forward and backward through the timeline, move zoom to `+` / `-` or configurable hotkeys, and keep the timeline view following the playhead during playback.
3. Empty-space selection and gap targeting
   Allow users to select dead space between clips directly in the timeline so gaps become first-class edit targets.
4. Ripple delete
   Delete the selected clip or selected empty space and automatically close the gap so timeline cleanup is faster.
5. Fade handle polish
   Flip the fade slope direction to feel more intuitive and show the fade duration in `seconds:frames` while dragging.
6. Better transform bounds and rotation controls
   Show clip bounds outside the visible frame, keep the clip image constrained to the timeline frame, and add clearer corner-based rotation controls similar to Photoshop / After Effects.
7. Richer clip info at the top of Inspector
   Surface resolution, FPS, codec, and other useful media info at the top of the Inspector, and show time as `hours:minutes:seconds:frames` instead of decimal seconds.
8. Stronger timeline marquee selection
   Improve click-and-drag selection in the timeline so users can quickly grab large groups of clips without relying on repeated `Shift` clicks.
9. Marker and playhead visual separation
   Make markers clearly distinct from the playhead through shape and color changes so they are easier to read at a glance.
10. Keyframe color and multi-select improvements
   Make the selected keyframe the brightest state, keep keyframe colors more intuitive, and support dragging multiple keyframes together for faster ease and timing adjustments.
11. Dope Sheet clip reference strip
   Add a visual filmstrip or clip reference above animated properties in the Dope Sheet so users can see where keyframes land against the source clip.
12. Per-clip enable / disable
   Let users enable or disable selected clips directly, separate from full-track toggles, with a context-menu action and a hotkey.
13. Audio gain and future audio controls
   Add per-clip audio boost in the Inspector so quiet recordings can be raised above recorded level, with future expansion toward gating, denoise, compression, reverb, and volume keyframes.
14. Audio meter playback bug and ruler polish
   Fix the issue where the audio meters keep moving after playback stops, and improve the meter ruler with clearer tick marks and labels such as every `5 dB`.

## Phase 2: Precision Editing and Pro Workflow Features

This phase focuses on features that help experienced editors work faster and with more control.

- Move selected clips by exact timecode offset
- Extend clip duration by a chosen amount
- Better multi-clip movement across tracks
- Show timelines and sequences in a dedicated browser section and open them directly from the Assets panel
- More direct text editing workflows
- Better editing toolbar coverage
- Fully customizable keyboard shortcuts and hotkeys in settings
- Editor keymap profiles with familiar presets such as Premiere Pro, Resolve, and Final Cut Pro

## Phase 3: Workflow Expansion

ComfyStudio is not just an editor. It is also a generation environment. This phase focuses on expanding creative options inside the app.

- Add more built-in workflows
- Expand both local and cloud workflow coverage
- Improve workflow discovery and usability
- Add stronger workflow grouping by use case
- Improve setup guidance for models, nodes, and dependencies
- Continue building workflows for image, video, audio, and hybrid pipelines

## Phase 4: Music Video Generation

One of the most exciting directions for ComfyStudio is turning it into a more complete system for music-driven creative output.

This phase is focused on building a dedicated music video generation workflow that can help creators move from concept to sequence faster.

Areas we want to explore:

- Music-driven generation workflows
- Faster shot ideation for songs and visual themes
- Better sequencing between generated clips and edit decisions
- Tools that support rhythm, pacing, and structure
- A smoother path from generated visuals to a finished music video timeline

This area is still being shaped and will likely grow based on experimentation and creator feedback.

## Phase 5: Creative Automation and Higher-Level Tools

Beyond individual workflows, we want ComfyStudio to become a stronger creative system for structured generation and editing.

Longer-term areas of interest include:

- Smarter sequence building
- Better AI-assisted edit preparation
- More advanced shot planning tools
- Stronger automation between prompts, assets, and timeline structure
- Better project templates for repeatable creative workflows

## Product Principles

As ComfyStudio grows, we want to stay grounded in a few principles:

- The editor should feel fast and intuitive
- Generation should support the edit, not interrupt it
- Powerful features should still feel accessible
- Local-first creative workflows should remain a core strength
- Real user feedback should continue shaping priorities

## Notes

This roadmap is a living document. Priorities may shift as features ship, workflows mature, and new feedback comes in.

If you use ComfyStudio and have thoughts on editing, generation, or workflow design, feedback is always welcome.
