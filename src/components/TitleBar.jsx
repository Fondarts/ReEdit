import { useEffect, useState } from 'react'
import { Copy, Minus, Settings as SettingsIcon, Square, X } from 'lucide-react'
import ComfyLauncherChip from './ComfyLauncherChip'
import UiModeToggle from './UiModeToggle'
import { useUiMode } from '../hooks/useUiMode'
import { REEDIT_TABS } from '../config/mode'

// Auto mode hides everything except Import + Proposal — the user uploads
// material in Import, hits Go, and the orchestrator runs the remaining
// steps in the background and lands on Proposal.
const LUCKY_REEDIT_TAB_IDS = new Set(['import', 'proposal', 'editor', 'review', 'export'])

function TitleBar({
  projectName,
  activeTab = 'editor',
  onTabChange,
  centerInsetLeft = 0,
  centerInsetRight = 0,
  showComfyUiTab = false,
  onOpenSettings,
}) {
  // The TitleBar surfaces the re-edit pipeline tabs in pipeline order.
  // The ComfyUI iframe tab stays opt-in via showComfyUiTab, appended at
  // the end so power users can still jump into raw ComfyUI.
  //
  // The UI mode is owned by the shared hook so a toggle flip from
  // anywhere (TitleBar, WelcomeScreen, dev tools) refreshes this list
  // without a hand-rolled event listener.
  const uiMode = useUiMode()

  const visibleReeditTabs = uiMode === 'lucky'
    ? REEDIT_TABS.filter((t) => LUCKY_REEDIT_TAB_IDS.has(t.id))
    : REEDIT_TABS

  const tabs = showComfyUiTab
    ? [...visibleReeditTabs, { id: 'comfyui', label: 'ComfyUI' }]
    : visibleReeditTabs.filter(t => t.id !== 'comfyui')

  // If the active tab gets hidden by switching to Auto mode, bounce the
  // user to the first visible tab. Otherwise they'd be looking at a
  // workspace that's still mounted but unreachable from the TitleBar.
  useEffect(() => {
    if (!tabs.find((t) => t.id === activeTab) && tabs.length > 0) {
      onTabChange?.(tabs[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode])
  const [windowState, setWindowState] = useState({
    isMaximized: false,
    isFullScreen: false,
  })

  useEffect(() => {
    let mounted = true
    let unsubscribe = null

    const loadWindowState = async () => {
      try {
        const nextState = await window.electronAPI?.getWindowState?.()
        if (mounted && nextState) {
          setWindowState({
            isMaximized: Boolean(nextState.isMaximized),
            isFullScreen: Boolean(nextState.isFullScreen),
          })
        }
      } catch (_) {
        // Ignore missing Electron bridge/state fetch errors in non-Electron contexts.
      }
    }

    loadWindowState()

    unsubscribe = window.electronAPI?.onWindowStateChanged?.((nextState) => {
      if (!mounted || !nextState) return
      setWindowState({
        isMaximized: Boolean(nextState.isMaximized),
        isFullScreen: Boolean(nextState.isFullScreen),
      })
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])

  const isRestoreDown = windowState.isMaximized || windowState.isFullScreen

  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow?.()
  }

  const handleToggleMaximize = () => {
    window.electronAPI?.toggleMaximizeWindow?.()
  }

  const handleCloseWindow = () => {
    window.electronAPI?.closeWindow?.()
  }
  
  return (
    <div className="h-10 bg-black flex items-center justify-between px-4 drag-region relative">
      {/* Left - Kissd brand mark: graffiti wordmark + red "ReEdit" name.
          Sits in the title bar's left slot so it doesn't crowd the
          launcher / mode-toggle / window-control cluster on the right.
          The SVG lives in /public so it can be hot-swapped with a
          higher-fidelity asset (same filename) without a rebuild. */}
      <div className="no-drag flex-shrink-0 flex items-center gap-2 select-none">
        <img
          src="/kissd-logo.svg"
          alt="Kissd"
          className="h-5 w-auto"
          draggable={false}
        />
        <span
          className="text-[14px] font-extrabold tracking-tight leading-none"
          style={{ color: '#EC1C24' }}
        >
          ReEdit
        </span>
      </div>
      
      {/* Center - App mode tabs. Pill-shaped, centered on the full
          window width (not between the side panels) so the bar reads
          symmetrically regardless of left/right inset sizes. Each tab
          is its own rounded pill inside the wrapper — the active one
          stands out with the accent fill and a soft glow, the inactive
          ones use a subtle hover state. No separators between tabs;
          the rounded shapes already provide enough visual grouping. */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex items-center pointer-events-none">
        <div className="no-drag flex items-center gap-0.5 h-9 bg-sf-dark-800/80 border border-sf-dark-700 rounded-full p-1 shadow-md shadow-black/30 pointer-events-auto">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id
            return (
              <div key={tab.id} className="relative flex h-full items-center">
                <button
                  onClick={() => onTabChange?.(tab.id)}
                  className={`px-4 h-full inline-flex items-center justify-center text-[12.5px] font-medium rounded-full transition-colors ${
                    isActive
                      ? 'bg-sf-accent text-white shadow-sm shadow-sf-accent/30'
                      : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700/70'
                  }`}
                >
                  {tab.label}
                </button>
                {tab.id === 'mog' && isActive && (
                  <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 rounded-full bg-pink-300/12 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-pink-200/65 shadow-[0_0_10px_rgba(244,114,182,0.12)]">
                    beta
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      
      {/* Right - Launcher chip + Window Controls (Windows style) */}
      <div className="flex items-center">
        {/* Auto / Simple / Advanced toggle — shared with the
            WelcomeScreen header so the persisted preference is the
            same regardless of where it was set. */}
        <UiModeToggle className="mr-2" />
        <ComfyLauncherChip />
        {/* Quick settings entry point next to the ComfyUI pill. Jumps
            straight to the Launcher section so the most common use
            (point at the run_nvidia_gpu.bat, change port, tweak
            auto-start) is one click away instead of hunting in the
            bottom-bar menu. */}
        {onOpenSettings && (
          <button
            type="button"
            onClick={() => onOpenSettings('launcher')}
            className="no-drag h-7 w-7 mr-1 flex items-center justify-center rounded-md bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-700 text-sf-text-muted hover:text-sf-text-primary transition-colors"
            title="Open Settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={handleMinimize}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title="Minimize"
        >
          <Minus className="w-4 h-4 text-sf-text-secondary" />
        </button>
        <button
          onClick={handleToggleMaximize}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title={isRestoreDown ? 'Restore Down' : 'Maximize'}
        >
          {isRestoreDown ? (
            <Copy className="w-3 h-3 text-sf-text-secondary" />
          ) : (
            <Square className="w-3 h-3 text-sf-text-secondary" />
          )}
        </button>
        <button
          onClick={handleCloseWindow}
          className="no-drag w-10 h-10 flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4 text-sf-text-secondary" />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
