import { useEffect, useRef, useState } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import useProjectStore from '../../stores/projectStore'

// Minimal new-project dialog for the re-edit pipeline. ComfyStudio's
// stock NewProjectDialog asks for canvas resolution + fps up-front —
// it was built for animatics where you pick those before importing
// stills. In the re-edit flow we don't know any of that until the
// user drops a source video, and ImportVideoView overwrites
// project.settings at that point anyway. So we only ask for a name
// here and seed the project with placeholder 1920×1080 @ 24fps that
// the import pass will rewrite.
//
// Any re-edit project that never sees an import will just stay on
// those defaults — same outcome as the full dialog with everything
// defaulted, but without making the user answer questions they
// can't meaningfully answer yet.
function NewReeditProjectDialog({ isOpen, onClose }) {
  const createProject = useProjectStore((s) => s.createProject)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setName('')
      setError(null)
      setCreating(false)
      // Focus on next tick so the autofocus doesn't fight the
      // backdrop-click handler Electron sometimes invokes.
      setTimeout(() => { inputRef.current?.focus() }, 0)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Pick a name for the project.')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const created = await createProject({
        name: trimmed,
        width: 1920,
        height: 1080,
        fps: 24,
      })
      if (!created) {
        // projectStore writes its own error into the store's `error`
        // field. Surface something generic here so the dialog doesn't
        // just silently hang.
        throw new Error('Could not create project — check the projects folder is writable.')
      }
      onClose?.()
    } catch (err) {
      setError(err?.message || 'Could not create project.')
    } finally {
      setCreating(false)
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !creating) handleCreate()
    else if (e.key === 'Escape') onClose?.()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="w-[440px] bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <h2 className="text-sm font-semibold text-sf-text-primary">New project</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Project name</label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="E.g. Nissan Armada spring 2026"
            disabled={creating}
            className="w-full text-sm rounded-lg border border-sf-dark-700 bg-sf-dark-950 px-3 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
          />

          <p className="mt-3 text-[11px] leading-snug text-sf-text-muted">
            Resolution and frame rate are set when you import the source video — no need to pick them up front.
          </p>

          {error && (
            <p className="mt-3 text-[11px] text-sf-error">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="px-3 py-1.5 rounded-md text-xs text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
              ${creating || !name.trim()
                ? 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'
                : 'bg-sf-accent hover:bg-sf-accent-hover text-white'}`}
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Create project
          </button>
        </div>
      </div>
    </div>
  )
}

export default NewReeditProjectDialog
