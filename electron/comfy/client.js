// Canonical ComfyUI client for the main process. Extracted verbatim from
// electron/main.js so every pipeline handler shares ONE implementation of
// auth, path prefixing, upload/download, queueing and job polling — local
// ComfyUI and Comfy Cloud alike. The renderer's src/services/comfyui.js
// is frozen for legacy interactive flows; all new generation goes through
// this module via IPC.
//
// The factory takes an injectable fetch so the transport can be unit
// tested in plain Node (electron's net.fetch is picked up automatically
// when running inside the app).

const fs = require('fs').promises
const path = require('path')

const DEFAULT_LOCAL_COMFY_PORT = 8188
const DEFAULT_LOCAL_COMFY_URL = `http://127.0.0.1:${DEFAULT_LOCAL_COMFY_PORT}`

// Status vocabulary on Cloud isn't strictly documented, so we accept the
// common synonyms, matched case-insensitively.
const TERMINAL_OK_STATES = new Set([
  'completed', 'finished', 'succeeded', 'success', 'done', 'ok',
  'complete', 'completed_at', 'ready', 'ran', 'finalized',
])
const TERMINAL_FAIL_STATES = new Set([
  'failed', 'fail', 'cancelled', 'canceled', 'error', 'errored',
  'timeout', 'timed_out', 'aborted',
])

// Helper: is this comfyUrl a non-loopback (cloud) endpoint? Handlers
// that copy files into the local input dir use this to short-circuit
// with a clear error instead of failing deep in the workflow.
function isCloudComfyUrl(comfyUrl) {
  try {
    const parsed = new URL(comfyUrl)
    // WHATWG URL keeps the brackets on IPv6 hostnames ('[::1]') — strip
    // them so the loopback comparison actually matches.
    const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
    if (!host) return false
    if (host === 'localhost' || host === '::1') return false
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return false
    return true
  } catch { return false }
}

// Auth headers for cloud requests. Returns an empty object on local
// since loopback doesn't authenticate. `apiKey` is sent twice (X-API-Key
// is Comfy Cloud's documented header; Authorization: Bearer is a
// fallback for proxies that standardised on Bearer).
function _comfyHeaders(comfyUrl, apiKey) {
  if (!isCloudComfyUrl(comfyUrl)) return {}
  const key = String(apiKey || '').trim()
  if (!key) return {}
  return { 'X-API-Key': key, Authorization: `Bearer ${key}` }
}

// Path prefixer. Comfy Cloud puts its endpoints under /api/...;
// local ComfyUI uses the same routes at the root.
function _comfyApiPath(comfyUrl, p) {
  const route = p.startsWith('/') ? p : `/${p}`
  if (!isCloudComfyUrl(comfyUrl)) return route
  return route.startsWith('/api/') ? route : `/api${route}`
}

// Sniff a Comfy Cloud `/api/jobs/<id>` body for "this looks done" signals.
// Different deployments use different shapes; we accept any of:
//   - body.outputs (top-level dict mapping node ids to output records)
//   - body.job.outputs (same, nested one level)
//   - body.status / body.state in TERMINAL_OK_STATES with outputs present
//   - body.result / body.results carrying outputs
// Returns the canonical { outputs, ...rest } shape on success, null otherwise.
function _sniffCompletedJobBody(body) {
  if (!body || typeof body !== 'object') return null
  const outputs = body.outputs
    || body.job?.outputs
    || body.result?.outputs
    || body.results?.outputs
  if (outputs && typeof outputs === 'object' && Object.keys(outputs).length > 0) {
    return { ...body, outputs }
  }
  const rawState = String(
    body.status ?? body.state ?? body.job?.status ?? body.job?.state ?? ''
  ).toLowerCase().trim()
  if (TERMINAL_OK_STATES.has(rawState) && (body.outputs || body.job?.outputs)) {
    return { ...body, outputs: body.outputs || body.job?.outputs }
  }
  return null
}

