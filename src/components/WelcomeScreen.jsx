import { useState, useEffect, useRef } from 'react'
import { FolderOpen, Plus, Film, AlertCircle, Loader2, Trash2, LayoutGrid, List, Minus, Square, Copy, X, Settings as SettingsIcon, Upload, FileText, Video as VideoIcon } from 'lucide-react'
import useProjectStore from '../stores/projectStore'
import NewReeditProjectDialog from './reedit/NewReeditProjectDialog'
import ComfyLauncherChip from './ComfyLauncherChip'
import CreditsChip from './CreditsChip'
import SettingsModal from './SettingsModal'
import UiModeToggle from './UiModeToggle'
import { resolveThumbnailUrl } from '../utils/projectThumbnail'

const WELCOME_ASSET_BASE_URL = (() => {
  const rawBase = typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
    ? String(import.meta.env.BASE_URL)
    : '/'
  return rawBase.endsWith('/') ? rawBase : `${rawBase}/`
})()

function getWelcomeAssetPath(filename) {
  const safeFilename = String(filename || '').replace(/^\/+/, '')
  return `${WELCOME_ASSET_BASE_URL}${safeFilename}`
}

/**
 * Hero loop with soft dissolve between iterations.
 *
 * HTML `<video loop>` restarts hard — perfect for a tight 2s cycle, jarring
 * for a 15s cinematic plate like the kling asset. To get a cross-dissolve
 * we render two `<video>` elements pointed at the same source, each muted
 * and each controlled independently. One plays through, and when it has
 * `fadeSeconds` left we start the other from t=0 and let CSS animate their
 * opacities past each other. On the next handoff we swap roles.
 *
 * Why two videos of the same file instead of a pre-baked crossfade in the
 * MP4 itself: baking the dissolve into the file forces a specific fade
 * duration and introduces a double-exposure region in the asset. Doing it
 * at playback time keeps the asset clean and the fade duration tunable.
 *
 * Why not requestAnimationFrame opacity tweens: `transition: opacity … s
 * linear` on the style attr is cheaper, butter-smooth, and survives React
 * re-renders without custom tear-down code. The only runtime bookkeeping
 * we need is "when remaining time on the active video dips below
 * fadeSeconds, kick off the other one."
 */
function HeroVideoLoop({ src, poster, fadeSeconds = 5, className = '', style = {} }) {
  const videoARef = useRef(null)
  const videoBRef = useRef(null)
  // `active` is the side currently fading IN / holding the visible frame.
  // We mirror it into a ref so the timeupdate handlers — which close over
  // the initial render — read the current value rather than a stale one.
  const [active, setActive] = useState('A')
  const activeRef = useRef('A')
  useEffect(() => { activeRef.current = active }, [active])

  // Kick off the A side on mount. We wait for metadata so `duration` is
  // available before the first timeupdate fires; otherwise the `remaining`
  // check would short-circuit with NaN and never trigger the handoff.
  useEffect(() => {
    const a = videoARef.current
    if (!a) return
    let cancelled = false
    const tryPlay = () => {
      if (cancelled) return
      a.play().catch(() => {
        // Autoplay blocked. The reduced-motion <img> fallback will show
        // instead; we don't retry noisily here.
      })
    }
    if (a.readyState >= 1) tryPlay()
    else a.addEventListener('loadedmetadata', tryPlay, { once: true })
    return () => {
      cancelled = true
      a.removeEventListener('loadedmetadata', tryPlay)
    }
  }, [])

  const handleTimeUpdate = (side) => (event) => {
    const el = event.currentTarget
    const duration = Number(el.duration) || 0
    if (!duration || !isFinite(duration)) return
    const remaining = duration - el.currentTime
    if (remaining > fadeSeconds) return
    if (activeRef.current !== side) return
    // We're the active side and we're inside the fade window — hand off.
    const otherSide = side === 'A' ? 'B' : 'A'
    const otherEl = otherSide === 'A' ? videoARef.current : videoBRef.current
    if (otherEl) {
      try { otherEl.currentTime = 0 } catch (_) { /* ignore seek failure */ }
      otherEl.play().catch(() => { /* same rationale as above */ })
    }
    activeRef.current = otherSide
    setActive(otherSide)
  }

  // Pause the fully-faded-out side when its dissolve completes, so the GPU
  // doesn't keep decoding two 1080p streams for the ~10s between handoffs.
  const handleTransitionEnd = (side) => (event) => {
    if (event.propertyName !== 'opacity') return
    if (activeRef.current === side) return
    const el = side === 'A' ? videoARef.current : videoBRef.current
    if (el && !el.paused) {
      try { el.pause() } catch (_) { /* ignore */ }
    }
  }

  const videoStyle = (side) => ({
    ...style,
    opacity: active === side ? 1 : 0,
    transitionProperty: 'opacity',
    transitionDuration: `${fadeSeconds}s`,
    transitionTimingFunction: 'linear',
  })

  return (
    <>
      <video
        ref={videoARef}
        src={src}
        poster={poster}
        className={className}
        style={videoStyle('A')}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        draggable={false}
        onTimeUpdate={handleTimeUpdate('A')}
        onTransitionEnd={handleTransitionEnd('A')}
      />
      <video
        ref={videoBRef}
        src={src}
        poster={poster}
        className={className}
        style={videoStyle('B')}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        draggable={false}
        onTimeUpdate={handleTimeUpdate('B')}
        onTransitionEnd={handleTransitionEnd('B')}
      />
    </>
  )
}

