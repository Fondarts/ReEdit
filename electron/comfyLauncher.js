/**
 * ComfyUI process launcher (Pass 1).
 *
 * Owns the ComfyUI child process: spawn, readiness probing, graceful stop,
 * restart, and a rolling log buffer mirrored to disk. Stays intentionally small
 * so Pass 2/3 can layer auto-start and tighter integrations on top.
 *
 * State model:
 *   unknown  - not yet probed
 *   idle     - no external ComfyUI detected, nothing launched by us
 *   starting - we spawned the process, waiting for HTTP readiness
 *   running  - HTTP ready, child process is ours
 *   external - HTTP ready but the process was started outside ComfyStudio
 *   stopping - user requested stop, we issued kill
 *   stopped  - cleanly stopped by user
 *   crashed  - unexpected exit without explicit stop
 */

const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const http = require('http')
const net = require('net')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

const LAUNCHER_SETTING_KEY = 'comfyLauncher'
const LOG_RING_MAX = 2000
const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024 // 50 MB per session before rotating
const STATE_EVENT = 'state'
const LOG_EVENT = 'log'

const DEFAULT_CONFIG = Object.freeze({
  launcherScript: '',
  autoStart: false,
  stopOnQuit: true,
  startupTimeoutMs: 120_000,
  extraArgs: '',
  disableAutoLaunch: true,
})

function nowMs() {
  return Date.now()
}

function safeCloneConfig(config) {
  const base = config && typeof config === 'object' ? config : {}
  return {
    launcherScript: typeof base.launcherScript === 'string' ? base.launcherScript : '',
    autoStart: Boolean(base.autoStart),
    stopOnQuit: base.stopOnQuit === undefined ? true : Boolean(base.stopOnQuit),
    startupTimeoutMs: Number.isFinite(Number(base.startupTimeoutMs)) ? Number(base.startupTimeoutMs) : DEFAULT_CONFIG.startupTimeoutMs,
    extraArgs: typeof base.extraArgs === 'string' ? base.extraArgs : '',
    disableAutoLaunch: base.disableAutoLaunch === undefined ? true : Boolean(base.disableAutoLaunch),
  }
}

/**
 * Detect the classic ComfyUI standalone-portable layout living next to the
 * launcher script (e.g. run_nvidia_gpu.bat). Returns { pythonExe, mainPy }
 * when a valid layout is found, otherwise null. Used so we can spawn python
 * directly and have full control over arguments — the default ComfyUI .bat
 * files don't forward %*, so we'd otherwise be unable to pass flags like
 * --disable-auto-launch.
 */
function detectPortableLayout(launcherScript) {
  try {
    const dir = path.dirname(launcherScript)
    const pythonExe = process.platform === 'win32'
      ? path.join(dir, 'python_embeded', 'python.exe')
      : path.join(dir, 'python_embeded', 'bin', 'python3')
    const mainPy = path.join(dir, 'ComfyUI', 'main.py')
    if (fs.existsSync(pythonExe) && fs.existsSync(mainPy)) {
      return { pythonExe, mainPy, cwd: dir }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Filter duplicate flags. If `--disable-auto-launch` is requested but already
 * present (e.g. user pasted it into extraArgs), avoid duplication.
 */
function ensureArgFlag(args, flag) {
  return args.includes(flag) ? args : [...args, flag]
}

function parseHttpBase(httpBase) {
  try {
    const url = new URL(String(httpBase || 'http://127.0.0.1:8188'))
    return {
      hostname: url.hostname || '127.0.0.1',
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol || 'http:',
    }
  } catch {
    return { hostname: '127.0.0.1', port: 8188, protocol: 'http:' }
  }
}

/**
 * Probe http://.../system_stats. Resolves to { ok, status, body, error }.
 */
function probeHttp(httpBase, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const parsed = parseHttpBase(httpBase)
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/system_stats',
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'ComfyStudio-Launcher/1.0' },
      },
      (res) => {
        let chunks = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { chunks += chunk })
        res.on('end', () => {
          resolve({ ok: res.statusCode === 200, status: res.statusCode || 0, body: chunks, error: '' })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (error) => {
      resolve({ ok: false, status: 0, body: '', error: error?.message || 'unknown' })
    })
    req.end()
  })
}

