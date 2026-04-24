import { useState } from 'react'
import { X, ClipboardCheck, Clipboard, FolderOpen, ExternalLink, MousePointer2 } from 'lucide-react'

/**
 * Shown after "Send to ComfyUI" — drives the user through dropping
 * the saved workflow JSON onto ComfyUI's canvas.
 *
 * Why drag-drop is primary here: ComfyUI's Ctrl+V only accepts the
 * internal node-copy format that ComfyUI itself writes to the
 * clipboard. Our JSON is a full workflow graph, which the paste
 * handler ignores or mis-interprets (we've seen it paste a leftover
 * "math expression" node from an earlier in-app copy). Drag-drop of
 * a .json onto the canvas is the reliable universal path, so the
 * modal leads with "Show file in folder + drag it over" and keeps
 * clipboard as an optional fallback.
 */
function SendToComfyModal({ isOpen, payload, onClose }) {
  const [copyState, setCopyState] = useState('idle') // idle | copied | failed

  if (!isOpen || !payload) return null

  const { json, savedPath, copied, comfyBase } = payload
  const filename = savedPath ? savedPath.split(/[\\/]/).pop() : null

  const handleRevealInFolder = () => {
    if (!savedPath) return
    if (window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(savedPath).catch(() => {})
    } else if (window.electronAPI?.openExternal) {
      const dir = savedPath.replace(/[\\/][^\\/]+$/, '')
      window.electronAPI.openExternal(`file://${dir.replace(/\\/g, '/')}`).catch(() => {})
    }
  }

  const handleCopy = async () => {
    let ok = false
    if (window.electronAPI?.writeTextToClipboard) {
      try {
        const res = await window.electronAPI.writeTextToClipboard(json)
        ok = Boolean(res?.success)
      } catch { /* ignore */ }
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(json)
        ok = true
      } catch { /* ignore */ }
    }
    setCopyState(ok ? 'copied' : 'failed')
    if (ok) setTimeout(() => setCopyState('idle'), 1800)
  }

  const handleOpenComfy = () => {
    if (!comfyBase) return
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(comfyBase).catch(() => {})
    } else {
      window.open(comfyBase, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div className="w-full max-w-xl bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <h2 className="text-sm font-semibold text-sf-text-primary">Workflow ready — drag it into ComfyUI</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm text-sf-text-primary">
          <p className="text-sf-text-muted">
            ComfyUI is opened in your browser. The workflow is <strong className="text-sf-text-primary">not queued</strong> — it won't run until you hit Queue Prompt there.
          </p>

          <ol className="space-y-3 pl-4 list-decimal text-sm">
            <li>
              <span className="font-medium">Reveal the workflow JSON</span> in your file explorer:
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={handleRevealInFolder}
                  disabled={!savedPath}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                    ${savedPath
                      ? 'bg-sf-accent hover:bg-sf-accent-hover text-white'
                      : 'bg-sf-dark-800 text-sf-text-muted cursor-not-allowed'}`}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Show {filename || 'file'} in folder
                </button>
              </div>
            </li>
            <li>
              <span className="font-medium">Drag the file</span> from the explorer window onto ComfyUI's canvas — the graph loads instantly.
              <div className="mt-1 flex items-center gap-1.5 text-xs text-sf-text-muted">
                <MousePointer2 className="w-3 h-3" />
                Drop anywhere on the dark canvas area.
              </div>
            </li>
            <li>
              Inspect + tweak any node. Hit <strong className="text-sf-text-primary">Queue Prompt</strong> in ComfyUI when you're happy.
            </li>
          </ol>

          <div className="pt-2 border-t border-sf-dark-800/60 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-sf-text-muted mr-1">Other options:</span>
            {comfyBase && (
              <button
                type="button"
                onClick={handleOpenComfy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                Reopen ComfyUI
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] border border-sf-dark-700 bg-sf-dark-900 hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
              title="ComfyUI's Ctrl+V only handles its own internal node-copy format — drag-drop is the reliable path."
            >
              {copyState === 'copied'
                ? <><ClipboardCheck className="w-3 h-3 text-emerald-400" /> Copied</>
                : copyState === 'failed'
                  ? <><Clipboard className="w-3 h-3 text-sf-error" /> Copy failed</>
                  : <><Clipboard className="w-3 h-3" /> {copied ? 'Copy JSON again' : 'Copy JSON'}</>}
            </button>
          </div>

          {savedPath && (
            <p className="text-[10px] text-sf-text-muted/80 font-mono break-all">
              {savedPath}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-sf-accent hover:bg-sf-accent-hover text-white font-medium transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

export default SendToComfyModal
