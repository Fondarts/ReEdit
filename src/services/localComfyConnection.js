export const COMFY_CONNECTION_SETTING_KEY = 'comfyConnection'
export const COMFY_CONNECTION_LOCAL_KEY = 'comfystudio-comfy-connection'
export const COMFY_CONNECTION_CHANGED_EVENT = 'comfystudio-comfy-connection-changed'

export const LOCAL_COMFY_HOST = '127.0.0.1'
export const DEFAULT_COMFY_PORT = 8188

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

let cachedPort = DEFAULT_COMFY_PORT
let hydrated = false
let hydrationPromise = null
let connectionVersion = 0

function normalizePort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < 1 || parsed > 65535) return null
  return parsed
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase()
  if (!normalized) return false
  if (LOOPBACK_HOSTS.has(normalized)) return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false
  return normalized
    .split('.')
    .map((part) => Number(part))
    .every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
}

function buildConnection(port) {
  const safePort = normalizePort(port) || DEFAULT_COMFY_PORT
  return {
    host: LOCAL_COMFY_HOST,
    port: safePort,
    httpBase: `http://${LOCAL_COMFY_HOST}:${safePort}`,
    wsBase: `ws://${LOCAL_COMFY_HOST}:${safePort}`,
  }
}

function readLocalStoragePort() {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(COMFY_CONNECTION_LOCAL_KEY)
    if (!raw) return null
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = raw
    }
    const fromStored = parseStoredPortValue(parsed)
    return fromStored.success ? fromStored.port : null
  } catch {
    return null
  }
}

function writeLocalStoragePort(port) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(COMFY_CONNECTION_LOCAL_KEY, JSON.stringify({ port }))
  } catch {
    // Ignore storage write failures.
  }
}

function dispatchConnectionChanged(config) {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    window.dispatchEvent(new CustomEvent(COMFY_CONNECTION_CHANGED_EVENT, { detail: config }))
  } catch {
    // Ignore event dispatch failures.
  }
}

function parseStoredPortValue(raw) {
  if (raw && typeof raw === 'object') {
    if (raw.port !== undefined) {
      const normalized = normalizePort(raw.port)
      if (normalized) return { success: true, port: normalized }
    }
    if (raw.httpBase) {
      return parseLocalComfyPortInput(raw.httpBase)
    }
    if (raw.url) {
      return parseLocalComfyPortInput(raw.url)
    }
  }
  if (typeof raw === 'number') {
    const normalized = normalizePort(raw)
    if (normalized) return { success: true, port: normalized }
  }
  if (typeof raw === 'string') {
    return parseLocalComfyPortInput(raw)
  }
  return { success: false, error: 'No local ComfyUI setting found' }
}

function hydrateFromLocalStorage() {
  const fromLocalStorage = readLocalStoragePort()
  if (fromLocalStorage) {
    cachedPort = fromLocalStorage
  }
}

hydrateFromLocalStorage()