/**
 * Lightweight check: is something listening on <hostname>:<port>?
 * We use this before HTTP probing so we don't spam ECONNREFUSED logs during boot.
 */
function isPortOpen(httpBase, timeoutMs = 500) {
  return new Promise((resolve) => {
    const parsed = parseHttpBase(httpBase)
    const socket = net.connect({ host: parsed.hostname, port: parsed.port })
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      try { socket.destroy() } catch (_) { /* ignore */ }
      resolve(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Kill a child process tree. Returns a promise that resolves when the OS has
 * confirmed the process is gone (best-effort).
 */
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve()
      return
    }

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    const onExit = () => finish()
    child.once('exit', onExit)
    child.once('close', onExit)

    if (process.platform === 'win32' && child.pid) {
      try {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        killer.on('error', () => {
          // Fallback if taskkill is missing for some reason.
          try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
        })
        killer.on('exit', () => {
          // Give the OS a moment to reap; "exit" on the child follows shortly.
          setTimeout(finish, 500)
        })
      } catch (_) {
        try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
        setTimeout(finish, 500)
      }
    } else {
      try { child.kill('SIGTERM') } catch (_) { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch (_) { /* ignore */ }
      }, 8_000)
      child.once('exit', () => clearTimeout(killTimer))
      setTimeout(finish, 9_000)
    }
  })
}

/**
 * Scan the parent directory of the ComfyUI root for common launcher scripts.
 * Returns an array of candidate launchers ranked by preference.
 */
async function detectLaunchersForComfyRoot(comfyRootPath) {
  const root = String(comfyRootPath || '').trim()
  const results = []
  if (!root) return results

  const parent = path.dirname(root)
  if (!parent) return results

  const preferredNames = [
    { name: 'run_nvidia_gpu.bat', label: 'Portable NVIDIA GPU launcher', kind: 'nvidia_gpu' },
    { name: 'run_nvidia_gpu_fast_fp16_accumulation.bat', label: 'Portable NVIDIA GPU (fast FP16)', kind: 'nvidia_gpu_fast' },
    { name: 'run_cpu.bat', label: 'Portable CPU launcher', kind: 'cpu' },
    { name: 'run_nvidia_gpu.sh', label: 'NVIDIA GPU launcher (POSIX)', kind: 'nvidia_gpu' },
    { name: 'run_cpu.sh', label: 'CPU launcher (POSIX)', kind: 'cpu' },
  ]

  for (const entry of preferredNames) {
    const candidate = path.join(parent, entry.name)
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isFile()) {
        results.push({
          path: candidate,
          label: entry.label,
          kind: entry.kind,
          size: stat.size,
          modified: stat.mtimeMs,
        })
      }
    } catch (_) {
      /* launcher not present, keep scanning */
    }
  }

  return results
}

function chunkToLines(buffer, trailing) {
  const combined = `${trailing || ''}${buffer.toString('utf8')}`
  const lines = combined.split(/\r?\n/)
  const nextTrailing = lines.pop() ?? ''
  return { lines: lines.filter((line) => line.length > 0), trailing: nextTrailing }
}

function formatLogFilename(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  return `comfyui-${yyyy}${mm}${dd}-${hh}${mi}.log`
}

class ComfyLauncher extends EventEmitter {
  constructor({ logDir, getHttpBase, getConfig, setConfig, getComfyRootPath }) {
    super()
    this._state = 'unknown'
    this._child = null
    this._pid = null
    this._startedAt = 0
    this._stoppedAt = 0
    this._exitCode = null
    this._exitSignal = null
    this._ownership = 'none' // 'ours' | 'external' | 'none'
    this._probeTimer = null
    this._probingSince = 0
    this._startupTimeoutMs = DEFAULT_CONFIG.startupTimeoutMs
    this._lastStatusMessage = ''
    this._lastError = ''

    this._logRing = [] // { ts, stream, text }
    this._stdoutTrailing = ''
    this._stderrTrailing = ''
    this._logStream = null
    this._logFilePath = ''
    this._logBytesWritten = 0

    this._logDir = logDir
    this._getHttpBase = getHttpBase
    this._getConfig = getConfig
    this._setConfig = setConfig
    this._getComfyRootPath = getComfyRootPath
  }

