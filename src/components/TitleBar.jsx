import { Fragment, useEffect, useState } from 'react'
import { Copy, Minus, Settings as SettingsIcon, Square, X, Sparkles, SlidersHorizontal } from 'lucide-react'
import ComfyLauncherChip from './ComfyLauncherChip'
import { REEDIT_MODE, REEDIT_TABS } from '../config/mode'

const TOP_TABS = [
  { id: 'editor', label: 'Editor' },
  { id: 'generate', label: 'Generate' },
  { id: 'mog', label: 'MoGraph' },
  { id: 'stock', label: 'Stock' },
  { id: 'comfyui', label: 'ComfyUI' },
  { id: 'llm-assistant', label: 'LLM' },
  { id: 'export', label: 'Export' },
]

// Tabs visibles en modo Simple (sub-conjunto de REEDIT_TABS). Esconde
// pasos técnicos (Optimization) y la timeline pro (Editor). El user toggleable
// queda persistido en localStorage para que sobreviva reloads.
const UI_MODE_STORAGE_KEY = 'comfystudio-ui-mode'
const SIMPLE_REEDIT_TAB_IDS = new Set(['projects', 'import', 'analysis', 'optimization', 'proposal', 'editor', 'export'])

function readPersistedUiMode() {
  try {
    const v = localStorage.getItem(UI_MODE_STORAGE_KEY)
    return v === 'simple' ? 'simple' : 'advanced'
  } catch { return 'advanced' }
}

function TitleBar({
  projectName,
  activeTab = 'editor',
  onTabChange,
  centerInsetLeft = 0,
  centerInsetRight = 0,
  showComfyUiTab = false,
  onOpenSettings,
}) {
  // Under REEDIT_MODE the TitleBar surfaces the re-edit pipeline tabs in
  // pipeline order and hides the generic ComfyStudio ones. The ComfyUI
  // iframe tab stays opt-in via the same showComfyUiTab setting, appended
  // at the end so power users can still jump into raw ComfyUI.
  const [uiMode, setUiModeState] = useState(readPersistedUiMode)

  // Notify other components of UI-mode changes via the same event-bus
  // pattern the rest of the app uses (no global store needed). Anybody
  // that wants to react to it can subscribe to `comfystudio-ui-mode-changed`.
  const setUiMode = (next) => {
    if (next === uiMode) return
    try { localStorage.setItem(UI_MODE_STORAGE_KEY, next) } catch { /* ignore */ }
    setUiModeState(next)
    try {
      window.dispatchEvent(new CustomEvent('comfystudio-ui-mode-changed', { detail: next }))
    } catch { /* ignore */ }
  }

  const allReeditTabs = REEDIT_TABS
  const visibleReeditTabs = uiMode === 'simple'
    ? allReeditTabs.filter((t) => SIMPLE_REEDIT_TAB_IDS.has(t.id))
    : allReeditTabs

  const baseTabs = REEDIT_MODE ? visibleReeditTabs : TOP_TABS
  const tabs = showComfyUiTab
    ? (REEDIT_MODE ? [...baseTabs, { id: 'comfyui', label: 'ComfyUI' }] : baseTabs)
    : baseTabs.filter(t => t.id !== 'comfyui')

  // If the active tab gets hidden by switching to Simple mode, bounce the
  // user to the first visible tab. Otherwise they'd be looking at a
  // workspace that's still mounted but unreachable from the TitleBar.
  useEffect(() => {
    if (!REEDIT_MODE) return
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
      {/* Left - Spacer for center alignment */}
      <div className="w-[120px] flex-shrink-0" />
      
      {/* Center - App mode tabs; extend 1px into content so grey touches with no black line */}
      <div
        className="absolute top-0 flex items-center justify-center"
        style={{
          left: `${centerInsetLeft}px`,
          right: `${centerInsetRight}px`,
          bottom: -1,
          height: 'calc(100% + 1px)'
        }}
      >
        <div className="no-drag flex items-center gap-0 h-full bg-sf-dark-800 border-x border-sf-dark-700 border-t-0 rounded-none p-0.5">
          {tabs.map((tab, index) => (
            <Fragment key={tab.id}>
              {index > 0 && (
                <div className="w-px h-4 bg-sf-dark-600 flex-shrink-0" aria-hidden="true" />
              )}
              <div className="relative flex h-full items-center">
                <button
                  onClick={() => onTabChange?.(tab.id)}
                  className={`px-3 py-1 text-[11px] rounded-none transition-colors ${
                    activeTab === tab.id
                      ? 'bg-sf-accent text-white'
                      : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
                  }`}
                >
                  {tab.label}
                </button>
                {tab.id === 'mog' && activeTab === 'mog' && (
                  <div className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 rounded-full bg-pink-300/12 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-pink-200/65 shadow-[0_0_10px_rgba(244,114,182,0.12)]">
                    beta
                  </div>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      
      {/* Right - Launcher chip + Window Controls (Windows style) */}
      <div className="flex items-center">
        {/* Simple / Advanced UI mode toggle. Simple hides Optimization and
            the Resolve-style Editor; Advanced shows the full pipeline.
            Persisted in localStorage so it survives reloads. */}
        {REEDIT_MODE && (
          <div className="no-drag flex items-center bg-sf-dark-800 border border-sf-dark-700 rounded-md mr-2 overflow-hidden">
            <button
              type="button"
              onClick={() => setUiMode('simple')}
              title="Simple — guided linear flow"
              className={`h-7 px-2 flex items-center gap-1 text-[10px] transition-colors ${
                uiMode === 'simple'
                  ? 'bg-sf-accent text-white'
                  : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
              }`}
            >
              <Sparkles className="w-3 h-3" /> Simple
            </button>
            <button
              type="button"
              onClick={() => setUiMode('advanced')}
              title="Advanced — full pipeline with Optimization + Editor"
              className={`h-7 px-2 flex items-center gap-1 text-[10px] transition-colors ${
                uiMode === 'advanced'
                  ? 'bg-sf-accent text-white'
                  : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700'
              }`}
            >
              <SlidersHorizontal className="w-3 h-3" /> Advanced
            </button>
          </div>
        )}
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