function createComfyClient({ fetchImpl } = {}) {
  let _fetch = fetchImpl
  if (!_fetch) {
    try {
      // Inside Electron main use net.fetch (respects proxy settings and
      // Chromium's network stack). Falls back to global fetch in tests.
      const { net } = require('electron')
      if (net?.fetch) _fetch = (...args) => net.fetch(...args)
    } catch { /* not running inside electron */ }
    if (!_fetch) _fetch = (...args) => globalThis.fetch(...args)
  }

  // Upload a local file to ComfyUI's input via /upload/image. Works the
  // same on local (the ComfyUI server writes it to its input/ dir) and on
  // cloud (the file is staged remotely for the workflow to consume). The
  // returned `name` is what LoadVideo / LoadImage nodes reference.
  //
  // Returns { name, subfolder, type } on success.
  async function uploadFileToComfy({
    comfyUrl, apiKey, localFilePath, filename, subfolder = '', type = 'input',
  }) {
    const fileBuffer = await fs.readFile(localFilePath)
    const form = new FormData()
    // ComfyUI's /upload/image accepts any media (mp4 / wav / png) under
    // the 'image' multipart field — the field name is historical.
    const blob = new Blob([fileBuffer])
    form.append('image', blob, filename || path.basename(localFilePath))
    if (subfolder) form.append('subfolder', subfolder)
    form.append('type', type)
    form.append('overwrite', 'true')

    const url = `${comfyUrl}${_comfyApiPath(comfyUrl, '/upload/image')}`
    const res = await _fetch(url, {
      method: 'POST',
      headers: _comfyHeaders(comfyUrl, apiKey),
      body: form,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Upload failed (${res.status}) for ${path.basename(localFilePath)}: ${text.slice(0, 300)}`)
    }
    return await res.json()
  }

  // Download a generated artifact from ComfyUI via /view. Follows redirects
  // (Comfy Cloud responds with a 302 to a signed URL). Writes to destPath.
  async function downloadFromComfy({
    comfyUrl, apiKey, filename, subfolder = '', type = 'output', destPath,
  }) {
    const params = new URLSearchParams({ filename, type })
    if (subfolder) params.set('subfolder', subfolder)
    const url = `${comfyUrl}${_comfyApiPath(comfyUrl, '/view')}?${params.toString()}`
    const res = await _fetch(url, {
      headers: _comfyHeaders(comfyUrl, apiKey),
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`Download failed (${res.status}) for ${filename}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.writeFile(destPath, buf)
    return destPath
  }

  // POST a workflow to /prompt and return the prompt_id. When the graph
  // contains Partner API nodes (Kling / Seedance / Vidu / Veo / Luma / …)
  // the worker must ALSO authenticate against comfy.org — that auth
  // travels in the POST body under `extra_data.api_key_comfy_org`, not in
  // headers. Pass includeComfyOrgKey: true for those workflows; it's a
  // no-op on local endpoints. See docs.comfy.org/development/cloud.
  async function queuePromptToComfy({ comfyUrl, apiKey, workflow, includeComfyOrgKey = false, clientId }) {
    const payload = { prompt: workflow }
    if (clientId) payload.client_id = clientId
    if (includeComfyOrgKey && isCloudComfyUrl(comfyUrl) && apiKey) {
      payload.extra_data = { api_key_comfy_org: apiKey }
    }
    let res
    try {
      res = await _fetch(`${comfyUrl}${_comfyApiPath(comfyUrl, '/prompt')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._comfyHeaders(comfyUrl, apiKey) },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      throw new Error(`Could not reach ComfyUI at ${comfyUrl}: ${err.message}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ComfyUI rejected the workflow (${res.status}): ${body.slice(0, 400)}`)
    }
    const json = await res.json()
    const promptId = json?.prompt_id
    if (!promptId) throw new Error('ComfyUI returned no prompt_id.')
    return promptId
  }

  // Poll for job completion. Local ComfyUI exposes /history/<id> with the
  // outputs as soon as the job finishes; Cloud splits status
  // (/api/job/<id>/status) from outputs (/api/jobs/<id>). This helper
  // hides that difference.
  //
  // Returns the history-shaped object: { outputs: { [nodeId]: { ... } }, status }
  async function waitForComfyJob({
    comfyUrl, apiKey, promptId, timeoutMs = 30 * 60 * 1000, pollMs = 2000, onTick,
  }) {
    const headers = _comfyHeaders(comfyUrl, apiKey)
    const startedAt = Date.now()
    const cloud = isCloudComfyUrl(comfyUrl)
    const seenStates = new Set()
    // How often to fall through to a direct `/api/jobs/<id>` poke even when
    // /status looks unfinished. Some Cloud deployments leave /status stuck
    // on "running" indefinitely after the job actually finished — pinging
    // the outputs endpoint directly rescues those cases. Every 5 ticks
    // (≈10-15s with the typical pollMs) keeps the cost low.
    let tick = 0
    while (true) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Comfy job ${promptId} timed out after ${Math.round(timeoutMs / 60000)} min.`)
      }
      if (cloud) {
        // Lightweight status probe first; fetch full outputs only when done.
        const statusRes = await _fetch(`${comfyUrl}/api/job/${encodeURIComponent(promptId)}/status`, { headers })
        if (statusRes.ok) {
          const s = await statusRes.json().catch(() => ({}))
          onTick?.(s)
          // The status field may live at the top level or nested under
          // `state` / `job.status` depending on the deployment. Try them
          // all and lowercase the result.
          const rawState = String(
            s?.status ?? s?.state ?? s?.job?.status ?? s?.job?.state ?? ''
          ).toLowerCase().trim()
          if (rawState && !seenStates.has(rawState)) {
            seenStates.add(rawState)
            // Dump the whole status response the first time we see a new
            // state, so a stuck poll leaves an audit trail we can debug
            // later without asking the user for DevTools.
            console.log(`[waitForComfyJob] cloud status for ${promptId}: "${rawState}" · body: ${JSON.stringify(s).slice(0, 500)}`)
          }
          if (TERMINAL_OK_STATES.has(rawState)) {
            const outRes = await _fetch(`${comfyUrl}/api/jobs/${encodeURIComponent(promptId)}`, { headers })
            if (!outRes.ok) throw new Error(`Job ${promptId} ${rawState} but /api/jobs returned ${outRes.status}`)
            return await outRes.json()
          }
          if (TERMINAL_FAIL_STATES.has(rawState)) {
            // Surface every error text the API included so the user sees
            // why the job failed instead of a generic "failed". /status
            // usually only carries the top-level state — the full traceback
            // lives on /api/jobs/<id> under `error` / `messages` / `logs`.
            // Fetch it as a follow-up so the throw carries the actionable
            // detail.
            let detail = s?.error || s?.message || s?.job?.error || ''
            try {
              const jobRes = await _fetch(`${comfyUrl}/api/jobs/${encodeURIComponent(promptId)}`, { headers })
              if (jobRes.ok) {
                const body = await jobRes.json().catch(() => ({}))
                const candidates = [
                  body?.error, body?.message, body?.job?.error, body?.job?.message,
                  Array.isArray(body?.messages) ? body.messages.map((m) => typeof m === 'string' ? m : JSON.stringify(m)).join(' | ') : null,
                  Array.isArray(body?.job?.messages) ? body.job.messages.map((m) => typeof m === 'string' ? m : JSON.stringify(m)).join(' | ') : null,
                  typeof body?.logs === 'string' ? body.logs.slice(-800) : null,
                  typeof body?.job?.logs === 'string' ? body.job.logs.slice(-800) : null,
                ].filter(Boolean)
                if (candidates.length > 0) detail = candidates.join(' · ')
                else if (!detail) detail = JSON.stringify(body).slice(0, 600)
                console.log(`[waitForComfyJob] cloud error body for ${promptId}: ${JSON.stringify(body).slice(0, 800)}`)
              }
            } catch (err) {
              console.log(`[waitForComfyJob] could not fetch detailed error for ${promptId}: ${err?.message}`)
            }
            throw new Error(`Comfy job ${promptId} ${rawState}${detail ? `: ${String(detail).slice(0, 500)}` : '.'}`)
          }
        } else if (statusRes.status === 404) {
          // Some deployments retire the status row once the job finishes
          // and only keep /api/jobs/<id>. Probe the full record as a
          // fallback before treating the 404 as fatal.
          const outRes = await _fetch(`${comfyUrl}/api/jobs/${encodeURIComponent(promptId)}`, { headers })
          if (outRes.ok) {
            const body = await outRes.json().catch(() => null)
            const canonical = _sniffCompletedJobBody(body)
            if (canonical) return canonical
          }
        }
        // Even when /status said something non-terminal, the job may
        // actually be done — happens when the deployment doesn't update
        // /status promptly. Every few ticks, ask the outputs endpoint
        // directly and accept it as terminal if we see outputs.
        tick += 1
        if (tick % 5 === 0) {
          try {
            const outRes = await _fetch(`${comfyUrl}/api/jobs/${encodeURIComponent(promptId)}`, { headers })
            if (outRes.ok) {
              const body = await outRes.json().catch(() => null)
              const canonical = _sniffCompletedJobBody(body)
              if (canonical) {
                console.log(`[waitForComfyJob] ${promptId} recovered via /api/jobs while /status was still non-terminal.`)
                return canonical
              }
            }
          } catch (_) { /* ignore — keep polling /status */ }
        }
      } else {
        const res = await _fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, { headers })
        if (res.ok) {
          const data = await res.json().catch(() => ({}))
          const entry = data?.[promptId]
          if (entry) {
            onTick?.(entry)
            if (entry?.status?.completed) return entry
            if (entry?.status?.status_str === 'error') {
              throw new Error(`Comfy job ${promptId} failed.`)
            }
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  return {
    uploadFileToComfy,
    downloadFromComfy,
    queuePromptToComfy,
    waitForComfyJob,
  }
}

const defaultClient = createComfyClient()

module.exports = {
  DEFAULT_LOCAL_COMFY_PORT,
  DEFAULT_LOCAL_COMFY_URL,
  TERMINAL_OK_STATES,
  TERMINAL_FAIL_STATES,
  isCloudComfyUrl,
  _comfyHeaders,
  _comfyApiPath,
  _sniffCompletedJobBody,
  createComfyClient,
  uploadFileToComfy: defaultClient.uploadFileToComfy,
  downloadFromComfy: defaultClient.downloadFromComfy,
  queuePromptToComfy: defaultClient.queuePromptToComfy,
  waitForComfyJob: defaultClient.waitForComfyJob,
}