  async init() {
    await this._ensureLogDir()
    await this._detectExternal()
  }

  async _ensureLogDir() {
    try {
      await fsp.mkdir(this._logDir, { recursive: true })
    } catch (error) {
      // Logging failures are non-fatal; we'll still emit to the ring buffer.
      console.warn('[comfyLauncher] failed to create log dir:', error?.message || error)
    }
  }

  _openLogFile() {
    try {
      if (this._logStream) {
        try { this._logStream.end() } catch (_) { /* ignore */ }
        this._logStream = null
      }
      this._logFilePath = path.join(this._logDir, formatLogFilename())
      this._logStream = fs.createWriteStream(this._logFilePath, { flags: 'a' })
      this._logBytesWritten = 0
      this._logStream.on('error', (error) => {
        console.warn('[comfyLauncher] log file error:', error?.message || error)
      })
    } catch (error) {
      console.warn('[comfyLauncher] could not open log file:', error?.message || error)
      this._logStream = null
      this._logFilePath = ''
    }
  }

  _closeLogFile() {
    if (this._logStream) {
      try { this._logStream.end() } catch (_) { /* ignore */ }
      this._logStream = null
    }
  }

  _appendLog(stream, line) {
    if (!line) return
    const entry = { ts: nowMs(), stream, text: line.length > 4000 ? `${line.slice(0, 4000)}…` : line }
    this._logRing.push(entry)
    if (this._logRing.length > LOG_RING_MAX) {
      this._logRing.splice(0, this._logRing.length - LOG_RING_MAX)
    }
    this.emit(LOG_EVENT, entry)

    if (this._logStream) {
      try {
        const payload = `[${new Date(entry.ts).toISOString()}][${stream}] ${entry.text}\n`
        const ok = this._logStream.write(payload)
        this._logBytesWritten += Buffer.byteLength(payload, 'utf8')
        if (!ok) {
          // Backpressure: ignore; we'll keep the ring buffer canonical.
        }
        if (this._logBytesWritten > LOG_FILE_MAX_BYTES) {
          this._openLogFile()
        }
      } catch (error) {
        console.warn('[comfyLauncher] log write failed:', error?.message || error)
      }
    }
  }

  _setState(nextState, patch = {}) {
    const changed = this._state !== nextState || Object.keys(patch).length > 0
    this._state = nextState
    if (patch.statusMessage !== undefined) this._lastStatusMessage = patch.statusMessage || ''
    if (patch.error !== undefined) this._lastError = patch.error || ''
    if (changed) this.emit(STATE_EVENT, this.getState())
  }

  getState() {
    return {
      state: this._state,
      ownership: this._ownership,
      pid: this._pid,
      startedAt: this._startedAt,
      stoppedAt: this._stoppedAt,
      exitCode: this._exitCode,
      exitSignal: this._exitSignal,
      uptimeMs: this._startedAt && this._state === 'running' ? Math.max(0, nowMs() - this._startedAt) : 0,
      launcherScript: (this._getConfig?.()?.launcherScript) || '',
      httpBase: this._getHttpBase?.() || '',
      statusMessage: this._lastStatusMessage,
      error: this._lastError,
      logFilePath: this._logFilePath,
      probingSince: this._probingSince,
    }
  }

  getLogs({ tailLines = 400 } = {}) {
    const count = Math.max(1, Math.min(LOG_RING_MAX, Number(tailLines) || 400))
    return this._logRing.slice(-count)
  }