export function parseLocalComfyPortInput(input) {
  const raw = String(input ?? '').trim()
  if (!raw) {
    return { success: true, port: DEFAULT_COMFY_PORT }
  }

  if (/^\d+$/.test(raw)) {
    const port = normalizePort(raw)
    if (!port) {
      return { success: false, error: 'Port must be between 1 and 65535.' }
    }
    return { success: true, port }
  }

  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `http://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: 'Use a local http URL (or just the port number).' }
    }
    if (!isLoopbackHost(parsed.hostname)) {
      return { success: false, error: 'Remote ComfyUI is disabled. Use localhost/127.0.0.1 only.' }
    }
    const port = normalizePort(parsed.port || DEFAULT_COMFY_PORT)
    if (!port) {
      return { success: false, error: 'Port must be between 1 and 65535.' }
    }
    return { success: true, port }
  } catch {
    return { success: false, error: 'Invalid value. Use a local port like 8188.' }
  }
}

export function isLoopbackHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

export function getLocalComfyConnectionSync() {
  return buildConnection(cachedPort)
}

export function getLocalComfyHttpBaseSync() {
  return getLocalComfyConnectionSync().httpBase
}

export function getLocalComfyWsBaseSync() {
  return getLocalComfyConnectionSync().wsBase
}

export async function hydrateLocalComfyConnection() {
  if (hydrated) {
    return getLocalComfyConnectionSync()
  }
  if (hydrationPromise) {
    return hydrationPromise
  }

  hydrationPromise = (async () => {
    const startVersion = connectionVersion
    hydrateFromLocalStorage()

    if (typeof window !== 'undefined' && window?.electronAPI?.getSetting) {
      try {
        const stored = await window.electronAPI.getSetting(COMFY_CONNECTION_SETTING_KEY)
        let parsed = parseStoredPortValue(stored)

        // Legacy migration path if previous versions ever stored a free-form URL key.
        if (!parsed.success) {
          const legacyUrl = await window.electronAPI.getSetting('comfyUrl')
          parsed = parseStoredPortValue(legacyUrl)
        }

        if (parsed.success && startVersion === connectionVersion) {
          cachedPort = parsed.port
          writeLocalStoragePort(cachedPort)
        }
      } catch {
        // Ignore settings read failures and keep local/default values.
      }
    }

    hydrated = true
    const config = getLocalComfyConnectionSync()
    hydrationPromise = null
    return config
  })()

  return hydrationPromise
}

export async function saveLocalComfyConnectionPort(input) {
  const parsed = parseLocalComfyPortInput(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error }
  }

  connectionVersion += 1
  cachedPort = parsed.port
  const config = getLocalComfyConnectionSync()
  writeLocalStoragePort(config.port)

  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.setSetting) {
      await window.electronAPI.setSetting(COMFY_CONNECTION_SETTING_KEY, {
        host: config.host,
        port: config.port,
      })
    }
  } catch (err) {
    return {
      success: false,
      error: err?.message || 'Failed to persist local ComfyUI setting.',
    }
  }

  dispatchConnectionChanged(config)
  return { success: true, config }
}

export async function checkLocalComfyConnection(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 4500
  const maybePort = options.port ?? cachedPort
  const normalizedPort = normalizePort(maybePort)
  if (!normalizedPort) {
    return { ok: false, error: 'Invalid local ComfyUI port.' }
  }

  const config = buildConnection(normalizedPort)
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(`${config.httpBase}/system_stats`, {
      signal: controller?.signal,
    })
    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        httpBase: config.httpBase,
        port: config.port,
      }
    }
    return {
      ok: false,
      status: response.status,
      httpBase: config.httpBase,
      port: config.port,
      error: `ComfyUI returned HTTP ${response.status}.`,
    }
  } catch (err) {
    const isTimeout = err?.name === 'AbortError'
    return {
      ok: false,
      httpBase: config.httpBase,
      port: config.port,
      error: isTimeout
        ? `Timed out connecting to ${config.httpBase}.`
        : `Could not connect to ${config.httpBase}: ${err?.message || 'Unknown error'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================
//  Cloud / remote ComfyUI support
// ------------------------------------------------------------
//  The legacy code above is loopback-only on purpose (`isLoopbackHost`
//  rejects anything else). Cloud is a separate mode flag with its own
//  base URL + API key. When MODE_CLOUD is active, `getActiveHttpBase()` /
//  `getActiveWsBase()` return the cloud endpoints; otherwise they fall
//  back to the existing local loopback config.
// ============================================================

export const COMFY_MODE_LOCAL = 'local'
export const COMFY_MODE_CLOUD = 'cloud'

export const COMFY_MODE_SETTING_KEY = 'comfyMode'        // 'local' | 'cloud'
export const COMFY_CLOUD_SETTING_KEY = 'comfyCloud'      // { httpBase, apiKey }
export const COMFY_CLOUD_LOCAL_KEY = 'comfystudio-comfy-cloud'

let cachedMode = COMFY_MODE_LOCAL
let cachedCloudHttpBase = ''
let cachedCloudApiKey = ''

function readCloudFromLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return null
    const mode = localStorage.getItem(`${COMFY_CLOUD_LOCAL_KEY}-mode`)
    const httpBase = localStorage.getItem(`${COMFY_CLOUD_LOCAL_KEY}-base`) || ''
    const apiKey = localStorage.getItem(`${COMFY_CLOUD_LOCAL_KEY}-key`) || ''
    return {
      mode: mode === COMFY_MODE_CLOUD ? COMFY_MODE_CLOUD : COMFY_MODE_LOCAL,
      httpBase, apiKey,
    }
  } catch { return null }
}