function WelcomeScreen() {
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [recentProjectsList, setRecentProjectsList] = useState([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  // Resolved <img>-ready URLs for each project's on-disk thumbnail, keyed
  // by project path (Electron) or name (web fallback).
  const [thumbnailUrls, setThumbnailUrls] = useState({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState(null)
  const [windowState, setWindowState] = useState({ isMaximized: false, isFullScreen: false })
  
  const {
    isFirstRun,
    isLoading,
    error,
    defaultProjectsHandle,
    defaultProjectsLocation,
    recentProjects,
    checkBrowserSupport,
    selectDefaultProjectsLocation,
    openProjectFromPicker,
    openLatestAutosaveForFailedProject,
    openRecentProject,
    removeRecentProject,
    clearError,
    getRecentProjectsList,
    isElectronMode,
    lastFailedProjectHandle,
    lastFailedProjectName,
    showHeroBackground,
    projectListViewMode,
    setProjectListViewMode,
  } = useProjectStore()
  
  const isBrowserSupported = checkBrowserSupport()
  const canOpenLatestAutosave = Boolean(
    lastFailedProjectHandle && error?.includes('Project file is empty or invalid')
  )
  const welcomeHeroVideoSrc = getWelcomeAssetPath('welcome-hero.mp4')
  const welcomeHeroPosterSrc = getWelcomeAssetPath('hero-v1.webp')
  
  // Load recent projects on mount
  useEffect(() => {
    const loadRecentProjects = async () => {
      if (defaultProjectsHandle) {
        setLoadingProjects(true)
        try {
          const projects = await getRecentProjectsList()
          setRecentProjectsList(projects)
        } catch (err) {
          console.error('Error loading recent projects:', err)
        }
        setLoadingProjects(false)
      } else {
        setRecentProjectsList(recentProjects)
      }
    }
    
    loadRecentProjects()
  }, [defaultProjectsHandle, recentProjects])

  // Once we have the list, resolve any on-disk thumbnail pointers into
  // <img>-ready URLs. We do this separately so the grid can render cards
  // immediately (with placeholder icons) while thumbnails swap in as they
  // resolve, matching Resolve's "pop in" behaviour.
  useEffect(() => {
    let cancelled = false
    const urls = {}
    const run = async () => {
      for (const project of recentProjectsList) {
        if (cancelled) return
        if (!project?.thumbnail) continue
        try {
          const url = await resolveThumbnailUrl(
            project.path || project.handle,
            project.thumbnail
          )
          if (cancelled) return
          if (url) {
            const key = project.path || project.name
            urls[key] = url
            // Push each as it resolves so cards don't wait for the slowest.
            setThumbnailUrls((prev) => ({ ...prev, [key]: url }))
          }
        } catch (_) {
          // Non-fatal; card falls back to placeholder icon.
        }
      }
    }
    // Clear any stale URLs before resolving the new batch so removed
    // projects don't linger.
    setThumbnailUrls({})
    run()
    return () => {
      cancelled = true
    }
  }, [recentProjectsList])
  
  // Format date for display
  const formatDate = (isoString) => {
    if (!isoString) return 'Unknown'
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now - date
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString()
  }
  
  // Handle opening a recent project
  const handleOpenRecent = async (project) => {
    // Use the unified openRecentProject function which handles both Electron and web modes
    await openRecentProject(project)
  }

  // Keep native-style window controls in sync with the Electron main window.
  useEffect(() => {
    let mounted = true

    const load = async () => {
      try {
        const next = await window.electronAPI?.getWindowState?.()
        if (mounted && next) {
          setWindowState({
            isMaximized: Boolean(next.isMaximized),
            isFullScreen: Boolean(next.isFullScreen),
          })
        }
      } catch (_) { /* non-Electron contexts */ }
    }
    load()

    const unsubscribe = window.electronAPI?.onWindowStateChanged?.((next) => {
      if (!mounted || !next) return
      setWindowState({
        isMaximized: Boolean(next.isMaximized),
        isFullScreen: Boolean(next.isFullScreen),
      })
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [])

  const isRestoreDown = windowState.isMaximized || windowState.isFullScreen
  const handleMinimize = () => window.electronAPI?.minimizeWindow?.()
  const handleToggleMaximize = () => window.electronAPI?.toggleMaximizeWindow?.()
  const handleCloseWindow = () => window.electronAPI?.closeWindow?.()

  // Native-style title strip — thin drag region with window controls.
  // Matches the TitleBar used once a project is open so users always have
  // access to minimize / maximize / close, even on first run.
  const titleStrip = (
    <div className="h-8 flex-shrink-0 bg-black flex items-stretch justify-end drag-region select-none">
      <div className="no-drag flex items-stretch">
        <button
          onClick={handleMinimize}
          className="w-11 h-8 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title="Minimize"
          aria-label="Minimize"
        >
          <Minus className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        <button
          onClick={handleToggleMaximize}
          className="w-11 h-8 flex items-center justify-center hover:bg-sf-dark-700 transition-colors"
          title={isRestoreDown ? 'Restore Down' : 'Maximize'}
          aria-label={isRestoreDown ? 'Restore Down' : 'Maximize'}
        >
          {isRestoreDown ? (
            <Copy className="w-3 h-3 text-sf-text-secondary" />
          ) : (
            <Square className="w-3 h-3 text-sf-text-secondary" />
          )}
        </button>
        <button
          onClick={handleCloseWindow}
          className="w-11 h-8 flex items-center justify-center hover:bg-red-600 transition-colors"
          title="Close"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
      </div>
    </div>
  )

  // First-run setup screen
  if (isFirstRun || !defaultProjectsHandle) {
    return (
      <div className="h-screen bg-sf-dark-950 flex flex-col">
        {titleStrip}
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md w-full mx-4">
          {/* Branding */}
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-sf-text-primary">ComfyStudio</h1>
          </div>
          
          {/* Browser Support Warning - only show in web mode */}
          {!isBrowserSupported && !isElectronMode() && (
            <div className="mb-6 p-4 bg-sf-error/20 border border-sf-error/50 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-sf-error flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-sf-text-primary font-medium">Browser Not Supported</p>
                  <p className="text-xs text-sf-text-muted mt-1">
                    ComfyStudio requires the File System Access API. Please use Google Chrome or Microsoft Edge.
                  </p>
                </div>
              </div>
            </div>
          )}
          
          {/* Setup Card */}
          <div className="bg-sf-dark-900 border border-sf-dark-700 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-sf-text-primary mb-2 text-center">Set Up Your Workspace</h2>
            <p className="text-sm text-sf-text-muted mb-6">
              Choose a folder where your ComfyStudio projects and media will be stored. Each project will have its own subfolder with all assets and imported media organized inside.
            </p>
            
            {/* Current Location Display */}
            {defaultProjectsLocation && (
              <div className="mb-4 p-3 bg-sf-dark-800 rounded-lg">
                <p className="text-xs text-sf-text-muted mb-1">Current location:</p>
                <p className="text-sm text-sf-text-primary truncate">{defaultProjectsLocation}</p>
              </div>
            )}
            
            {/* Error Display */}
            {error && (
              <div className="mb-4 p-3 bg-sf-error/20 border border-sf-error/50 rounded-lg">
                <p className="text-xs text-sf-error">{error}</p>
                {canOpenLatestAutosave && (
                  <button
                    onClick={openLatestAutosaveForFailedProject}
                    className="text-xs text-sf-text-primary hover:text-white mt-2 rounded-md border border-sf-dark-500 bg-sf-dark-900 px-2.5 py-1 transition-colors"
                  >
                    Open latest autosave{lastFailedProjectName ? ` for ${lastFailedProjectName}` : ''}
                  </button>
                )}
                <button 
                  onClick={clearError}
                  className="text-xs text-sf-text-muted hover:text-sf-text-primary mt-1"
                >
                  Dismiss
                </button>
              </div>
            )}
            
            {/* Action Button - simple outlined style */}
            <button
              onClick={selectDefaultProjectsLocation}
              disabled={(!isBrowserSupported && !isElectronMode()) || isLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-500 disabled:bg-sf-dark-700 disabled:border-sf-dark-600 disabled:cursor-not-allowed rounded-lg text-sf-text-secondary font-medium transition-colors"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <FolderOpen className="w-5 h-5" />
              )}
              Choose Projects Folder
            </button>
            
            <p className="text-xs text-sf-text-muted text-center mt-4">
              You can change this later in Settings
            </p>
          </div>
        </div>
        </div>
      </div>
    )
  }
  
  // Main welcome screen with recent projects
  // Header content is the same in both hero and no-hero layouts — we
  // just shift its background/positioning depending on whether the hero
  // is visible behind it.
  const headerContent = (
    <>
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold text-sf-text-primary drop-shadow">Kissd ReEdit</h1>
        <div className="flex items-center gap-1.5">
          <ComfyLauncherChip />
          {/* Credits chip — self-hides when no API key is configured. */}
          <CreditsChip />
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Auto / Simple / Advanced mode toggle. Same component the
            in-project TitleBar uses, so the preference set here carries
            over when the user opens a project. */}
        <UiModeToggle />
        {/* Settings — icon-only entry point so the user can reach
            ComfyUI mode (Local / Cloud), Capabilities, etc. without
            opening a project first. */}
        <button
          type="button"
          onClick={() => {
            setSettingsInitialSection(null)
            setSettingsOpen(true)
          }}
          className="h-9 w-9 flex items-center justify-center rounded-lg hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon className="w-4 h-4" />
        </button>
      </div>
    </>
  )

  return (
    <div className="h-screen bg-sf-dark-950 flex flex-col">
      {titleStrip}

      {/* Header bar — always a solid dark strip, never overlaps the image.
          The top border visually separates the header from the native window
          controls strip above it (matches the border below the banner). */}
      <div className="flex-shrink-0 flex items-center justify-between px-8 py-4 bg-sf-dark-950 border-t border-b border-sf-dark-800/60">
        {headerContent}
      </div>

      {/* Body — two-column layout.
          Left  = single list of projects (with "+ New project" at top).
          Right = Import panel (drop slots for the next session).
          Each column scrolls independently so a long project list
          doesn't push the Import slots off-screen. */}
      <div className="flex-1 overflow-hidden flex flex-row min-h-0">

        {/* ─── Left: project list ─── */}
        <main className="flex-1 basis-1/2 min-w-0 overflow-y-auto px-6 py-6 border-r border-sf-dark-800">
        <div className="max-w-3xl mx-auto">
        {error && (
          <div className="mb-4 rounded-lg border border-sf-error/50 bg-sf-error/15 p-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-sf-error flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-sf-text-primary">{error}</p>
              {canOpenLatestAutosave && (
                <button
                  onClick={openLatestAutosaveForFailedProject}
                  className="mt-2 inline-flex items-center gap-1.5 rounded border border-sf-dark-500 bg-sf-dark-900 px-2 py-1 text-[11px] text-sf-text-primary hover:border-sf-dark-400 hover:text-white transition-colors"
                >
                  <FolderOpen className="w-3 h-3" />
                  Open latest autosave{lastFailedProjectName ? ` for ${lastFailedProjectName}` : ''}
                </button>
              )}
              <button
                onClick={clearError}
                className="ml-2 text-[10px] text-sf-text-muted hover:text-sf-text-primary"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Recent Projects Section */}
        <div className="mb-8">
          {/* "+ New project" sits at the very top of the list so it
              reads as the first row of the projects column. Clicking
              opens the rename dialog (NewReeditProjectDialog) and the
              project lands in the list as soon as it's created. */}
          <button
            onClick={() => setShowNewProjectDialog(true)}
            className="w-full mb-3 flex items-center gap-3 px-4 py-3 rounded-lg border border-sf-accent/40 bg-sf-accent/10 hover:bg-sf-accent/15 hover:border-sf-accent/60 transition-colors shadow-lg shadow-sf-accent/10 text-left"
          >
            <div className="w-9 h-9 rounded-md bg-sf-accent/20 flex items-center justify-center flex-shrink-0">
              <Plus className="w-4 h-4 text-sf-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-sf-text-primary">New project</div>
              <div className="text-[11px] text-sf-text-muted leading-snug">
                Click to name it; resolution + fps come from the imported video.
              </div>
            </div>
          </button>

          <div className="flex items-end justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-sf-text-primary tracking-tight leading-none">
              Select a project
            </h2>
            {/* Grid / list toggle */}
            {recentProjectsList.length > 0 && (
              <div className="inline-flex items-center gap-0.5 rounded-md border border-sf-dark-700 bg-sf-dark-900 p-0.5" role="group" aria-label="View mode">
                <button
                  type="button"
                  onClick={() => setProjectListViewMode('grid')}
                  title="Grid view"
                  aria-label="Grid view"
                  aria-pressed={projectListViewMode !== 'list'}
                  className={`p-1 rounded transition-colors ${projectListViewMode !== 'list'
                    ? 'bg-sf-dark-700 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'}`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setProjectListViewMode('list')}
                  title="List view"
                  aria-label="List view"
                  aria-pressed={projectListViewMode === 'list'}
                  className={`p-1 rounded transition-colors ${projectListViewMode === 'list'
                    ? 'bg-sf-dark-700 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'}`}
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
          
          {loadingProjects ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-sf-accent animate-spin" />
            </div>
          ) : recentProjectsList.length === 0 ? (
            <div className="bg-sf-dark-900 border border-sf-dark-700 rounded-xl p-12 text-center">
              <p className="text-sf-text-primary font-medium mb-2">No recent projects</p>
              <p className="text-sm text-sf-text-muted mb-6">Create your first project to get started</p>
              <button
                onClick={() => setShowNewProjectDialog(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-500 rounded-lg text-sm text-sf-text-secondary font-medium transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Project
              </button>
            </div>
          ) : projectListViewMode === 'list' ? (
            /* List view — compact rows with small thumbnails */
            <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 shadow-lg shadow-black/40 overflow-hidden divide-y divide-sf-dark-800">
              {recentProjectsList.map((project, index) => {
                const thumbKey = project.path || project.name
                const resolvedThumb = thumbnailUrls[thumbKey]
                const resolution = project.settings?.width && project.settings?.height
                  ? `${project.settings.width}×${project.settings.height}`
                  : null
                return (
                  <div
                    key={project.name + index}
                    className="group relative flex items-center gap-3 pl-2 pr-2 py-2 hover:bg-sf-dark-800/70 transition-colors"
                  >
                    <button
                      onClick={() => handleOpenRecent(project)}
                      className="flex-1 flex items-center gap-3 text-left min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent rounded"
                      title={project.name}
                    >
                      {/* Small thumbnail */}
                      <div className="flex-shrink-0 w-20 aspect-video rounded bg-sf-dark-800 overflow-hidden">
                        {resolvedThumb ? (
                          <img src={resolvedThumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Film className="w-4 h-4 text-sf-text-muted/60" />
                          </div>
                        )}
                      </div>
                      {/* Name */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-sf-text-primary truncate">{project.name}</p>
                        {project.path && (
                          <p className="text-[10px] text-sf-text-muted truncate">{project.path}</p>
                        )}
                      </div>
                      {/* Metadata columns */}
                      <div className="hidden sm:flex flex-shrink-0 items-center gap-4 text-[11px] text-sf-text-muted tabular-nums">
                        {resolution && <span className="w-24 text-right">{resolution}</span>}
                        <span className="w-24 text-right">{formatDate(project.modified)}</span>
                      </div>
                    </button>
                    {/* Remove from recent */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeRecentProject(project)
                        setRecentProjectsList((prev) =>
                          prev.filter((p) => !(p.name === project.name && (p.path || '') === (project.path || '')))
                        )
                      }}
                      className="flex-shrink-0 p-1.5 rounded-md hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Remove from recent projects"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : (
            /* Grid view — thumbnail cards */
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}
            >
              {recentProjectsList.map((project, index) => {
                const thumbKey = project.path || project.name
                const resolvedThumb = thumbnailUrls[thumbKey]
                const resolution = project.settings?.width && project.settings?.height
                  ? `${project.settings.width}×${project.settings.height}`
                  : null
                return (
                  <div
                    key={project.name + index}
                    className="group relative bg-sf-dark-900 border border-sf-dark-700 rounded-lg overflow-hidden shadow-lg shadow-black/40 hover:border-sf-accent/70 hover:shadow-xl hover:shadow-sf-accent/10 hover:-translate-y-0.5 transition-all duration-150 text-left"
                  >
                    <button
                      onClick={() => handleOpenRecent(project)}
                      className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
                      title={project.name}
                    >
                      {/* Thumbnail */}
                      <div className="aspect-video bg-sf-dark-800 relative overflow-hidden">
                        {resolvedThumb ? (
                          <img
                            src={resolvedThumb}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Film className="w-5 h-5 text-sf-text-muted/60" />
                          </div>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-sf-accent/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <div className="w-8 h-8 bg-sf-accent rounded-full flex items-center justify-center">
                            <FolderOpen className="w-4 h-4 text-white" />
                          </div>
                        </div>
                      </div>
                      {/* Info */}
                      <div className="px-2.5 py-1.5">
                        <p className="text-[12px] font-medium text-sf-text-primary truncate">
                          {project.name}
                        </p>
                        <div className="flex items-center gap-1.5 text-[10px] text-sf-text-muted mt-0.5 truncate">
                          <span>{formatDate(project.modified)}</span>
                          {resolution && (
                            <>
                              <span className="opacity-50">•</span>
                              <span>{resolution}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </button>
                    {/* Remove from recent */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeRecentProject(project)
                        setRecentProjectsList((prev) =>
                          prev.filter((p) => !(p.name === project.name && (p.path || '') === (project.path || '')))
                        )
                      }}
                      className="absolute top-1.5 right-1.5 p-1 rounded-md bg-sf-dark-900/90 hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      title="Remove from recent projects"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        
        </div>{/* /max-w-3xl */}
        </main>{/* /left column (projects list) */}

        {/* ─── Right: Import slots ─── */}
        <aside className="flex-1 basis-1/2 min-w-0 overflow-y-auto bg-sf-dark-900/30">
          <div className="max-w-md mx-auto p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-sf-text-primary mb-1">Import</h2>
              <p className="text-xs text-sf-text-muted leading-snug">
                Drop the source video and (for Auto mode) the Sundogs PDF.
                You'll be asked to name the project before the import runs.
              </p>
            </div>

            {/* Drop zone — video. Visual surface for now: clicking
                "+ New project" first is the recommended flow; if the
                user drops here we open the rename dialog and ask them
                to confirm the project name, then the import handlers
                inside the project take over. Full auto-create-on-drop
                is a follow-up. */}
            <button
              type="button"
              onClick={() => setShowNewProjectDialog(true)}
              className="w-full flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-xl border-2 border-dashed border-sf-dark-700 bg-sf-dark-900/40 hover:border-sf-accent/50 hover:bg-sf-accent/5 transition-colors text-center"
            >
              <VideoIcon className="w-6 h-6 text-sf-text-muted" />
              <div className="text-sm font-medium text-sf-text-primary">Source video</div>
              <div className="text-[11px] text-sf-text-muted leading-snug max-w-[260px]">
                Click to start a new project and pick the main video in the next step.
              </div>
            </button>

            {/* Sundogs PDF slot — same idea: visual hint that this
                exists, click routes to the new-project flow where the
                Auto Import view does the real upload. */}
            <button
              type="button"
              onClick={() => setShowNewProjectDialog(true)}
              className="w-full flex items-center gap-3 px-3 py-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 hover:bg-sf-dark-800 transition-colors text-left"
            >
              <FileText className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-sf-text-primary">Sundogs PDF</div>
                <div className="text-[11px] text-sf-text-muted leading-snug">
                  Required only for Auto mode (grades the proposal against
                  benchmark scores).
                </div>
              </div>
              <Upload className="w-3.5 h-3.5 text-sf-text-muted" />
            </button>

            {/* Open existing — secondary path for users who saved a
                project on disk somewhere outside the default folder. */}
            <button
              onClick={openProjectFromPicker}
              className="w-full flex items-start gap-3 p-3 rounded-lg border border-sf-dark-800 bg-sf-dark-900/30 hover:bg-sf-dark-800 text-left transition-colors"
            >
              <FolderOpen className="w-4 h-4 mt-0.5 text-sf-text-muted flex-shrink-0" />
              <div>
                <div className="text-sm font-medium text-sf-text-primary">Open project…</div>
                <div className="text-[11px] text-sf-text-muted leading-snug">
                  Pick a <span className="text-sf-text-secondary">.comfystudio</span> file from disk.
                </div>
              </div>
            </button>

            {/* Projects folder location */}
            <div className="rounded-lg border border-sf-dark-800 bg-sf-dark-900/60 p-3">
              <div className="text-[10px] uppercase tracking-wider text-sf-text-muted mb-1">
                Projects folder
              </div>
              <div className="text-[11px] text-sf-text-secondary break-words leading-snug">
                {defaultProjectsLocation || 'Not set'}
              </div>
              <button
                onClick={selectDefaultProjectsLocation}
                className="mt-2 text-[11px] text-sf-accent hover:underline"
              >
                Change…
              </button>
            </div>
          </div>
        </aside>
      </div>{/* /two-column body */}

      {/* New Project Dialog */}
      <NewReeditProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
      />

      {/* Settings Modal — reachable from the gear icon in the header. */}
      {settingsOpen && (
        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsInitialSection}
        />
      )}

    </div>
  )
}

export default WelcomeScreen