  async _detectExternal() {
    const httpBase = this._getHttpBase?.() || ''
    if (!httpBase) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: 'ComfyUI not detected.' })
      return
    }

    const portOpen = await isPortOpen(httpBase, 500)
    if (!portOpen) {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: 'ComfyUI is not running.' })
      return
    }

    const probe = await probeHttp(httpBase, 1500)
    if (probe.ok) {
      this._ownership = 'external'
      this._setState('external', { statusMessage: `ComfyUI already running at ${httpBase}` })
    } else {
      this._ownership = 'none'
      this._setState('idle', { statusMessage: `Something is on ${httpBase} but /system_stats did not respond.` })
    }
  }

  async start() {
    if (this._state === 'running' || this._state === 'starting' || this._state === 'external') {
      return { success: false, error: `ComfyUI is already in state "${this._state}".` }
    }

    const config = safeCloneConfig(this._getConfig?.())
    const launcherScript = String(config.launcherScript || '').trim()
    if (!launcherScript) {
      const message = 'No ComfyUI launcher script is configured. Pick your run_nvidia_gpu.bat (or equivalent) in Settings.'
      this._setState('idle', { statusMessage: message, error: 'missing-launcher' })
      return { success: false, error: message }
    }

    try {
      const stat = await fsp.stat(launcherScript)
      if (!stat.isFile()) throw new Error('Not a file')
    } catch (error) {
      const message = `Launcher script does not exist or is not a file: ${launcherScript}`
      this._setState('idle', { statusMessage: message, error: 'missing-launcher-file' })
      return { success: false, error: message }
    }

    const httpBase = this._getHttpBase?.() || ''
    this._startupTimeoutMs = Math.max(10_000, Number(config.startupTimeoutMs) || DEFAULT_CONFIG.startupTimeoutMs)

    this._openLogFile()
    this._appendLog('system', `Starting ComfyUI from ${launcherScript}`)
    this._appendLog('system', `cwd=${path.dirname(launcherScript)} httpBase=${httpBase || 'unknown'}`)

    let child
    try {
      child = await this._spawnLauncher(launcherScript, config)
    } catch (error) {
      const message = `Failed to spawn ComfyUI: ${error?.message || error}`
      this._appendLog('system', message)
      this._setState('idle', { statusMessage: message, error: 'spawn-failed' })
      this._closeLogFile()
      return { success: false, error: message }
    }

    this._child = child
    this._pid = child.pid || null
    this._ownership = 'ours'
    this._startedAt = nowMs()
    this._stoppedAt = 0
    this._exitCode = null
    this._exitSignal = null
    this._probingSince = nowMs()
    this._setState('starting', { statusMessage: `Starting ComfyUI (pid ${this._pid}). First boot can take 30-60s.` })

    child.stdout?.on('data', (buf) => {
      const result = chunkToLines(buf, this._stdoutTrailing)
      this._stdoutTrailing = result.trailing
      for (const line of result.lines) this._appendLog('stdout', line)
    })
    child.stderr?.on('data', (buf) => {
      const result = chunkToLines(buf, this._stderrTrailing)
      this._stderrTrailing = result.trailing
      for (const line of result.lines) this._appendLog('stderr', line)
    })
    child.on('exit', (code, signal) => {
      this._exitCode = typeof code === 'number' ? code : null
      this._exitSignal = signal || null
      this._stoppedAt = nowMs()
      const explicit = this._state === 'stopping'
      this._appendLog('system', `Process exited (code=${this._exitCode}, signal=${this._exitSignal || 'none'}).`)

      this._child = null
      this._pid = null
      this._ownership = 'none'
      this._stopProbing()

      if (explicit) {
        this._setState('stopped', { statusMessage: 'ComfyUI stopped.' })
      } else if ((this._exitCode ?? -1) === 0) {
        this._setState('stopped', { statusMessage: 'ComfyUI exited.' })
      } else {
        this._setState('crashed', {
          statusMessage: `ComfyUI exited unexpectedly (code ${this._exitCode}${this._exitSignal ? `, signal ${this._exitSignal}` : ''}).`,
          error: 'unexpected-exit',
        })
      }

      this._closeLogFile()
    })
    child.on('error', (error) => {
      this._appendLog('system', `Process error: ${error?.message || error}`)
    })

    this._startProbing(httpBase, this._startupTimeoutMs)
    return { success: true }
  }

  async _spawnLauncher(launcherScript, config) {
    const cwd = path.dirname(launcherScript)
    const extraArgs = String(config.extraArgs || '').trim()
    const extraArgTokens = extraArgs ? splitShellArgs(extraArgs) : []
    const isWindowsBat = /\.(bat|cmd)$/i.test(launcherScript)

    // Preferred path: if the launcher lives inside a standard ComfyUI
    // portable build, spawn python directly. This lets us pass flags like
    // --disable-auto-launch reliably because the default .bat files in
    // ComfyUI_windows_portable do NOT forward %* to main.py.
    const portable = detectPortableLayout(launcherScript)
    if (portable) {
      let baseArgs = ['-s', portable.mainPy, '--windows-standalone-build']
      if (config.disableAutoLaunch !== false) {
        baseArgs = ensureArgFlag(baseArgs, '--disable-auto-launch')
      }
      const mergedArgs = (() => {
        const out = [...baseArgs]
        for (const token of extraArgTokens) {
          if (!out.includes(token)) out.push(token)
        }
        return out
      })()
      this._appendLog('system', `Launching ComfyUI directly: ${portable.pythonExe} ${mergedArgs.join(' ')}`)
      return spawn(portable.pythonExe, mergedArgs, {
        cwd: portable.cwd,
        windowsHide: true,
        // detached:true puts the child in its own process group so it can
        // survive the parent if the user chooses "Leave ComfyUI running" at
        // quit time. We still keep stdio pipes for live log capture while
        // ComfyStudio is running; on detach we release them explicitly.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    }

    // Fallback: run the user's launcher script. Arg forwarding depends on
    // whether the script itself propagates %* / "$@".
    if (process.platform === 'win32' && isWindowsBat) {
      const args = ['/c', launcherScript]
      if (config.disableAutoLaunch !== false) args.push('--disable-auto-launch')
      if (extraArgTokens.length) args.push(...extraArgTokens)
      this._appendLog('system', `Launching ComfyUI via cmd /c ${launcherScript} (args forwarding depends on your .bat)`)
      return spawn('cmd.exe', args, {
        cwd,
        windowsHide: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }

    if (process.platform !== 'win32') {
      const parts = []
      if (config.disableAutoLaunch !== false) parts.push('--disable-auto-launch')
      if (extraArgs) parts.push(extraArgs)
      const cmd = parts.length
        ? `exec "${launcherScript}" ${parts.join(' ')}`
        : `exec "${launcherScript}"`
      return spawn('bash', ['-c', cmd], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    }

    const finalArgs = [...extraArgTokens]
    if (config.disableAutoLaunch !== false) finalArgs.unshift('--disable-auto-launch')
    return spawn(launcherScript, finalArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  _startProbing(httpBase, timeoutMs) {
    this._stopProbing()
    const startedAt = nowMs()
    const tick = async () => {
      if (!this._child) return
      const elapsed = nowMs() - startedAt
      if (elapsed > timeoutMs) {
        this._appendLog('system', `Startup probe timed out after ${Math.round(elapsed / 1000)}s. Killing process.`)
        this._setState('stopping', { statusMessage: 'ComfyUI did not become ready in time. Stopping.', error: 'startup-timeout' })
        try { await killProcessTree(this._child) } catch (_) { /* ignore */ }
        return
      }

      const portOpen = await isPortOpen(httpBase, 500)
      if (!portOpen) {
        this._probeTimer = setTimeout(tick, 750)
        return
      }
      const probe = await probeHttp(httpBase, 1500)
      if (probe.ok) {
        this._ownership = 'ours'
        this._setState('running', { statusMessage: `ComfyUI ready at ${httpBase} (pid ${this._pid}).` })
        this._probeTimer = null
        return
      }
      this._probeTimer = setTimeout(tick, 750)
    }
    this._probeTimer = setTimeout(tick, 500)
  }

  _stopProbing() {
    if (this._probeTimer) {
      clearTimeout(this._probeTimer)
      this._probeTimer = null
    }
    this._probingSince = 0
  }

  async stop() {
    if (this._state === 'external') {
      return { success: false, error: 'ComfyUI was started outside of ComfyStudio. Stop it from the window where you started it.' }
    }
    if (!this._child) {
      return { success: false, error: 'No ComfyUI process is currently owned by ComfyStudio.' }
    }
    this._setState('stopping', { statusMessage: 'Stopping ComfyUI…' })
    this._appendLog('system', 'Stop requested by user.')
    try {
      await killProcessTree(this._child)
      return { success: true }
    } catch (error) {
      const message = `Failed to stop ComfyUI: ${error?.message || error}`
      this._appendLog('system', message)
      this._setState('running', { statusMessage: message, error: 'stop-failed' })
      return { success: false, error: message }
    }
  }

  async restart() {
    if (this._state === 'external') {
      return {
        success: false,
        error: 'ComfyUI is externally managed. Pass 2 will add a soft restart via ComfyUI-Manager for this case.',
      }
    }

    if (this._child) {
      this._appendLog('system', 'Restart requested by user.')
      const stopResult = await this.stop()
      if (!stopResult.success) return stopResult
      // Wait for the child exit to fully settle.
      await sleep(300)
    }

    return this.start()
  }

  async refreshExternal() {
    if (this._ownership === 'ours') return
    await this._detectExternal()
  }

  async shutdown({ confirmStop = true } = {}) {
    if (!this._child) return { stopped: false }
    const config = safeCloneConfig(this._getConfig?.())
    if (!config.stopOnQuit && !confirmStop) return { stopped: false }
    this._setState('stopping', { statusMessage: 'Stopping ComfyUI (app shutting down)…' })
    this._appendLog('system', 'Shutdown requested by host app.')
    try { await killProcessTree(this._child) } catch (_) { /* ignore */ }
    return { stopped: true }
  }

  /**
   * Release the child process so it keeps running after ComfyStudio quits.
   *
   * This is a best-effort operation: we unref the subprocess, detach our
   * stdio pipes, and strip listeners so its future exit doesn't touch us.
   * When the parent Electron process exits, the child continues as an
   * orphaned process (on Windows it's already in its own process group from
   * `detached: true`; on POSIX we rely on the existing POSIX launcher which
   * spawns through `bash -c exec …` so the final process has no parent tie).
   *
   * Returns { detached: true, pid } on success, { detached: false } if no
   * owned process is running.
   */
  async detach() {
    if (!this._child) return { detached: false }
    const pid = this._pid
    this._appendLog('system', 'Detach requested — leaving ComfyUI running after ComfyStudio quits.')

    this._stopProbing()

    const child = this._child
    // Remove our listeners so its (eventual) exit doesn't mutate our state
    // after we've already told the UI we detached.
    try { child.removeAllListeners('exit') } catch (_) { /* ignore */ }
    try { child.removeAllListeners('close') } catch (_) { /* ignore */ }
    try { child.removeAllListeners('error') } catch (_) { /* ignore */ }

    // Drain and destroy stdio so node stops holding handles to the child's
    // pipes. The child still owns the write end; Python's default behaviour
    // on a broken pipe is to suppress subsequent print errors (BrokenPipeError
    // is caught globally on shutdown). ComfyUI keeps running.
    try { child.stdout?.removeAllListeners('data'); child.stdout?.destroy() } catch (_) { /* ignore */ }
    try { child.stderr?.removeAllListeners('data'); child.stderr?.destroy() } catch (_) { /* ignore */ }
    try { child.stdin?.destroy() } catch (_) { /* ignore */ }

    try { child.unref() } catch (_) { /* ignore */ }

    // Flip ownership to "external" so if ComfyStudio is relaunched while
    // ComfyUI is still up, the normal detectExternal path adopts it.
    this._ownership = 'external'
    this._child = null
    this._setState('external', {
      statusMessage: pid
        ? `ComfyUI left running (pid ${pid}). It will continue after ComfyStudio quits.`
        : 'ComfyUI left running. It will continue after ComfyStudio quits.',
    })

    this._closeLogFile()
    return { detached: true, pid }
  }
}

/**
 * Quick-and-dirty shell-style argument splitter: keeps quoted substrings
 * together and treats everything else as whitespace-separated tokens.
 */
function splitShellArgs(input) {
  const text = String(input || '').trim()
  if (!text) return []
  const out = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) { quote = '' } else { current += ch }
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (current) { out.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

module.exports = {
  ComfyLauncher,
  detectLaunchersForComfyRoot,
  DEFAULT_CONFIG,
  LAUNCHER_SETTING_KEY,
  safeCloneConfig,
  splitShellArgs,
  killProcessTree,
  probeHttp,
  isPortOpen,
}