function writeCloudToLocalStorage({ mode, httpBase, apiKey }) {
  try {
    if (typeof localStorage === 'undefined') return
    if (mode != null)     localStorage.setItem(`${COMFY_CLOUD_LOCAL_KEY}-mode`, mode)
    if (httpBase != null) localStorage.setItem(`${COMFY_CLOUD_LOCAL_KEY}-base`, httpBase)
    if (apiKey != null)   localStorage.setItem(`${COMFY_CLOUD_LOCAL_KEY}-key`, apiKey)
  } catch { /* ignore */ }
}

;(function hydrateCloudFromLocalStorage() {
  const raw = readCloudFromLocalStorage()
  if (!raw) return
  cachedMode = raw.mode || COMFY_MODE_LOCAL
  cachedCloudHttpBase = raw.httpBase || ''
  cachedCloudApiKey = raw.apiKey || ''
})()

// Normalize a cloud base URL: must be http(s), no trailing slash, no
// /ws or /prompt suffix. Returns { ok, httpBase, error }.
export function parseCloudHttpBase(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: 'Cloud URL is required.' }
  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`
  }
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Cloud URL must be http(s).' }
    }
    // Strip trailing slash and any path component the user may have
    // pasted (e.g. .../ws or .../prompt). We always append our own
    // route names downstream.
    parsed.pathname = ''
    parsed.search = ''
    parsed.hash = ''
    const httpBase = parsed.toString().replace(/\/$/, '')
    return { ok: true, httpBase }
  } catch {
    return { ok: false, error: 'Invalid URL.' }
  }
}

export function deriveWsBase(httpBase) {
  if (!httpBase) return ''
  return httpBase.replace(/^http/i, (m) => m.toLowerCase() === 'https' ? 'wss' : 'ws')
}

// Active connection: respects mode. Falls back to local when cloud isn't
// configured (so a half-configured cloud doesn't brick the app).
export function getActiveComfyConnectionSync() {
  if (cachedMode === COMFY_MODE_CLOUD && cachedCloudHttpBase) {
    return {
      mode: COMFY_MODE_CLOUD,
      httpBase: cachedCloudHttpBase,
      wsBase: deriveWsBase(cachedCloudHttpBase),
      apiKey: cachedCloudApiKey || '',
    }
  }
  const local = getLocalComfyConnectionSync()
  return {
    mode: COMFY_MODE_LOCAL,
    httpBase: local.httpBase,
    wsBase: local.wsBase,
    apiKey: '',
  }
}

export function getActiveHttpBaseSync() { return getActiveComfyConnectionSync().httpBase }
export function getActiveWsBaseSync()   { return getActiveComfyConnectionSync().wsBase   }
export function getActiveApiKeySync()   { return getActiveComfyConnectionSync().apiKey   }
export function getActiveModeSync()     { return getActiveComfyConnectionSync().mode     }

// IPC payload helper: spread this into the options object you send to
// any `analysis:*` handler so main.js sees the right host + key. We need
// both because the renderer-side connection module lives in Vite-land
// and isn't accessible from the Node main process.
//
//   await window.electronAPI.optimizeFootage({
//     scene, projectDir,
//     ...getActiveComfyIpcContext(),
//   })
export function getActiveComfyIpcContext() {
  const c = getActiveComfyConnectionSync()
  return { comfyUrl: c.httpBase, apiKey: c.apiKey || null }
}

export async function hydrateComfyCloudConnection() {
  // Mirror of hydrateLocalComfyConnection — pulls the cloud config from
  // electron settings and prefers it over the localStorage fallback we
  // already loaded synchronously above.
  if (typeof window === 'undefined' || !window?.electronAPI?.getSetting) return
  try {
    const mode = await window.electronAPI.getSetting(COMFY_MODE_SETTING_KEY)
    if (mode === COMFY_MODE_CLOUD || mode === COMFY_MODE_LOCAL) cachedMode = mode
    const cloud = await window.electronAPI.getSetting(COMFY_CLOUD_SETTING_KEY)
    if (cloud && typeof cloud === 'object') {
      if (typeof cloud.httpBase === 'string') cachedCloudHttpBase = cloud.httpBase
      if (typeof cloud.apiKey === 'string')   cachedCloudApiKey = cloud.apiKey
    }
    // Persist to localStorage too so a renderer cold-start doesn't have
    // to wait on the IPC roundtrip before deciding which host to hit.
    writeCloudToLocalStorage({
      mode: cachedMode,
      httpBase: cachedCloudHttpBase,
      apiKey: cachedCloudApiKey,
    })
    dispatchConnectionChanged(getActiveComfyConnectionSync())
  } catch { /* ignore — keep last-known values */ }
}

export async function saveComfyMode(mode) {
  const normalized = mode === COMFY_MODE_CLOUD ? COMFY_MODE_CLOUD : COMFY_MODE_LOCAL
  cachedMode = normalized
  writeCloudToLocalStorage({ mode: normalized })
  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.setSetting) {
      await window.electronAPI.setSetting(COMFY_MODE_SETTING_KEY, normalized)
    }
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to persist mode.' }
  }
  dispatchConnectionChanged(getActiveComfyConnectionSync())
  return { success: true, mode: normalized }
}

export async function saveCloudComfyConnection({ httpBase, apiKey }) {
  const parsed = parseCloudHttpBase(httpBase)
  if (!parsed.ok) return { success: false, error: parsed.error }
  cachedCloudHttpBase = parsed.httpBase
  cachedCloudApiKey = String(apiKey || '').trim()
  writeCloudToLocalStorage({
    httpBase: cachedCloudHttpBase,
    apiKey: cachedCloudApiKey,
  })
  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.setSetting) {
      await window.electronAPI.setSetting(COMFY_CLOUD_SETTING_KEY, {
        httpBase: cachedCloudHttpBase,
        apiKey: cachedCloudApiKey,
      })
    }
  } catch (err) {
    return { success: false, error: err?.message || 'Failed to persist cloud settings.' }
  }
  dispatchConnectionChanged(getActiveComfyConnectionSync())
  return { success: true, httpBase: cachedCloudHttpBase }
}

// Probe a candidate cloud endpoint. Same shape as checkLocalComfyConnection
// so the UI can render either path with one component.
//
// Comfy Cloud doesn't expose /system_stats — that's a local-only ComfyUI
// helper. We hit /api/user instead (documented as the user-info endpoint)
// to verify both the URL and the API key in one call.
export async function checkCloudComfyConnection({ httpBase, apiKey, timeoutMs = 6000 } = {}) {
  const parsed = parseCloudHttpBase(httpBase)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)
  try {
    const headers = { Accept: 'application/json' }
    const key = String(apiKey || '').trim()
    if (key) {
      headers['X-API-Key'] = key
      headers['Authorization'] = `Bearer ${key}`  // belt-and-braces for hosts that use Bearer
    }
    const res = await fetch(`${parsed.httpBase}/api/user`, {
      signal: controller?.signal,
      headers,
    })
    if (!res.ok) {
      return { ok: false, status: res.status, httpBase: parsed.httpBase, error: `HTTP ${res.status}` }
    }
    // Validate that the response actually looks like ComfyUI's
    // /system_stats and not a dashboard HTML page returning 200 to any
    // path. Real ComfyUI returns a JSON object with a `system` field
    // (containing argv, comfyui_version, etc.). Pasting the dashboard
    // URL by mistake is the most common setup error here, so flag it
    // before the user discovers via cryptic /prompt failures later.
    const ct = String(res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('json')) {
      return {
        ok: false, status: res.status, httpBase: parsed.httpBase,
        error: `URL responded with ${ct || 'no content-type'} — expected JSON. This looks like a dashboard page, not the ComfyUI API. Look for an "API endpoint" or "Inference URL" in your Comfy Cloud dashboard.`,
      }
    }
    let body
    try { body = await res.json() } catch {
      return {
        ok: false, status: res.status, httpBase: parsed.httpBase,
        error: 'Response was not JSON — not a ComfyUI API endpoint.',
      }
    }
    // /api/user returns user / account info. We don't enforce a strict
    // shape (the doc doesn't promise specific fields), but if the host
    // is the right one it'll be a JSON object — that's enough.
    if (!body || typeof body !== 'object') {
      return {
        ok: false, status: res.status, httpBase: parsed.httpBase,
        error: 'Response was not a JSON object — not a Comfy Cloud /api/user endpoint.',
      }
    }
    return { ok: true, status: res.status, httpBase: parsed.httpBase }
  } catch (err) {
    return { ok: false, httpBase: parsed.httpBase, error: err?.message || 'Connection failed' }
  } finally {
    clearTimeout(timer)
  }
}
