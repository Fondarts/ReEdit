// Central feature flag for the project:re-edit fork of ComfyStudio.
//
// When REEDIT_MODE is true the TitleBar exposes the re-edit pipeline tabs
// (Import → Analysis → Proposal → Editor → Export) and hides the generic
// ComfyStudio tabs (Generate, MoGraph, Stock, LLM). The original components
// stay in the bundle so upstream cherry-picks still apply cleanly; we'll
// delete the hidden surfaces after M1 lands.

export const REEDIT_MODE = true

// Tabs visible in the TitleBar under REEDIT_MODE, in display order.
// Ids must match the branches in App.jsx's render switch.
export const REEDIT_TABS = [
  { id: 'projects', label: 'Projects' },
  { id: 'import', label: 'Import' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'editor', label: 'Editor' },
  { id: 'export', label: 'Export' },
]

// Tab ids that render a single full-screen workspace (no left panel /
// inspector / timeline docked around them). The editor tab keeps the
// Resolve-style layout; the other re-edit tabs are single-panel.
export const REEDIT_FULLSCREEN_TABS = new Set(['projects', 'import', 'analysis', 'proposal'])

// Decide the initial tab when a project is opened or created.
// - No sourceVideo yet → Import.
// - Has video, no approved proposal → Analysis (user continues from where they left).
// - Approved proposal → Editor (the timeline is the right workspace).
export function pickInitialReeditTab(project) {
  if (!project) return 'import'
  if (!project.sourceVideo) return 'import'
  if (project.proposal?.status === 'approved') return 'editor'
  return 'analysis'
}
