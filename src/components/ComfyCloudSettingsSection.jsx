import { memo, useEffect, useState } from 'react'
import { Cloud, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff } from 'lucide-react'
import {
  COMFY_MODE_LOCAL,
  COMFY_MODE_CLOUD,
  getActiveModeSync,
  getActiveHttpBaseSync,
  getActiveApiKeySync,
  saveComfyMode,
  saveCloudComfyConnection,
  checkCloudComfyConnection,
  hydrateComfyCloudConnection,
  COMFY_CONNECTION_CHANGED_EVENT,
} from '../services/localComfyConnection'

// Standalone settings card for the ComfyUI Cloud connection. Sits next
// to the Local launcher card. Owns: mode toggle (local/cloud), cloud
// HTTP base URL, API key, Test button + status read-out. Everything
// else (queue / WS / fetch headers) reads from the same connection
// module, so flipping the mode here is enough to redirect the whole
// app to a remote ComfyUI.

function ComfyCloudSettingsSection() {
  const [mode, setMode] = useState(getActiveModeSync())
  const [httpBase, setHttpBase] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [savingMode, setSavingMode] = useState(false)
  const [savingCloud, setSavingCloud] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState(null)    // { ok, message }
  const [error, setError] = useState(null)

  // Initial hydration: pull persisted values from electron settings via
  // localComfyConnection, then mirror them into local state so the
  // inputs are controlled.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await hydrateComfyCloudConnection()
      if (cancelled) return
      setMode(getActiveModeSync())
      setHttpBase(getActiveModeSync() === COMFY_MODE_CLOUD ? getActiveHttpBaseSync() : '')
      setApiKey(getActiveModeSync() === COMFY_MODE_CLOUD ? getActiveApiKeySync() : '')
    })()

    // Refresh from the central store if some other component flips the
    // mode (e.g. a quick toggle in the title bar chip).
    const onConn = () => {
      setMode(getActiveModeSync())
    }
    window.addEventListener(COMFY_CONNECTION_CHANGED_EVENT, onConn)
    return () => {
      cancelled = true
      window.removeEventListener(COMFY_CONNECTION_CHANGED_EVENT, onConn)
    }
  }, [])

  async function applyMode(next) {
    if (next === mode) return
    setSavingMode(true)
    setError(null)
    try {
      const res = await saveComfyMode(next)
      if (!res?.success) throw new Error(res?.error || 'Failed to save mode.')
      setMode(next)
    } catch (err) {
      setError(err?.message || 'Failed to save mode.')
    } finally {
      setSavingMode(false)
    }
  }

  async function applyCloud() {
    setSavingCloud(true)
    setError(null)
    try {
      const res = await saveCloudComfyConnection({ httpBase, apiKey })
      if (!res?.success) throw new Error(res?.error || 'Failed to save cloud settings.')
      setDirty(false)
    } catch (err) {
      setError(err?.message || 'Failed to save cloud settings.')
    } finally {
      setSavingCloud(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setStatus(null)
    setError(null)
    try {
      const res = await checkCloudComfyConnection({ httpBase, apiKey })
      if (res?.ok) {
        setStatus({ ok: true, message: `Connected to ${res.httpBase}` })
      } else {
        setStatus({ ok: false, message: res?.error || 'No response.' })
      }
    } catch (err) {
      setStatus({ ok: false, message: err?.message || 'Connection failed.' })
    } finally {
      setTesting(false)
    }
  }

  const onUrl = (e) => { setHttpBase(e.target.value); setDirty(true); setStatus(null) }
  const onKey = (e) => { setApiKey(e.target.value); setDirty(true); setStatus(null) }

  return (
    <section className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 p-4 space-y-4">
      <header className="flex items-center gap-2">
        <Cloud className="w-4 h-4 text-sky-300" />
        <div>
          <h3 className="text-sm font-semibold">ComfyUI Cloud</h3>
          <p className="text-[11px] text-sf-text-muted">
            Route the queue, history, uploads and WebSocket to a remote ComfyUI server (Comfy Cloud, a self-hosted reverse proxy, RunPod, etc.).
          </p>
        </div>
      </header>

      {/* Mode toggle */}
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-sf-text-muted w-16">Mode</div>
        <div className="flex bg-sf-dark-800 border border-sf-dark-700 rounded overflow-hidden text-xs">
          <button
            onClick={() => applyMode(COMFY_MODE_LOCAL)}
            disabled={savingMode}
            className={`px-3 py-1 transition-colors ${
              mode === COMFY_MODE_LOCAL
                ? 'bg-sf-accent text-white'
                : 'text-sf-text-muted hover:bg-sf-dark-700'
            }`}
          >Local</button>
          <button
            onClick={() => applyMode(COMFY_MODE_CLOUD)}
            disabled={savingMode}
            className={`px-3 py-1 transition-colors ${
              mode === COMFY_MODE_CLOUD
                ? 'bg-sky-500 text-white'
                : 'text-sf-text-muted hover:bg-sf-dark-700'
            }`}
          >Cloud</button>
        </div>
        {savingMode && <Loader2 className="w-3.5 h-3.5 animate-spin text-sf-text-muted" />}
        <div className="ml-auto text-[10px] text-sf-text-muted">
          {mode === COMFY_MODE_CLOUD ? 'All prompts will be sent to the cloud URL below.' : 'Using local loopback (legacy default).'}
        </div>
      </div>

      {/* Cloud inputs */}
      <div className="space-y-2">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-sf-text-muted mb-1">Cloud URL</label>
          <input
            type="text"
            value={httpBase}
            onChange={onUrl}
            placeholder="https://your-instance.comfy.cloud"
            className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-3 py-1.5 text-sm font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-sf-text-muted mb-1">API key</label>
          <div className="flex items-center gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={onKey}
              placeholder="sk-…"
              className="flex-1 bg-sf-dark-800 border border-sf-dark-700 rounded px-3 py-1.5 text-sm font-mono"
            />
            <button
              onClick={() => setShowKey((v) => !v)}
              className="px-2 py-1.5 rounded border border-sf-dark-700 hover:bg-sf-dark-800 text-sf-text-muted"
              title={showKey ? 'Hide' : 'Show'}
            >
              {showKey ? <EyeOff size={14}/> : <Eye size={14}/>}
            </button>
          </div>
          <div className="text-[10px] text-sf-text-muted mt-1">
            Sent as <code className="text-sf-text-secondary">Authorization: Bearer …</code> on every HTTP call,
            and as a <code className="text-sf-text-secondary">?token=…</code> query param on the WebSocket.
          </div>
        </div>
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <button
          onClick={runTest}
          disabled={testing || !httpBase}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded border border-sf-dark-700 hover:bg-sf-dark-800 text-xs disabled:opacity-50"
        >
          {testing ? <Loader2 size={12} className="animate-spin"/> : <Cloud size={12}/>}
          Test connection
        </button>
        <button
          onClick={applyCloud}
          disabled={savingCloud || !dirty}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-sf-accent hover:bg-sf-accent-hover text-white text-xs disabled:opacity-50"
        >
          {savingCloud ? <Loader2 size={12} className="animate-spin"/> : null}
          Save cloud settings
        </button>
        {status && (
          <div className={`flex items-center gap-1.5 text-xs ${status.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
            {status.ok ? <CheckCircle2 size={12}/> : <AlertCircle size={12}/>}
            <span>{status.message}</span>
          </div>
        )}
      </div>

      {error && (
        <div className="text-xs text-rose-300 flex items-start gap-1.5">
          <AlertCircle size={12} className="mt-0.5 shrink-0"/>
          <span>{error}</span>
        </div>
      )}

      {/* Caveat: file-upload workflows still need a manual lift to work
          in cloud mode. Keep the user informed instead of letting them
          discover it via a confusing error mid-render. */}
      {mode === COMFY_MODE_CLOUD && (
        <div className="text-[11px] text-amber-300 border-l-2 border-amber-500/40 pl-2 leading-relaxed">
          Cloud mode is wired up for the queue / history / view endpoints and the WebSocket. Workflows that
          copy local files into ComfyUI's <code>input/</code> folder (Optimize footage, Commit reframe / extend,
          F5-TTS voiceover, ACE music) still assume a loopback path — those will surface a clear error until the
          file upload is migrated to <code>/upload/image</code>. Use local mode for those for now.
        </div>
      )}
    </section>
  )
}

export default memo(ComfyCloudSettingsSection)
