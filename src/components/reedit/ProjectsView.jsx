import { useEffect, useState } from 'react'
import { FolderOpen, Plus, Film, Loader2, Trash2, LayoutGrid, List, CheckCircle2 } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'
import NewReeditProjectDialog from './NewReeditProjectDialog'
import { resolveThumbnailUrl } from '../../utils/projectThumbnail'

// Reads the ComfyStudio recent-projects list off the store (same
// plumbing the first-run WelcomeScreen uses) and renders it as a
// grid/list that's reachable at any time from the Projects tab, not
// just before a project is open. This turns "close current project to
// pick another one" into "click a card to switch."
function ProjectsView() {
  const {
    currentProject,
    defaultProjectsHandle,
    defaultProjectsLocation,
    recentProjects,
    selectDefaultProjectsLocation,
    openProjectFromPicker,
    openRecentProject,
    removeRecentProject,
    getRecentProjectsList,
    isLoading,
    projectListViewMode,
    setProjectListViewMode,
  } = useProjectStore()

  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [recentProjectsList, setRecentProjectsList] = useState([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [thumbnailUrls, setThumbnailUrls] = useState({})

  // Pull the list fresh whenever the default projects folder or the
  // in-memory `recentProjects` changes. ComfyStudio stores two parallel
  // sources — the legacy `recentProjects` array (web) and a disk scan
  // under `defaultProjectsHandle` (Electron) — and `getRecentProjectsList`
  // returns whichever is authoritative for the current mode.
  useEffect(() => {
    const load = async () => {
      if (defaultProjectsHandle) {
        setLoadingProjects(true)
        try {
          const projects = await getRecentProjectsList()
          setRecentProjectsList(projects)
        } catch (err) {
          console.error('[reedit] could not load project list:', err)
        } finally {
          setLoadingProjects(false)
        }
      } else {
        setRecentProjectsList(recentProjects || [])
      }
    }
    load()
  }, [defaultProjectsHandle, recentProjects, getRecentProjectsList])

  // Resolve thumbnails lazily so cards render immediately with a
  // placeholder icon and swap in the real image as each resolves.
  useEffect(() => {
    let cancelled = false
    setThumbnailUrls({})
    const run = async () => {
      for (const project of recentProjectsList) {
        if (cancelled) return
        if (!project?.thumbnail) continue
        try {
          const url = await resolveThumbnailUrl(project.path || project.handle, project.thumbnail)
          if (cancelled || !url) continue
          const key = project.path || project.name
          setThumbnailUrls((prev) => ({ ...prev, [key]: url }))
        } catch (_) { /* non-fatal; card stays on placeholder */ }
      }
    }
    run()
    return () => { cancelled = true }
  }, [recentProjectsList])

  const formatDate = (iso) => {
    if (!iso) return 'Unknown'
    const date = new Date(iso)
    const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString()
  }

  const isCurrent = (project) => {
    if (!currentProject) return false
    if (project.path && project.path === currentProject.path) return true
    return project.name === currentProject.name
  }

  // Initial setup nudge — if the user never picked a projects folder,
  // opening arbitrary projects isn't going to work. Surface the fix
  // inline rather than silently showing an empty list.
  const needsFolder = !defaultProjectsHandle

  return (
    <div className="flex-1 flex flex-col bg-sf-dark-950 text-sf-text-primary overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 border-b border-sf-dark-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-sf-dark-800 border border-sf-dark-700 flex items-center justify-center">
            <FolderOpen className="w-4 h-4 text-sf-accent" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Projects</h1>
            <p className="text-xs text-sf-text-muted truncate max-w-[560px]">
              {defaultProjectsLocation
                ? `Saved under ${defaultProjectsLocation}`
                : 'Pick a projects folder to get started.'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openProjectFromPicker}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
            title="Open a project from anywhere on disk"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open project
          </button>
          <button
            type="button"
            onClick={() => setShowNewProjectDialog(true)}
            disabled={needsFolder || isLoading}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
              ${needsFolder || isLoading
                ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
          >
            <Plus className="w-3.5 h-3.5" />
            New project
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-5">
        {needsFolder ? (
          <div className="max-w-md mx-auto mt-10 bg-sf-dark-900 border border-sf-dark-700 rounded-xl p-6 text-center">
            <h2 className="text-base font-semibold mb-2">Set up your workspace</h2>
            <p className="text-sm text-sf-text-muted mb-5">
              Pick a folder on disk where project files and their assets will live.
            </p>
            <button
              type="button"
              onClick={selectDefaultProjectsLocation}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sf-dark-800 hover:bg-sf-dark-700 border border-sf-dark-500 text-sf-text-secondary transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              Choose projects folder
            </button>
          </div>
        ) : loadingProjects ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-sf-accent animate-spin" />
          </div>
        ) : recentProjectsList.length === 0 ? (
          <div className="max-w-md mx-auto mt-10 bg-sf-dark-900 border border-sf-dark-700 rounded-xl p-8 text-center">
            <p className="text-sm text-sf-text-primary font-medium mb-2">No projects yet</p>
            <p className="text-xs text-sf-text-muted mb-5">Create your first one to start re-editing.</p>
            <button
              type="button"
              onClick={() => setShowNewProjectDialog(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sf-accent hover:bg-sf-accent-hover text-white text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New project
            </button>
          </div>
        ) : (
          <>
            {/* View mode toggle */}
            <div className="flex items-center justify-between mb-3">
              <div className="text-[11px] uppercase tracking-wider text-sf-text-muted">
                {recentProjectsList.length} project{recentProjectsList.length === 1 ? '' : 's'}
              </div>
              <div className="inline-flex items-center gap-0.5 rounded-md border border-sf-dark-700 bg-sf-dark-900 p-0.5" role="group">
                <button
                  type="button"
                  onClick={() => setProjectListViewMode('grid')}
                  className={`p-1 rounded transition-colors ${projectListViewMode !== 'list'
                    ? 'bg-sf-dark-700 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'}`}
                  title="Grid view"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setProjectListViewMode('list')}
                  className={`p-1 rounded transition-colors ${projectListViewMode === 'list'
                    ? 'bg-sf-dark-700 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800'}`}
                  title="List view"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {projectListViewMode === 'list' ? (
              <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 shadow-lg shadow-black/40 overflow-hidden divide-y divide-sf-dark-800">
                {recentProjectsList.map((project, index) => {
                  const thumbKey = project.path || project.name
                  const resolvedThumb = thumbnailUrls[thumbKey]
                  const resolution = project.settings?.width && project.settings?.height
                    ? `${project.settings.width}×${project.settings.height}`
                    : null
                  const current = isCurrent(project)
                  return (
                    <div
                      key={project.name + index}
                      className={`group relative flex items-center gap-3 pl-2 pr-2 py-2 transition-colors ${current ? 'bg-sf-accent/10' : 'hover:bg-sf-dark-800/70'}`}
                    >
                      <button
                        onClick={() => openRecentProject(project)}
                        className="flex-1 flex items-center gap-3 text-left min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent rounded"
                        title={current ? 'Already open' : project.name}
                      >
                        <div className="flex-shrink-0 w-20 aspect-video rounded bg-sf-dark-800 overflow-hidden">
                          {resolvedThumb ? (
                            <img src={resolvedThumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-4 h-4 text-sf-text-muted/60" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-sf-text-primary truncate flex items-center gap-2">
                            {project.name}
                            {current && <CheckCircle2 className="w-3.5 h-3.5 text-sf-accent" />}
                          </p>
                          {project.path && (
                            <p className="text-[10px] text-sf-text-muted truncate">{project.path}</p>
                          )}
                        </div>
                        <div className="hidden sm:flex flex-shrink-0 items-center gap-4 text-[11px] text-sf-text-muted tabular-nums">
                          {resolution && <span className="w-24 text-right">{resolution}</span>}
                          <span className="w-24 text-right">{formatDate(project.modified)}</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeRecentProject(project)
                          setRecentProjectsList((prev) => prev.filter((p) => !(p.name === project.name && (p.path || '') === (project.path || ''))))
                        }}
                        className="flex-shrink-0 p-1.5 rounded-md hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove from recent"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
              >
                {recentProjectsList.map((project, index) => {
                  const thumbKey = project.path || project.name
                  const resolvedThumb = thumbnailUrls[thumbKey]
                  const resolution = project.settings?.width && project.settings?.height
                    ? `${project.settings.width}×${project.settings.height}`
                    : null
                  const current = isCurrent(project)
                  return (
                    <div
                      key={project.name + index}
                      className={`group relative rounded-lg overflow-hidden shadow-lg shadow-black/40 transition-all duration-150 text-left border
                        ${current
                          ? 'border-sf-accent ring-2 ring-sf-accent/40 bg-sf-accent/5'
                          : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-accent/70 hover:shadow-xl hover:shadow-sf-accent/10 hover:-translate-y-0.5'}`}
                    >
                      <button
                        onClick={() => openRecentProject(project)}
                        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
                        title={current ? 'Already open' : project.name}
                      >
                        <div className="aspect-video bg-sf-dark-800 relative overflow-hidden">
                          {resolvedThumb ? (
                            <img src={resolvedThumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-5 h-5 text-sf-text-muted/60" />
                            </div>
                          )}
                          {current && (
                            <div className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sf-accent text-white text-[9px] font-semibold uppercase tracking-wider">
                              <CheckCircle2 className="w-3 h-3" />
                              Open
                            </div>
                          )}
                        </div>
                        <div className="px-2.5 py-1.5">
                          <p className="text-[12px] font-medium text-sf-text-primary truncate">{project.name}</p>
                          <div className="flex items-center gap-1.5 text-[10px] text-sf-text-muted mt-0.5 truncate">
                            <span>{formatDate(project.modified)}</span>
                            {resolution && <><span className="opacity-50">•</span><span>{resolution}</span></>}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeRecentProject(project)
                          setRecentProjectsList((prev) => prev.filter((p) => !(p.name === project.name && (p.path || '') === (project.path || ''))))
                        }}
                        className="absolute top-1.5 right-1.5 p-1 rounded-md bg-sf-dark-900/90 hover:bg-sf-error/80 text-sf-text-muted hover:text-white opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        title="Remove from recent"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      <NewReeditProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
      />
    </div>
  )
}

export default ProjectsView
