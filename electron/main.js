const { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard, shell, session } = require('electron')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs').promises
const fsSync = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const { Readable } = require('stream')
const { fileURLToPath } = require('url')
const ffmpegStaticPath = require('ffmpeg-static')
const ffprobeStatic = require('ffprobe-static')
const ffprobeStaticPath = ffprobeStatic?.path || ffprobeStatic
const {
  ComfyLauncher,
  detectLaunchersForComfyRoot,
  DEFAULT_CONFIG: DEFAULT_LAUNCHER_CONFIG,
  LAUNCHER_SETTING_KEY,
  safeCloneConfig: safeCloneLauncherConfig,
} = require('./comfyLauncher')

const isDev = !app.isPackaged

// Register `comfystudio://` as a privileged scheme BEFORE `app.ready`.
// Without this the scheme only works for `<img>` (resource loader) —
// `<video>`, `<audio>`, and renderer `fetch()` need the privileges
// below. `stream: true` specifically enables byte-range requests that
// `<video>` issues under the hood. We deliberately DO NOT set
// `standard: true` here: the standard-URL parser normalises the path
// (lowercases, reorders, treats percent-encoded backslashes as host
// delimiters) and breaks the handler below, which was written around
// `request.url.replace('comfystudio://', '')`. A non-standard scheme
// keeps the raw encoded path intact on the way in. `corsEnabled`
// requires `standard:true`, so we skip it too — same-origin playback
// doesn't need CORS anyway.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'comfystudio',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
])

// App icon (build/icon.png) – used for window and taskbar/dock
const iconPath = path.join(__dirname, '..', 'build', 'icon.png')

const SPLASH_MIN_DURATION_MS = 4500  // Minimum time splash is visible (Resolve-style)
const COMFYUI_CHECK_MS = 2500        // Max wait for ComfyUI
const STEP_DELAY_MS = 400            // Delay between status messages
const COMFY_CONNECTION_SETTING_KEY = 'comfyConnection'
const DEFAULT_LOCAL_COMFY_PORT = 8188
const DEFAULT_LOCAL_COMFY_URL = `http://127.0.0.1:${DEFAULT_LOCAL_COMFY_PORT}`

let mainWindow = null
let splashWindow = null
let exportWorkerWindow = null
let restoreFullscreenAfterMinimize = false
const settingsPath = path.join(app.getPath('userData'), 'settings.json')

function resolvePackagedBinaryPath(binaryPath) {
  if (!binaryPath || typeof binaryPath !== 'string') return binaryPath
  if (!app.isPackaged) return binaryPath

  const packagedCandidates = []

  if (binaryPath === ffmpegStaticPath) {
    packagedCandidates.push(path.join(process.resourcesPath, 'bin', path.basename(binaryPath)))
  }

  if (binaryPath === ffprobeStaticPath) {
    packagedCandidates.push(
      path.join(process.resourcesPath, 'bin', 'ffprobe-static', process.platform, process.arch, path.basename(binaryPath))
    )
  }

  packagedCandidates.push(binaryPath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1'))

  for (const candidate of packagedCandidates) {
    if (candidate && candidate !== binaryPath && fsSync.existsSync(candidate)) {
      return candidate
    }
  }

  return binaryPath
}

const ffmpegPath = resolvePackagedBinaryPath(ffmpegStaticPath)
const ffprobePath = resolvePackagedBinaryPath(ffprobeStaticPath)

async function writeFileAtomic(filePath, data, options) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  )

  try {
    await fs.writeFile(tempPath, data, options)
    await fs.rename(tempPath, filePath)
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch (_) {
      // Ignore cleanup failures for temp files.
    }
    throw error
  }
}

function getWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return {
      isMaximized: false,
      isFullScreen: false,
    }
  }

  return {
    isMaximized: mainWindow.isMaximized(),
    isFullScreen: mainWindow.isFullScreen(),
  }
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:stateChanged', getWindowState())
}

function setSplashStatus(text) {
  if (!splashWindow || splashWindow.isDestroyed()) return
  const escaped = JSON.stringify(String(text))
  splashWindow.webContents.executeJavaScript(`document.getElementById('splash-status').textContent = ${escaped}`).catch(() => {})
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function captureCommandOutput(command, args = [], timeoutMs = 2500) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    let child = null
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch (error) {
      resolve({ success: false, output: '', error: error.message })
      return
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        // Ignore failures when terminating helper processes.
      }
      finish({ success: false, output: stdout || stderr, error: 'Timed out while gathering system info.' })
    }, timeoutMs)

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    child.on('error', (error) => {
      finish({ success: false, output: stdout || stderr, error: error.message })
    })
    child.on('close', (code) => {
      finish({
        success: code === 0,
        output: (stdout || stderr).trim(),
        error: code === 0 ? null : (stderr.trim() || `Command exited with code ${code}`),
      })
    })
  })
}

function emitWorkflowSetupProgress(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('workflowSetup:progress', {
    ts: Date.now(),
    level: 'info',
    stage: '',
    message: '',
    ...payload,
  })
}

function clampPercent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.max(0, Math.min(100, numeric))
}

function getWorkflowSetupOverallPercent({ completedTasks = 0, totalTasks = 0, taskPercent = null } = {}) {
  const total = Number(totalTasks)
  if (!Number.isFinite(total) || total <= 0) return 0

  const completed = Math.max(0, Math.min(total, Number(completedTasks) || 0))
  const normalizedTaskPercent = clampPercent(taskPercent)
  const unitsDone = completed + (normalizedTaskPercent == null ? 0 : (normalizedTaskPercent / 100))
  return clampPercent(Math.round((unitsDone / total) * 100)) ?? 0
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function isDirectoryPath(targetPath) {
  try {
    const stat = await fs.stat(targetPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function normalizePythonCommand(pythonInfo = null) {
  if (!pythonInfo?.command) return ''
  return [pythonInfo.command, ...(Array.isArray(pythonInfo.baseArgs) ? pythonInfo.baseArgs : [])].join(' ').trim()
}

async function detectPythonCommandForComfyRoot(rootPath) {
  const windowsCandidates = [
    path.join(rootPath, 'python_embeded', 'python.exe'),
    path.join(rootPath, 'python_embedded', 'python.exe'),
    path.join(rootPath, '.venv', 'Scripts', 'python.exe'),
    path.join(rootPath, 'venv', 'Scripts', 'python.exe'),
    path.join(rootPath, 'env', 'Scripts', 'python.exe'),
  ]
  const posixCandidates = [
    path.join(rootPath, '.venv', 'bin', 'python'),
    path.join(rootPath, 'venv', 'bin', 'python'),
    path.join(rootPath, 'env', 'bin', 'python'),
  ]

  const directCandidates = process.platform === 'win32' ? windowsCandidates : posixCandidates
  for (const candidate of directCandidates) {
    if (!candidate) continue
    if (!(await pathExists(candidate))) continue
    if (await isDirectoryPath(candidate)) continue
    return {
      command: candidate,
      baseArgs: [],
      source: 'embedded',
    }
  }

  const systemCandidates = process.platform === 'win32'
    ? [
        { command: 'python', baseArgs: [] },
        { command: 'py', baseArgs: ['-3'] },
      ]
    : [
        { command: 'python3', baseArgs: [] },
        { command: 'python', baseArgs: [] },
      ]

  for (const candidate of systemCandidates) {
    const result = await captureCommandOutput(candidate.command, [...candidate.baseArgs, '--version'], 3000)
    if (!result.success) continue
    return {
      ...candidate,
      source: 'system',
      version: result.output || '',
    }
  }

  return {
    command: '',
    baseArgs: [],
    source: '',
    version: '',
  }
}

async function validateWorkflowSetupRootInternal(rootPath) {
  const normalizedInput = String(rootPath || '').trim()
  if (!normalizedInput) {
    return {
      success: false,
      isValid: false,
      error: 'Select your local ComfyUI folder first.',
      warnings: [],
      normalizedPath: '',
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  const normalizedPath = path.resolve(normalizedInput)
  if (!(await pathExists(normalizedPath))) {
    return {
      success: false,
      isValid: false,
      error: 'The selected ComfyUI folder does not exist.',
      warnings: [],
      normalizedPath,
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  if (!(await isDirectoryPath(normalizedPath))) {
    return {
      success: false,
      isValid: false,
      error: 'The selected ComfyUI path is not a folder.',
      warnings: [],
      normalizedPath,
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }

  const mainPyPath = path.join(normalizedPath, 'main.py')
  const customNodesPath = path.join(normalizedPath, 'custom_nodes')
  const modelsPath = path.join(normalizedPath, 'models')
  const looksLikeComfyRoot = (
    await pathExists(mainPyPath)
    || await isDirectoryPath(customNodesPath)
    || await isDirectoryPath(modelsPath)
  )

  if (!looksLikeComfyRoot) {
    return {
      success: false,
      isValid: false,
      error: 'This folder does not look like a ComfyUI root. Pick the folder that contains main.py, custom_nodes, or models.',
      warnings: [],
      normalizedPath,
      customNodesPath,
      modelsPath,
      pythonCommand: '',
      python: null,
    }
  }

  const warnings = []
  if (!(await pathExists(mainPyPath))) {
    warnings.push('Could not find main.py directly inside this folder. If installs fail, pick the top-level ComfyUI directory instead.')
  }

  const python = await detectPythonCommandForComfyRoot(normalizedPath)
  if (!python.command) {
    warnings.push('Could not detect a dedicated Python interpreter for this ComfyUI install. Model downloads can still work, but custom-node dependency installs may fail.')
  }

  return {
    success: true,
    isValid: true,
    error: '',
    warnings,
    normalizedPath,
    customNodesPath,
    modelsPath,
    pythonCommand: normalizePythonCommand(python),
    python,
  }
}

function emitProcessLines(prefix, buffer, level = 'info') {
  const lines = String(buffer || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    emitWorkflowSetupProgress({
      level,
      stage: 'command',
      message: prefix ? `${prefix}: ${line}` : line,
    })
  }
}

function runCommandStreaming({ command, args = [], cwd = undefined, label = 'Command' }) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    emitWorkflowSetupProgress({
      stage: 'command',
      message: `${label}: ${command} ${args.join(' ')}`.trim(),
    })

    let child = null
    try {
      child = spawn(command, args, { cwd, windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      emitProcessLines(label, text, 'info')
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      emitProcessLines(label, text, 'warning')
    })

    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${label} exited with code ${code}`))
    })
  })
}

async function installNodePackTask(task, validation, progressMeta = {}) {
  const label = task?.displayName || task?.id || 'Custom node pack'
  const targetDir = path.join(validation.customNodesPath, task.installDirName)
  const currentTaskIndex = Number(progressMeta.currentTaskIndex) || 0
  const totalTasks = Number(progressMeta.totalTasks) || 0
  const completedTasks = Number(progressMeta.completedTasks) || 0

  emitWorkflowSetupProgress({
    stage: 'node-pack',
    status: 'active',
    taskType: 'node-pack',
    currentLabel: label,
    currentTaskIndex,
    totalTasks,
    completedTasks,
    taskPercent: null,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks, totalTasks }),
    message: `Installing ${label}...`,
  })

  await fs.mkdir(validation.customNodesPath, { recursive: true })

  if (await isDirectoryPath(targetDir)) {
    if (await isDirectoryPath(path.join(targetDir, '.git'))) {
      await runCommandStreaming({
        command: 'git',
        args: ['-C', targetDir, 'pull', '--ff-only'],
        cwd: validation.normalizedPath,
        label: `Update ${label}`,
      })
    } else {
      emitWorkflowSetupProgress({
        stage: 'node-pack',
        status: 'complete',
        level: 'warning',
        taskType: 'node-pack',
        currentLabel: label,
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: 100,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message: `${label}: skipped auto-update because ${targetDir} already exists but is not a git checkout.`,
      })
      return {
        id: task.id,
        displayName: label,
        targetDir,
        skipped: true,
      }
    }
  } else {
    await runCommandStreaming({
      command: 'git',
      args: ['clone', task.repoUrl, targetDir],
      cwd: validation.normalizedPath,
      label: `Install ${label}`,
    })
  }

  if (task.requirementsStrategy === 'requirements-txt') {
    const requirementsPath = path.join(targetDir, 'requirements.txt')
    if (await pathExists(requirementsPath)) {
      if (!validation.python?.command) {
        throw new Error(`Could not find a Python interpreter for ${label}.`)
      }

      await runCommandStreaming({
        command: validation.python.command,
        args: [...(validation.python.baseArgs || []), '-m', 'pip', 'install', '-r', requirementsPath],
        cwd: targetDir,
        label: `${label} requirements`,
      })
    }
  }

  emitWorkflowSetupProgress({
    stage: 'node-pack',
    status: 'complete',
    level: 'success',
    taskType: 'node-pack',
    currentLabel: label,
    currentTaskIndex,
    totalTasks,
    completedTasks: completedTasks + 1,
    taskPercent: 100,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
    message: `${label}: ready in ${targetDir}`,
  })

  return {
    id: task.id,
    displayName: label,
    targetDir,
    skipped: false,
  }
}

async function downloadFileWithProgress(task, targetPath, progressMeta = {}) {
  const currentLabel = task?.displayName || task?.filename || 'Model'
  const currentTaskIndex = Number(progressMeta.currentTaskIndex) || 0
  const totalTasks = Number(progressMeta.totalTasks) || 0
  const completedTasks = Number(progressMeta.completedTasks) || 0

  if (await pathExists(targetPath)) {
    emitWorkflowSetupProgress({
      stage: 'download',
      status: 'complete',
      level: 'info',
      taskType: 'model',
      currentLabel,
      currentTaskIndex,
      totalTasks,
      completedTasks: completedTasks + 1,
      taskPercent: 100,
      overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
      message: `${task.filename}: already exists, skipping download.`,
    })
    return {
      filename: task.filename,
      targetPath,
      skipped: true,
      sha256: '',
      bytesDownloaded: 0,
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.download`

  emitWorkflowSetupProgress({
    stage: 'download',
    status: 'active',
    taskType: 'model',
    currentLabel,
    currentTaskIndex,
    totalTasks,
    completedTasks,
    taskPercent: 0,
    bytesDownloaded: 0,
    totalBytes: Number(task.sizeBytes) || 0,
    overallPercent: getWorkflowSetupOverallPercent({ completedTasks, totalTasks, taskPercent: 0 }),
    message: `Downloading ${task.filename}...`,
  })

  let response = null
  try {
    response = await net.fetch(task.downloadUrl)
  } catch (error) {
    throw new Error(`Could not reach ${task.downloadUrl}: ${error.message}`)
  }

  if (!response.ok) {
    throw new Error(`Download failed for ${task.filename} (${response.status} ${response.statusText})`)
  }

  const totalBytes = Number(response.headers.get('content-length') || task.sizeBytes || 0)
  const digest = crypto.createHash('sha256')
  let bytesDownloaded = 0
  let lastProgressAt = 0

  try {
    if (!response.body) {
      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      digest.update(buffer)
      bytesDownloaded = buffer.length
      await fs.writeFile(tempPath, buffer)
    } else {
      await new Promise((resolve, reject) => {
        const fileStream = fsSync.createWriteStream(tempPath)
        const sourceStream = Readable.fromWeb(response.body)

        sourceStream.on('data', (chunk) => {
          bytesDownloaded += chunk.length
          digest.update(chunk)
          const now = Date.now()
          if (now - lastProgressAt < 500 && (!totalBytes || bytesDownloaded < totalBytes)) return
          lastProgressAt = now
          const percent = totalBytes > 0
            ? Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
            : `${Math.round(bytesDownloaded / (1024 * 1024))} MB`
          emitWorkflowSetupProgress({
            stage: 'download',
            status: 'active',
            taskType: 'model',
            currentLabel,
            currentTaskIndex,
            totalTasks,
            completedTasks,
            taskPercent: Number.isFinite(percent) ? percent : null,
            bytesDownloaded,
            totalBytes,
            overallPercent: getWorkflowSetupOverallPercent({
              completedTasks,
              totalTasks,
              taskPercent: Number.isFinite(percent) ? percent : null,
            }),
            message: Number.isFinite(percent)
              ? `Downloading ${task.filename}: ${percent}%`
              : `Downloading ${task.filename}: ${percent}`,
          })
        })

        sourceStream.on('error', reject)
        fileStream.on('error', reject)
        fileStream.on('finish', resolve)
        sourceStream.pipe(fileStream)
      })
    }

    const actualSha256 = digest.digest('hex')
    if (task.sha256 && actualSha256 !== String(task.sha256).trim().toLowerCase()) {
      throw new Error(`Checksum mismatch for ${task.filename}. Expected ${task.sha256}, got ${actualSha256}.`)
    }

    await fs.rename(tempPath, targetPath)
    emitWorkflowSetupProgress({
      stage: 'download',
      status: 'complete',
      level: 'success',
      taskType: 'model',
      currentLabel,
      currentTaskIndex,
      totalTasks,
      completedTasks: completedTasks + 1,
      taskPercent: 100,
      bytesDownloaded,
      totalBytes,
      overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
      message: `${task.filename}: downloaded to ${targetPath}`,
    })

    return {
      filename: task.filename,
      targetPath,
      skipped: false,
      sha256: actualSha256,
      bytesDownloaded,
    }
  } catch (error) {
    try {
      await fs.unlink(tempPath)
    } catch (_) {
      // Ignore temp cleanup failures.
    }
    throw error
  }
}

function normalizeFrameUrlForComparison(value) {
  try {
    const parsed = new URL(String(value || ''))
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
  } catch {
    return String(value || '').trim().replace(/\/+$/, '')
  }
}

function collectFrameTree(frame, output = []) {
  if (!frame) return output
  output.push(frame)
  const children = Array.isArray(frame.frames) ? frame.frames : []
  for (const child of children) {
    collectFrameTree(child, output)
  }
  return output
}

function getMainWindowFrames() {
  if (!mainWindow || mainWindow.isDestroyed()) return []
  const rootFrame = mainWindow.webContents?.mainFrame
  if (!rootFrame) return []

  if (Array.isArray(rootFrame.framesInSubtree) && rootFrame.framesInSubtree.length > 0) {
    const seen = new Set()
    const frames = [rootFrame, ...rootFrame.framesInSubtree].filter((frame) => {
      if (!frame) return false
      const dedupeKey = `${frame.routingId ?? ''}:${frame.processId ?? ''}:${frame.url ?? ''}`
      if (seen.has(dedupeKey)) return false
      seen.add(dedupeKey)
      return true
    })
    return frames
  }

  return collectFrameTree(rootFrame, [])
}

async function findEmbeddedComfyFrame(comfyBaseUrl, timeoutMs = 12000) {
  const normalizedBase = normalizeFrameUrlForComparison(comfyBaseUrl)
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    const frame = getMainWindowFrames().find((candidate) => {
      const candidateUrl = normalizeFrameUrlForComparison(candidate?.url)
      return candidateUrl && normalizedBase && candidateUrl.startsWith(normalizedBase)
    })

    if (frame) return frame
    await delay(250)
  }

  return null
}

async function loadWorkflowGraphInEmbeddedComfy({ workflowGraph, comfyBaseUrl, waitForMs = 12000 }) {
  const frame = await findEmbeddedComfyFrame(comfyBaseUrl, waitForMs)
  if (!frame) {
    throw new Error('Could not locate the embedded ComfyUI tab. Enable the ComfyUI tab and make sure the local server is running.')
  }

  const script = `
    (async () => {
      const graphData = ${JSON.stringify(workflowGraph)};
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureCanvasVisible = async (appInstance) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const canvasEl = appInstance?.canvasEl || appInstance?.canvas?.canvas || document.querySelector('canvas');
          const rect = canvasEl?.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            return true;
          }
          await sleep(100);
        }
        return false;
      };

      let comfyApp = globalThis.app || globalThis.__COMFYUI_APP__ || null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!comfyApp) {
          try {
            const appModule = await import('/scripts/app.js');
            comfyApp = appModule?.app || globalThis.app || globalThis.__COMFYUI_APP__ || null;
          } catch (_) {
            // Ignore temporary frontend boot timing failures and keep polling.
          }
        }

        if (comfyApp?.loadGraphData) break;
        await sleep(250);
        comfyApp = comfyApp || globalThis.app || globalThis.__COMFYUI_APP__ || null;
      }

      if (!comfyApp?.loadGraphData) {
        return { success: false, error: 'ComfyUI frontend app is not ready yet.' };
      }

      try {
        const canvasVisible = await ensureCanvasVisible(comfyApp);
        if (!canvasVisible) {
          return { success: false, error: 'ComfyUI canvas is still hidden, so the workflow could not be loaded safely yet.' };
        }

        await comfyApp.loadGraphData(graphData);
        await sleep(0);
        if (comfyApp.canvas?.resize) {
          comfyApp.canvas.resize();
        }
        if (comfyApp.canvas?.setDirty) {
          comfyApp.canvas.setDirty(true, true);
        }
        if (comfyApp.canvas?.draw) {
          comfyApp.canvas.draw(true, true);
        }
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    })()
  `

  const result = await frame.executeJavaScript(script, true)
  if (!result?.success) {
    throw new Error(result?.error || 'ComfyUI refused to load the workflow graph.')
  }

  return result
}

async function detectNvidiaGpuName() {
  const commands = process.platform === 'win32'
    ? [{
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
      }]
    : [{
        command: 'nvidia-smi',
        args: ['--query-gpu=name', '--format=csv,noheader'],
      }]

  for (const candidate of commands) {
    const result = await captureCommandOutput(candidate.command, candidate.args)
    if (!result.success || !result.output) continue

    const names = result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    const nvidiaName = names.find((name) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name))
    if (nvidiaName) return nvidiaName
  }

  return null
}

function sanitizeLocalComfyPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return null
  if (parsed < 1 || parsed > 65535) return null
  return parsed
}

async function resolveLocalComfyPort() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    const raw = settings?.[COMFY_CONNECTION_SETTING_KEY]
    const rawPort = raw && typeof raw === 'object' ? raw.port : raw
    return sanitizeLocalComfyPort(rawPort) || DEFAULT_LOCAL_COMFY_PORT
  } catch {
    return DEFAULT_LOCAL_COMFY_PORT
  }
}

async function checkComfyUIRunning(portOverride = null) {
  const port = sanitizeLocalComfyPort(portOverride) || await resolveLocalComfyPort()
  const healthUrl = `http://127.0.0.1:${port}/system_stats`
  return new Promise((resolve) => {
    const req = http.get(healthUrl, (res) => {
      resolve({
        ok: res.statusCode === 200 || (res.statusCode >= 200 && res.statusCode < 400),
        port,
      })
    })
    req.on('error', () => resolve({ ok: false, port }))
    req.setTimeout(COMFYUI_CHECK_MS, () => {
      req.destroy()
      resolve({ ok: false, port })
    })
  })
}

// ============================================
// ComfyUI launcher (process manager)
// ============================================

const COMFY_ROOT_SETTING_KEY = 'comfyRootPath'
const launcherLogDir = path.join(app.getPath('userData'), 'logs')
let cachedLauncherConfig = safeCloneLauncherConfig(DEFAULT_LAUNCHER_CONFIG)
let cachedHttpBase = `http://127.0.0.1:${DEFAULT_LOCAL_COMFY_PORT}`
let launcherQuitConfirmed = false

async function readSettingsRaw() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function writeSettingsRaw(mutator) {
  const current = await readSettingsRaw()
  const next = mutator(current)
  await writeFileAtomic(settingsPath, JSON.stringify(next, null, 2), 'utf8')
  return next
}

async function refreshLauncherConfigCache() {
  const settings = await readSettingsRaw()
  cachedLauncherConfig = safeCloneLauncherConfig(settings?.[LAUNCHER_SETTING_KEY])
  const port = sanitizeLocalComfyPort(
    settings?.[COMFY_CONNECTION_SETTING_KEY]?.port
    ?? settings?.[COMFY_CONNECTION_SETTING_KEY]
  ) || DEFAULT_LOCAL_COMFY_PORT
  cachedHttpBase = `http://127.0.0.1:${port}`
  return { config: cachedLauncherConfig, httpBase: cachedHttpBase, comfyRootPath: settings?.[COMFY_ROOT_SETTING_KEY] || '' }
}

const comfyLauncher = new ComfyLauncher({
  logDir: launcherLogDir,
  stateFilePath: path.join(app.getPath('userData'), 'comfy-launcher.state.json'),
  getHttpBase: () => cachedHttpBase,
  getConfig: () => cachedLauncherConfig,
  setConfig: async (partial) => {
    await writeSettingsRaw((settings) => ({
      ...settings,
      [LAUNCHER_SETTING_KEY]: safeCloneLauncherConfig({ ...cachedLauncherConfig, ...(partial || {}) }),
    }))
    await refreshLauncherConfigCache()
    return cachedLauncherConfig
  },
  getComfyRootPath: async () => (await readSettingsRaw())?.[COMFY_ROOT_SETTING_KEY] || '',
})

function broadcast(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload)
    }
  } catch (_) {
    /* ignore send errors during shutdown */
  }
}

comfyLauncher.on('state', (state) => {
  broadcast('comfyLauncher:state', state)
})
comfyLauncher.on('log', (entry) => {
  broadcast('comfyLauncher:log', entry)
})

async function initComfyLauncher() {
  await refreshLauncherConfigCache()
  await comfyLauncher.init()
}

async function maybeAutoStartComfyLauncher() {
  try {
    const config = cachedLauncherConfig
    if (!config?.autoStart) return
    if (!config.launcherScript) return
    const state = comfyLauncher.getState()
    if (state.state === 'external' || state.state === 'starting' || state.state === 'running') return
    const result = await comfyLauncher.start()
    if (result?.success === false) {
      console.warn('[comfyLauncher] auto-start failed:', result.error)
    }
  } catch (error) {
    console.warn('[comfyLauncher] auto-start error:', error?.message || error)
  }
}

async function runStartupChecks() {
  const start = Date.now()
  if (!splashWindow || splashWindow.isDestroyed()) return

  const comfyPort = await resolveLocalComfyPort()
  setSplashStatus(`Checking ComfyUI on localhost:${comfyPort}…`)
  const comfyCheck = await checkComfyUIRunning(comfyPort)
  if (comfyCheck.ok) {
    setSplashStatus(`ComfyUI connected (localhost:${comfyCheck.port})`)
  } else {
    setSplashStatus(`ComfyUI not detected on localhost:${comfyCheck.port}`)
  }
  await delay(STEP_DELAY_MS)

  setSplashStatus('Loading project page…')
  await delay(STEP_DELAY_MS)
  setSplashStatus('Loading media page…')
  await delay(STEP_DELAY_MS)
  setSplashStatus('Loading workspace…')
  await delay(STEP_DELAY_MS)

  const elapsed = Date.now() - start
  const remaining = Math.max(0, SPLASH_MIN_DURATION_MS - elapsed)
  if (remaining > 0) {
    await delay(remaining)
  }
}

// ============================================
// Window Controls
// ============================================

ipcMain.handle('window:minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false

  restoreFullscreenAfterMinimize = mainWindow.isFullScreen()
  if (!restoreFullscreenAfterMinimize) {
    mainWindow.minimize()
    return true
  }

  const minimizeAfterLeavingFullscreen = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    mainWindow.minimize()
  }

  mainWindow.once('leave-full-screen', minimizeAfterLeavingFullscreen)
  mainWindow.setFullScreen(false)
  setTimeout(minimizeAfterLeavingFullscreen, 150)
  return true
})

ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false
  if (mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(false)
  } else if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return true
})

ipcMain.handle('window:close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
  return true
})

ipcMain.handle('window:isMaximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

ipcMain.handle('window:getState', () => {
  return getWindowState()
})

ipcMain.handle('window:toggleFullScreen', () => {
  if (!mainWindow) return false
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
  return true
})

// Register custom protocol for serving local files
// Minimal extension → MIME map. We set Content-Type ourselves (rather
// than letting net.fetch guess) because the range-streaming path below
// builds the Response from a raw fs stream that has no type metadata.
const PROTOCOL_MIME_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.json': 'application/json', '.txt': 'text/plain',
}

function guessProtocolMime(filePath) {
  return PROTOCOL_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function registerFileProtocol() {
  protocol.handle('comfystudio', async (request) => {
    // Strip any query string / fragment before turning the URL into a
    // file path. Callers use `?v=<analysis.createdAt>` as a
    // cache-buster (so <img> tags re-fetch when a scene's thumbnail
    // is regenerated on a new analysis pass) — without this,
    // decodeURIComponent would include the `?v=...` bit in the file
    // path and the lookup 404s.
    let url = request.url.replace('comfystudio://', '')
    const queryIdx = url.search(/[?#]/)
    if (queryIdx >= 0) url = url.slice(0, queryIdx)
    const filePath = decodeURIComponent(url)

    // Tell Chromium not to heuristically cache these responses. The files
    // these URLs point at (scene thumbnails, generated clips) routinely
    // get overwritten in place between analysis / generation runs, so
    // caching served stale frames.
    const baseHeaders = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Content-Type': guessProtocolMime(filePath),
      // Advertise range support so the media element knows it can seek.
      'Accept-Ranges': 'bytes',
    }

    try {
      const normalizedPath = path.normalize(filePath)
      const stat = fsSync.statSync(normalizedPath)
      const total = stat.size

      // Range request: the <video>/<audio> element streams media with
      // `Range: bytes=start-end` and REQUIRES a 206 Partial Content reply
      // to start playback / seek. The previous implementation returned the
      // whole file as 200, which left native players able to read metadata
      // but unable to actually play (the symptom: press play, nothing
      // happens). Honour the range here and reply 206 with the slice.
      const rangeHeader = request.headers.get('Range') || request.headers.get('range')
      const match = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      if (match) {
        let start = match[1] === '' ? null : parseInt(match[1], 10)
        let end = match[2] === '' ? null : parseInt(match[2], 10)
        if (start === null && end !== null) {
          // Suffix range: last N bytes.
          start = Math.max(0, total - end)
          end = total - 1
        } else {
          if (start === null) start = 0
          if (end === null || end >= total) end = total - 1
        }
        if (start > end || start >= total) {
          return new Response('Requested range not satisfiable', {
            status: 416,
            headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` },
          })
        }
        const stream = fsSync.createReadStream(normalizedPath, { start, end })
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
          },
        })
      }

      // No range: stream the whole file (still advertise Accept-Ranges so
      // the player will issue range requests on the next read).
      const stream = fsSync.createReadStream(normalizedPath)
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(total) },
      })
    } catch (err) {
      console.error('Protocol error:', err)
      return new Response('File not found', { status: 404 })
    }
  })
}

function createSplashWindow() {
  const splashPath = isDev
    ? path.join(__dirname, '../public/splash.html')
    : path.join(__dirname, '../dist/splash.html')
  // Match your splash image aspect ratio (1672×941); extra height for status bar
  const SPLASH_ASPECT = 1672 / 941
  const splashWidth = 1200
  const statusBarHeight = 44
  const splashHeight = Math.round(splashWidth / SPLASH_ASPECT) + statusBarHeight
  splashWindow = new BrowserWindow({
    width: splashWidth,
    height: splashHeight,
    icon: iconPath,
    backgroundColor: '#0a0a0b',
    frame: false,
    transparent: false,
    center: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  splashWindow.loadFile(splashPath)
  splashWindow.on('closed', () => {
    splashWindow = null
  })
  return splashWindow
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    icon: iconPath,
    backgroundColor: '#0a0a0b',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // In dev mode, disable web security to allow file:// URLs from localhost
      // In production, the app loads from file:// so this isn't an issue
      webSecurity: !isDev,
    }
  })

  // Start maximized rather than true fullscreen. Maximized uses the full
  // work area (entire screen minus the OS taskbar/dock) so the user still
  // has access to their taskbar, tray, notifications, and Alt-Tab without
  // having to exit the app. True fullscreen (the old behavior via
  // setFullScreen(true)) hid the taskbar entirely, which users reported as
  // too intrusive for a window they're not actively playing back from.
  // Users who want edge-to-edge can still toggle fullscreen via the
  // title-bar control or the window:toggleFullScreen IPC.
  mainWindow.maximize()

  // Route every external link to the user's default browser instead of
  // letting Electron spawn an in-app BrowserWindow. This covers:
  //   - window.open(url, '_blank', ...)
  //   - <a href="..." target="_blank">
  //   - plain navigations that target an http(s) URL outside our app bundle.
  // Safe because we only hand off http(s) and mailto; anything else is denied.
  {
    const { shell } = require('electron')
    const isSafeExternalUrl = (url) => /^(https?:|mailto:)/i.test(String(url || ''))

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) {
        shell.openExternal(url).catch((err) => {
          console.warn('[shell.openExternal] failed:', err?.message || err)
        })
      }
      return { action: 'deny' }
    })

    mainWindow.webContents.on('will-navigate', (event, url) => {
      // Only intercept real external URLs — let in-app navigations
      // (localhost dev server, file:// bundled assets) through untouched.
      if (!isSafeExternalUrl(url)) return
      try {
        const currentUrl = mainWindow.webContents.getURL()
        const nextOrigin = new URL(url).origin
        const currentOrigin = currentUrl ? new URL(currentUrl).origin : ''
        if (nextOrigin && nextOrigin === currentOrigin) return
      } catch (_) {
        // If URL parsing fails, fall through to the external handoff.
      }
      event.preventDefault()
      shell.openExternal(url).catch((err) => {
        console.warn('[shell.openExternal] failed:', err?.message || err)
      })
    })
  }

  // Load the app
  if (isDev) {
    // Try common Vite ports in case 5173 is in use
    const tryPorts = [5173, 5174, 5175, 5176]
    let loaded = false
    
    for (const port of tryPorts) {
      try {
        await mainWindow.loadURL(`http://127.0.0.1:${port}`)
        console.log(`Loaded from port ${port}`)
        loaded = true
        break
      } catch (err) {
        console.log(`Port ${port} not available, trying next...`)
      }
    }
    
    if (!loaded) {
      console.error('Could not connect to Vite dev server on any port')
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  mainWindow.on('close', async (event) => {
    if (launcherQuitConfirmed) return
    const state = comfyLauncher.getState()
    const ownsRunning = state.ownership === 'ours' && (state.state === 'running' || state.state === 'starting')
    if (!ownsRunning) return

    event.preventDefault()
    try {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Stop ComfyUI & quit', 'Leave ComfyUI running', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'Quit ComfyStudio?',
        message: 'ComfyUI is still running.',
        detail: 'ComfyStudio started ComfyUI. Choose what happens to it when you quit.\n\n• Stop ComfyUI & quit — shuts down ComfyUI and cancels any in-flight generation jobs.\n• Leave ComfyUI running — ComfyStudio will quit but ComfyUI stays up. Handy when you\'re just relaunching ComfyStudio and don\'t want to wait for ComfyUI to boot again.',
      })
      if (choice.response === 2) return
      launcherQuitConfirmed = true
      try {
        if (choice.response === 1) {
          await comfyLauncher.detach()
        } else {
          await comfyLauncher.shutdown({ confirmStop: true })
        }
      } catch (error) {
        console.warn('[comfyLauncher] shutdown/detach during close failed:', error?.message || error)
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.close()
      } else {
        app.quit()
      }
    } catch (error) {
      console.warn('[comfyLauncher] close handler error:', error?.message || error)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('restore', () => {
    if (!restoreFullscreenAfterMinimize) return
    restoreFullscreenAfterMinimize = false
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setFullScreen(true)
    }, 0)
  })

  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)
  mainWindow.on('enter-full-screen', sendWindowState)
  mainWindow.on('leave-full-screen', sendWindowState)
  
  // Register keyboard shortcut for DevTools (F12 or Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || 
        (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })
}

// ============================================
// IPC Handlers - Dialog Operations
// ============================================

ipcMain.handle('dialog:selectDirectory', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: options.title || 'Select Folder',
    defaultPath: options.defaultPath || app.getPath('documents'),
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return result.filePaths[0]
})

ipcMain.handle('dialog:selectFile', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', ...(options.multiple ? ['multiSelections'] : [])],
    title: options.title || 'Select File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'Media Files', extensions: ['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  
  return options.multiple ? result.filePaths : result.filePaths[0]
})

ipcMain.handle('dialog:saveFile', async (event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || app.getPath('documents'),
    filters: options.filters || [
      { name: 'All Files', extensions: ['*'] }
    ],
  })
  
  if (result.canceled) {
    return null
  }
  
  return result.filePath
})

// ============================================
// IPC Handlers - File System Operations
// ============================================

ipcMain.handle('fs:exists', async (event, filePath) => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('fs:isDirectory', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return stat.isDirectory()
  } catch {
    return false
  }
})

ipcMain.handle('fs:createDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.mkdir(dirPath, { recursive: options.recursive !== false })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFile', async (event, filePath, options = {}) => {
  try {
    const encoding = options.encoding || null // null returns Buffer
    const data = await fs.readFile(filePath, encoding)
    
    // If no encoding specified, return as base64 for binary files
    if (!encoding) {
      return { success: true, data: data.toString('base64'), encoding: 'base64' }
    }
    
    return { success: true, data, encoding }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:readFileAsBuffer', async (event, filePath) => {
  try {
    const data = await fs.readFile(filePath)
    const slice = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    return { success: true, data: slice }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFile', async (event, filePath, data, options = {}) => {
  try {
    // Handle different data types
    let writeData = data
    if (options.encoding === 'base64') {
      writeData = Buffer.from(data, 'base64')
    } else if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      // JSON object
      writeData = JSON.stringify(data, null, 2)
    }

    await writeFileAtomic(filePath, writeData, options.encoding === 'base64' ? null : options)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:writeFileFromArrayBuffer', async (event, filePath, arrayBuffer) => {
  try {
    const buffer = Buffer.from(arrayBuffer)
    await writeFileAtomic(filePath, buffer)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteFile', async (event, filePath) => {
  try {
    await fs.unlink(filePath)
    return { success: true }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { success: true } // Already deleted
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:deleteDirectory', async (event, dirPath, options = {}) => {
  try {
    await fs.rm(dirPath, { recursive: options.recursive !== false, force: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:copyFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.copyFile(srcPath, destPath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:moveFile', async (event, srcPath, destPath) => {
  try {
    // Ensure destination directory exists
    const dir = path.dirname(destPath)
    await fs.mkdir(dir, { recursive: true })
    
    await fs.rename(srcPath, destPath)
    return { success: true }
  } catch (err) {
    // If rename fails (cross-device), fall back to copy + delete
    if (err.code === 'EXDEV') {
      await fs.copyFile(srcPath, destPath)
      await fs.unlink(srcPath)
      return { success: true }
    }
    return { success: false, error: err.message }
  }
})

ipcMain.handle('fs:listDirectory', async (event, dirPath, options = {}) => {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    
    const items = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name)
      let stat = null
      
      if (options.includeStats) {
        try {
          stat = await fs.stat(fullPath)
        } catch {
          // Ignore stat errors
        }
      }
      
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        size: stat?.size,
        modified: stat?.mtime?.toISOString(),
        created: stat?.birthtime?.toISOString(),
      }
    }))
    
    return { success: true, items }
  } catch (err) {
    return { success: false, error: err.message, items: [] }
  }
})

ipcMain.handle('fs:getFileInfo', async (event, filePath) => {
  try {
    const stat = await fs.stat(filePath)
    return {
      success: true,
      info: {
        name: path.basename(filePath),
        path: filePath,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
      }
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// IPC Handlers - Path Operations
// ============================================

ipcMain.handle('path:join', (event, ...parts) => {
  return path.join(...parts)
})

ipcMain.handle('path:dirname', (event, filePath) => {
  return path.dirname(filePath)
})

ipcMain.handle('path:basename', (event, filePath, ext) => {
  return path.basename(filePath, ext)
})

ipcMain.handle('path:extname', (event, filePath) => {
  return path.extname(filePath)
})

ipcMain.handle('path:normalize', (event, filePath) => {
  return path.normalize(filePath)
})

ipcMain.handle('path:getAppPath', (event, name) => {
  // Valid names: home, appData, userData, documents, downloads, music, pictures, videos, temp
  return app.getPath(name)
})

// ============================================
// IPC Handlers - Media Info (using HTML5 in renderer for now)
// Future: Replace with FFprobe for frame-accurate info
// ============================================

ipcMain.handle('media:getFileUrl', (event, filePath) => {
  // Convert file path to comfystudio:// protocol URL
  const encodedPath = encodeURIComponent(filePath)
  return `comfystudio://${encodedPath}`
})

// Writes arbitrary text to the OS clipboard via Electron's main-
// process clipboard module. Using navigator.clipboard.writeText from
// the renderer fails silently on focus changes (e.g. when we
// openExternal a ComfyUI URL right after copying — the browser
// steals focus before the async write resolves) and the user ends
// up with whatever the previous clipboard contents were.
ipcMain.handle('clipboard:writeText', async (event, text) => {
  try {
    clipboard.writeText(String(text ?? ''))
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

// Reveals a file in the user's OS file manager with the target
// selected. Used by the "Show in folder" button in the Send-to-
// ComfyUI modal so the user can drag the saved workflow JSON
// directly onto ComfyUI's canvas — that's the reliable way to load
// a workflow (clipboard paste in ComfyUI only handles its internal
// node-copy format, not arbitrary workflow JSON).
ipcMain.handle('shell:showItemInFolder', async (event, filePath) => {
  try {
    if (!filePath) return { success: false, error: 'filePath is required.' }
    shell.showItemInFolder(String(filePath))
    return { success: true }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

// Reads a local file and returns it as a data URL (base64). Needed for
// renderer code that has to feed a file into a multimodal API — the
// renderer can't `fetch('comfystudio://...')` because the protocol is
// registered via `protocol.handle()` without the `supportFetchAPI`
// privilege, so fetch() gets a generic "Failed to fetch". The IPC hop
// is cheap for per-scene thumbnail JPEGs (tens of KB).
ipcMain.handle('media:readFileAsDataUrl', async (event, filePath, mimeType) => {
  if (!filePath) return { success: false, error: 'filePath is required.' }
  try {
    const buf = await fs.readFile(filePath)
    const mime = mimeType || (filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    return { success: true, dataUrl, bytes: buf.length }
  } catch (err) {
    return { success: false, error: err?.message || String(err) }
  }
})

ipcMain.handle('media:getFileUrlDirect', (event, filePath) => {
  // Return file:// URL directly (for when protocol isn't working)
  // Normalize path for URL
  let normalizedPath = filePath.replace(/\\/g, '/')
  if (!normalizedPath.startsWith('/')) {
    normalizedPath = '/' + normalizedPath
  }
  return `file://${normalizedPath}`
})

ipcMain.handle('media:getVideoFps', async (event, filePath) => {
  if (!ffprobePath) {
    return { success: false, error: 'FFprobe binary not available.' }
  }

  const parseFps = (value) => {
    if (!value || value === '0/0') return null
    const [num, den] = String(value).split('/').map(Number)
    if (!den || !num) return null
    return num / den
  }

  return await new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate',
      '-of', 'json',
      filePath
    ]

    const proc = spawn(ffprobePath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || `FFprobe exited with code ${code}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const streams = Array.isArray(parsed?.streams) ? parsed.streams : []
        const videoStream = streams.find((stream) => stream?.codec_type === 'video') || null
        const audioStream = streams.find((stream) => stream?.codec_type === 'audio') || null
        const fps = parseFps(videoStream?.avg_frame_rate) || parseFps(videoStream?.r_frame_rate)
        const hasAudio = streams.some((stream) => stream?.codec_type === 'audio')
        resolve({
          success: true,
          fps: fps || null,
          hasAudio,
          videoCodec: videoStream?.codec_name || null,
          audioCodec: audioStream?.codec_name || null,
        })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

// ============================================================
// project:re-edit — analysis pipeline (scene cut + thumbnails)
// ============================================================
//
// Scene detection runs through PySceneDetect's content detector. We
// tried FFmpeg's built-in `scene` filter first because it needed zero
// bundling, but on real ad footage it under-detected heavily (missed
// roughly half the hard cuts on a 17-cut 30s commercial). PySceneDetect
// uses HSL-space frame diffing which is much more reliable on brand-
// heavy footage where luma diffs alone are too small to trip the
// threshold.
//
// The bridge is a small Python script in electron/reedit_scene_detect.py
// that exits with:
//   code 0 → JSON payload on stdout ({"success": true, "scenes": [...]})
//   code 2 → PySceneDetect not installed (actionable error on stdout+stderr)
//   code 1 → any other failure
// Keeping the JSON schema identical to the previous FFmpeg handler means
// the renderer doesn't have to care which detector ran.
ipcMain.handle('analysis:detectScenes', async (event, videoPath, options = {}) => {
  if (!videoPath) return { success: false, error: 'videoPath is required.' }

  // PySceneDetect ContentDetector threshold: roughly 0–100, default 27.
  // Lower → more sensitive. We expose the same `threshold` key the old
  // handler used so the renderer can stay unchanged.
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 27
  const minSceneDurSec = Number.isFinite(options.minSceneDurSec) ? options.minSceneDurSec : 0.5

  const scriptPath = path.join(__dirname, 'reedit_scene_detect.py')
  // Was hardcoded to 'python'/'python3' — inconsistent with the other
  // Python-spawning handlers (mask generation, stem separation), which
  // go through resolvePythonExe() and honour a REEDIT_PYTHON override.
  // On a machine with multiple Python installs, whichever 'python' is
  // first on PATH for an Electron-launched process isn't guaranteed to
  // be the one the user installed scenedetect into — this lets them
  // pin it (e.g. REEDIT_PYTHON="C:\...\Python312\python.exe") without
  // touching system PATH.
  const pythonCmd = resolvePythonExe()
  const args = [scriptPath, videoPath, String(threshold), String(minSceneDurSec)]

  return await new Promise((resolve) => {
    const proc = spawn(pythonCmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        resolve({
          success: false,
          error: `Python interpreter not found (looked for "${pythonCmd}" in PATH). Install Python 3${pythonCmd === 'py' ? ' from python.org (includes the "py" launcher)' : ''}, or set REEDIT_PYTHON to a specific python.exe, and retry.`,
        })
      } else {
        resolve({ success: false, error: err.message })
      }
    })
    proc.on('close', (code) => {
      // The bridge always prints JSON, even on failure. Trust that first.
      try {
        const last = stdout.trim().split('\n').filter(Boolean).pop()
        if (last) {
          const parsed = JSON.parse(last)
          resolve(parsed)
          return
        }
      } catch (_) {
        // Fall through to plain error reporting.
      }
      if (code !== 0) {
        resolve({ success: false, error: stderr.trim() || `PySceneDetect exited with code ${code}` })
      } else {
        resolve({ success: false, error: 'PySceneDetect produced no output.' })
      }
    })
  })
})

// Extracts a single contiguous sub-clip of the source video to its own
// MP4 file. We need this because ComfyStudio's timeline filmstrip uses
// a shared <video src={assetUrl}> for every clip of a given asset, and
// Chromium ignores Media Fragments URIs (#t=2.79) on `file://` URLs —
// so trim-based scene "virtual clips" all end up showing the same
// frame. Extracting each scene to its own file means the asset URL is
// unique per scene, the filmstrip works natively, and playback doesn't
// need trim math.
//
// `-c copy` is stream copy (no re-encode) — milliseconds per scene, but
// cuts land on the nearest keyframe before tcIn, which can drift up to
// one GOP (typically <1s in web-delivered ads). That's usually fine for
// the re-edit workflow; we can swap to re-encode here later if a pilot
// complains about imprecise first frames.
// Scene clips feed two consumers that are both sensitive to frame-
// accurate boundaries: (1) the hover preview in AnalysisView, where a
// clip that bleeds into the next shot reads as "wrong scene"; (2) the
// Gemini video analyzer, which describes whatever frames it sees — a
// bleed of half a second from the neighbouring shot is enough to make
// the output describe the wrong subject. Stream-copy (`-c copy`) can't
// start on an arbitrary frame; it snaps to the prior keyframe, which
// is why earlier clips contained more than one plano. We re-encode
// with libx264 veryfast so cuts land exactly on `tcIn`.
function ffprobeDurationSec(filePath) {
  return new Promise((resolve) => {
    if (!ffprobeStaticPath) return resolve(null)
    const p = spawn(ffprobeStaticPath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.on('error', () => resolve(null))
    p.on('close', () => {
      const n = parseFloat(String(out).trim())
      resolve(Number.isFinite(n) ? n : null)
    })
  })
}

ipcMain.handle('analysis:extractSceneClip', async (event, options) => {
  if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available.' }
  const { videoPath, tcIn, tcOut, outputPath } = options || {}
  if (!videoPath || !outputPath || !Number.isFinite(tcIn) || !Number.isFinite(tcOut) || tcOut <= tcIn) {
    return { success: false, error: 'videoPath, tcIn, tcOut (tcOut > tcIn), and outputPath are required.' }
  }

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
  } catch (err) {
    return { success: false, error: `Cannot create output dir: ${err.message}` }
  }

  // Cache validation: accept the file only if its duration is within
  // ~0.15 s of the requested window. Clips extracted by the old
  // stream-copy path routinely run long (they start at the previous
  // keyframe, inflating duration by up to the GOP length) and that
  // mismatch is the tell. Regenerate whenever the tolerance is missed
  // so the bug heals itself without forcing users to wipe .reedit/clips.
  const expectedDuration = Math.max(tcIn + 0.05, tcOut) - Math.max(0, tcIn)
  const CACHE_TOLERANCE_SEC = 0.15
  try {
    const stat = await fs.stat(outputPath)
    if (stat?.size > 1024) {
      const cachedDuration = await ffprobeDurationSec(outputPath)
      if (cachedDuration != null && Math.abs(cachedDuration - expectedDuration) <= CACHE_TOLERANCE_SEC) {
        return { success: true, path: outputPath, cached: true }
      }
      // duration disagreed (or ffprobe failed) — fall through to
      // re-extract. The new file overwrites the old one via `-y`.
    }
  } catch (_) { /* missing file — proceed */ }

  return await new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-ss', String(Math.max(0, tcIn)),
      '-to', String(Math.max(tcIn + 0.05, tcOut)),
      '-i', videoPath,
      // Re-encode for frame-accurate trim. `veryfast` + CRF 20 is the
      // sweet spot here: per-shot clips are short (<5 s typically), so
      // encoding cost is negligible compared to the Gemini round trip,
      // and the output stays visually lossless for previews + model
      // input. Audio re-encoded to AAC so the container matches what
      // the original video used (simplest way to avoid mux warnings).
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => resolve({ success: false, error: err.message }))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: `FFmpeg exited with code ${code}. ${stderr.slice(-200)}` })
        return
      }
      resolve({ success: true, path: outputPath, cached: false })
    })
  })
})

// ============================================
// Optimize footage — remove graphics from a shot with Wan VACE
// ============================================
//
// Triggered from the Analysis view's per-shot "Optimize" button. The
// pipeline is: (1) use the Gemini `removal_hint` to derive make_mask.py
// args; (2) generate a mask + pre-blanked source video next to the
// cached shot clip; (3) copy the three files (source, mask, blank) to
// ComfyUI's input dir with a project-scoped prefix so runs don't
// collide; (4) submit a Wan VACE workflow identical to the SUPER02
// one, parameterised by the shot's native resolution and fps, with
// RealESRGAN upscale + Lanczos resize back to native 1920×... at the
// end; (5) poll /history until done and emit progress events the
// renderer displays per-row.

// Map the Gemini color_family names to conservative OpenCV HSV ranges.
// These are wider than a typical Photoshop pick because mask_strategy
// 'color' has to catch the graphic across every frame and the model's
// hsv_range_hint is frequently off by ±10 H — we'd rather cover too
// much than too little, then let make_mask.py's dilate kernel clean up
// the edges.
const COLOR_HSV_RANGES = {
  yellow:  { lower: [20, 120, 120], upper: [35, 255, 255] },
  orange:  { lower: [10, 150, 120], upper: [20, 255, 255] },
  red:     { lower: [0, 120, 100], upper: [10, 255, 255] },  // low-red band; see dualRed
  magenta: { lower: [140, 80, 100], upper: [170, 255, 255] },
  pink:    { lower: [145, 60, 150], upper: [170, 255, 255] },
  purple:  { lower: [125, 80, 80], upper: [145, 255, 255] },
  blue:    { lower: [90, 80, 80], upper: [130, 255, 255] },
  cyan:    { lower: [80, 80, 120], upper: [100, 255, 255] },
  green:   { lower: [35, 80, 100], upper: [85, 255, 255] },
}

// Dilate kernel size used by make_mask.py. Started at 25 but that was
// pushing the mask onto neighbouring skin / car body and showing the
// VACE seam outside the actual graphic. 13 hugs the text/logo more
// tightly and lets the bigger composite feather (σ=16 — see the
// optimizeFootage handler call) blend the edge instead of relying on
// the dilate to do the softening.
const MASK_DILATE_KERNEL = '13'

// Per-axis padding around each Gemini bbox (% of frame dim) for the
// `boxes` mode. The Python defaults were 7% x / 10% y — at 1920×1080
// that's 134px / 108px of headroom around every box, which turns a
// modest text overlay into a frame-spanning rectangle. Gemini's bboxes
// have improved (we now also separate physical brand marks out), so
// we can run a much tighter pad. 1.5% / 2% is enough to absorb a few
// pixels of bbox drift + the anti-aliased glow around text without
// chewing into adjacent skin / car body.
const MASK_BOX_PADDING_PCT_X = '2.5'
const MASK_BOX_PADDING_PCT_Y = '3.0'

// Vertical offset (% of frame) applied to every box. The 5% default
// was a workaround for an old Gemini bias toward the cap line; current
// model anchors closer to the mean line so we only need ~1% to absorb
// the residual drift.
const MASK_BOX_OFFSET_PCT_Y = '1.0'

// Max per-blob area as a percent of the frame. Above this, a connected
// component is treated as background (sky / wall / specular) instead
// of text. We picked 12%: a 1920×1080 frame is ~2.07M pixels, 12% is
// ~248k pixels — more than any single letter or even a full-width
// chyron needs, so real text always survives.
const MASK_MAX_BLOB_AREA_PCT = '12'

// Fraction of frames a pixel must be "detected" in to count as a
// persistent overlay. 0.50 = pixel lit in half the frames survives.
// We started at 0.60 (bias toward killing false positives) but that
// cut real overlays that only appear for part of the shot — legal
// disclaimers that fade in at the end, dynamic chyrons, etc. 0.50 is
// the compromise: captions on screen for half the run still pass,
// and transient highlights / panning skies still fail because their
// per-pixel occupancy is much lower.
const MASK_PERSISTENCE_THRESHOLD = '0.50'

// Position values we recognise as ROI constraints. Anything outside
// this set (or missing) falls through to "no ROI" in make_mask.py.
const KNOWN_ROI_POSITIONS = new Set([
  'top', 'bottom', 'center',
  'lower_third', 'upper_third',
  'corner_top_left', 'corner_top_right',
  'corner_bottom_left', 'corner_bottom_right',
  'full_frame', 'scattered',
])

// Pick a stable, valid bbox list from the two places Gemini may emit
// it: `graphics.bboxes` (the canonical spot per our prompt) or
// `graphics.removal_hint.bboxes` (where the model sometimes puts it
// because it's reasoning about "how to remove" this shot). Returns []
// if neither is present or valid.
// Heuristic flag: does this bbox label / role suggest a physical
// in-world object rather than a post-production overlay? We use this
// as a defensive filter against analyses generated before the schema
// split (when Gemini was instructed to mix overlays + physical marks
// in the same array). The patterns target the way the model usually
// describes physical marks in free-text labels.
function looksLikePhysicalMark(b) {
  if (!b) return false
  const text = `${b.label || ''} ${b.role || ''}`.toLowerCase()
  if (!text.trim()) return false
  // Whole-phrase signals — explicit "physical X" wording.
  if (text.includes('physical')) return true
  // Object-attached mark patterns — "logo on the [body part]",
  // "[mark] on the hood/door/grille/bumper/dashboard/...".
  if (/\b(?:logo|badge|mark|emblem|wordmark|roundel|swoosh|h-mark|monogram)\s+on\s+(?:the|a)\s+\w/.test(text)) return true
  if (/\bon\s+(?:the|a)\s+(?:hood|grille|grill|bumper|door|fender|wheel|trunk|tailgate|dashboard|steering wheel|shoe|jersey|shirt|cap|helmet|jacket|bag|bottle|can|product)\b/.test(text)) return true
  // Specific physical-only items — almost never overlays.
  if (/\b(?:kidney grille|kidney grill|license plate|number plate|registration plate|grille|grill|nose badge|hood badge|trunk badge)\b/.test(text)) return true
  if (/\b(?:embossed|engraved|stitched|printed on|painted on|label on)\b/.test(text)) return true
  return false
}

function extractBboxes(graphics) {
  if (!graphics || typeof graphics !== 'object') return []
  const direct = Array.isArray(graphics.bboxes) ? graphics.bboxes : null
  const nested = Array.isArray(graphics.removal_hint?.bboxes) ? graphics.removal_hint.bboxes : null
  const source = (direct && direct.length) ? direct : (nested && nested.length) ? nested : []
  const out = []
  for (const b of source) {
    if (!b) continue
    // CRITICAL filter — physical brand marks (kidney grilles, badges,
    // license plates, product labels) MUST NOT feed the inpaint mask
    // or VACE paints over real geometry. Two layers:
    //   1. Explicit `kind: "physical"` flag from new analyses → drop.
    //   2. Heuristic content match on label/role → drop. Catches old
    //      analyses + occasional model drift where Gemini wrote
    //      "physical license plate" but forgot to set the kind field.
    if (b.kind === 'physical') continue
    if (looksLikePhysicalMark(b)) continue
    const box = Array.isArray(b) ? b : b.box_2d
    if (!Array.isArray(box) || box.length !== 4) continue
    const nums = box.map((n) => Number(n))
    if (nums.some((n) => !Number.isFinite(n))) continue
    const ymin = Math.min(nums[0], nums[2])
    const xmin = Math.min(nums[1], nums[3])
    const ymax = Math.max(nums[0], nums[2])
    const xmax = Math.max(nums[1], nums[3])
    // Reject degenerate or near-frame-sized boxes (model occasionally
    // emits [0, 0, 1000, 1000] when it can't localise — that would
    // erase the whole shot).
    if (ymax - ymin < 5 || xmax - xmin < 5) continue
    if ((ymax - ymin) * (xmax - xmin) > 900000) continue  // >90% of frame
    out.push({ box_2d: [ymin, xmin, ymax, xmax], role: b.role || null, kind: b.kind || 'overlay', label: b.label || null })
  }
  return out
}

function pickMaskArgsFromHint(hint, graphics) {
  // Preferred path: Gemini-provided bounding boxes. When present and
  // non-degenerate, we bypass threshold heuristics entirely — the model
  // has already decided what counts as a graphic. We return the JSON
  // in `bboxesJson` so the caller can dump it to a tempfile and pass
  // `--bboxes-file` — avoids Windows' CLI length cap on long arg lists.
  const bboxes = extractBboxes(graphics)
  if (bboxes.length > 0) {
    return {
      mode: 'boxes',
      bboxesJson: JSON.stringify(bboxes),
      args: [
        '--mode', 'boxes',
        '--dilate-kernel', MASK_DILATE_KERNEL,
        '--boxes-padding-pct-x', MASK_BOX_PADDING_PCT_X,
        '--boxes-padding-pct-y', MASK_BOX_PADDING_PCT_Y,
        '--boxes-offset-pct-y', MASK_BOX_OFFSET_PCT_Y,
      ],
    }
  }

  // Fallback path: classical luma / color thresholds with ROI +
  // persistence refinement, used when bboxes aren't available (shot
  // captioned before we added the schema, or model chose not to
  // emit them).
  const refine = [
    '--dilate-kernel', MASK_DILATE_KERNEL,
    '--max-blob-area-pct', MASK_MAX_BLOB_AREA_PCT,
    '--persistence-threshold', MASK_PERSISTENCE_THRESHOLD,
  ]
  const position = String(hint?.position || '').toLowerCase()
  if (position && KNOWN_ROI_POSITIONS.has(position)) {
    refine.push('--roi', position)
  }

  if (!hint || typeof hint !== 'object') {
    return { mode: 'luma', args: ['--mode', 'luma', ...refine] }
  }
  const strategy = String(hint.mask_strategy || '').toLowerCase()
  if (strategy === 'color') {
    const hsv = hint.hsv_range_hint
    let lower, upper
    if (hsv && Array.isArray(hsv.lower) && Array.isArray(hsv.upper)) {
      lower = hsv.lower.map((n) => String(Math.round(n)))
      upper = hsv.upper.map((n) => String(Math.round(n)))
    } else {
      const family = String(hint.text_color_family || '').toLowerCase()
      const range = COLOR_HSV_RANGES[family]
      if (!range) {
        // Unknown color family — fall back to luma so we at least try.
        return { mode: 'luma', args: ['--mode', 'luma', '--luma-threshold', '195', ...refine] }
      }
      lower = range.lower.map(String)
      upper = range.upper.map(String)
    }
    return {
      mode: 'color',
      args: ['--mode', 'color', '--hsv-lower', ...lower, '--hsv-upper', ...upper, ...refine],
    }
  }
  if (strategy === 'luma_dark') {
    // make_mask.py only implements bright-luma currently. Dark text is
    // rare enough in ads that we fall back to bright with a warning in
    // the logs rather than extending the script right now.
    const threshold = Number.isFinite(hint.luma_threshold_hint) ? String(hint.luma_threshold_hint) : '60'
    return { mode: 'luma', args: ['--mode', 'luma', '--luma-threshold', threshold, ...refine], warn: 'mask_strategy=luma_dark requested but make_mask.py only supports luma_bright; result may be inverted.' }
  }
  // luma_bright (default) + unsure + mixed all fall here. Default
  // threshold dropped from 195 → 170 so grey legal disclaimers
  // (typical luma 180-210 — lighter than body text but not pure
  // white) survive the per-frame detection pass. The persistence
  // gate still kills skies / highlights that briefly clear 170.
  const threshold = Number.isFinite(hint.luma_threshold_hint)
    ? String(Math.round(hint.luma_threshold_hint))
    : '170'
  return { mode: 'luma', args: ['--mode', 'luma', '--luma-threshold', threshold, ...refine] }
}

function resolvePythonExe() {
  // Prefer an explicit env override (user can pin to a specific install
  // or venv — handy when multiple Pythons are on PATH and only one has
  // the re-edit deps: scenedetect, opencv, demucs).
  //
  // Otherwise, on Windows, use the `py` launcher (py.exe, installed
  // system-wide under C:\Windows by the official python.org installer)
  // instead of the bare `python` command. This matters because
  // activating ANY virtualenv prepends its Scripts\ dir — which ships
  // python.exe/pip.exe but never its own py.exe — to the front of
  // PATH. If the Electron process inherits its environment from a
  // shell that had an unrelated venv active, plain `python` silently
  // resolves to that venv's interpreter (missing scenedetect/demucs)
  // while `py` still finds the system install the user actually set
  // up for this project. Other platforms don't have this launcher;
  // fall back to `python3`.
  return process.env.REEDIT_PYTHON || process.env.PYTHON
    || (process.platform === 'win32' ? 'py' : 'python3')
}

// Read ComfyUI's `--input-directory` argv by hitting /system_stats.
// The script-copied source/mask/blank files need to sit somewhere
// ComfyUI's VHS_LoadVideo node can find them by relative name.
//
// Returns null when:
//   - the URL isn't reachable (network error or non-200)
//   - the URL is a remote/cloud host (the input dir lives on the cloud
//     filesystem and we can't `fs.copyFile` into it from here — caller
//     should fall back to /upload/image HTTP)
async function resolveComfyInputDir(comfyUrl) {
  // Reject non-loopback hosts up front: cloud / RunPod / Cloudflare-tunneled
  // ComfyUIs technically respond to /system_stats and may even hand us a
  // legitimate-looking `--input-directory` path, but copying into it from
  // our local filesystem doesn't move bytes to the remote box. Better to
  // bail here so the caller surfaces a clear "use local mode" error than
  // to silently miscopy files.
  try {
    const parsed = new URL(comfyUrl)
    const host = String(parsed.hostname || '').toLowerCase()
    const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
    if (!loopback) return null
  } catch { return null }
  try {
    const res = await net.fetch(`${comfyUrl}/system_stats`)
    if (!res.ok) return null
    const data = await res.json()
    const argv = Array.isArray(data?.system?.argv) ? data.system.argv : []
    const idx = argv.indexOf('--input-directory')
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1]
    // Fall back to `<base-directory>/input` if ComfyUI was launched
    // without an explicit input dir.
    const bdIdx = argv.indexOf('--base-directory')
    if (bdIdx >= 0 && bdIdx + 1 < argv.length) return path.join(argv[bdIdx + 1], 'input')
    return null
  } catch {
    return null
  }
}

// Canonical ComfyUI transport lives in electron/comfy/client.js —
// shared by every pipeline handler (auth, path prefixing, upload,
// download, queueing, polling) for local ComfyUI and Comfy Cloud alike.
const {
  isCloudComfyUrl,
  _comfyHeaders,
  _comfyApiPath,
  uploadFileToComfy,
  downloadFromComfy,
  queuePromptToComfy,
  waitForComfyJob,
} = require('./comfy/client')
const { getAdapter, listAdapters } = require('./comfy/adapters')

// ============================================
// LTX 2.3 IC-Edit watermark removal workflow loader
// ============================================
//
// Loads the joyfox/LTX2.3-ICEdit-Insight reference workflow (UI format)
// from disk and turns it into the prompt-API format that ComfyUI's
// /prompt endpoint expects. The workflow is checked into the repo at
// reedit/workflows/LTX-2.3-ICLORA-edit-official.json — when the user
// updates the workflow there, the next run picks up the changes
// automatically (we cache parsed JSON until the file mtime changes).
//
// Conversion rules:
//   - Each node's `inputs[]` is walked in order. If an input has a
//     `link`, the value becomes `[srcNodeId, srcSlot]`. If an input has
//     `widget: {name}`, the value is pulled from `widgets_values` —
//     positionally when the latter is an array, or by name when it's an
//     object (VHS_* nodes use the object shape).
//   - `Seed (rgthree)` doesn't declare any inputs in the UI JSON; we
//     synthesise `{seed: <int>}` so the downstream RandomNoise node has
//     something to read.
//   - Nodes with `mode: 4` (muted/bypass in ComfyUI UI) are skipped.
//
// Patches applied for our use case:
//   - text encoder swap (we ship the fp8_scaled gemma, not the
//     fp8_e4m3fn the workflow author shipped with).
//   - IC-LoRA filename swap (the author's v2 file isn't published; we
//     point at the public `*-general.safetensors`).
//   - Wire 5097 (SageAttention) to the WATERMARK IC-LoRA (5133) and
//     5097/2483 to the watermark prompt (5131) instead of the upscale
//     prompt (5132). The reference workflow ships configured for
//     upscale; this flips it to watermark removal.
//   - The video filename uploaded for this scene, a random seed, and a
//     project-scoped output filename prefix.

const LTX_IC_EDIT_WORKFLOW_PATH = path.resolve(__dirname, '..', 'workflows', 'LTX-2.3-ICLORA-edit-official.json')
let _ltxIcEditCache = { mtimeMs: 0, json: null }

async function loadLtxIcEditWorkflowJson() {
  let stat
  try { stat = await fs.stat(LTX_IC_EDIT_WORKFLOW_PATH) } catch (err) {
    throw new Error(`LTX IC-Edit workflow JSON missing at ${LTX_IC_EDIT_WORKFLOW_PATH}. Re-clone the repo or restore it from workflows/LTX-2.3-ICLORA-edit-official.json.`)
  }
  if (_ltxIcEditCache.json && _ltxIcEditCache.mtimeMs === stat.mtimeMs) {
    return _ltxIcEditCache.json
  }
  const raw = await fs.readFile(LTX_IC_EDIT_WORKFLOW_PATH, 'utf-8')
  const json = JSON.parse(raw)
  _ltxIcEditCache = { mtimeMs: stat.mtimeMs, json }
  return json
}

function convertUiWorkflowToApi(uiJson) {
  // Build linkId → [srcNodeId, srcSlot] map. ComfyUI link format:
  //   [linkId, srcNode, srcSlot, dstNode, dstSlot, type]
  const linkMap = {}
  for (const link of uiJson.links || []) {
    if (!Array.isArray(link) || link.length < 3) continue
    linkMap[link[0]] = [String(link[1]), Number(link[2])]
  }

  const api = {}
  for (const node of uiJson.nodes || []) {
    if (!node || typeof node.id === 'undefined') continue
    if (node.mode === 4 || node.mode === 2) continue  // muted / bypassed
    const nid = String(node.id)
    const inputsObj = {}
    const wv = node.widgets_values
    const wvIsArray = Array.isArray(wv)
    const wvIsObject = wv !== null && typeof wv === 'object' && !wvIsArray
    let widgetIdx = 0
    for (const inp of (node.inputs || [])) {
      if (!inp?.name) continue
      const name = inp.name
      if (inp.link != null) {
        const src = linkMap[inp.link]
        if (src) inputsObj[name] = src
        continue
      }
      // Widget input — pull from widgets_values.
      if (inp.widget) {
        if (wvIsObject) {
          if (name in wv) inputsObj[name] = wv[name]
        } else if (wvIsArray) {
          if (widgetIdx < wv.length) {
            inputsObj[name] = wv[widgetIdx]
            widgetIdx += 1
          }
        }
      }
    }
    api[nid] = {
      class_type: node.type,
      inputs: inputsObj,
      _meta: { title: node.title || node.type },
    }
  }

  // ── Special-case fixups for nodes the converter can't handle from
  // schema alone:
  //
  // `Seed (rgthree)` has no inputs[] entries in the UI JSON but its
  // first widgets_values element is the seed (-1 = random in rgthree's
  // convention). The /prompt API needs an explicit `seed` input.
  for (const node of uiJson.nodes || []) {
    if (node?.type !== 'Seed (rgthree)') continue
    const nid = String(node.id)
    if (!api[nid]) continue
    const wv = Array.isArray(node.widgets_values) ? node.widgets_values : []
    const seed = Number.isFinite(Number(wv[0])) && Number(wv[0]) >= 0
      ? Number(wv[0])
      : Math.floor(Math.random() * 1e15)
    api[nid].inputs = { seed }
  }

  return api
}

// Build the API-format LTX 2.3 IC-Edit watermark removal workflow with
// the per-scene knobs patched in. Caller passes the filename already
// uploaded to Comfy + the desired output prefix; we return the workflow
// object plus the metadata the caller needs to find the saved video in
// /history (the VHS_VideoCombine node id, the filename prefix, etc.).
async function buildLtxIcEditWatermarkWorkflow({
  comfyInputName, outputPrefix, seed,
}) {
  const uiJson = await loadLtxIcEditWorkflowJson()
  const api = convertUiWorkflowToApi(uiJson)

  // ── Bake the watermark-removal prompt as a literal string instead of
  // wiring it through node 5131 ("CR Prompt Text", from the ComfyRoll
  // Custom Nodes pack). Two problems with keeping that node in the API
  // graph: (1) most installs — ours included — don't have ComfyRoll,
  // so ComfyUI rejects the whole /prompt submit with "unsupported node
  // type 'CR Prompt Text'" (VALIDATION_ERROR, no partial fallback);
  // (2) CR Prompt Text declares its text as a WIDGET, not a formal
  // input slot (its UI-JSON `inputs: []`), so convertUiWorkflowToApi's
  // generic positional/by-name widget mapping never populates
  // `inputs.text` for it anyway — even with the pack installed, the
  // node would submit with an empty prompt. Pull the author's default
  // straight out of the UI JSON's widgets_values and delete both
  // CR Prompt Text nodes (5131 = watermark-removal prompt, 5132 =
  // upscale-mode prompt, unused here) so ComfyUI never has to
  // instantiate the unsupported type.
  const ltxIcEditDefaultPromptNode = (uiJson.nodes || []).find((n) => n.id === 5131)
  const ltxIcEditDefaultPrompt = String(ltxIcEditDefaultPromptNode?.widgets_values?.[0] || '')
    || 'Remove the watermark and any platform overlay from this video; restore a clean, natural original image. Keep subject, scene, action, camera movement, timing and overall style identical — only remove the watermark and repair the affected detail.'
  delete api['5131']
  delete api['5132']

  // ── Same class of problem, two more custom-node dependencies from
  // packs that aren't installed everywhere: node 5128 builds a full
  // white "edit everything" mask (measure size → solid white image →
  // repeat over every frame → convert to mask) for VAEEncodeForInpaint.
  // 'easy imageSize' (ComfyUI-Easy-Use) and 'Image To Mask' (WAS Node
  // Suite) both have drop-in CORE-node equivalents with an IDENTICAL
  // input/output slot layout, so a straight class_type swap is safe —
  // no rewiring needed:
  //   - 'easy imageSize'  → 'GetImageSize'  (same image input; output
  //     slots 0/1 are width/height on both, GetImageSize adds a
  //     batch_size at slot 2 that nothing here consumes)
  //   - 'Image To Mask'   → 'ImageToMask'   (same image input; the
  //     'method: intensity' widget becomes 'channel: red' — the source
  //     image here is solid #FFFFFF from node 5123, so every channel
  //     reads 1.0 either way)
  if (api['5128']) api['5128'].class_type = 'GetImageSize'
  if (api['5125']) {
    api['5125'].class_type = 'ImageToMask'
    delete api['5125'].inputs.method
    api['5125'].inputs.channel = 'red'
  }

  // ── Text encoder. The reference workflow ships pointing at
  // gemma_3_12B_it_fp8_e4m3fn.safetensors — most installs (ours
  // included) have the fp8_scaled variant from Comfy-Org's mirror,
  // which is the same model with scale factors pre-applied. Drop in the
  // scaled version when available; fall back to whatever the workflow
  // shipped with otherwise (user can fix the dropdown manually).
  if (api['5023']) {
    api['5023'].inputs.text_encoder = 'gemma_3_12B_it_fp8_scaled.safetensors'
  }

  // ── IC-LoRA filename. Author's v2 file isn't on HF (only the
  // *-general.safetensors is published). Point both IC-LoRA loaders at
  // files we actually have. 5011 is the upscale variant — we don't use
  // it for watermark removal but the workflow keeps it loaded, so we
  // hand it the watermark file too (loaded but bypassed downstream).
  if (api['5133']) {
    api['5133'].inputs.lora_name = 'ltx2.3-train/ltx2.3-ic-watermark-remove-general.safetensors'
  }
  if (api['5011']) {
    api['5011'].inputs.lora_name = 'ltx2.3-train/ltx2.3-ic-watermark-remove-general.safetensors'
    // Set strength to 0 so it loads but contributes nothing — saves us
    // from rewiring the SageAttention node downstream.
    api['5011'].inputs.strength_model = 0
  }

  // ── Switch the workflow from "upscale" mode to "watermark removal".
  // The reference JSON has 5097 (SageAttention) reading from 5011
  // (upscale LoRA) and 2483 (positive CLIP encode) reading from 5132
  // (upscale prompt). Repoint both to the watermark side.
  if (api['5097']) api['5097'].inputs.model = ['5133', 0]
  if (api['2483']) api['2483'].inputs.text = ltxIcEditDefaultPrompt

  // ── Source video. VHS_LoadVideo accepts the filename of an asset
  // that was already uploaded to ComfyUI's input/ dir via /upload/image.
  if (api['5099']) {
    api['5099'].inputs.video = comfyInputName
    // Drop the default 121-frame cap so we process the whole clip.
    // (Caller can clamp upstream if VRAM is the issue.)
    api['5099'].inputs.frame_load_cap = 0
  }

  // ── Output prefix on VHS_VideoCombine.
  if (api['5069']) {
    api['5069'].inputs.filename_prefix = outputPrefix
    // Force-disable the videopreview's cos_url cache the author left
    // pointing at a remote bucket — we want the local /view route.
    delete api['5069'].inputs.videopreview
  }

  // ── Seed. Patch both the rgthree Seed node and the RandomNoise node
  // (whichever the workflow actually wires to the sampler) so a re-run
  // of the same scene produces a different result.
  const finalSeed = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1e15)
  if (api['5104']) api['5104'].inputs = { seed: finalSeed }
  if (api['5106'] && api['5106'].inputs) {
    // RandomNoise expects noise_seed as either an int or a link. If
    // 5104 is wired (link), keep the link; otherwise pin the int.
    if (!Array.isArray(api['5106'].inputs.noise_seed)) {
      api['5106'].inputs.noise_seed = finalSeed
    }
  }

  return { workflow: api, saveNodeId: '5069', filenamePrefix: outputPrefix, seed: finalSeed }
}

function buildWanVaceWorkflow({
  sourceName, maskName, prefix, genW, genH, targetW, targetH, numFrames, fps, positive, negative,
}) {
  // Mirrors vace_inpaint_super02.py, with the upscale tail we verified
  // (node 15 batched upscale + node 16 scale to target resolution) and
  // the per-shot parameters wired in instead of hardcoded SUPER02
  // values. Seed stays at 42 to keep runs reproducible across retries;
  // callers that want variation can override via a seed arg later.
  return {
    '1': { class_type: 'WanVideoModelLoader', inputs: { model: 'wan2.1_vace_1.3B_fp16.safetensors', base_precision: 'fp16', quantization: 'disabled', load_device: 'main_device' } },
    '2': { class_type: 'WanVideoVAELoader', inputs: { model_name: 'wan_2.1_vae.safetensors', precision: 'bf16' } },
    '3': { class_type: 'WanVideoTextEncodeCached', inputs: { model_name: 'umt5_xxl_fp16.safetensors', precision: 'bf16', positive_prompt: positive, negative_prompt: negative, quantization: 'disabled', use_disk_cache: false, device: 'gpu' } },
    '4': { class_type: 'VHS_LoadVideo', inputs: { video: sourceName, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    '5': { class_type: 'VHS_LoadVideo', inputs: { video: maskName, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    '6': { class_type: 'WanVideoImageResizeToClosest', inputs: { image: ['4', 0], generation_width: genW, generation_height: genH, aspect_ratio_preservation: 'crop_to_new' } },
    '7': { class_type: 'WanVideoImageResizeToClosest', inputs: { image: ['5', 0], generation_width: genW, generation_height: genH, aspect_ratio_preservation: 'crop_to_new' } },
    '8': { class_type: 'ImageToMask', inputs: { image: ['7', 0], channel: 'red' } },
    '9': { class_type: 'WanVideoVACEEncode', inputs: { vae: ['2', 0], width: genW, height: genH, num_frames: numFrames, strength: 1, vace_start_percent: 0, vace_end_percent: 1, input_frames: ['6', 0], input_masks: ['8', 0], tiled_vae: false } },
    '10': { class_type: 'WanVideoSchedulerv2', inputs: { scheduler: 'unipc', steps: 25, shift: 5, start_step: 0, end_step: -1 } },
    '11': { class_type: 'WanVideoSamplerv2', inputs: { model: ['1', 0], image_embeds: ['9', 0], text_embeds: ['3', 0], cfg: 5, seed: 42, force_offload: true, scheduler: ['10', 0] } },
    '12': { class_type: 'WanVideoDecode', inputs: { vae: ['2', 0], samples: ['11', 0], enable_vae_tiling: false, tile_x: 272, tile_y: 272, tile_stride_x: 144, tile_stride_y: 144 } },
    '13': { class_type: 'VHS_VideoCombine', inputs: { images: ['16', 0], frame_rate: fps, loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4', pingpong: false, save_output: true } },
    '14': { class_type: 'UpscaleModelLoader', inputs: { model_name: 'RealESRGAN_x4plus.pth' } },
    '15': { class_type: 'ImageUpscaleWithModelBatched', inputs: { upscale_model: ['14', 0], images: ['12', 0], per_batch: 4, downscale_ratio: 1, downscale_method: 'lanczos', precision: 'float16' } },
    '16': { class_type: 'ImageScale', inputs: { image: ['15', 0], upscale_method: 'lanczos', width: targetW, height: targetH, crop: 'disabled' } },
  }
}

// Bare upscale workflow — load video → upscale x4 → scale to target →
// save. No VACE, no text encoder, no sampler. Used by the Commit
// reframe path where the reframe was already baked into a pre-cropped
// MP4 via ffmpeg and all ComfyUI needs to do is bring the resolution
// back up for delivery. Roughly 1/20th the cost of a VACE pass for a
// clip of the same length.
//
// Cloud-compatible: built only out of nodes shipped with ComfyUI core
// + VideoHelperSuite (the latter is the de-facto standard, present in
// Comfy Cloud's stock image). The previous version used the KJNodes
// `ImageUpscaleWithModelBatched` which isn't preinstalled there.
// Default model is `RealESRGAN_x4plus.pth` — the one upscale model
// that has been bundled with ComfyUI for years, so it's always present
// regardless of where the workflow runs.
function buildUpscaleOnlyWorkflow({ inputName, outputPrefix, targetW, targetH, fps, upscaleModel }) {
  return {
    '1': { class_type: 'VHS_LoadVideo', inputs: { video: inputName, force_rate: 0, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: 'AnimateDiff' } },
    '2': { class_type: 'UpscaleModelLoader', inputs: { model_name: upscaleModel || 'RealESRGAN_x4plus.pth' } },
    '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
    '4': { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: targetW, height: targetH, crop: 'disabled' } },
    '5': { class_type: 'VHS_VideoCombine', inputs: { images: ['4', 0], frame_rate: fps, loop_count: 0, filename_prefix: outputPrefix, format: 'video/h264-mp4', pingpong: false, save_output: true } },
  }
}

// Negative prompt re-used across all optimize runs. Targets the usual
// VACE failure modes (ghost text, duplicate frames, inpainting
// artifacts) and the specific things we're trying to remove.
const OPTIMIZE_NEGATIVE_PROMPT = (
  'text, watermark, overlay, title, caption, letters, typography, logo, ' +
  'chyron, lower third, subtitle, legal disclaimer, url, ' +
  'duplicate frames, blur, distortion, deformed, low quality, artifacts, ' +
  'ghosting, color banding.'
)

function probeVideoMeta(filePath) {
  // Returns { width, height, fps, duration, nbFrames } via ffprobe.
  // Every one of these feeds directly into the workflow (gen res + fps
  // + num_frames) so failing the probe has to short-circuit the
  // optimize; we return null and let the caller surface the error.
  return new Promise((resolve) => {
    if (!ffprobeStaticPath) return resolve(null)
    const p = spawn(ffprobeStaticPath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration',
      '-of', 'json',
      filePath,
    ], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.on('error', () => resolve(null))
    p.on('close', () => {
      try {
        const data = JSON.parse(out)
        const s = data?.streams?.[0]
        if (!s) return resolve(null)
        const [num, den] = String(s.r_frame_rate || '').split('/').map(Number)
        const fps = (Number.isFinite(num) && Number.isFinite(den) && den > 0) ? num / den : null
        resolve({
          width: Number(s.width) || null,
          height: Number(s.height) || null,
          fps,
          duration: parseFloat(s.duration) || null,
          nbFrames: parseInt(s.nb_frames, 10) || null,
        })
      } catch {
        resolve(null)
      }
    })
  })
}

// Clamp Wan's gen dimensions to the shot's aspect ratio, keeping the
// total pixel count close to 768×432 (the 16:9 sweet-spot we verified
// on SUPER02). The training resolution for Wan 2.1 VACE 1.3B is
// 832×480, so we stay in that neighbourhood rather than scaling up.
function pickGenDims(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || height === 0) {
    return { genW: 832, genH: 480 }
  }
  const aspect = width / height
  // Snap to multiples of 16 (VAE downsample stride) on both axes. 432
  // isn't /16 but Wan tolerates it; 480 is /16 and matches the training
  // resolution, so prefer 480-height whenever aspect is close to 16:9.
  if (Math.abs(aspect - 16 / 9) < 0.02) return { genW: 768, genH: 432 }
  if (Math.abs(aspect - 9 / 16) < 0.02) return { genW: 432, genH: 768 }
  if (Math.abs(aspect - 1) < 0.02) return { genW: 512, genH: 512 }
  // Non-standard aspect: start from height=480 and round width.
  const w = Math.round((480 * aspect) / 16) * 16
  return { genW: Math.max(256, w), genH: 480 }
}

function sanitizeForFilename(s, maxLen = 40) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, maxLen)
}

async function copyFileOverwrite(src, dst) {
  // fs.copyFile with explicit fallback: on Windows a stale read handle
  // from ComfyUI (loaded the previous run's mask) will ENOENT the copy
  // until we drop it. Two retries with a short gap clears that 99% of
  // the time without asking the user to close anything.
  for (let i = 0; i < 3; i++) {
    try {
      await fs.copyFile(src, dst)
      return
    } catch (err) {
      if (i === 2) throw err
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

// Drop the API workflow JSON we submitted to ComfyUI next to its
// output MP4 so the user can drag it back into ComfyUI later for
// inspection / iteration. We write TWO files:
//   - `<base>.workflow.json`      → the BARE API workflow at the top
//                                   level. ComfyUI's drag-to-load
//                                   expects either UI format
//                                   (`nodes` array) or flat API format
//                                   (object with node-id keys); an
//                                   envelope around it makes the canvas
//                                   come up empty.
//   - `<base>.workflow.meta.json` → small sidecar with our metadata
//                                   (version, sceneId, modelId,
//                                   promptId, submittedAt). For
//                                   debugging / sweeping by hand.
// Returns the workflow JSON path so the renderer can show it / open
// it in OS file manager.
async function saveWorkflowAlongsideOutput(outputMp4Path, workflow, extras = {}) {
  if (!outputMp4Path) {
    console.warn('[saveWorkflow] no outputMp4Path; skipping')
    return null
  }
  if (!workflow || typeof workflow !== 'object') {
    console.warn('[saveWorkflow] no workflow object; skipping. type=', typeof workflow)
    return null
  }
  const dir = path.dirname(outputMp4Path)
  const base = path.basename(outputMp4Path).replace(/\.[^.]+$/, '')
  const workflowPath = path.join(dir, `${base}.workflow.json`)
  const metaPath = path.join(dir, `${base}.workflow.meta.json`)

  // Serialise the bare workflow first — that's the file ComfyUI can
  // load directly. If JSON.stringify fails on it (rare; no cycles in
  // a flat API workflow but be defensive), the whole save aborts.
  let workflowText
  try {
    workflowText = JSON.stringify(workflow, null, 2)
  } catch (err) {
    console.warn('[saveWorkflow] workflow JSON.stringify failed:', err?.message || err)
    return null
  }
  if (!workflowText || workflowText.length < 10) {
    console.warn('[saveWorkflow] serialised workflow is suspiciously empty (len=' + (workflowText?.length ?? 0) + ')')
    return null
  }

  const meta = {
    kind: extras.kind || 'reedit',
    version: extras.version || null,
    sceneId: extras.sceneId || null,
    modelId: extras.modelId || null,
    promptId: extras.promptId || null,
    submittedAt: new Date().toISOString(),
    workflowFile: path.basename(workflowPath),
  }

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(workflowPath, workflowText, 'utf8')
    const st = await fs.stat(workflowPath).catch(() => null)
    if (!st || st.size <= 2) {
      console.warn(`[saveWorkflow] file written but on-disk size is ${st?.size ?? 'missing'} bytes: ${workflowPath}`)
      return null
    }
    // Sidecar metadata. Best-effort — failing to write it doesn't
    // invalidate the workflow file, which is what the user actually
    // needs to reopen in ComfyUI.
    try {
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
    } catch (metaErr) {
      console.warn('[saveWorkflow] meta sidecar failed (non-fatal):', metaErr?.message || metaErr)
    }
    console.log(`[saveWorkflow] wrote ${st.size} bytes to ${workflowPath}`)
    return workflowPath
  } catch (err) {
    console.warn('[saveWorkflow] fs.writeFile failed:', err?.message || err, 'path=', workflowPath)
    return null
  }
}

// Composite the VACE output onto the original clip using the
// generated binary mask as a matte. The goal here is to keep every
// pixel that wasn't masked pixel-identical to the source: Wan VACE
// subtly re-renders the whole frame (colour shifts, micro jitter) and
// the user only wants the "patches" where graphics were, not a full
// re-render.
//
// Filter graph:
//   [mask]  → gray, gblur(sigma=feather)       → feathered alpha
//   [vace]  + [alpha]   → alphamerge           → vace with per-pixel alpha
//   [orig]  + [vace α]  → overlay              → composite
//
// `eof_action=pass` on overlay lets the original run to its full length
// even if VACE produced one frame less (we snap to (N-1)%4==0 for Wan).
// `shortest=1` would truncate to the shorter stream, which would drop
// the trailing frames from the source; we want the opposite.
function compositeWithOriginalMask({ originalPath, vacePath, maskPath, outputPath, feather = 3, expectedFrames = null }) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve({ success: false, error: 'FFmpeg binary not available.' })
    const sigma = Math.max(0.5, Number(feather) || 3)
    const filter = [
      // Mask → grayscale, slight gaussian feather. `setsar=1` keeps the
      // pixel aspect in sync with the video layers so alphamerge doesn't
      // complain about SAR mismatch.
      `[2:v]format=gray,setsar=1,gblur=sigma=${sigma}[mblur]`,
      // VACE output needs an RGBA surface for alphamerge to write into.
      `[1:v]format=rgba,setsar=1[vace_rgba]`,
      `[vace_rgba][mblur]alphamerge[vace_alpha]`,
      // Original gets set to the target pixel format and SAR too.
      `[0:v]format=yuv420p,setsar=1[bg]`,
      // eof_action=endall: the moment ANY of (bg, vace, mask) runs out
      // of frames, the overlay stops. That's critical because Wan VACE
      // occasionally returns one frame more than the original — without
      // this, the extra VACE frame would land on the composite with no
      // mask and the un-removed graphic would show through on the last
      // frame. The `-frames:v` cap below is a belt-and-suspenders in
      // case the duration-based stop lets a partial frame leak.
      `[bg][vace_alpha]overlay=format=auto:eof_action=endall[vout]`,
    ].join(';')

    const args = [
      '-hide_banner',
      '-nostats',
      '-i', originalPath,
      '-i', vacePath,
      '-i', maskPath,
      '-filter_complex', filter,
      '-map', '[vout]',
      // Best-effort keep the original's audio if it has any; `?` makes
      // the map optional so silent clips don't fail.
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'medium',
      // CRF 18 is visually lossless for 1080p H.264; we re-encode here
      // because the filter graph changes the pixel data. The overlayed
      // region is actually new content, but the bulk of the frame is
      // the source so we don't want to compress that aggressively.
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      // Hard cap at the original frame count. Redundant with
      // eof_action=endall but cheap and kills any off-by-one that
      // slips through the filter graph.
      ...(Number.isFinite(expectedFrames) && expectedFrames > 0
        ? ['-frames:v', String(expectedFrames)]
        : []),
      '-y',
      outputPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => resolve({ success: false, error: err.message, stderr }))
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({ success: false, error: `ffmpeg composite exited with code ${code}. Tail: ${stderr.slice(-400)}`, stderr })
      }
      resolve({ success: true, outputPath, stderr })
    })
  })
}

function runPython(scriptPath, args, { onStderr } = {}) {
  return new Promise((resolve) => {
    const python = resolvePythonExe()
    const proc = spawn(python, [scriptPath, ...args], { windowsHide: true })
    let stderr = ''
    let stdout = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => {
      const chunk = d.toString()
      stderr += chunk
      onStderr?.(chunk)
    })
    proc.on('error', (err) => resolve({ success: false, error: err.message, stdout, stderr }))
    proc.on('close', (code) => {
      resolve({ success: code === 0, code, stdout, stderr })
    })
  })
}

// Preview-only mask run: same make_mask.py invocation the optimize
// pipeline uses, but stops after generating `{sceneId}_mask.mp4` +
// `{sceneId}_blank.mp4`. Skips ComfyUI, upscaling and composite so the
// user can iterate on ROI / threshold / persistence without burning
// 12 minutes of VACE time per try.
ipcMain.handle('analysis:previewMask', async (event, options) => {
  const { scene, projectDir } = options || {}
  if (!scene?.id) return { success: false, error: 'scene.id required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const sceneId = scene.id

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Shot clip not found at ${sourceClipPath}. Run Caption all first.` }
  }

  const graphics = scene.videoAnalysis?.graphics || null
  const hint = graphics?.removal_hint || null
  const maskArgs = pickMaskArgsFromHint(hint, graphics)

  const maskScriptPath = path.resolve(__dirname, '..', 'scripts', 'make_mask.py')
  try { await fs.access(maskScriptPath) } catch {
    return { success: false, error: `make_mask.py not found at ${maskScriptPath}.` }
  }

  // If boxes mode, stage the JSON in a per-scene scratch file so we
  // don't hit Windows' ~8 KB command-line cap on long bbox lists.
  const finalScriptArgs = ['--src', sourceClipPath, ...maskArgs.args]
  if (maskArgs.bboxesJson) {
    const bboxesPath = path.join(path.dirname(sourceClipPath), `${sceneId}_bboxes.json`)
    try { await fs.writeFile(bboxesPath, maskArgs.bboxesJson, 'utf-8') } catch (err) {
      return { success: false, error: `Could not write bboxes file: ${err.message}` }
    }
    finalScriptArgs.push('--bboxes-file', bboxesPath)
  }

  const runRes = await runPython(maskScriptPath, finalScriptArgs)
  if (!runRes.success) {
    return { success: false, error: `make_mask.py failed (code ${runRes.code}). Tail: ${(runRes.stderr || '').slice(-300)}` }
  }

  const clipsDir = path.dirname(sourceClipPath)
  const maskPath = path.join(clipsDir, `${sceneId}_mask.mp4`)
  const blankPath = path.join(clipsDir, `${sceneId}_blank.mp4`)
  try {
    await fs.access(maskPath)
    await fs.access(blankPath)
  } catch {
    return { success: false, error: 'Mask / blank files missing after make_mask.py reported success.' }
  }
  return {
    success: true,
    maskPath,
    blankPath,
    argsUsed: maskArgs.args,
    scriptStdout: (runRes.stdout || '').slice(-1500),
    scriptStderr: (runRes.stderr || '').slice(-500),
  }
})

ipcMain.handle('analysis:optimizeFootage', async (event, options) => {
  const { scene, projectDir, comfyUrl: comfyUrlOpt, apiKey: apiKeyOpt } = options || {}
  if (!scene?.id) return { success: false, error: 'scene.id required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const sceneId = scene.id
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:optimizeFootage:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer may be closed */ }
  }

  emit('starting')

  // 1. Locate or extract the source clip — we reuse the frame-accurate
  //    sub-clip that the video analyzer already caches, so the
  //    optimize pass matches exactly what Gemini saw.
  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Shot clip not found at ${sourceClipPath}. Re-run Caption all with Gemini to generate it.` }
  }

  // 2. Probe the clip to derive Wan gen dims + output target size.
  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height || !meta?.fps || !meta?.nbFrames) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }
  const { genW, genH } = pickGenDims(meta.width, meta.height)
  const numFrames = meta.nbFrames
  // Wan VACE requires (N-1) % 4 === 0. Snap down if the shot doesn't
  // already comply — most ad shots are short enough that one frame
  // either way is imperceptible.
  const wanFrames = Math.max(5, numFrames - ((numFrames - 1) % 4))
  if (wanFrames !== numFrames) emit('note', { message: `Clamped num_frames ${numFrames} → ${wanFrames} to satisfy (N-1)%%4==0.` })

  emit('generating_mask', { meta, genW, genH, numFrames: wanFrames })

  // 3. Generate mask + blank with make_mask.py using the hint.
  const graphics = scene.videoAnalysis?.graphics || null
  const hint = graphics?.removal_hint || null
  const maskArgs = pickMaskArgsFromHint(hint, graphics)
  if (maskArgs.warn) emit('note', { message: maskArgs.warn })
  emit('note', { message: `Mask mode: ${maskArgs.mode}${maskArgs.mode === 'boxes' ? ` (${extractBboxes(graphics).length} box${extractBboxes(graphics).length === 1 ? '' : 'es'})` : ''}.` })

  // Derived file names live next to the source clip so `.reedit/clips`
  // becomes the canonical staging area for everything the optimize
  // pipeline produces per scene.
  const clipsDir = path.dirname(sourceClipPath)
  const maskPath = path.join(clipsDir, `${sceneId}_mask.mp4`)
  const blankPath = path.join(clipsDir, `${sceneId}_blank.mp4`)
  // make_mask.py decides the output paths based on `<src>_mask.mp4` /
  // `<src>_blank.mp4`, which is exactly what we want.
  // make_mask.py lives in reedit/scripts/ next to the other helpers
  // (build-workflow-starter-pack.mjs, docker-build-linux.sh, …).
  const maskScriptPath = path.resolve(__dirname, '..', 'scripts', 'make_mask.py')
  try {
    await fs.access(maskScriptPath)
  } catch {
    return { success: false, error: `make_mask.py not found at ${maskScriptPath}.` }
  }

  const finalMaskArgs = ['--src', sourceClipPath, ...maskArgs.args]
  if (maskArgs.bboxesJson) {
    const bboxesPath = path.join(clipsDir, `${sceneId}_bboxes.json`)
    try { await fs.writeFile(bboxesPath, maskArgs.bboxesJson, 'utf-8') } catch (err) {
      return { success: false, error: `Could not write bboxes file: ${err.message}` }
    }
    finalMaskArgs.push('--bboxes-file', bboxesPath)
  }

  const maskRes = await runPython(maskScriptPath, finalMaskArgs, {
    onStderr: (chunk) => emit('mask_log', { chunk }),
  })
  if (!maskRes.success) {
    return { success: false, error: `make_mask.py failed (code ${maskRes.code}). Is Python + opencv-python installed? Tail: ${(maskRes.stderr || '').slice(-200)}` }
  }
  // Verify the outputs landed where we expect.
  try {
    await fs.access(maskPath)
    await fs.access(blankPath)
  } catch {
    return { success: false, error: 'make_mask.py reported success but mask/blank files are missing.' }
  }

  emit('uploading')

  // 4. Upload the blank + mask to ComfyUI's input via /upload/image.
  //    Works the same on local (server writes them into its input/
  //    directory) and on cloud (the file is staged remotely for the
  //    workflow to consume). The returned `name` is what LoadVideo
  //    references inside the workflow JSON.
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}`
  let comfySrcName
  let comfyMaskName
  try {
    const blankUp = await uploadFileToComfy({
      comfyUrl, apiKey,
      localFilePath: blankPath,
      filename: `${prefix}_blank.mp4`,
    })
    const maskUp = await uploadFileToComfy({
      comfyUrl, apiKey,
      localFilePath: maskPath,
      filename: `${prefix}_mask.mp4`,
    })
    comfySrcName = blankUp?.name || `${prefix}_blank.mp4`
    comfyMaskName = maskUp?.name || `${prefix}_mask.mp4`
  } catch (err) {
    return { success: false, error: `Failed to upload inputs to ComfyUI (${comfyUrl}): ${err.message}` }
  }

  // 5. Build + submit the workflow. Prompt from the Gemini analysis;
  //    negative is a shared overlay-removal negative.
  const positive = scene.videoAnalysis?.visual
    || scene.caption
    || 'A high-quality cinematic shot, natural lighting, crisp detail, no text or overlays.'
  const outputPrefix = `reedit_optimized/${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}`
  const workflow = buildWanVaceWorkflow({
    sourceName: comfySrcName,
    maskName: comfyMaskName,
    prefix: outputPrefix,
    genW, genH,
    targetW: meta.width,
    targetH: meta.height,
    numFrames: wanFrames,
    fps: meta.fps,
    positive,
    negative: OPTIMIZE_NEGATIVE_PROMPT,
  })

  emit('queued_submit')

  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow: workflow })
  } catch (err) {
    return { success: false, error: err.message }
  }

  emit('queued', { promptId })

  // 6. Wait for the job to complete. waitForComfyJob hides the
  //    local vs cloud polling difference (local: /history/<id>; cloud:
  //    /api/job/<id>/status until completed, then /api/jobs/<id>).
  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 20 * 60 * 1000,
      pollMs: 4000,
      onTick: () => {
        emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) })
      },
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy job ${promptId} failed.` }
  }

  // 7. Extract the output filename from the history entry. Local Comfy
  //    populates `g.fullpath` (an absolute path on the server's disk);
  //    Cloud doesn't — it returns just `filename` + `subfolder` + `type`.
  //    Either way, we have to download the bytes via /view because in
  //    cloud the file lives on remote storage. Even in local, the file
  //    is in ComfyUI's output dir; pulling via /view keeps the code
  //    path uniform and is cheap on loopback.
  let outFilename = null, outSubfolder = '', outType = 'output'
  for (const out of Object.values(result.outputs || {})) {
    const gifs = Array.isArray(out?.gifs) ? out.gifs : []
    for (const g of gifs) {
      if (g?.filename) {
        outFilename = g.filename
        outSubfolder = g.subfolder || ''
        outType = g.type || 'output'
        break
      }
    }
    if (outFilename) break
  }
  if (!outFilename) {
    return { success: false, error: 'Workflow completed but no video output was reported in history.' }
  }

  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }

  // Version the output so re-runs don't clobber previous attempts —
  // the user wants to A/B across mask / feather / prompt tweaks. We
  // scan the optimized dir for existing files matching `<sceneId>_VNN`
  // and pick the next integer. Padding to two digits keeps the names
  // sortable in a file manager ("_V02" lists before "_V10").
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_V(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `V${String(nextVersion).padStart(2, '0')}`
  emit('note', { message: `Writing version ${versionTag}.` })

  // Stage the raw VACE output under a distinct name so it stays
  // available for A/B compare. The "final" path the UI links to is the
  // composite below, which merges VACE into the original using the
  // mask as a matte.
  const vaceRawPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_vace_raw.mp4`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFilename,
      subfolder: outSubfolder,
      type: outType,
      destPath: vaceRawPath,
    })
  } catch (err) {
    // Non-fatal: skip the composite step and return the remote
    // filename so the UI at least has a reference.
    emit('note', { message: `Could not download VACE output (${err.message}); skipping composite.` })
    return { success: true, promptId, outputPath: null, remoteName: outFilename, inProjectDir: false, composited: false, version: versionTag }
  }

  // 8. Composite the VACE output onto the original using the generated
  //    mask as a feathered matte. Everything outside the mask stays
  //    pixel-identical to the source; only the "patch" pixels adopt
  //    VACE's re-rendered content. This avoids the overall colour /
  //    detail drift VACE introduces on non-masked regions.
  emit('compositing')
  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  const localMaskPath = path.join(clipsDir, `${sceneId}_mask.mp4`)
  const compRes = await compositeWithOriginalMask({
    originalPath: sourceClipPath,
    vacePath: vaceRawPath,
    maskPath: localMaskPath,
    outputPath: finalPath,
    // σ=16 — paired with the smaller dilate kernel (13). The combo
    // lets the mask stay tight around the actual graphic while the
    // feather smooths the VACE↔original seam. σ=8 was leaving a
    // visible line on user-marked artefacts; doubling the feather
    // softens that without bleeding back into the σ=45 over-blur
    // regression we had earlier when the dilate was too aggressive.
    feather: 16,
    // Force the composite length to the original clip's frame count.
    // Wan VACE sometimes returns +1 frame on shots where our wanFrames
    // snap differs from numFrames; without this cap that trailing
    // frame shows the original graphic un-masked because the mask
    // video ended earlier.
    expectedFrames: meta.nbFrames,
  })
  if (!compRes.success) {
    // Composite failed — fall back to exposing the raw VACE output so
    // the user still has something usable, and surface the error.
    emit('note', { message: `Composite step failed: ${compRes.error}. Returning raw VACE output.` })
    const workflowJsonPath = await saveWorkflowAlongsideOutput(vaceRawPath, workflow, {
      kind: 'optimize-vace', version: versionTag, sceneId, modelId: 'wan-vace', promptId,
    })
    emit('done', { promptId, outputPath: vaceRawPath, version: versionTag, workflowJsonPath })
    return { success: true, promptId, outputPath: vaceRawPath, workflowJsonPath, inProjectDir: true, composited: false, compositeError: compRes.error, version: versionTag }
  }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, workflow, {
    kind: 'optimize-vace', version: versionTag, sceneId, modelId: 'wan-vace', promptId,
  })
  emit('done', { promptId, outputPath: finalPath, version: versionTag, workflowJsonPath })
  return { success: true, promptId, outputPath: finalPath, workflowJsonPath, inProjectDir: true, composited: true, vaceRawPath, version: versionTag }
})

// ============================================
// Optimize footage — LTX 2.3 IC-Edit watermark/overlay removal
// ============================================
//
// Alternative engine to the VACE pipeline above. Same end goal (remove
// on-screen graphics from a shot), totally different mechanics:
//   - No external mask. The IC-LoRA infers what's an overlay from the
//     reference image of the first frame and the natural-language prompt.
//   - No Python helper. The whole pipeline lives in ComfyUI as a single
//     workflow (the joyfox/LTX2.3-ICEdit-Insight reference graph).
//   - Single model family: LTX 2.3 base FP8 + Gemma encoder + the
//     distilled-LoRA + the watermark IC-LoRA. Shares VRAM with our
//     existing extend / LipDub flows so the model load amortises.
//
// Versions land in the same `.reedit/optimized/<sceneId>_*` stack as
// VACE outputs, but use an `L{NN}` tag (`L01`, `L02`, …) so the user
// can A/B them against VACE's `V{NN}` outputs in the version dropdown.
ipcMain.handle('analysis:optimizeFootageLTX', async (event, options) => {
  const { scene, projectDir, comfyUrl: comfyUrlOpt, apiKey: apiKeyOpt, promptOverride } = options || {}
  if (!scene?.id) return { success: false, error: 'scene.id required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const sceneId = scene.id
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:optimizeFootageLTX:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer may be closed */ }
  }
  emit('starting')

  // Locate the cached sub-clip the captioner already wrote. Same
  // contract as the VACE handler — the analyzer is responsible for
  // ensuring this clip exists.
  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Shot clip not found at ${sourceClipPath}. Re-run Caption all so the cached sub-clip exists.` }
  }

  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height || !meta?.fps) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }

  // Upload the source clip. VHS_LoadVideo inside the workflow reads it
  // from ComfyUI's input/ folder (or remote staging on Cloud).
  emit('uploading')
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}`
  let comfyInputName
  try {
    const up = await uploadFileToComfy({
      comfyUrl, apiKey,
      localFilePath: sourceClipPath,
      filename: `${prefix}_source.mp4`,
    })
    comfyInputName = up?.name || `${prefix}_source.mp4`
  } catch (err) {
    return { success: false, error: `Failed to upload source clip to ComfyUI: ${err.message}` }
  }

  // Pick the next L-tagged version slot. Scan existing files matching
  // `<sceneId>_LNN` and increment. Two-digit padding for sortable names.
  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_L(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `L${String(nextVersion).padStart(2, '0')}`
  emit('note', { message: `Writing version ${versionTag}.` })

  // Build the patched workflow JSON. The output prefix is namespaced
  // under reedit/ so a user with many projects doesn't end up with one
  // huge flat output dir on the Comfy side.
  const outputPrefix = `reedit_optimized/${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`
  const seed = Math.floor(Math.random() * 1e12)
  let built
  try {
    built = await buildLtxIcEditWatermarkWorkflow({
      comfyInputName,
      outputPrefix,
      seed,
    })
  } catch (err) {
    return { success: false, error: `Could not load LTX IC-Edit workflow: ${err.message}` }
  }
  const { workflow } = built

  // Optional prompt override. The reference workflow ships with the
  // joyfox-authored Chinese prompt baked into node 2483's CLIPTextEncode
  // (see buildLtxIcEditWatermarkWorkflow — node 5131 that used to hold
  // it was removed, it's an uninstalled ComfyRoll custom node); English
  // usually works fine for the ad-cleanup use case, but expose it so
  // the user can swap if a particular shot needs steering.
  if (promptOverride && typeof promptOverride === 'string' && workflow['2483']?.inputs) {
    workflow['2483'].inputs.text = promptOverride
  }

  emit('queued_submit')
  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow: workflow })
  } catch (err) {
    return { success: false, error: err.message }
  }
  emit('queued', { promptId })

  // LTX 2.3 at ~920k px / 6 steps with the distilled LoRA is fast —
  // 30-90s on a 4070 for typical ad shots. 20-min ceiling covers cold
  // model load + Cloud queue wait.
  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 20 * 60 * 1000,
      pollMs: 3000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy LTX IC-Edit job ${promptId} failed.` }
  }

  // VHS_VideoCombine writes to `gifs[]` in the history (filename ends
  // in `.mp4` despite the key name — Comfy historical baggage).
  const VIDEO_RE = /\.(mp4|mov|webm|mkv|gif|avi|m4v)$/i
  let outFilename = null, outSubfolder = '', outType = 'output'
  for (const out of Object.values(result.outputs || {})) {
    const candidates = [
      ...(Array.isArray(out?.gifs) ? out.gifs : []),
      ...(Array.isArray(out?.videos) ? out.videos : []),
      ...(Array.isArray(out?.images) ? out.images : []),
    ]
    for (const c of candidates) {
      if (!c?.filename) continue
      if (!VIDEO_RE.test(c.filename)) continue
      outFilename = c.filename
      outSubfolder = c.subfolder || ''
      outType = c.type || 'output'
      break
    }
    if (outFilename) break
  }
  if (!outFilename) {
    return { success: false, error: 'LTX IC-Edit workflow completed but no video output was reported in history.' }
  }

  emit('finalizing')
  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFilename,
      subfolder: outSubfolder,
      type: outType,
      destPath: finalPath,
    })
  } catch (err) {
    return { success: false, error: `Could not download LTX IC-Edit output: ${err.message}` }
  }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, workflow, {
    kind: 'optimize-ltx-ic-edit', version: versionTag, sceneId, modelId: 'ltx-2.3-ic-edit-watermark', promptId, seed,
  })
  emit('done', { promptId, outputPath: finalPath, version: versionTag, workflowJsonPath })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    workflowJsonPath,
    inProjectDir: true,
    version: versionTag,
    modelId: 'ltx-2.3-ic-edit-watermark',
    engine: 'ltx-ic-edit',
  }
})

// ============================================
// Commit reframe (zoom/pan → upscale + crop)
// ============================================
//
// Handler for the "Commit reframe" button in InspectorPanel. Given a
// scene that's currently being previewed with a zoom/pan transform on
// the timeline, this bakes the reframe into a physical MP4:
//   1. ffmpeg pre-crops the original sub-clip by `crop=<w>:<h>:<x>:<y>`
//      derived from the zoom/anchor params, scaling the crop back to
//      the target delivery resolution (pixel-for-pixel what the user
//      was previewing, but as an actual file).
//   2. The pre-cropped video goes to ComfyUI for a RealESRGAN x4 pass
//      which lifts the effective resolution back to delivery-quality.
//   3. The final file lands in `.reedit/optimized/<sceneId>_R{NN}.mp4`
//      and slots into the same `scene.optimizations[]` stack as the
//      VACE `V{NN}` outputs, so the version dropdown + resolver work
//      without any new plumbing.
// Third optimize engine: Kling 3 Omni Edit on Comfy Cloud. Maskless,
// prompt-based removal — no make_mask.py, no local checkpoints. Output
// keeps the input duration; we still remux the ORIGINAL audio over the
// result. Versions tag as K{NN} in the same optimization stack so the
// dropdown lets the user A/B against VACE (V) and LTX (L) runs.
ipcMain.handle('analysis:optimizeFootageKling', async (event, options) => {
  const { scene, projectDir, comfyUrl: comfyUrlOpt, apiKey: apiKeyOpt, promptOverride } = options || {}
  if (!scene?.id) return { success: false, error: 'scene.id required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const sceneId = scene.id
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''
  const adapter = getAdapter('kling-omni-edit')
  if (!isCloudComfyUrl(comfyUrl)) {
    return { success: false, error: `${adapter.label} needs Comfy Cloud. Switch the ComfyUI mode to Cloud in the launcher chip or Settings → ComfyUI.` }
  }

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:optimizeFootageKling:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer may be closed */ }
  }
  emit('starting')

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Shot clip not found at ${sourceClipPath}. Re-run Caption all so the cached sub-clip exists.` }
  }
  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }

  emit('uploading')
  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_K(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `K${String(nextVersion).padStart(2, '0')}`
  emit('note', { message: `Writing version ${versionTag}.` })
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`

  let comfyInputName = `${prefix}_source.mp4`
  try {
    const up = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: sourceClipPath, filename: comfyInputName })
    comfyInputName = up?.name || comfyInputName
  } catch (err) {
    return { success: false, error: `Failed to upload source clip: ${err.message}` }
  }

  // Prompt: the analyzer's removal hint when present, else the
  // adapter's generic "remove all graphics" default.
  const hint = promptOverride
    || scene?.videoAnalysis?.graphics?.removal_hint
    || scene?.videoAnalysis?.removal_hint
    || ''
  const workflow = adapter.buildWorkflow({
    sourceVideoFilename: comfyInputName,
    prompt: hint,
    resolution: meta.height >= 1000 ? '1080p' : '720p',
    outputPrefix: `reedit_optimized/${prefix}`,
    seed: Math.floor(Math.random() * 2147483647),
  })

  emit('queued_submit')
  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow, includeComfyOrgKey: true })
  } catch (err) {
    return { success: false, error: err.message }
  }
  emit('queued', { promptId })

  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 20 * 60 * 1000, pollMs: 4000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy job ${promptId} failed.` }
  }

  const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i
  let outFile = null
  for (const out of Object.values(result.outputs || {})) {
    for (const c of [...(out?.videos || []), ...(out?.gifs || []), ...(out?.images || [])]) {
      if (c?.filename && VIDEO_RE.test(c.filename)) { outFile = c; break }
    }
    if (outFile) break
  }
  if (!outFile) return { success: false, error: 'Kling Edit finished but reported no video output.' }

  emit('finalizing')
  const stagePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_raw.mp4`)
  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFile.filename, subfolder: outFile.subfolder || '', type: outFile.type || 'output',
      destPath: stagePath,
    })
  } catch (err) {
    return { success: false, error: `Could not download Kling Edit output: ${err.message}` }
  }
  // Normalise dims/fps back to the source and remux the original audio.
  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', stagePath,
      '-i', sourceClipPath,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-vf', `scale=${meta.width}:${meta.height}:flags=lanczos,setsar=1`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', finalPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg finalize failed (${code}): ${stderr.slice(-300)}`)))
    proc.on('error', reject)
  }).catch((err) => ({ success: false, error: err.message }))
  try { await fs.unlink(stagePath) } catch (_) { /* ignore */ }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, workflow, {
    kind: 'optimize-kling', version: versionTag, sceneId, modelId: adapter.id, promptId,
  })

  emit('done', { promptId, outputPath: finalPath, version: versionTag, inProjectDir: true, workflowJsonPath })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    workflowJsonPath,
    version: versionTag,
    inProjectDir: true,
    kind: 'optimize-kling',
    modelId: adapter.id,
  }
})

ipcMain.handle('analysis:commitReframe', async (event, options) => {
  const {
    sceneId, sourceVideoPath, projectDir,
    zoom, anchorX, anchorY,
    targetW, targetH,
    comfyUrl: comfyUrlOpt,
    apiKey: apiKeyOpt,
    upscaleModel: upscaleModelOpt,
  } = options || {}
  if (!sceneId) return { success: false, error: 'sceneId required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''
  // Fall back to the shipped default when the renderer didn't pass one;
  // older callers (before capability settings existed) omit the field.
  // Default to RealESRGAN_x4plus.pth — the one upscale model
  // universally bundled with ComfyUI (local + Cloud). The
  // capability-settings dropdown still lets a power user pick NMKD or
  // others, but only the canonical name works on stock Cloud images.
  const upscaleModel = upscaleModelOpt || 'RealESRGAN_x4plus.pth'

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:commitReframe:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting')

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Source clip not found at ${sourceClipPath}. The scene needs to have been captioned or optimized at least once so the cached sub-clip exists.` }
  }

  // Probe clip to know native dims + fps.
  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height || !meta?.fps) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }
  const srcW = meta.width
  const srcH = meta.height
  const fps = meta.fps
  // Output target. When the caller didn't supply explicit dims, bump
  // the result up to 4K (preserving the source aspect) if the source
  // is 1080p or smaller — that's what the upscale pass is here for in
  // the first place. Above 1080p we keep the native dims; the upscale
  // pass is still useful because we're undoing a ffmpeg pre-crop that
  // softens detail, even when not changing the final resolution.
  let outW = Math.round(Number(targetW) || srcW)
  let outH = Math.round(Number(targetH) || srcH)
  if (!targetW && !targetH && Math.max(srcW, srcH) <= 1920) {
    // Aspect-preserving fit-inside (3840×2160 box). The crop math below
    // re-derives crop from the chosen aspect, so feeding it a 4K-sized
    // target just means the upscale tail brings the pixel count up.
    const aspect = srcW / srcH
    if (aspect >= (3840 / 2160)) {
      outW = 3840
      outH = Math.round(3840 / aspect / 2) * 2  // even dims for h264
    } else {
      outH = 2160
      outW = Math.round(2160 * aspect / 2) * 2
    }
  }

  // Derive crop window from zoom + anchor. The cropped region is the
  // rectangle centered on (anchorX, anchorY) whose dimensions are the
  // source divided by zoom — pick the same aspect as the target so the
  // subsequent scale is a pure pixel rescale, no letterboxing.
  const zoomClamped = Math.max(1, Math.min(3, Number(zoom) || 1.2))
  // Keep the target aspect; width-limited or height-limited depending
  // on which of the two requires a smaller crop at the requested zoom.
  const targetAspect = outW / outH
  const srcAspect = srcW / srcH
  let cropW, cropH
  if (targetAspect >= srcAspect) {
    // Target is wider or equal — width is the limiting dimension.
    cropW = Math.round(srcW / zoomClamped)
    cropH = Math.round(cropW / targetAspect)
  } else {
    cropH = Math.round(srcH / zoomClamped)
    cropW = Math.round(cropH * targetAspect)
  }
  // Anchor defines the center of the crop in source coords. Clamp so
  // the crop stays fully inside the source frame.
  // Number() never yields null/undefined, so `?? 0.5` was dead and NaN
  // (missing anchor) leaked through the clamp. Check finiteness instead.
  const ax = Number(anchorX)
  const ay = Number(anchorY)
  const axClamped = Math.max(0, Math.min(1, Number.isFinite(ax) ? ax : 0.5))
  const ayClamped = Math.max(0, Math.min(1, Number.isFinite(ay) ? ay : 0.5))
  const cropCenterX = axClamped * srcW
  const cropCenterY = ayClamped * srcH
  let cropX = Math.round(cropCenterX - cropW / 2)
  let cropY = Math.round(cropCenterY - cropH / 2)
  cropX = Math.max(0, Math.min(srcW - cropW, cropX))
  cropY = Math.max(0, Math.min(srcH - cropH, cropY))

  emit('pre_cropping', { cropW, cropH, cropX, cropY, zoom: zoomClamped })

  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }
  // Scan existing R-tagged entries so the new output gets the next
  // free number. Runs with V-tagged VACE outputs are skipped — they
  // live in the same directory but don't compete for R slots.
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_R(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `R${String(nextVersion).padStart(2, '0')}`
  emit('note', { message: `Writing version ${versionTag}.` })

  // Pre-crop via ffmpeg: the output is already at the delivery aspect
  // but at a sub-frame resolution (since we zoomed in). ComfyUI will
  // upscale that back to delivery-quality in the next step. We write
  // straight into the project dir with a distinct `_pre_crop.mp4`
  // suffix so the commit is easy to inspect / debug.
  const preCropPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_pre_crop.mp4`)
  const cropExpr = `crop=${cropW}:${cropH}:${cropX}:${cropY}`
  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', sourceClipPath,
      '-vf', `${cropExpr},setsar=1`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', preCropPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg pre-crop failed (${code}): ${stderr.slice(-300)}`))
    })
    proc.on('error', reject)
  }).catch((err) => {
    throw err
  })

  emit('uploading')

  // Upload pre-crop to ComfyUI via /upload/image. Works on both local
  // (server writes into its input/ dir) and cloud (file is staged
  // remotely for the workflow).
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`
  let comfyInputName
  try {
    const up = await uploadFileToComfy({
      comfyUrl, apiKey,
      localFilePath: preCropPath,
      filename: `${prefix}_pre_crop.mp4`,
    })
    comfyInputName = up?.name || `${prefix}_pre_crop.mp4`
  } catch (err) {
    return { success: false, error: `Failed to upload pre-crop to ComfyUI: ${err.message}` }
  }

  emit('queued_submit')
  const outputPrefix = `reedit_optimized/${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`
  const workflow = buildUpscaleOnlyWorkflow({
    inputName: comfyInputName,
    outputPrefix,
    targetW: outW,
    targetH: outH,
    fps,
    upscaleModel,
  })

  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow: workflow })
  } catch (err) {
    return { success: false, error: err.message }
  }

  emit('queued', { promptId })

  // Wait for completion. Cap 20 min — upscale-only is fast (30-90s on
  // a 4070) but cloud queue waits can dilate the wall-clock time.
  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 20 * 60 * 1000,
      pollMs: 3000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy job ${promptId} failed.` }
  }

  // Pull the finished video via /view and drop it under .reedit/optimized/
  // R{NN}.mp4 so it joins the same stack as V-series outputs.
  let outFilename = null, outSubfolder = '', outType = 'output'
  for (const out of Object.values(result.outputs || {})) {
    const gifs = Array.isArray(out?.gifs) ? out.gifs : []
    for (const g of gifs) {
      if (g?.filename) {
        outFilename = g.filename
        outSubfolder = g.subfolder || ''
        outType = g.type || 'output'
        break
      }
    }
    if (outFilename) break
  }
  if (!outFilename) {
    return { success: false, error: 'Workflow completed but no video output was reported in history.' }
  }

  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFilename,
      subfolder: outSubfolder,
      type: outType,
      destPath: finalPath,
    })
  } catch (err) {
    emit('note', { message: `Could not download final (${err.message}).` })
    const workflowJsonPathFallback = await saveWorkflowAlongsideOutput(finalPath, workflow, {
      kind: 'reframe', version: versionTag, sceneId, modelId: 'realesrgan-upscale', promptId,
    })
    emit('done', { promptId, outputPath: null, remoteName: outFilename, version: versionTag, inProjectDir: false, workflowJsonPath: workflowJsonPathFallback })
    return { success: true, promptId, outputPath: null, remoteName: outFilename, workflowJsonPath: workflowJsonPathFallback, version: versionTag, inProjectDir: false, kind: 'reframe' }
  }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, workflow, {
    kind: 'reframe', version: versionTag, sceneId, modelId: 'realesrgan-upscale', promptId,
  })

  emit('done', { promptId, outputPath: finalPath, version: versionTag, inProjectDir: true, workflowJsonPath })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    workflowJsonPath,
    version: versionTag,
    inProjectDir: true,
    kind: 'reframe',
    preCropPath,
    cropInfo: { cropW, cropH, cropX, cropY, zoom: zoomClamped, anchorX: axClamped, anchorY: ayClamped },
  }
})

// ============================================
// Footage extend: add up to +2 s of AI-generated continuation to a shot
// ============================================
//
// Mirrors commitReframe in shape (starting → queued → running → done)
// but does image-to-video instead of upscale:
//   1. Extract the clip's last frame as a PNG (ffmpeg -sseof -0.05).
//   2. Upload the PNG to ComfyUI's input directory.
//   3. Submit the LTX 2.3 i2v workflow the renderer pre-patched with
//      duration / size / fps / prompt.
//   4. Poll /history until the tail clip is ready.
//   5. ffmpeg concat-demuxer the original sub-clip + the tail into a
//      single MP4 saved under .reedit/optimized/<sceneId>_E{NN}.mp4.
//   6. Reply with the version tag so the renderer can register the
//      E-tagged entry into the scene's optimization stack.
// ============================================
// Reframe by OUTPAINT — widen the canvas instead of cropping it
// ============================================
//
// The crop-reframe above can only remove pixels; this handler fills NEW
// canvas so 9:16 footage becomes true 16:9 (and vice versa). Two engines:
//   - 'luma-ray-3.2-reframe' (default): Comfy Cloud partner node, one
//     shot, ≤30 s source, output capped at 1080p.
//   - 'ltx-ic-local': the validated oumoumad IC-LoRA outpaint workflow
//     bundled at workflows/outpaint_ltx23_ic_api.json (see its _meta for
//     slots, pad presets and the 8k+1 frame quirk).
// Output is tagged O{NN} in .reedit/optimized/ and always carries the
// original clip's audio (outpaint engines return silent or re-encoded
// audio — we remux the source track over the result).
const OUTPAINT_LTX_WORKFLOW_PATH = path.resolve(__dirname, '..', 'workflows', 'outpaint_ltx23_ic_api.json')
const OUTPAINT_LTX_SLOTS = {
  LOAD_VIDEO: '5060',      // .inputs.video — input clip filename
  FIRST_FRAME: '2004',     // .inputs.image — first-frame stub PNG
  PROMPT: '2483',          // .inputs.text — scene description for the fill
  SEED: '4832',            // .inputs.noise_seed
  PAD: '5086',             // ImagePadKJ — left/right/top/bottom
}

function parseAspect(aspect) {
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(aspect || '').trim())
  if (!m) return null
  const w = Number(m[1]); const h = Number(m[2])
  if (!(w > 0) || !(h > 0)) return null
  return w / h
}

ipcMain.handle('analysis:commitReframeOutpaint', async (event, options) => {
  const {
    sceneId, projectDir, targetAspect, prompt,
    modelId: modelIdOpt,
    comfyUrl: comfyUrlOpt, apiKey: apiKeyOpt,
  } = options || {}
  if (!sceneId) return { success: false, error: 'sceneId required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const targetRatio = parseAspect(targetAspect)
  if (!targetRatio) return { success: false, error: `targetAspect must look like "16:9" (got "${targetAspect}").` }
  const modelId = String(modelIdOpt || 'luma-ray-3.2-reframe')
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:commitReframeOutpaint:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting', { modelId, targetAspect })

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Source clip not found at ${sourceClipPath}. Run captioning/optimization once so the cached sub-clip exists.` }
  }
  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height || !meta?.fps) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }
  const sourceRatio = meta.width / meta.height
  if (Math.abs(sourceRatio - targetRatio) < 0.01) {
    return { success: false, error: `Clip is already ${targetAspect} — nothing to outpaint.` }
  }

  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_O(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `O${String(nextVersion).padStart(2, '0')}`
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`
  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  const stagePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_raw.mp4`)
  emit('note', { message: `Writing version ${versionTag}.` })

  let workflow
  let partner = false
  let trimToSec = null

  if (modelId === 'ltx-ic-local') {
    // ---- Local LTX IC-LoRA outpaint ----
    let template
    try {
      template = JSON.parse(await fs.readFile(OUTPAINT_LTX_WORKFLOW_PATH, 'utf8'))
    } catch (err) {
      return { success: false, error: `Outpaint workflow JSON missing/unreadable at ${OUTPAINT_LTX_WORKFLOW_PATH}: ${err.message}` }
    }
    delete template._meta

    // LTX only generates 8k+1 frame counts and truncates DOWN otherwise
    // (see the workflow's _meta.frame_count_quirk). Pre-pad the clip by
    // cloning the last frame up to the next valid count, then trim the
    // result back to the source duration after download.
    const frames = Number(meta.nbFrames) || Math.round(meta.duration * meta.fps)
    const validFrames = frames % 8 === 1 ? frames : (Math.floor(frames / 8) + 1) * 8 + 1
    const padFrames = validFrames - frames
    let uploadClipPath = sourceClipPath
    if (padFrames > 0) {
      emit('note', { message: `Pre-padding ${padFrames} cloned frames (LTX 8k+1 quirk).` })
      uploadClipPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_padded.mp4`)
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats',
          '-i', sourceClipPath,
          '-vf', `tpad=stop_mode=clone:stop=${padFrames}`,
          '-an',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
          '-pix_fmt', 'yuv420p',
          '-y', uploadClipPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg tpad failed (${code}): ${stderr.slice(-300)}`)))
        proc.on('error', reject)
      }).catch((err) => ({ success: false, error: err.message }))
      trimToSec = meta.duration
    }

    // First-frame stub for the (bypassed) i2v branch.
    emit('extracting_reference')
    const stubPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_first.png`)
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, ['-hide_banner', '-nostats', '-i', sourceClipPath, '-frames:v', '1', '-q:v', '2', '-y', stubPath], { windowsHide: true })
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg first-frame failed (${code})`)))
      proc.on('error', reject)
    })

    emit('uploading')
    let clipName = `${prefix}_source.mp4`
    let stubName = `${prefix}_first.png`
    try {
      const upClip = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: uploadClipPath, filename: clipName })
      clipName = upClip?.name || clipName
      const upStub = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: stubPath, filename: stubName })
      stubName = upStub?.name || stubName
    } catch (err) {
      return { success: false, error: `Upload failed: ${err.message}` }
    }

    // Pad math: grow the canvas on the axis the target needs. The
    // workflow halves (source + pads) and snaps to /32 internally, so we
    // just need pads that produce the target ratio at full size.
    let padL = 0; let padR = 0; let padT = 0; let padB = 0
    if (targetRatio > sourceRatio) {
      const fullW = Math.round(meta.height * targetRatio)
      const total = Math.max(0, fullW - meta.width)
      padL = Math.floor(total / 2); padR = total - padL
    } else {
      const fullH = Math.round(meta.width / targetRatio)
      const total = Math.max(0, fullH - meta.height)
      padT = Math.floor(total / 2); padB = total - padT
    }

    workflow = template
    workflow[OUTPAINT_LTX_SLOTS.LOAD_VIDEO].inputs.video = clipName
    workflow[OUTPAINT_LTX_SLOTS.FIRST_FRAME].inputs.image = stubName
    workflow[OUTPAINT_LTX_SLOTS.PROMPT].inputs.text = String(prompt || 'the same scene, seamlessly extended — no text, no logos')
    workflow[OUTPAINT_LTX_SLOTS.SEED].inputs.noise_seed = Math.floor(Math.random() * 2147483647)
    Object.assign(workflow[OUTPAINT_LTX_SLOTS.PAD].inputs, { left: padL, right: padR, top: padT, bottom: padB })
  } else {
    // ---- Cloud adapter (Luma Ray 3.2 by default) ----
    const outpaintAdapter = getAdapter(modelId)
    if (!outpaintAdapter || outpaintAdapter.kind !== 'reframe-outpaint') {
      const available = listAdapters({ kind: 'reframe-outpaint' }).map((a) => a.id).concat('ltx-ic-local').join(', ')
      return { success: false, error: `Unknown outpaint model "${modelId}". Available: ${available}.` }
    }
    if (!isCloudComfyUrl(comfyUrl)) {
      return { success: false, error: `${outpaintAdapter.label} needs Comfy Cloud. Switch the ComfyUI mode to Cloud, or pick the local LTX engine.` }
    }
    const maxSrc = Number(outpaintAdapter.caps?.maxSourceSec) || 30
    if (meta.duration > maxSrc + 0.05) {
      return { success: false, error: `Clip is ${meta.duration.toFixed(1)}s — ${outpaintAdapter.label} accepts up to ${maxSrc}s.` }
    }
    emit('uploading')
    let clipName = `${prefix}_source.mp4`
    try {
      const up = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: sourceClipPath, filename: clipName })
      clipName = up?.name || clipName
    } catch (err) {
      return { success: false, error: `Upload failed: ${err.message}` }
    }
    workflow = outpaintAdapter.buildWorkflow({
      sourceVideoFilename: clipName,
      prompt,
      aspectRatio: targetAspect,
      resolution: '1080p',
      outputPrefix: `reedit_outpaint/${prefix}`,
      seed: Math.floor(Math.random() * 2147483647),
    })
    partner = Boolean(outpaintAdapter.partner)
  }

  emit('queued_submit')
  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow, includeComfyOrgKey: partner })
  } catch (err) {
    return { success: false, error: err.message }
  }
  emit('queued', { promptId })

  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 30 * 60 * 1000, pollMs: 3000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy job ${promptId} failed.` }
  }

  // Locate the output video (same key-shape zoo as commitExtend).
  const VIDEO_RE = /\.(mp4|mov|webm|mkv|avi|m4v)$/i
  let outFile = null
  for (const out of Object.values(result.outputs || {})) {
    for (const c of [...(out?.videos || []), ...(out?.gifs || []), ...(out?.images || [])]) {
      if (c?.filename && VIDEO_RE.test(c.filename)) { outFile = c; break }
    }
    if (outFile) break
  }
  if (!outFile) return { success: false, error: 'Workflow completed but reported no video output.' }

  emit('finalizing')
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFile.filename, subfolder: outFile.subfolder || '', type: outFile.type || 'output',
      destPath: stagePath,
    })
  } catch (err) {
    return { success: false, error: `Could not download outpaint output: ${err.message}` }
  }

  // Remux the ORIGINAL audio over the generated video (outpaint engines
  // return silent or re-encoded sound) and trim back to the source
  // duration when we pre-padded for the LTX frame quirk.
  await new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', stagePath,
      '-i', sourceClipPath,
      '-map', '0:v:0', '-map', '1:a:0?',
      ...(trimToSec ? ['-t', String(trimToSec)] : []),
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', finalPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg remux failed (${code}): ${stderr.slice(-300)}`)))
    proc.on('error', reject)
  }).catch((err) => ({ success: false, error: err.message }))
  try { await fs.unlink(stagePath) } catch (_) { /* ignore */ }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, workflow, {
    kind: 'reframe-outpaint', version: versionTag, sceneId, modelId, promptId, targetAspect,
  })

  emit('done', { promptId, outputPath: finalPath, version: versionTag, targetAspect, inProjectDir: true, workflowJsonPath, modelId })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    workflowJsonPath,
    version: versionTag,
    inProjectDir: true,
    kind: 'reframe-outpaint',
    targetAspect,
    modelId,
  }
})

ipcMain.handle('analysis:commitExtend', async (event, options) => {
  const {
    sceneId, projectDir, extendSec,
    workflow, loadImageNodeId, loadVideoNodeId,
    modelId,
    comfyUrl: comfyUrlOpt,
    apiKey: apiKeyOpt,
  } = options || {}
  if (!sceneId) return { success: false, error: 'sceneId required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  // Three execution modes depending on the model:
  //   - last-frame mode (LTX, base WAN): we extract one frame from the
  //     source clip and inject it into a LoadImage node; ComfyUI
  //     generates only the tail, we ffmpeg-concat it onto the original.
  //   - whole-clip mode (WAN SVI Pro): we upload the source MP4 and
  //     inject it into a LoadVideo node; the workflow itself emits the
  //     concatenated original+extended video — no concat in main.js.
  //   - adapter mode (cloud, e.g. Vidu Q2 Extend): the renderer passes
  //     only modelId; the adapter builds the graph around the uploaded
  //     source clip. True video-context extension, so the duration
  //     ceiling is higher than the 2 s drift-limit of last-frame i2v.
  const extendAdapter = modelId ? getAdapter(modelId) : null
  const isAdapterMode = Boolean(extendAdapter && extendAdapter.kind === 'extend')
  if (!isAdapterMode && (!workflow || typeof workflow !== 'object')) {
    return { success: false, error: 'workflow JSON required.' }
  }
  const isVideoInputMode = !isAdapterMode && Boolean(loadVideoNodeId) && !loadImageNodeId
  if (!isAdapterMode && !isVideoInputMode && !loadImageNodeId) {
    return { success: false, error: 'Either loadImageNodeId (LTX/WAN base) or loadVideoNodeId (SVI) is required.' }
  }
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''
  if (isAdapterMode && extendAdapter.mode === 'cloud' && !isCloudComfyUrl(comfyUrl)) {
    return { success: false, error: `${extendAdapter.label} needs Comfy Cloud. Switch the ComfyUI mode to Cloud in the launcher chip or Settings → ComfyUI.` }
  }
  // Per-model ceiling: cloud video-context extends tolerate more than
  // the 2 s cap that protects last-frame i2v from drifting.
  const maxExtend = isAdapterMode
    ? Math.min(5, Number(extendAdapter.caps?.maxDurationSec) || 5)
    : 2
  const wantExtendSec = Math.max(0.2, Math.min(maxExtend, Number(extendSec) || 1))

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:commitExtend:progress', { sceneId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting', { modelId, mode: isVideoInputMode ? 'svi-video-input' : 'image-input' })

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const sourceClipPath = path.join(projectDirFwd, '.reedit', 'clips', `${sceneId}.mp4`)
  try {
    const st = await fs.stat(sourceClipPath)
    if (!st || st.size < 1024) throw new Error('empty')
  } catch {
    return { success: false, error: `Source clip not found at ${sourceClipPath}. The scene needs to have been captioned or optimized at least once so the cached sub-clip exists.` }
  }

  const meta = await probeVideoMeta(sourceClipPath)
  if (!meta?.width || !meta?.height || !meta?.fps) {
    return { success: false, error: 'ffprobe failed to read clip metadata.' }
  }
  const fps = meta.fps

  const projectOptimizedDir = path.join(projectDirFwd, '.reedit', 'optimized')
  try { await fs.mkdir(projectOptimizedDir, { recursive: true }) } catch (_) { /* ignore */ }
  // Pick the next E{NN} slot without clobbering existing R/V entries.
  const existing = await fs.readdir(projectOptimizedDir).catch(() => [])
  const versionRe = new RegExp(`^${sceneId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}_E(\\d{2,})(?:[_.]|$)`)
  let nextVersion = 1
  for (const name of existing) {
    const m = name.match(versionRe)
    if (m) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n >= nextVersion) nextVersion = n + 1
    }
  }
  const versionTag = `E${String(nextVersion).padStart(2, '0')}`
  emit('note', { message: `Writing version ${versionTag}.` })

  emit('uploading')
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}_${versionTag}`

  // Patch the workflow with the right input filename. SVI/adapter modes
  // upload the source clip as a video; the other paths upload the last
  // frame as a PNG and let the workflow produce only the tail.
  let patchedWorkflow = isAdapterMode ? null : JSON.parse(JSON.stringify(workflow))
  let lastFrameLocalPath = null

  if (isAdapterMode) {
    // Cloud extend adapter — upload the source sub-clip, let the adapter
    // build the whole graph (it owns the node ids).
    let comfyInputName = `${prefix}_source.mp4`
    try {
      const up = await uploadFileToComfy({
        comfyUrl, apiKey,
        localFilePath: sourceClipPath,
        filename: comfyInputName,
      })
      comfyInputName = up?.name || comfyInputName
    } catch (err) {
      return { success: false, error: `Failed to upload source clip: ${err.message}` }
    }
    patchedWorkflow = extendAdapter.buildWorkflow({
      sourceVideoFilename: comfyInputName,
      prompt: options?.prompt || '',
      durationSec: Math.max(1, Math.ceil(wantExtendSec)),
      resolution: meta.height >= 1000 ? '1080p' : '720p',
      outputPrefix: `reedit_extend/${prefix}`,
      seed: Math.floor(Math.random() * 2147483647),
    })
  } else if (isVideoInputMode) {
    // SVI Pro path — upload the source sub-clip MP4 via /upload/image.
    let comfyInputName = `${prefix}_source.mp4`
    try {
      const up = await uploadFileToComfy({
        comfyUrl, apiKey,
        localFilePath: sourceClipPath,
        filename: comfyInputName,
      })
      comfyInputName = up?.name || comfyInputName
    } catch (err) {
      return { success: false, error: `Failed to upload source clip: ${err.message}` }
    }
    if (patchedWorkflow[loadVideoNodeId]?.inputs) {
      patchedWorkflow[loadVideoNodeId].inputs.video = comfyInputName
    } else {
      return { success: false, error: `Workflow has no node ${loadVideoNodeId} to inject the input video into.` }
    }
  } else {
    // LTX / WAN base — extract the last frame, upload as PNG.
    emit('extracting_last_frame')
    lastFrameLocalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_last_frame.png`)
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-nostats',
        '-sseof', '-0.05',
        '-i', sourceClipPath,
        '-frames:v', '1',
        '-q:v', '2',
        '-y', lastFrameLocalPath,
      ]
      const proc = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg last-frame extract failed (${code}): ${stderr.slice(-300)}`))
      })
      proc.on('error', reject)
    }).catch((err) => { throw err })

    let comfyInputName = `${prefix}_last_frame.png`
    try {
      const up = await uploadFileToComfy({
        comfyUrl, apiKey,
        localFilePath: lastFrameLocalPath,
        filename: comfyInputName,
      })
      comfyInputName = up?.name || comfyInputName
    } catch (err) {
      return { success: false, error: `Failed to upload last frame: ${err.message}` }
    }
    if (patchedWorkflow[loadImageNodeId]?.inputs) {
      patchedWorkflow[loadImageNodeId].inputs.image = comfyInputName
    } else {
      return { success: false, error: `Workflow has no node ${loadImageNodeId} to inject the input image into.` }
    }
  }

  emit('queued_submit')
  let promptId
  try {
    promptId = await queuePromptToComfy({
      comfyUrl, apiKey, workflow: patchedWorkflow,
      includeComfyOrgKey: Boolean(isAdapterMode && extendAdapter.partner),
    })
  } catch (err) {
    return { success: false, error: err.message }
  }

  emit('queued', { promptId })

  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 20 * 60 * 1000, pollMs: 3000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy job ${promptId} failed.` }
  }

  // Step 4 — find the generated tail MP4 in the history outputs.
  // ComfyUI's history packs MP4-style outputs under different keys
  // depending on the node implementation:
  //   - VHS_VideoCombine → `gifs`
  //   - SaveVideo (built-in LTX/WAN) → `videos` OR `images` (the
  //     filename ending in .mp4 lands in `images` in some builds)
  // We only accept files with video extensions — without this filter
  // a `PreviewImage` node (e.g. SVI's anchor-frame preview at node
  // 311) would land first in the iteration and we'd return its PNG
  // as the "output", which the renderer then can't play.
  const VIDEO_RE = /\.(mp4|mov|webm|mkv|gif|avi|m4v)$/i
  const isVideoFile = (filename) => VIDEO_RE.test(String(filename || ''))
  let tailOutFilename = null
  let tailOutSubfolder = ''
  let tailOutType = 'output'
  for (const out of Object.values(result.outputs || {})) {
    const candidates = [
      ...(Array.isArray(out?.videos) ? out.videos : []),
      ...(Array.isArray(out?.gifs) ? out.gifs : []),
      ...(Array.isArray(out?.images) ? out.images : []),
    ]
    for (const c of candidates) {
      // Skip preview images / non-video outputs.
      if (!c?.filename) continue
      if (!isVideoFile(c.filename)) continue
      tailOutFilename = c.filename
      tailOutSubfolder = c.subfolder || ''
      tailOutType = c.type || 'output'
      break
    }
    if (tailOutFilename) break
  }

  if (!tailOutFilename) {
    return {
      success: false,
      error: `Workflow completed but no video output was reported in history. Check ComfyUI's output dir for a file matching ${sceneId}_${versionTag}* and re-run if it isn't there.`,
    }
  }

  emit('finalizing')
  const finalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}.mp4`)
  let tailLocalPath = null

  if (isAdapterMode) {
    // Cloud extend output shape isn't fixed across providers: it may be
    // the full original+extension or only the generated continuation.
    // Probe the duration and pick full-video vs concat accordingly.
    const stagePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_cloud_raw.mp4`)
    try {
      await downloadFromComfy({
        comfyUrl, apiKey,
        filename: tailOutFilename,
        subfolder: tailOutSubfolder,
        type: tailOutType,
        destPath: stagePath,
      })
    } catch (err) {
      return { success: false, error: `Could not download cloud extend output: ${err.message}` }
    }
    const outMeta = await probeVideoMeta(stagePath)
    const sourceDur = Number(meta.duration) || 0
    const outDur = Number(outMeta?.duration) || 0
    const looksLikeFullVideo = sourceDur > 0 && outDur >= sourceDur + wantExtendSec * 0.5
    emit('note', { message: `Cloud extend returned ${outDur.toFixed(2)}s (source ${sourceDur.toFixed(2)}s) → ${looksLikeFullVideo ? 'full video' : 'tail, concatenating'}.` })
    const pieces = looksLikeFullVideo ? [stagePath] : [sourceClipPath, stagePath]
    const listFilePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_concat.txt`)
    const toListLine = (p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    await fs.writeFile(listFilePath, pieces.map(toListLine).join('\n') + '\n', 'utf8')
    // Normalise dims/fps to the source in the same pass — cloud outputs
    // regularly come back at a different resolution.
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-nostats',
        '-f', 'concat', '-safe', '0',
        '-i', listFilePath,
        '-vf', `scale=${meta.width}:${meta.height}:flags=lanczos,setsar=1,fps=${meta.fps}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y', finalPath,
      ]
      const proc = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg finalize failed (${code}): ${stderr.slice(-300)}`))
      })
      proc.on('error', reject)
    }).catch((err) => { throw err })
    try { await fs.unlink(listFilePath) } catch (_) { /* ignore */ }
    try { await fs.unlink(stagePath) } catch (_) { /* ignore */ }
  } else if (isVideoInputMode) {
    // SVI Pro mode: ComfyUI already emitted the concatenated
    // original+extended video. Probe the output dims and, if they
    // don't match the source exactly (the workflow's
    // ImageResizeKJv2 rounds to multiples of 8/16 for VAE alignment,
    // so a 1920×1080 source typically comes out 1920×1080 or
    // 1920×1072), ffmpeg-rescale the whole video to the source's
    // dimensions. Without this the visible original→extended seam
    // shows a small but jarring height/width jump.
    const sviStagePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_svi_raw.mp4`)
    try {
      await downloadFromComfy({
        comfyUrl, apiKey,
        filename: tailOutFilename,
        subfolder: tailOutSubfolder,
        type: tailOutType,
        destPath: sviStagePath,
      })
    } catch (err) {
      return { success: false, error: `Could not download ComfyUI SVI output: ${err.message}` }
    }
    const sviMeta = await probeVideoMeta(sviStagePath)
    const dimsMatch = sviMeta?.width === meta.width && sviMeta?.height === meta.height
    if (dimsMatch) {
      // Already exact — just rename to the final path so we don't
      // leave the staging file behind.
      try {
        await fs.rename(sviStagePath, finalPath)
      } catch (_) {
        // Fallback to copy + best-effort delete.
        await copyFileOverwrite(sviStagePath, finalPath)
        try { await fs.unlink(sviStagePath) } catch (_) { /* ignore */ }
      }
    } else {
      // Re-encode with explicit scale to source dims. CRF 18 is
      // visually lossless for this kind of small dimension fix.
      emit('note', { message: `SVI output ${sviMeta?.width || '?'}×${sviMeta?.height || '?'} → rescaling to source ${meta.width}×${meta.height}` })
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats',
          '-i', sviStagePath,
          '-vf', `scale=${meta.width}:${meta.height}:flags=lanczos,setsar=1`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-y', finalPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg rescale failed (${code}): ${stderr.slice(-300)}`))
        })
        proc.on('error', reject)
      }).catch((err) => { throw err })
      try { await fs.unlink(sviStagePath) } catch (_) { /* ignore */ }
    }
  } else {
    // LTX / WAN base mode: ComfyUI gave us only the tail. Concat it
    // onto the source sub-clip with the demuxer.
    tailLocalPath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_tail.mp4`)
    try {
      await downloadFromComfy({
        comfyUrl, apiKey,
        filename: tailOutFilename,
        subfolder: tailOutSubfolder,
        type: tailOutType,
        destPath: tailLocalPath,
      })
    } catch (err) {
      return { success: false, error: `Could not download ComfyUI tail output: ${err.message}` }
    }
    const listFilePath = path.join(projectOptimizedDir, `${sceneId}_${versionTag}_concat.txt`)
    const toListLine = (p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    const listBody = `${toListLine(sourceClipPath)}\n${toListLine(tailLocalPath)}\n`
    await fs.writeFile(listFilePath, listBody, 'utf8')
    await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-nostats',
        '-f', 'concat', '-safe', '0',
        '-i', listFilePath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        '-y', finalPath,
      ]
      const proc = spawn(ffmpegPath, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg concat failed (${code}): ${stderr.slice(-300)}`))
      })
      proc.on('error', reject)
    }).catch((err) => { throw err })
    try { await fs.unlink(listFilePath) } catch (_) { /* ignore */ }
  }

  const workflowJsonPath = await saveWorkflowAlongsideOutput(finalPath, patchedWorkflow, {
    kind: 'extend', version: versionTag, sceneId, modelId: modelId || null, promptId,
  })

  emit('done', { promptId, outputPath: finalPath, version: versionTag, extendSec: wantExtendSec, inProjectDir: true, workflowJsonPath, modelId })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    workflowJsonPath,
    version: versionTag,
    inProjectDir: true,
    kind: 'extend',
    extendSec: wantExtendSec,
    tailPath: tailLocalPath,
    lastFramePath: lastFrameLocalPath,
    modelId: modelId || null,
  }
})

// ============================================
// Additional assets — import + probe
// ============================================
//
// Files the user drops on the "Additional material" section in Import
// (extra footage, graphics, music, voiceover) get copied into
// `<projectDir>/.reedit/additional/<category>/<sanitized-filename>` so
// the project stays portable. The handler probes media metadata so the
// renderer can show duration / dims / codec without re-decoding.
ipcMain.handle('import:additionalAsset', async (event, options) => {
  const { sourcePath, category, projectDir } = options || {}
  if (!sourcePath) return { success: false, error: 'sourcePath required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const allowed = new Set(['extraFootage', 'graphics', 'music', 'voiceover'])
  if (!allowed.has(category)) {
    return { success: false, error: `Unknown category "${category}". Expected one of: ${[...allowed].join(', ')}.` }
  }
  try {
    const st = await fs.stat(sourcePath)
    if (!st.isFile()) return { success: false, error: 'Source path is not a file.' }
  } catch (err) {
    return { success: false, error: `Source file unreadable: ${err.message}` }
  }

  const ext = path.extname(sourcePath).toLowerCase()
  const baseName = path.basename(sourcePath, ext)
  // Sanitise the name and de-dup if the same filename was already
  // imported (rare — most additional-material drops are unique — but
  // would otherwise silently overwrite an earlier entry).
  const sanitized = sanitizeForFilename(baseName, 80)
  const destDir = path.join(projectDir.replace(/\\/g, '/'), '.reedit', 'additional', category)
  try { await fs.mkdir(destDir, { recursive: true }) } catch (err) {
    return { success: false, error: `Could not create destination dir: ${err.message}` }
  }
  let destPath = path.join(destDir, `${sanitized}${ext}`)
  let suffix = 1
  while (true) {
    try {
      await fs.access(destPath)
      destPath = path.join(destDir, `${sanitized}_${suffix}${ext}`)
      suffix++
    } catch {
      break // does not exist — safe to write here
    }
  }

  try {
    await copyFileOverwrite(sourcePath, destPath)
  } catch (err) {
    return { success: false, error: `Copy failed: ${err.message}` }
  }

  // Probe metadata. For video / audio we use ffprobe; for images we
  // skip the probe and let the renderer's <img> element discover dims
  // on first paint. Failures are non-fatal — the entry still imports.
  const isVideo = ['extraFootage'].includes(category)
  const isAudio = ['music', 'voiceover'].includes(category)
  let meta = { duration: null, width: null, height: null, fps: null, hasAudio: null, videoCodec: null, audioCodec: null }
  if (isVideo) {
    const probed = await probeVideoMeta(destPath)
    if (probed) {
      meta.duration = probed.duration
      meta.width = probed.width
      meta.height = probed.height
      meta.fps = probed.fps
    }
    // Re-probe via the broader audio-aware ffprobe to capture hasAudio.
    try {
      const dur = await probeAudioDuration(destPath)
      if (Number.isFinite(dur) && !meta.duration) meta.duration = dur
    } catch (_) { /* ignore */ }
  } else if (isAudio) {
    try {
      const dur = await probeAudioDuration(destPath)
      if (Number.isFinite(dur)) meta.duration = dur
    } catch (_) { /* ignore */ }
  }

  return {
    success: true,
    asset: {
      id: `add-${category}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: path.basename(destPath),
      originalName: path.basename(sourcePath),
      path: destPath,
      category,
      mime: ext.replace(/^\./, ''),
      ...meta,
      importedAt: new Date().toISOString(),
    },
  }
})

// Delete an additional asset's underlying file. Caller is responsible
// for also removing the entry from `project.additionalAssets`.
ipcMain.handle('import:deleteAdditionalAsset', async (event, options) => {
  const { assetPath } = options || {}
  if (!assetPath) return { success: false, error: 'assetPath required.' }
  try {
    await fs.unlink(assetPath)
    return { success: true }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: true } // already gone
    return { success: false, error: err.message }
  }
})

// ============================================
// Voiceover synthesis (F5-TTS via ComfyUI)
// ============================================
//
// Renderer hands us a draftId + the script segments (text only) + a
// reference window (start/end seconds + transcript) carved from the
// original Demucs vocals stem. We:
//   1. Extract the reference WAV from the stem at the requested range
//      (ffmpeg, mono 24kHz — what F5-TTS expects).
//   2. Upload it + a paired .txt file (the EXACT transcript Gemini
//      produced) into ComfyUI's input dir.
//   3. For each segment, queue an F5TTSAudio→SaveAudio workflow that
//      synthesises that line. Run them in series — F5-TTS holds the
//      model in VRAM after the first job, so back-to-back is fast.
//   4. After each job, copy the FLAC ComfyUI wrote into our project
//      under .reedit/vo_generated/<draftId>/<segId>.wav (re-encode to
//      WAV via ffmpeg so the renderer's <audio> element handles it).
//
// Progress events fire after every stage so the UI can show "rendering
// segment 3/5" with the segment label.
ipcMain.handle('analysis:synthesizeVoiceover', async (event, options) => {
  const {
    draftId,
    projectDir,
    segments,
    voiceRef,
    language = 'en',
    // Voice source mode:
    //   'clone' (default) — F5-TTS clones the speaker from voiceRef
    //   'kokoro' — Kokoro-TTS synthesises with a named voice id; voiceRef
    //              is ignored, the only required extra is `kokoroVoice`.
    voiceMode = 'clone',
    // Kokoro voice id (e.g. 'af_bella', 'am_adam'). Required when
    // voiceMode === 'kokoro'. The display-language (English / Spanish /
    // etc.) is derived from the id's first letter — no extra param needed.
    kokoroVoice = null,
    // Advanced F5-TTS knobs surfaced from the renderer. Defaults match
    // the model's recommended settings; the panel exposes them as a
    // small "Advanced" row.
    nfeSteps = 32,    // 16-64 useful range; higher = sharper / slower
    speed = 1.0,       // 0.85 fast … 1.0 default … 1.2 slower / more deliberate
    comfyUrl: comfyUrlOpt,
    apiKey: apiKeyOpt,
  } = options || {}
  if (!draftId) return { success: false, error: 'draftId required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  if (!Array.isArray(segments) || segments.length === 0) return { success: false, error: 'segments[] required.' }
  // Mode-specific validation. Clone needs a reference window; Kokoro
  // needs a voice id only.
  const isKokoro = voiceMode === 'kokoro'
  if (isKokoro) {
    if (!kokoroVoice || typeof kokoroVoice !== 'string') {
      return { success: false, error: 'kokoroVoice id required (e.g. "af_bella") when voiceMode="kokoro".' }
    }
  } else {
    if (!voiceRef || !voiceRef.audioPath) return { success: false, error: 'voiceRef.audioPath required (path to the source VO stem).' }
    if (!Number.isFinite(voiceRef.startSec) || !Number.isFinite(voiceRef.endSec) || voiceRef.endSec <= voiceRef.startSec) {
      return { success: false, error: 'voiceRef.startSec / endSec must be valid and endSec > startSec.' }
    }
    if (!voiceRef.transcript || !String(voiceRef.transcript).trim()) {
      return { success: false, error: 'voiceRef.transcript required (exact spoken text of the reference window).' }
    }
  }
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:synthesizeVoiceover:progress', { draftId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting', { totalSegments: segments.length, voiceMode })

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const draftDir = path.join(projectDirFwd, '.reedit', 'vo_generated', sanitizeForFilename(draftId, 60))
  try { await fs.mkdir(draftDir, { recursive: true }) } catch (err) {
    return { success: false, error: `Could not create output dir: ${err.message}` }
  }

  // Reference extract + upload only runs for clone mode. Kokoro skips
  // straight to per-segment synthesis with the chosen voice id.
  let referenceFilename = null
  if (!isKokoro) {
    // Stage 1: extract the reference WAV. F5-TTS works best with a mono
    // 24 kHz / 16-bit clip; transcoding here also strips any DC offset
    // from the Demucs output and ensures the file is small enough to
    // upload (a 12 s mono 24kHz WAV is under 600 KB).
    emit('extracting_reference', {
      startSec: Number(voiceRef.startSec).toFixed(2),
      endSec: Number(voiceRef.endSec).toFixed(2),
    })
    const refWavLocalPath = path.join(draftDir, '_voice_ref.wav')
    const refTxtLocalPath = path.join(draftDir, '_voice_ref.txt')
    const refDuration = Number(voiceRef.endSec) - Number(voiceRef.startSec)
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats', '-y',
          '-ss', String(Number(voiceRef.startSec).toFixed(3)),
          '-t', String(refDuration.toFixed(3)),
          '-i', voiceRef.audioPath,
          '-ac', '1',
          '-ar', '24000',
          '-c:a', 'pcm_s16le',
          refWavLocalPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg reference extract failed (${code}): ${stderr.slice(-300)}`))
        })
        proc.on('error', reject)
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
    try {
      await fs.writeFile(refTxtLocalPath, String(voiceRef.transcript).trim(), 'utf-8')
    } catch (err) {
      return { success: false, error: `Could not write reference transcript: ${err.message}` }
    }

    // Stage 2: upload the reference pair to ComfyUI via /upload/image.
    // F5TTSAudioAdvanced's `sample` input takes a filename that lives in
    // ComfyUI's input/ dir; /upload/image accepts arbitrary file types
    // despite the name and stages them in input/ on local, or under the
    // job's input space on cloud — same workflow JSON works for both.
    emit('uploading_reference')
    const refBaseName = `reedit_voref_${sanitizeForFilename(draftId, 40)}`
    try {
      const wavUp = await uploadFileToComfy({
        comfyUrl, apiKey,
        localFilePath: refWavLocalPath,
        filename: `${refBaseName}.wav`,
      })
      await uploadFileToComfy({
        comfyUrl, apiKey,
        localFilePath: refTxtLocalPath,
        filename: `${refBaseName}.txt`,
      })
      referenceFilename = wavUp?.name || `${refBaseName}.wav`
    } catch (err) {
      return { success: false, error: `Failed to upload reference pair to ComfyUI: ${err.message}` }
    }
  }

  // Stage 3: synthesise each segment in series. F5TTSAudio caches the
  // model in VRAM between calls so back-to-back jobs run in 2-4 s once
  // the first finishes (~10-20 s including model load).
  const segmentAudio = {}
  const VIDEO_AUDIO_RE = /\.(wav|flac|mp3|ogg|m4a|opus)$/i
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (!seg?.id || !seg?.text || !String(seg.text).trim()) {
      emit('segment_skipped', { index: i + 1, total: segments.length, segId: seg?.id, reason: 'empty text' })
      continue
    }
    emit('segment_starting', { index: i + 1, total: segments.length, segId: seg.id, role: seg.role || 'line' })

    const filenamePrefix = `reedit_vo_${sanitizeForFilename(draftId, 30)}/${sanitizeForFilename(seg.id, 30)}`
    const seed = Math.floor(Math.random() * 1e9)
    const safeSpeed = Math.max(0.7, Math.min(1.4, Number(speed) || 1.0))

    let segmentWorkflow
    let saveNodeId
    if (isKokoro) {
      // Kokoro path — KokoroSpeaker (id → embedding) → KokoroGenerator
      // (text + speaker + speed + lang) → SaveAudio. The Kokoro voice
      // id's first letter encodes language: a=american, b=british,
      // j=japanese, z=mandarin, e=spanish, f=french, h=hindi, i=italian,
      // p=brazilian portuguese. We map that to the display-name string
      // the node expects ("English", "Spanish", etc.).
      const KOKORO_LANG_BY_PREFIX = {
        a: 'English',
        b: 'English (British)',
        j: 'Japanese',
        z: 'Mandarin Chinese',
        e: 'Spanish',
        f: 'French',
        h: 'Hindi',
        i: 'Italian',
        p: 'Brazilian Portuguese',
      }
      const prefix = String(kokoroVoice).charAt(0).toLowerCase()
      const kokoroLang = KOKORO_LANG_BY_PREFIX[prefix] || 'English'
      const SPEAKER_ID = '1'
      const GENERATOR_ID = '2'
      const SAVE_ID = '3'
      segmentWorkflow = {
        [SPEAKER_ID]: {
          class_type: 'KokoroSpeaker',
          inputs: { speaker_name: kokoroVoice },
        },
        [GENERATOR_ID]: {
          class_type: 'KokoroGenerator',
          inputs: {
            text: String(seg.text).trim(),
            speaker: [SPEAKER_ID, 0],
            speed: safeSpeed,
            lang: kokoroLang,
          },
        },
        [SAVE_ID]: {
          class_type: 'SaveAudio',
          inputs: {
            audio: [GENERATOR_ID, 0],
            filename_prefix: filenamePrefix,
          },
        },
      }
      saveNodeId = SAVE_ID
    } else {
      // F5-TTS clone path. Kept inline (no shared helper) so main.js
      // stays self-contained.
      const F5_LANGUAGE_MODELS = {
        en: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
        zh: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
        es: { model: 'F5-ES', model_type: 'F5TTS_Base' },
        fr: { model: 'F5-FR', model_type: 'F5TTS_Base' },
        de: { model: 'F5-DE', model_type: 'F5TTS_Base' },
        it: { model: 'F5-IT', model_type: 'F5TTS_Base' },
        ja: { model: 'F5-JP', model_type: 'F5TTS_Base' },
        pt: { model: 'F5v1', model_type: 'F5TTS_v1_Base' },
      }
      const langModel = F5_LANGUAGE_MODELS[language] || F5_LANGUAGE_MODELS.en
      // Clamp NFE — 16 is the practical floor before audio degrades;
      // 64 is the practical ceiling before quality returns plateau.
      const safeNfe = Math.max(16, Math.min(64, Math.round(Number(nfeSteps) || 32)))
      const F5_AUDIO_NODE_ID = '1'
      const F5_SAVE_NODE_ID = '2'
      segmentWorkflow = {
        [F5_AUDIO_NODE_ID]: {
          class_type: 'F5TTSAudioAdvanced',
          inputs: {
            sample: referenceFilename,
            speech: String(seg.text).trim(),
            seed,
            model: langModel.model,
            vocoder: 'auto',
            speed: safeSpeed,
            model_type: langModel.model_type,
            nfe_step: safeNfe,
          },
        },
        [F5_SAVE_NODE_ID]: {
          class_type: 'SaveAudio',
          inputs: {
            audio: [F5_AUDIO_NODE_ID, 0],
            filename_prefix: filenamePrefix,
          },
        },
      }
      saveNodeId = F5_SAVE_NODE_ID
    }

    let promptId
    try {
      promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow: segmentWorkflow })
    } catch (err) {
      return { success: false, error: err.message }
    }

    // Wait for completion via the shared poller (handles local /history
    // and cloud /api/job/<id>/status under the same call).
    const startedAt = Date.now()
    let resultEntry
    try {
      resultEntry = await waitForComfyJob({
        comfyUrl, apiKey, promptId,
        timeoutMs: 5 * 60 * 1000,
        pollMs: 1500,
        onTick: () => emit('segment_running', { segId: seg.id, elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
      })
    } catch (err) {
      return { success: false, error: err?.message || `Comfy job for segment "${seg.id}" failed.` }
    }

    // Extract the saved audio reference from the history outputs.
    // SaveAudio emits under `audio` in newer ComfyUI; fall back to
    // `images` / `gifs` and filter by extension as we do for the video
    // flows.
    let savedFilename = null
    let savedSubfolder = ''
    let savedType = 'output'
    for (const out of Object.values(resultEntry.outputs || {})) {
      const candidates = [
        ...(Array.isArray(out?.audio) ? out.audio : []),
        ...(Array.isArray(out?.images) ? out.images : []),
        ...(Array.isArray(out?.gifs) ? out.gifs : []),
      ]
      for (const c of candidates) {
        if (!c?.filename) continue
        if (!VIDEO_AUDIO_RE.test(c.filename)) continue
        savedFilename = c.filename
        savedSubfolder = c.subfolder || ''
        savedType = c.type || 'output'
        break
      }
      if (savedFilename) break
    }
    if (!savedFilename) {
      return { success: false, error: `Could not locate output audio in ComfyUI history for segment "${seg.id}".` }
    }

    // Download the rendered audio via /view (302-redirected signed URL
    // on cloud; direct file on local). Keep the original extension when
    // staging so the subsequent ffmpeg transcode reads it correctly.
    const stagedRawPath = path.join(draftDir, `_${seg.id}_raw${path.extname(savedFilename) || '.flac'}`)
    try {
      await downloadFromComfy({
        comfyUrl, apiKey,
        filename: savedFilename,
        subfolder: savedSubfolder,
        type: savedType,
        destPath: stagedRawPath,
      })
    } catch (err) {
      return { success: false, error: `Could not download segment "${seg.id}" audio: ${err.message}` }
    }

    // Convert whatever F5/SaveAudio emitted (FLAC by default) into a
    // PCM WAV under the project — keeps downstream playback / ffmpeg
    // pipelines simple. Also probes duration for the UI / placer.
    const finalWavPath = path.join(draftDir, `${seg.id}.wav`)
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats', '-y',
          '-i', stagedRawPath,
          '-ac', '1',
          '-ar', '24000',
          '-c:a', 'pcm_s16le',
          finalWavPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg WAV transcode failed (${code}): ${stderr.slice(-300)}`))
        })
        proc.on('error', reject)
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
    try { await fs.unlink(stagedRawPath) } catch (_) { /* non-fatal */ }
    let durationSec = null
    try {
      const meta = await probeAudioDuration(finalWavPath)
      if (Number.isFinite(meta)) durationSec = meta
    } catch (_) { /* non-fatal */ }

    segmentAudio[seg.id] = {
      path: finalWavPath,
      durationSec,
      seed,
    }
    emit('segment_done', { index: i + 1, total: segments.length, segId: seg.id, path: finalWavPath, durationSec })
  }

  // Stage 4 — concat the per-segment WAVs into one continuous track,
  // inserting `gapBeforeSec` of silence before each segment. The
  // timeline places this single asset on the audio track instead of N
  // small clips — cleaner waveform, fewer clip boundaries to drag
  // around, and the program audio mix doesn't have to thread N gaps.
  // We keep the per-segment WAVs around for inline preview in the panel.
  let combinedAudioPath = null
  let combinedDurationSec = null
  const orderedSegs = segments.filter((s) => segmentAudio[s.id])
  if (orderedSegs.length > 0) {
    emit('combining')
    combinedAudioPath = path.join(draftDir, `${sanitizeForFilename(draftId, 40)}_combined.wav`)
    // Build an ffmpeg concat list with anullsrc-padded silence per gap.
    // Simpler approach: use the `concat` filter with all segment streams
    // + a generated silent stream per gap, all at 24 kHz mono PCM.
    const inputs = []
    const filterParts = []
    let nextStreamIdx = 0
    let runningDurSec = 0
    for (let i = 0; i < orderedSegs.length; i++) {
      const seg = orderedSegs[i]
      const audio = segmentAudio[seg.id]
      const gap = Math.max(0, Number(seg.gapBeforeSec) || 0)
      if (gap > 0) {
        // Silent input via lavfi — fixed duration, mono 24 kHz.
        inputs.push('-f', 'lavfi', '-t', gap.toFixed(3), '-i', 'anullsrc=channel_layout=mono:sample_rate=24000')
        filterParts.push(`[${nextStreamIdx}:a]`)
        nextStreamIdx++
        runningDurSec += gap
      }
      inputs.push('-i', audio.path)
      filterParts.push(`[${nextStreamIdx}:a]`)
      nextStreamIdx++
      runningDurSec += Number(audio.durationSec) || 0
    }
    const filterComplex = `${filterParts.join('')}concat=n=${filterParts.length}:v=0:a=1[out]`
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats', '-y',
          ...inputs,
          '-filter_complex', filterComplex,
          '-map', '[out]',
          '-ac', '1',
          '-ar', '24000',
          '-c:a', 'pcm_s16le',
          combinedAudioPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg concat failed (${code}): ${stderr.slice(-300)}`))
        })
        proc.on('error', reject)
      })
      combinedDurationSec = await probeAudioDuration(combinedAudioPath).catch(() => runningDurSec)
    } catch (err) {
      // Non-fatal — the per-segment files still exist, the placer can
      // fall back to N-clips placement if combinedAudioPath is null.
      emit('combine_warn', { message: err.message })
      combinedAudioPath = null
    }
  }

  emit('done', { segmentCount: Object.keys(segmentAudio).length, hasCombined: Boolean(combinedAudioPath) })
  return {
    success: true,
    segmentAudio,
    combinedAudioPath,
    combinedDurationSec,
    // voiceRef echo only makes sense for the clone path — Kokoro uses
    // a named voice id with no extracted reference. Returning null on
    // the kokoro side keeps the renderer's persistence call schemaless.
    voiceRef: isKokoro ? null : {
      audioPath: path.join(projectDirFwd, '.reedit', 'vo_generated', sanitizeForFilename(draftId, 60), '_voice_ref.wav'),
      transcript: voiceRef.transcript,
      startSec: voiceRef.startSec,
      endSec: voiceRef.endSec,
    },
  }
})

// Lightweight probe: asks ffprobe for an audio file's duration in
// seconds. Used by the synth handler to populate UI durations.
async function probeAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr.slice(-200)}`))
      const dur = parseFloat(stdout.trim())
      resolve(Number.isFinite(dur) ? dur : null)
    })
    proc.on('error', reject)
  })
}

// ============================================
// Music generation (ACE-Step 1.5 via ComfyUI)
// ============================================
//
// Renderer hands us a draftId + a tags prompt (genre / instruments /
// mood) + optional lyrics + duration / language / key / bpm. We:
//   1. Build the ACE-Step 1.5 split-4b workflow as API JSON — same
//      graph as the comfy-core template (UNETLoader → DualCLIPLoader
//      → TextEncodeAceStepAudio1.5 → KSampler → VAEDecodeAudio →
//      SaveAudioMP3).
//   2. Submit + poll /history.
//   3. Locate the saved MP3 in ComfyUI's output dir, copy into
//      `<projectDir>/.reedit/music_generated/<draftId>.mp3`, probe
//      its duration, return the path.
//
// Models required (the user's ComfyUI must have them or auto-download
// must be enabled):
//   - models/diffusion_models/acestep_v1.5_turbo.safetensors
//   - models/vae/ace_1.5_vae.safetensors
//   - models/text_encoders/qwen_0.6b_ace15.safetensors
//   - models/text_encoders/qwen_4b_ace15.safetensors
ipcMain.handle('analysis:synthesizeMusic', async (event, options) => {
  const {
    draftId,
    projectDir,
    tags,
    lyrics = '',
    durationSec = 30,
    bpm = 120,
    language = 'en',
    keyscale = 'C major',
    timesignature = '4',
    cfgScale = 2.0,
    temperature = 0.85,
    topP = 0.9,
    seed: seedOpt,
    comfyUrl: comfyUrlOpt,
    apiKey: apiKeyOpt,
  } = options || {}
  if (!draftId) return { success: false, error: 'draftId required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  if (!tags || !String(tags).trim()) return { success: false, error: 'tags (genre/style prompt) required.' }
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:synthesizeMusic:progress', { draftId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting')

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const outDir = path.join(projectDirFwd, '.reedit', 'music_generated')
  try { await fs.mkdir(outDir, { recursive: true }) } catch (err) {
    return { success: false, error: `Could not create music output dir: ${err.message}` }
  }

  const seed = Number.isFinite(Number(seedOpt))
    ? Math.floor(Number(seedOpt))
    : Math.floor(Math.random() * 1e9)
  // ACE-Step's max useful duration is ~240 s; clamp to a sane range.
  const safeDuration = Math.max(4, Math.min(240, Number(durationSec) || 30))
  // ACE-Step was trained almost exclusively on full songs (the
  // template default is 120 s). When you ask for 10-30 s the model
  // collapses into a fade-out / outro early, leaving the back half
  // mostly silent. Fix: synth at a longer internal duration that
  // sits inside the training distribution, then trim with ffmpeg to
  // the exact duration the user asked for. min(60, target * 1.5)
  // covers the short-clip case while keeping render time bounded.
  const internalDuration = Math.max(60, Math.min(240, safeDuration * 1.5))
  const filenamePrefix = `reedit_music/${sanitizeForFilename(draftId, 60)}`

  // Build the API-format workflow. Node ids are 1..N in topological
  // order. Mirrors the comfy-core "audio_ace_step_1_5_split_4b"
  // template but trimmed to what's needed for inference (no
  // PrimitiveNodes, no MarkdownNote, etc.).
  const workflow = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: 'acestep_v1.5_turbo.safetensors', weight_dtype: 'default' },
    },
    '2': {
      class_type: 'VAELoader',
      inputs: { vae_name: 'ace_1.5_vae.safetensors' },
    },
    '3': {
      class_type: 'DualCLIPLoader',
      inputs: {
        clip_name1: 'qwen_0.6b_ace15.safetensors',
        clip_name2: 'qwen_4b_ace15.safetensors',
        type: 'ace',
        device: 'default',
      },
    },
    '4': {
      class_type: 'ModelSamplingAuraFlow',
      inputs: { model: ['1', 0], shift: 3 },
    },
    '5': {
      class_type: 'EmptyAceStep1.5LatentAudio',
      inputs: { seconds: internalDuration, batch_size: 1 },
    },
    '6': {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['3', 0],
        tags: String(tags).trim(),
        lyrics: String(lyrics || '').trim(),
        seed,
        bpm: Math.max(40, Math.min(220, Number(bpm) || 120)),
        duration: internalDuration,
        timesignature: String(timesignature || '4'),
        language: String(language || 'en'),
        keyscale: String(keyscale || 'C major'),
        generate_audio_codes: true,
        cfg_scale: Math.max(0, Math.min(10, Number(cfgScale) || 2.0)),
        temperature: Math.max(0, Math.min(2, Number(temperature) || 0.85)),
        top_p: Math.max(0, Math.min(1, Number(topP) || 0.9)),
        top_k: 0,
        min_p: 0,
      },
    },
    '7': {
      class_type: 'ConditioningZeroOut',
      inputs: { conditioning: ['6', 0] },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
        seed,
        steps: 8,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '9': {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['8', 0], vae: ['2', 0] },
    },
    '10': {
      class_type: 'SaveAudioMP3',
      inputs: { audio: ['9', 0], filename_prefix: filenamePrefix, quality: 'V0' },
    },
  }

  emit('queued_submit')
  let promptId
  try {
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow: workflow })
  } catch (err) {
    return { success: false, error: err.message }
  }
  emit('queued', { promptId })

  // Music synth is heavy — first run loads ~5.85 GB of weights from
  // disk + does a long denoise pass. Cap at 15 minutes.
  const startedAt = Date.now()
  let resultEntry
  try {
    resultEntry = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 15 * 60 * 1000,
      pollMs: 3000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy music job ${promptId} failed.` }
  }

  // Locate the saved audio in the history outputs. SaveAudioMP3 emits
  // under `audio` in newer ComfyUI builds; fall back to `images` and
  // filter by extension as the VO synth does.
  const AUDIO_RE = /\.(mp3|wav|flac|ogg|m4a|opus)$/i
  let savedFilename = null
  let savedSubfolder = ''
  let savedType = 'output'
  for (const out of Object.values(resultEntry.outputs || {})) {
    const candidates = [
      ...(Array.isArray(out?.audio) ? out.audio : []),
      ...(Array.isArray(out?.images) ? out.images : []),
      ...(Array.isArray(out?.gifs) ? out.gifs : []),
    ]
    for (const c of candidates) {
      if (!c?.filename) continue
      if (!AUDIO_RE.test(c.filename)) continue
      savedFilename = c.filename
      savedSubfolder = c.subfolder || ''
      savedType = c.type || 'output'
      break
    }
    if (savedFilename) break
  }
  if (!savedFilename) {
    return { success: false, error: 'Could not locate output audio in ComfyUI history for music synth.' }
  }
  const ext = path.extname(savedFilename) || '.mp3'
  const finalAudioPath = path.join(outDir, `${sanitizeForFilename(draftId, 60)}${ext}`)

  // Download the synthesised audio via /view (signed-URL redirect on
  // cloud; direct stream on local). Stage it next to the final path so
  // the optional ffmpeg trim has a real local file to operate on.
  const stagedAudioPath = path.join(outDir, `_${sanitizeForFilename(draftId, 60)}_raw${ext}`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: savedFilename,
      subfolder: savedSubfolder,
      type: savedType,
      destPath: stagedAudioPath,
    })
  } catch (err) {
    return { success: false, error: `Could not download synthesised music: ${err.message}` }
  }

  emit('finalizing')
  // Trim the model output to the user-requested duration. Two
  // tactics combined:
  //   1. We synthd at `internalDuration` (≥60s) so ACE-Step thinks
  //      it's writing a full song, not a 10s outro.
  //   2. We slice from the MIDDLE of that track, not the start —
  //      song intros tend to be low-energy (sparse hits, build-up)
  //      while the middle has the hook / verse the ad actually
  //      wants. Centred slice = full-energy ad bed.
  // Light fade in + out around the slice so the cut points don't
  // pop on the timeline.
  if (internalDuration > safeDuration + 0.5) {
    const sliceStart = Math.max(0, (internalDuration - safeDuration) / 2)
    const fadeSec = Math.min(0.4, Math.max(0.1, safeDuration * 0.05))
    const fadeOutStart = Math.max(0, safeDuration - fadeSec)
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats', '-y',
          '-ss', sliceStart.toFixed(3),
          '-i', stagedAudioPath,
          '-t', safeDuration.toFixed(3),
          // Fade in at the head + fade out at the tail. Both are
          // short enough (~5% of the slice) that the user perceives
          // a clean cut, not a fade.
          '-af', `afade=t=in:st=0:d=${fadeSec.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeSec.toFixed(3)}`,
          '-c:a', ext === '.mp3' ? 'libmp3lame' : 'pcm_s16le',
          ...(ext === '.mp3' ? ['-q:a', '2'] : []),
          finalAudioPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`ffmpeg trim failed (${code}): ${stderr.slice(-300)}`))
        })
        proc.on('error', reject)
      })
    } catch (err) {
      // Trim failed — fall back to keeping the full-length downloaded
      // file. Better to ship "30s of music when 10s was requested" than
      // to fail.
      emit('trim_warn', { message: err.message })
      try { await copyFileOverwrite(stagedAudioPath, finalAudioPath) } catch (cpErr) {
        return { success: false, error: `Could not stage synthesised music: ${cpErr.message}` }
      }
    }
  } else {
    try {
      await fs.rename(stagedAudioPath, finalAudioPath)
    } catch (_) {
      try { await copyFileOverwrite(stagedAudioPath, finalAudioPath) } catch (err) {
        return { success: false, error: `Could not stage synthesised music: ${err.message}` }
      }
    }
  }
  try { await fs.unlink(stagedAudioPath) } catch (_) { /* either already moved, or non-fatal */ }
  let durationFinal = null
  try {
    const dur = await probeAudioDuration(finalAudioPath)
    if (Number.isFinite(dur)) durationFinal = dur
  } catch (_) { /* non-fatal */ }

  // Save the workflow JSON next to the MP3 so the user can drop it
  // back into ComfyUI to inspect / iterate. Same helper the video
  // optimize / extend handlers use.
  let workflowJsonPath = null
  try {
    workflowJsonPath = await saveWorkflowAlongsideOutput(finalAudioPath, workflow, {
      kind: 'ace-step-music',
      draftId,
      promptId,
      internalDurationSec: internalDuration,
      requestedDurationSec: safeDuration,
    })
  } catch (_) { /* non-fatal */ }

  emit('done', { audioPath: finalAudioPath, durationSec: durationFinal, seed, internalDuration, workflowJsonPath })
  return {
    success: true,
    audioPath: finalAudioPath,
    durationSec: durationFinal,
    seed,
    promptId,
    internalDuration,
    workflowJsonPath,
  }
})

// ============================================
// Audio stem separation (VO + Music via Demucs)
// ============================================
//
// Wraps `separate_stems.py` (sibling of `make_mask.py` under
// reedit/scripts/). The script does the heavy lifting: extract audio, run demucs
// with `--two-stems vocals`, rename + move the outputs into the
// project's `.reedit/stems/` folder. We emit progress events so the
// Import view can show the current stage; the renderer persists the
// output paths into `sourceVideo.stems`.
ipcMain.handle('analysis:separateStems', async (event, options) => {
  const { sourceVideoPath, projectDir, model = 'htdemucs', device = 'auto' } = options || {}
  if (!sourceVideoPath) return { success: false, error: 'sourceVideoPath required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:separateStems:progress', { stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting')

  try {
    const st = await fs.stat(sourceVideoPath)
    if (!st || st.size < 1024) throw new Error('source video missing or empty')
  } catch (err) {
    return { success: false, error: `Source video not readable at ${sourceVideoPath}: ${err.message}` }
  }

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const stemsDir = path.join(projectDirFwd, '.reedit', 'stems')
  try { await fs.mkdir(stemsDir, { recursive: true }) } catch (err) {
    return { success: false, error: `Could not create stems dir: ${err.message}` }
  }

  const sourceBase = sanitizeForFilename(path.basename(sourceVideoPath, path.extname(sourceVideoPath))) || 'source'
  const vocalsPath = path.join(stemsDir, `${sourceBase}_vocals.wav`)
  const musicPath = path.join(stemsDir, `${sourceBase}_music.wav`)

  // Cache validation: if both WAVs exist AND are newer than the source
  // video's mtime, reuse them. The mtime check means re-importing a
  // fresh source (different content, same path) triggers a regen.
  try {
    const [vStat, mStat, srcStat] = await Promise.all([
      fs.stat(vocalsPath).catch(() => null),
      fs.stat(musicPath).catch(() => null),
      fs.stat(sourceVideoPath).catch(() => null),
    ])
    if (vStat && mStat && srcStat
        && vStat.size > 1024 && mStat.size > 1024
        && vStat.mtimeMs >= srcStat.mtimeMs && mStat.mtimeMs >= srcStat.mtimeMs) {
      emit('done', { vocalsPath, musicPath, model, cached: true })
      return { success: true, vocalsPath, musicPath, model, cached: true, inProjectDir: true }
    }
  } catch (_) { /* proceed with regen */ }

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'separate_stems.py')
  try { await fs.access(scriptPath) } catch {
    return { success: false, error: `separate_stems.py not found at ${scriptPath}.` }
  }

  // Hand ffmpeg + ffprobe paths to the script so it doesn't rely on
  // PATH lookup for those binaries — we already bundle them via
  // ffmpeg-static / ffprobe-static.
  const args = [
    '--src', sourceVideoPath,
    '--out-dir', stemsDir,
    '--out-prefix', sourceBase,
    '--model', model,
    '--device', device,
  ]
  if (ffmpegPath) args.push('--ffmpeg', ffmpegPath)
  if (ffprobeStaticPath) args.push('--ffprobe', ffprobeStaticPath)

  // The script prints `[stem] stage: message` lines on stderr. We
  // translate each into a progress event so the UI can show the stage
  // without parsing raw demucs output on the renderer side.
  let lastManifest = null
  const runRes = await runPython(scriptPath, args, {
    onStderr: (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const m = /^\[stem\]\s+([a-z_]+)\s*:\s*(.*)$/i.exec(line)
        if (!m) continue
        const [, stage, message] = m
        emit(stage, { message })
      }
    },
  })

  if (!runRes.success) {
    const tail = (runRes.stderr || '').slice(-400)
    // Common case: user hasn't installed demucs yet (or the Python that
    // ran it isn't the one it was pip-installed into — see
    // resolvePythonExe's REEDIT_PYTHON override). The stderr contains
    // "No module named 'demucs'" for a plain ImportError, but Python's
    // `-m` module runner prints it WITHOUT quotes ("No module named
    // demucs") — match both so the friendly hint always wins over a
    // raw traceback dump.
    if (/no module named ['"]?demucs['"]?/i.test(tail)) {
      return {
        success: false,
        error: "Demucs is not installed for the Python interpreter this app is using. Run `pip install demucs` there, or point REEDIT_PYTHON at an interpreter that has it (Settings → not yet exposed there; set the env var before launching). If you normally work inside another Python venv, launch the app from a shell without that venv activated.",
      }
    }
    if (/no audio stream/i.test(tail)) {
      return { success: false, error: 'Source video has no audio stream — nothing to separate.' }
    }
    return { success: false, error: `separate_stems.py failed (code ${runRes.code}). Tail: ${tail}` }
  }

  // The script prints a single JSON manifest line on stdout as its
  // final output. Parse the last JSON object we can find in stdout.
  const stdoutLines = String(runRes.stdout || '').split(/\r?\n/).filter(Boolean)
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    const trimmed = stdoutLines[i].trim()
    if (!trimmed.startsWith('{')) continue
    try {
      lastManifest = JSON.parse(trimmed)
      break
    } catch (_) { /* keep looking */ }
  }
  if (!lastManifest?.vocalsPath || !lastManifest?.musicPath) {
    return { success: false, error: 'separate_stems.py succeeded but did not emit a valid manifest line.' }
  }

  // Belt-and-suspenders: verify the files the script reported actually
  // exist on disk. This catches weird race conditions where the script
  // renamed a file but the move hadn't landed before the process exited.
  try {
    await fs.access(lastManifest.vocalsPath)
    await fs.access(lastManifest.musicPath)
  } catch (err) {
    return { success: false, error: `Manifest points to missing files: ${err.message}` }
  }

  emit('done', { vocalsPath: lastManifest.vocalsPath, musicPath: lastManifest.musicPath, model: lastManifest.model, device: lastManifest.device })
  return {
    success: true,
    vocalsPath: lastManifest.vocalsPath,
    musicPath: lastManifest.musicPath,
    model: lastManifest.model,
    device: lastManifest.device,
    inProjectDir: true,
    cached: false,
  }
})

// Extracts one JPEG frame at `tcSec` and writes it to `outputPath`. The
// `-ss` before `-i` uses keyframe fast-seek which is 10–100x faster than
// precise seek; good enough for thumbnails. Caller owns the output path
// so we don't need to know the project layout here.
ipcMain.handle('analysis:extractThumbnail', async (event, options) => {
  if (!ffmpegPath) return { success: false, error: 'FFmpeg binary not available.' }
  const { videoPath, tcSec, outputPath, width = 480 } = options || {}
  if (!videoPath || !outputPath || !Number.isFinite(tcSec)) {
    return { success: false, error: 'videoPath, tcSec, and outputPath are required.' }
  }

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
  } catch (err) {
    return { success: false, error: `Cannot create output dir: ${err.message}` }
  }

  return await new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-nostats',
      '-ss', String(Math.max(0, tcSec)),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '3',
      '-vf', `scale=${width}:-2`,
      '-y',
      outputPath,
    ]

    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''

    proc.stderr.on('data', (data) => { stderr += data.toString() })
    proc.on('error', (err) => resolve({ success: false, error: err.message }))
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: `FFmpeg exited with code ${code}. ${stderr.slice(-200)}` })
        return
      }
      resolve({ success: true, path: outputPath })
    })
  })
})

// ============================================
// Placeholder fill generation — Kling i2v via Comfy Cloud
// ============================================
//
// The proposer can emit `kind: 'placeholder'` rows that need to be
// filled with AI-generated footage. Each placeholder carries a
// `referenceFrame: { sourceSceneId, framePosition }` chosen by the LLM
// to keep the generated clip visually consistent with the rest of the
// cut. This handler:
//   1. Extracts the referenced frame from the source video as a PNG
//      (ffmpeg -ss N -vframes 1).
//   2. Uploads the PNG to Comfy Cloud via /upload/image.
//   3. Builds the Kling Omni image-to-video workflow inline, patched
//      with our prompt + duration + reference image.
//   4. Submits + polls + downloads the MP4 to
//      `<projectDir>/.reedit/fills/<placeholderId>.mp4`.
//
// Bulk orchestration (loop over placeholders, persist results) lives
// in the renderer-side `reeditFills.js` service — this handler stays
// focused on one fill at a time.
// Fill model builders + prompt formatters now live in
// electron/comfy/adapters/ (one file per model, registry in index.js).

ipcMain.handle('analysis:generateFill', async (event, options) => {
  const {
    placeholderId,
    projectDir,
    sourceVideoPath,
    referenceTcSec,         // absolute source timecode for the reference frame
    referenceTcSecList,     // OPTIONAL: multiple ref frames (Seedance multi-ref, up to 9)
    bridgeFrames,           // OPTIONAL: { prevTcSec, nextTcSec } for first/last-frame models (Veo FLF)
    referenceClip,          // OPTIONAL: { startSec, durationSec } — sub-clip uploaded as reference video (Seedance)
    prompt,
    durationSec,
    aspectRatio,
    modelId: modelIdOpt,    // adapter id from electron/comfy/adapters
    comfyUrl: comfyUrlOpt,
    apiKey: apiKeyOpt,
  } = options || {}
  const modelId = String(modelIdOpt || 'kling-v3-omni')
  const fillAdapter = getAdapter(modelId)
  if (!fillAdapter || fillAdapter.kind !== 'i2v') {
    const available = listAdapters({ kind: 'i2v' }).map((a) => a.id).join(', ')
    return { success: false, error: `Unknown fill model "${modelId}". Available: ${available}.` }
  }
  if (!placeholderId) return { success: false, error: 'placeholderId required.' }
  if (!projectDir)    return { success: false, error: 'projectDir required.' }
  if (!sourceVideoPath) return { success: false, error: 'sourceVideoPath required.' }
  // Which frames to extract from the source. Priority: explicit bridge
  // frames (FLF models) → multi-ref list → single legacy referenceTcSec.
  const refTcs = (bridgeFrames && Number.isFinite(bridgeFrames.prevTcSec) && Number.isFinite(bridgeFrames.nextTcSec))
    ? [bridgeFrames.prevTcSec, bridgeFrames.nextTcSec]
    : (Array.isArray(referenceTcSecList) && referenceTcSecList.length > 0)
      ? referenceTcSecList.filter(Number.isFinite).slice(0, 9)
      : Number.isFinite(referenceTcSec) ? [referenceTcSec] : []
  if (refTcs.length === 0) return { success: false, error: 'referenceTcSec, referenceTcSecList or bridgeFrames required.' }
  const comfyUrl = comfyUrlOpt || DEFAULT_LOCAL_COMFY_URL
  const apiKey = apiKeyOpt || ''
  // Kling is a Cloud-only model — there's no local backend. Fail fast
  // with a useful message instead of letting the upload silently 404.
  if (!isCloudComfyUrl(comfyUrl)) {
    return { success: false, error: 'Placeholder generation needs Comfy Cloud. Switch the ComfyUI mode to Cloud in the launcher chip or in Settings → ComfyUI before running this.' }
  }

  const emit = (stage, extra = {}) => {
    try { event.sender.send('analysis:generateFill:progress', { placeholderId, stage, ...extra }) } catch (_) { /* renderer closed */ }
  }
  emit('starting')

  const projectDirFwd = projectDir.replace(/\\/g, '/')
  const fillsDir = path.join(projectDirFwd, '.reedit', 'fills')
  try { await fs.mkdir(fillsDir, { recursive: true }) } catch (err) {
    return { success: false, error: `Could not create fills dir: ${err.message}` }
  }

  // 1. Extract the reference frame(s) from the source, then upload each.
  //    One frame for classic i2v, two for FLF bridges (prev-row last
  //    frame + next-row first frame), up to nine for Seedance multi-ref.
  emit('extracting_reference', { tcs: refTcs })
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(placeholderId)}`
  const extractFrame = (tcSec, destPath) => new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-ss', String(Math.max(0, Number(tcSec))),
      '-i', sourceVideoPath,
      '-vframes', '1',
      '-q:v', '2',
      '-y', destPath,
    ]
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg frame extract failed (${code}): ${stderr.slice(-300)}`))
    })
    proc.on('error', reject)
  })

  const uploadedRefNames = []
  let refPath = null
  try {
    for (let i = 0; i < refTcs.length; i++) {
      const localPath = path.join(fillsDir, `${sanitizeForFilename(placeholderId)}_ref${i > 0 ? `_${i + 1}` : ''}.png`)
      if (i === 0) refPath = localPath
      await extractFrame(refTcs[i], localPath)
      const remoteName = `${prefix}_ref_${i + 1}.png`
      const up = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: localPath, filename: remoteName })
      uploadedRefNames.push(up?.name || remoteName)
    }
  } catch (err) {
    return { success: false, error: `Reference frame extract/upload failed: ${err.message}` }
  }
  const comfyRefName = uploadedRefNames[0]

  // 2b. Optional reference sub-clip (Seedance reference_videos slot) —
  //     a short cut of the source that carries motion + product identity.
  let referenceVideoName = null
  if (referenceClip && Number.isFinite(referenceClip.startSec)) {
    emit('uploading_reference_clip')
    const clipDur = Math.max(0.5, Math.min(3, Number(referenceClip.durationSec) || 3))
    const refClipPath = path.join(fillsDir, `${sanitizeForFilename(placeholderId)}_refclip.mp4`)
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-hide_banner', '-nostats',
          '-ss', String(Math.max(0, Number(referenceClip.startSec))),
          '-i', sourceVideoPath,
          '-t', String(clipDur),
          '-an',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-pix_fmt', 'yuv420p',
          '-y', refClipPath,
        ]
        const proc = spawn(ffmpegPath, args, { windowsHide: true })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ref-clip cut failed (${code}): ${stderr.slice(-300)}`)))
        proc.on('error', reject)
      })
      const up = await uploadFileToComfy({ comfyUrl, apiKey, localFilePath: refClipPath, filename: `${prefix}_refclip.mp4` })
      referenceVideoName = up?.name || `${prefix}_refclip.mp4`
    } catch (err) {
      return { success: false, error: `Reference clip cut/upload failed: ${err.message}` }
    }
  }

  // 3. Build patched workflow + submit. The model-specific builder
  // picks the right node class names + clamps duration to the
  // provider's allowed range. All providers accept int32 seeds; we
  // roll once here and let the builder re-clamp.
  const outputPrefix = `reedit_fills/${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(placeholderId)}`
  const seed = Math.floor(Math.random() * 2147483647)
  const workflow = fillAdapter.buildWorkflow({
    referenceFilename: comfyRefName,
    referenceFilenames: uploadedRefNames.length > 1 ? uploadedRefNames : undefined,
    lastFrameFilename: bridgeFrames ? uploadedRefNames[1] : undefined,
    referenceVideoFilename: referenceVideoName || undefined,
    prompt,
    durationSec,
    aspectRatio,
    resolution: '720p',
    outputPrefix,
    seed,
  })

  emit('queued_submit')
  let promptId
  try {
    // Partner Nodes (Kling / Grok / Vidu / Nano Banana / Seedream)
    // authenticate against comfyapi.com using the user's Comfy.org key
    // — and that auth MUST travel in the POST body under
    // `extra_data.api_key_comfy_org`. The X-API-Key header only
    // authenticates the Cloud endpoint itself; without the body field
    // the worker hits "Unauthorized: Please login first to use this
    // node" the moment the Partner Node tries to dispatch. See
    // https://docs.comfy.org/development/cloud/api-reference.
    promptId = await queuePromptToComfy({ comfyUrl, apiKey, workflow, includeComfyOrgKey: true })
  } catch (err) {
    return { success: false, error: err.message }
  }
  emit('queued', { promptId })

  // 4. Poll. Kling Omni typically returns in 60-180 s; allow 10 min
  //    so a queue spike doesn't time us out.
  let result
  const startedAt = Date.now()
  try {
    result = await waitForComfyJob({
      comfyUrl, apiKey, promptId,
      timeoutMs: 10 * 60 * 1000,
      pollMs: 4000,
      onTick: () => emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
    })
  } catch (err) {
    return { success: false, error: err?.message || `Comfy Cloud fill job ${promptId} failed.` }
  }

  // 5. Extract the saved MP4 path from history outputs.
  const VIDEO_RE = /\.(mp4|mov|webm|mkv|gif|avi|m4v)$/i
  let outFilename = null, outSubfolder = '', outType = 'output'
  for (const out of Object.values(result.outputs || {})) {
    const candidates = [
      ...(Array.isArray(out?.videos) ? out.videos : []),
      ...(Array.isArray(out?.gifs) ? out.gifs : []),
      ...(Array.isArray(out?.images) ? out.images : []),
    ]
    for (const c of candidates) {
      if (!c?.filename) continue
      if (!VIDEO_RE.test(c.filename)) continue
      outFilename = c.filename
      outSubfolder = c.subfolder || ''
      outType = c.type || 'output'
      break
    }
    if (outFilename) break
  }
  if (!outFilename) {
    return { success: false, error: 'Fill workflow completed but no video output was reported in history.' }
  }

  // 6. Download the MP4 into the project.
  emit('finalizing')
  const finalPath = path.join(fillsDir, `${sanitizeForFilename(placeholderId)}.mp4`)
  try {
    await downloadFromComfy({
      comfyUrl, apiKey,
      filename: outFilename,
      subfolder: outSubfolder,
      type: outType,
      destPath: finalPath,
    })
  } catch (err) {
    return { success: false, error: `Could not download fill output: ${err.message}` }
  }

  emit('done', { promptId, outputPath: finalPath })
  return {
    success: true,
    promptId,
    outputPath: finalPath,
    referenceFramePath: refPath,
    seed,
    modelId,
  }
})

const audioWaveformCache = new Map()

function resolveMediaInputPath(mediaInput) {
  if (!mediaInput || typeof mediaInput !== 'string') return null
  if (mediaInput.startsWith('comfystudio://')) {
    return decodeURIComponent(mediaInput.replace('comfystudio://', ''))
  }
  if (mediaInput.startsWith('file://')) {
    try {
      return fileURLToPath(mediaInput)
    } catch (_) {
      // Fallback for unusual path encodings
      let normalizedPath = mediaInput.replace('file://', '')
      normalizedPath = decodeURIComponent(normalizedPath)
      if (/^\/[a-zA-Z]:\//.test(normalizedPath)) {
        normalizedPath = normalizedPath.slice(1)
      }
      return normalizedPath.replace(/\//g, path.sep)
    }
  }
  return mediaInput
}

ipcMain.handle('media:getAudioWaveform', async (event, mediaInput, options = {}) => {
  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const filePath = resolveMediaInputPath(mediaInput)
  if (!filePath) {
    return { success: false, error: 'Invalid audio input path.' }
  }

  const sampleCount = Math.max(128, Math.min(8192, Math.round(Number(options?.sampleCount) || 4096)))
  const sampleRate = Math.max(400, Math.min(6000, Math.round(Number(options?.sampleRate) || 2000)))

  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    return { success: false, error: `Audio file not found: ${err.message}` }
  }

  // v2 in the cache key so the bucket-distribution fix invalidates
  // every previously-cached entry on first run; stale buckets would
  // otherwise keep serving the old (slightly mis-aligned) waveform
  // that drove the audio/visual desync.
  const cacheKey = `v2|${filePath}|${sampleCount}|${sampleRate}|${stat.mtimeMs}`
  if (audioWaveformCache.has(cacheKey)) {
    return { success: true, ...audioWaveformCache.get(cacheKey) }
  }

  return await new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      'pipe:1',
    ]

    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    const chunks = []
    let stderr = ''

    proc.stdout.on('data', (data) => {
      chunks.push(Buffer.from(data))
    })
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    proc.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
        return
      }

      try {
        const raw = Buffer.concat(chunks)
        const floatCount = Math.floor(raw.length / 4)
        if (floatCount <= 0) {
          resolve({ success: false, error: 'No audio samples decoded.' })
          return
        }

        const bucketCount = sampleCount
        // Float-precision bucket boundaries — Math.floor of the exact
        // ratio at each edge — so any leftover samples spread evenly
        // across the LAST handful of buckets instead of getting dumped
        // into the final bucket. The old `floor(floatCount/bucketCount)`
        // sizing made the last bucket up to ~bucketCount-1 samples
        // wider than the rest, which then fooled the linear time→index
        // mapping in the renderer (a 30 s file at 2000 Hz had its
        // final 1.3 s squashed into one peak; the waveform displayed
        // ran ~0.2-0.5 s BEHIND the audio playback).
        const peaks = new Array(bucketCount).fill(0)
        let maxPeak = 0

        for (let i = 0; i < bucketCount; i++) {
          const start = Math.floor((i * floatCount) / bucketCount)
          const end = i === bucketCount - 1
            ? floatCount
            : Math.floor(((i + 1) * floatCount) / bucketCount)
          const span = Math.max(1, end - start)
          const stride = Math.max(1, Math.floor(span / 96))

          let peak = 0
          for (let s = start; s < end; s += stride) {
            const amp = Math.abs(raw.readFloatLE(s * 4))
            if (amp > peak) peak = amp
          }

          peaks[i] = peak
          if (peak > maxPeak) maxPeak = peak
        }

        if (maxPeak > 0) {
          for (let i = 0; i < peaks.length; i++) {
            peaks[i] = peaks[i] / maxPeak
          }
        }

        const result = {
          peaks,
          duration: floatCount / sampleRate,
        }
        audioWaveformCache.set(cacheKey, result)
        resolve({ success: true, ...result })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

// Mix the full timeline's program audio (video-embedded audio + audio clips) into
// a single mono 16 kHz WAV file using FFmpeg in the main process. This exists as
// a dedicated handler (not part of export:mixAudio) because:
//   1. export:mixAudio only accepts clips whose type === 'audio', skipping video
//      audio — but transcription needs the dialogue on video clips.
//   2. Doing the mix in the renderer via decodeAudioData() on multi-hundred-MB
//      mp4 files reliably OOMs Chromium (renderer goes black). FFmpeg demuxes
//      the audio stream without decoding video, so memory stays flat.
ipcMain.handle('captions:mixTimelineAudio', async (event, options = {}) => {
  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const {
    projectPath = '',
    clips = [],
    tracks = [],
    assets = [],
    duration: requestedDuration = 0,
    sampleRate = 16000,
    timeoutMs = 180000,
  } = options

  const programDuration = Math.max(0, Number(requestedDuration) || 0)
  if (programDuration <= 0.001) {
    return { success: false, error: 'Timeline duration is zero — nothing to mix.' }
  }

  const trackMap = new Map((tracks || []).map((track) => [track.id, track]))
  const assetMap = new Map((assets || []).map((asset) => [asset.id, asset]))
  const preparedInputs = []

  // Diagnostic: per-clip include/skip decision. Logged at the end so we can
  // eyeball exactly which clips the mixer pulled in when captions show text
  // for a clip the user thought was silenced.
  const decisions = []
  const skip = (clip, reason) => {
    decisions.push({
      clipId: clip?.id,
      type: clip?.type,
      trackId: clip?.trackId,
      decision: 'skip',
      reason,
    })
  }

  for (const clip of clips || []) {
    if (!clip) continue
    if (clip.type !== 'video' && clip.type !== 'audio') { skip(clip, `type=${clip.type}`); continue }
    if (clip.enabled === false) { skip(clip, 'clip.enabled=false'); continue }

    const track = trackMap.get(clip.trackId)
    if (!track) { skip(clip, 'no-matching-track'); continue }
    if (track.muted) { skip(clip, 'track.muted=true'); continue }
    if (track.visible === false) { skip(clip, 'track.visible=false'); continue }

    const asset = assetMap.get(clip.assetId)
    if (!asset) { skip(clip, 'no-matching-asset'); continue }
    if (asset.hasAudio === false) { skip(clip, 'asset.hasAudio=false'); continue }
    if (asset.audioEnabled === false) { skip(clip, 'asset.audioEnabled=false'); continue }
    if (clip.audioEnabled === false) { skip(clip, 'clip.audioEnabled=false'); continue }
    if (clip.reverse) { skip(clip, 'clip.reverse=true'); continue }

    let inputPath = null
    if (asset.path && projectPath) {
      inputPath = path.join(projectPath, asset.path)
    }
    if (!inputPath && asset.absolutePath) {
      inputPath = asset.absolutePath
    }
    if (!inputPath && asset.url) {
      inputPath = resolveMediaInputPath(asset.url)
    }
    if (!inputPath && clip.url) {
      inputPath = resolveMediaInputPath(clip.url)
    }
    if (!inputPath || !fsSync.existsSync(inputPath)) { skip(clip, 'no-resolvable-input-path'); continue }

    const clipStart = Number(clip.startTime) || 0
    const clipDuration = Math.max(0, Number(clip.duration) || 0)
    if (clipDuration <= 0.001) { skip(clip, 'clipDuration<=0'); continue }
    const clipEnd = clipStart + clipDuration

    const visibleStart = Math.max(0, clipStart)
    const visibleEnd = Math.min(programDuration, clipEnd)
    if (visibleEnd <= visibleStart) { skip(clip, 'off-program'); continue }

    const clipOffsetOnTimeline = visibleStart - clipStart
    const timeScale = getExportClipTimeScale(clip)
    if (!Number.isFinite(timeScale) || timeScale <= 0) { skip(clip, `bad-timescale=${timeScale}`); continue }

    const trimStart = Math.max(0, Number(clip.trimStart) || 0)
    const sourceOffsetSec = Math.max(0, trimStart + clipOffsetOnTimeline * timeScale)
    const timelineVisibleSec = visibleEnd - visibleStart
    const sourceDurationSec = Math.max(0, timelineVisibleSec * timeScale)
    if (sourceDurationSec <= 0.001) { skip(clip, 'sourceDurationSec<=0'); continue }

    const delayMs = Math.max(0, Math.round(visibleStart * 1000))
    preparedInputs.push({
      inputPath,
      sourceOffsetSec,
      sourceDurationSec,
      delayMs,
      timeScale,
    })
    decisions.push({
      clipId: clip.id,
      type: clip.type,
      trackId: clip.trackId,
      decision: 'include',
      delayMs,
      sourceDurationSec: Number(sourceDurationSec.toFixed(3)),
    })
  }

  // Compact summary: prints one log line that you can paste back to me.
  console.log('[captions:mix] filter decisions:', JSON.stringify({
    clipCount: (clips || []).length,
    trackCount: (tracks || []).length,
    assetCount: (assets || []).length,
    included: preparedInputs.length,
    skipped: decisions.filter((d) => d.decision === 'skip').length,
    tracks: (tracks || []).map((t) => ({ id: t.id, type: t.type, muted: !!t.muted, visible: t.visible !== false })),
    decisions,
  }))

  if (preparedInputs.length === 0) {
    return { success: false, error: 'No audible clips on the timeline — unmute a track or enable a clip\'s audio.' }
  }

  const tempDir = path.join(app.getPath('temp'), 'comfystudio-caption-audio')
  try {
    await fs.mkdir(tempDir, { recursive: true })
  } catch (err) {
    return { success: false, error: err.message }
  }
  const outputPath = path.join(tempDir, `timeline_mix_${Date.now()}.wav`)

  const normalizedSampleRate = Math.max(8000, Math.min(48000, Math.round(Number(sampleRate) || 16000)))
  const normalizedTimeout = Math.max(30000, Math.round(Number(timeoutMs) || 180000))

  const args = ['-y', '-v', 'error']
  for (const entry of preparedInputs) {
    // -vn on each input tells FFmpeg to skip video streams up front; combined with
    // filter_complex selecting [N:a] below, this means we never decode video frames.
    args.push('-vn', '-i', entry.inputPath)
  }

  const inputFilters = []
  const mixLabels = []
  preparedInputs.forEach((entry, index) => {
    const filters = [
      `atrim=start=${formatFilterNumber(entry.sourceOffsetSec)}:duration=${formatFilterNumber(entry.sourceDurationSec)}`,
      'asetpts=PTS-STARTPTS',
      ...buildAtempoFilterChain(entry.timeScale),
      // Force each input to mono before mixing so inputs with different channel
      // layouts combine cleanly.
      'aformat=channel_layouts=mono',
    ]
    if (entry.delayMs > 0) {
      filters.push(`adelay=${entry.delayMs}:all=1`)
    }
    const label = `m${index}`
    inputFilters.push(`[${index}:a]${filters.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  const durationClip = `atrim=duration=${formatFilterNumber(programDuration)},asetpts=PTS-STARTPTS`
  const finalFilter = mixLabels.length === 1
    ? `${mixLabels[0]}${durationClip}[outa]`
    : `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,${durationClip}[outa]`

  args.push(
    '-filter_complex', `${inputFilters.join(';')};${finalFilter}`,
    '-map', '[outa]',
    '-ar', String(normalizedSampleRate),
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    outputPath
  )

  return await new Promise((resolve) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let killedByTimeout = false
    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true
      proc.kill('SIGKILL')
    }, normalizedTimeout)

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle)
      resolve({ success: false, error: err.message })
    })

    proc.on('close', async (code) => {
      clearTimeout(timeoutHandle)
      if (killedByTimeout) {
        try { await fs.unlink(outputPath) } catch (_) { /* ignore */ }
        resolve({ success: false, error: `Audio mix timed out after ${Math.round(normalizedTimeout / 1000)}s` })
        return
      }
      if (code !== 0) {
        try { await fs.unlink(outputPath) } catch (_) { /* ignore */ }
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
        return
      }
      try {
        const stat = await fs.stat(outputPath)
        resolve({
          success: true,
          outputPath,
          size: stat.size,
          clipCount: preparedInputs.length,
        })
      } catch (err) {
        resolve({ success: false, error: err.message })
      }
    })
  })
})

// ============================================
// IPC Handlers - App Settings Storage
// ============================================

ipcMain.handle('settings:get', async (event, key) => {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    return key ? settings[key] : settings
  } catch {
    return key ? null : {}
  }
})

ipcMain.handle('settings:set', async (event, key, value) => {
  try {
    let settings = {}
    try {
      const data = await fs.readFile(settingsPath, 'utf8')
      settings = JSON.parse(data)
    } catch {
      // File doesn't exist yet
    }
    
    settings[key] = value
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('settings:delete', async (event, key) => {
  try {
    const data = await fs.readFile(settingsPath, 'utf8')
    const settings = JSON.parse(data)
    delete settings[key]
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// ============================================
// ComfyUI Launcher IPC
// ============================================

ipcMain.handle('comfyLauncher:getState', async () => {
  return comfyLauncher.getState()
})

ipcMain.handle('comfyLauncher:getConfig', async () => {
  await refreshLauncherConfigCache()
  return cachedLauncherConfig
})

ipcMain.handle('comfyLauncher:setConfig', async (_event, partial = {}) => {
  try {
    const next = await comfyLauncher._setConfig(partial || {})
    return { success: true, config: next }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:start', async () => {
  await refreshLauncherConfigCache()
  return comfyLauncher.start()
})

ipcMain.handle('comfyLauncher:stop', async () => {
  return comfyLauncher.stop()
})

ipcMain.handle('comfyLauncher:restart', async () => {
  await refreshLauncherConfigCache()
  return comfyLauncher.restart()
})

ipcMain.handle('comfyLauncher:detach', async () => {
  return comfyLauncher.detach()
})

ipcMain.handle('comfyLauncher:refresh', async () => {
  await refreshLauncherConfigCache()
  await comfyLauncher.refreshExternal()
  return comfyLauncher.getState()
})

ipcMain.handle('comfyLauncher:getLogs', async (_event, options = {}) => {
  return comfyLauncher.getLogs(options || {})
})

ipcMain.handle('comfyLauncher:appendLog', async (_event, payload = {}) => {
  try {
    const ok = comfyLauncher.appendExternalLog(payload || {})
    return { success: Boolean(ok) }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:describePortOwner', async () => {
  try {
    return await comfyLauncher.describePortOwner()
  } catch (error) {
    return { pid: null, name: '', port: null, error: error?.message || String(error) }
  }
})

ipcMain.handle('comfyLauncher:connectExternal', async () => {
  try {
    await comfyLauncher.refreshExternal()
    return { success: true, state: comfyLauncher.getState() }
  } catch (error) {
    return { success: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('shell:openExternal', async (_event, url) => {
  const target = String(url || '').trim()
  if (!target) {
    return { success: false, error: 'No URL provided.' }
  }
  // Allow http(s) and mailto: only to avoid arbitrary protocol handlers.
  if (!/^(https?:|mailto:)/i.test(target)) {
    return { success: false, error: 'Unsupported URL scheme.' }
  }
  try {
    const { shell } = require('electron')
    await shell.openExternal(target)
    return { success: true }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to open URL.' }
  }
})

ipcMain.handle('comfyLauncher:openLogFile', async () => {
  const state = comfyLauncher.getState()
  const filePath = state?.logFilePath
  if (!filePath) return { success: false, error: 'No log file has been written yet.' }
  try {
    const { shell } = require('electron')
    await shell.openPath(filePath)
    return { success: true, path: filePath }
  } catch (error) {
    return { success: false, error: error?.message || 'Failed to open log file.' }
  }
})

ipcMain.handle('comfyLauncher:detectLaunchers', async (_event, payload = {}) => {
  const explicitRoot = String(payload?.comfyRootPath || '').trim()
  const rootPath = explicitRoot || (await readSettingsRaw())?.[COMFY_ROOT_SETTING_KEY] || ''
  try {
    const candidates = await detectLaunchersForComfyRoot(rootPath)
    return { success: true, comfyRootPath: rootPath, candidates }
  } catch (error) {
    return { success: false, error: error?.message || String(error), candidates: [] }
  }
})

ipcMain.handle('comfyLauncher:pickLauncherScript', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'No active window.' }
  }
  const filters = process.platform === 'win32'
    ? [
        { name: 'Launcher scripts', extensions: ['bat', 'cmd'] },
        { name: 'All files', extensions: ['*'] },
      ]
    : [
        { name: 'Launcher scripts', extensions: ['sh', 'command'] },
        { name: 'All files', extensions: ['*'] },
      ]
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select ComfyUI launcher script',
    properties: ['openFile'],
    filters,
  })
  if (result.canceled || !result.filePaths?.length) {
    return { success: false, canceled: true }
  }
  return { success: true, filePath: result.filePaths[0] }
})

// ============================================
// Workflow Setup Manager
// ============================================

ipcMain.handle('comfyui:loadWorkflowGraph', async (event, payload = {}) => {
  try {
    if (!payload?.workflowGraph || typeof payload.workflowGraph !== 'object') {
      return { success: false, error: 'Missing ComfyUI workflow graph payload.' }
    }

    await loadWorkflowGraphInEmbeddedComfy({
      workflowGraph: payload.workflowGraph,
      comfyBaseUrl: payload.comfyBaseUrl || 'http://127.0.0.1:8188',
      waitForMs: payload.waitForMs,
    })

    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Could not load the workflow into the embedded ComfyUI tab.',
    }
  }
})

ipcMain.handle('workflowSetup:validateRoot', async (event, rootPath) => {
  try {
    return await validateWorkflowSetupRootInternal(rootPath)
  } catch (error) {
    return {
      success: false,
      isValid: false,
      error: error?.message || 'Could not validate the selected ComfyUI folder.',
      warnings: [],
      normalizedPath: '',
      customNodesPath: '',
      modelsPath: '',
      pythonCommand: '',
      python: null,
    }
  }
})

ipcMain.handle('workflowSetup:checkFiles', async (_event, payload = {}) => {
  const results = []
  try {
    const validation = await validateWorkflowSetupRootInternal(payload?.comfyRootPath)
    if (!validation.isValid || !validation.modelsPath) {
      return {
        success: false,
        error: validation.error || 'ComfyUI root is not configured.',
        results,
      }
    }

    const modelsPath = validation.modelsPath
    const files = Array.isArray(payload?.files) ? payload.files : []

    // Cache per-subdir directory listings so we can do case-insensitive matching
    // on filesystems where casing differs from the declared filename.
    const dirListingCache = new Map()
    const getDirListing = async (absoluteDir) => {
      if (dirListingCache.has(absoluteDir)) return dirListingCache.get(absoluteDir)
      let entries = []
      try {
        entries = await fs.readdir(absoluteDir)
      } catch {
        entries = []
      }
      const lowerSet = new Set(entries.map((name) => String(name || '').toLowerCase()))
      dirListingCache.set(absoluteDir, lowerSet)
      return lowerSet
    }

    for (const file of files) {
      const filename = String(file?.filename || '').trim()
      const targetSubdir = String(file?.targetSubdir || '').trim()
      if (!filename) {
        results.push({ filename: '', targetSubdir, exists: false })
        continue
      }

      const candidateSubdirs = new Set()
      if (targetSubdir) candidateSubdirs.add(targetSubdir)
      // Some loaders (e.g. LTX AV text encoder) accept either a text_encoders or
      // checkpoints path. Also try a couple of common siblings so existing but
      // relocated files still resolve without forcing a redundant download.
      candidateSubdirs.add('checkpoints')
      candidateSubdirs.add('text_encoders')
      candidateSubdirs.add('loras')
      candidateSubdirs.add('upscale_models')
      candidateSubdirs.add('vae')
      candidateSubdirs.add('diffusion_models')
      candidateSubdirs.add('clip')

      let exists = false
      let resolvedPath = ''
      const lowerTarget = filename.toLowerCase()

      for (const subdir of candidateSubdirs) {
        const absoluteDir = subdir ? path.join(modelsPath, subdir) : modelsPath
        const listing = await getDirListing(absoluteDir)
        if (listing.has(lowerTarget)) {
          exists = true
          resolvedPath = path.join(absoluteDir, filename)
          break
        }
      }

      results.push({
        filename,
        targetSubdir,
        exists,
        resolvedPath: exists ? resolvedPath : '',
      })
    }

    return { success: true, results, modelsPath }
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'Failed to check model files on disk.',
      results,
    }
  }
})

ipcMain.handle('workflowSetup:install', async (event, payload = {}) => {
  const validation = await validateWorkflowSetupRootInternal(payload?.comfyRootPath)
  if (!validation.isValid) {
    return {
      success: false,
      error: validation.error || 'Choose a valid ComfyUI folder first.',
      validation,
      nodePacks: [],
      models: [],
      errors: [],
      restartRecommended: false,
    }
  }

  const plan = payload?.plan && typeof payload.plan === 'object' ? payload.plan : {}
  const nodePacks = Array.isArray(plan.nodePacks) ? plan.nodePacks : []
  const models = Array.isArray(plan.models) ? plan.models : []

  const nodePackResults = []
  const modelResults = []
  const errors = []
  const totalTasks = nodePacks.length + models.length
  let completedTasks = 0

  emitWorkflowSetupProgress({
    stage: 'install',
    status: 'active',
    totalTasks,
    completedTasks,
    overallPercent: totalTasks > 0 ? 0 : 100,
    message: 'Starting workflow setup install...',
  })

  for (const task of nodePacks) {
    const currentTaskIndex = completedTasks + 1
    try {
      const result = await installNodePackTask(task, validation, {
        currentTaskIndex,
        totalTasks,
        completedTasks,
      })
      nodePackResults.push(result)
    } catch (error) {
      const message = error?.message || `Failed to install ${task?.displayName || task?.id || 'node pack'}.`
      errors.push(message)
      emitWorkflowSetupProgress({
        stage: 'node-pack',
        status: 'complete',
        level: 'error',
        taskType: 'node-pack',
        currentLabel: task?.displayName || task?.id || 'Custom node pack',
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: null,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message,
      })
    }
    completedTasks += 1
  }

  for (const task of models) {
    const currentTaskIndex = completedTasks + 1
    const targetFolder = task?.targetSubdir
      ? path.join(validation.modelsPath, task.targetSubdir)
      : validation.modelsPath
    const targetPath = path.join(targetFolder, task.filename)

    try {
      const result = await downloadFileWithProgress(task, targetPath, {
        currentTaskIndex,
        totalTasks,
        completedTasks,
      })
      modelResults.push(result)
    } catch (error) {
      const message = error?.message || `Failed to download ${task?.filename || 'model'}.`
      errors.push(message)
      emitWorkflowSetupProgress({
        stage: 'download',
        status: 'complete',
        level: 'error',
        taskType: 'model',
        currentLabel: task?.displayName || task?.filename || 'Model',
        currentTaskIndex,
        totalTasks,
        completedTasks: completedTasks + 1,
        taskPercent: null,
        overallPercent: getWorkflowSetupOverallPercent({ completedTasks: completedTasks + 1, totalTasks }),
        message,
      })
    }
    completedTasks += 1
  }

  emitWorkflowSetupProgress({
    stage: 'install',
    status: 'finished',
    level: errors.length === 0 ? 'success' : 'warning',
    totalTasks,
    completedTasks: totalTasks,
    overallPercent: 100,
    message: errors.length === 0
      ? 'Workflow setup install finished.'
      : 'Workflow setup install finished with errors.',
  })

  return {
    success: errors.length === 0,
    validation,
    nodePacks: nodePackResults,
    models: modelResults,
    errors,
    restartRecommended: nodePackResults.some((entry) => !entry?.skipped),
  }
})

// ============================================
// Export Operations
// ============================================

ipcMain.handle('export:runInWorker', async (event, payload) => {
  if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
    return { success: false, error: 'Export already in progress' }
  }
  const workerUrl = isDev
    ? `http://127.0.0.1:5173?export=worker`
    : `file://${path.join(__dirname, '../dist/index.html')}?export=worker`
  exportWorkerWindow = new BrowserWindow({
    width: 400,
    height: 200,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Allow loading file:// URLs for video/image elements during export (otherwise "Media load rejected by URL safety check")
      webSecurity: false,
    },
  })
  const workerContents = exportWorkerWindow.webContents
  const forwardToMain = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  }
  const onProgress = (event, data) => {
    if (event.sender === workerContents) forwardToMain('export:progress', data)
  }
  const onComplete = (event, data) => {
    if (event.sender === workerContents) {
      forwardToMain('export:complete', data)
      if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
        exportWorkerWindow.close()
        exportWorkerWindow = null
      }
    }
  }
  const onError = (event, err) => {
    if (event.sender === workerContents) {
      console.error('[Export] Worker reported error:', err, typeof err)
      forwardToMain('export:error', err)
      if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
        exportWorkerWindow.close()
        exportWorkerWindow = null
      }
    }
  }
  ipcMain.on('export:progress', onProgress)
  ipcMain.on('export:complete', onComplete)
  ipcMain.on('export:error', onError)
  const sendJob = () => {
    if (exportWorkerWindow && !exportWorkerWindow.isDestroyed()) {
      exportWorkerWindow.webContents.send('export:job', payload)
    }
  }
  ipcMain.once('export:workerReady', (event) => {
    if (event.sender === workerContents) sendJob()
  })
  exportWorkerWindow.on('closed', () => {
    ipcMain.removeListener('export:progress', onProgress)
    ipcMain.removeListener('export:complete', onComplete)
    ipcMain.removeListener('export:error', onError)
  })
  exportWorkerWindow.on('closed', () => {
    exportWorkerWindow = null
  })
  await exportWorkerWindow.loadURL(workerUrl)
  return { started: true }
})

const formatFilterNumber = (value, fallback = '0.000000') => {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(0, num).toFixed(6)
}

const getExportClipTimeScale = (clip) => {
  if (!clip) return 1
  const sourceScale = Number(clip.sourceTimeScale)
  const timelineFps = Number(clip.timelineFps)
  const sourceFps = Number(clip.sourceFps)
  const baseScale = Number.isFinite(sourceScale) && sourceScale > 0
    ? sourceScale
    : ((Number.isFinite(timelineFps) && timelineFps > 0 && Number.isFinite(sourceFps) && sourceFps > 0)
      ? (timelineFps / sourceFps)
      : 1)
  const speed = Number(clip.speed)
  const speedScale = Number.isFinite(speed) && speed > 0 ? speed : 1
  return baseScale * speedScale
}

const buildAtempoFilterChain = (rate) => {
  const safeRate = Math.max(0.01, Number(rate) || 1)
  let remaining = safeRate
  const filters = []
  let guard = 0
  while (remaining > 2 && guard < 16) {
    filters.push('atempo=2.0')
    remaining /= 2
    guard += 1
  }
  while (remaining < 0.5 && guard < 32) {
    filters.push('atempo=0.5')
    remaining /= 0.5
    guard += 1
  }
  filters.push(`atempo=${remaining.toFixed(6)}`)
  return filters
}

const clampAudioFadeSeconds = (value, clipDuration = 0) => {
  const duration = Math.max(0, Number(clipDuration) || 0)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(parsed, duration)
}

const MIN_AUDIO_CLIP_GAIN_DB = -24
const MAX_AUDIO_CLIP_GAIN_DB = 24

const normalizeAudioClipGainDb = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(MIN_AUDIO_CLIP_GAIN_DB, Math.min(MAX_AUDIO_CLIP_GAIN_DB, parsed))
}

const audioGainDbToLinear = (value) => Math.pow(10, normalizeAudioClipGainDb(value) / 20)

const buildAudioFadeVolumeExpression = (clipDuration, fadeIn, fadeOut, clipOffset = 0, gainDb = 0, trackVolume = 100) => {
  const duration = Math.max(0, Number(clipDuration) || 0)
  const normalizedFadeIn = clampAudioFadeSeconds(fadeIn, duration)
  const normalizedFadeOut = clampAudioFadeSeconds(fadeOut, duration)
  const offset = Math.max(0, Math.min(Number(clipOffset) || 0, duration))
  const trackGain = Math.max(0, Math.min(1, (Number(trackVolume) || 0) / 100))
  const baseGain = audioGainDbToLinear(gainDb) * trackGain

  const fadeInExpr = normalizedFadeIn > 0
    ? `if(lt(t+${formatFilterNumber(offset)},${formatFilterNumber(normalizedFadeIn)}),(t+${formatFilterNumber(offset)})/${formatFilterNumber(normalizedFadeIn)},1)`
    : '1'

  const fadeOutStart = Math.max(0, duration - normalizedFadeOut)
  const fadeOutExpr = normalizedFadeOut > 0
    ? `if(gt(t+${formatFilterNumber(offset)},${formatFilterNumber(fadeOutStart)}),(${formatFilterNumber(duration)}-(t+${formatFilterNumber(offset)}))/${formatFilterNumber(normalizedFadeOut)},1)`
    : '1'

  const fadeExpr = `max(0,min(1,min(${fadeInExpr},${fadeOutExpr})))`
  if (Math.abs(baseGain - 1) < 0.000001) {
    return fadeExpr
  }
  return `${formatFilterNumber(baseGain)}*(${fadeExpr})`
}

ipcMain.handle('export:mixAudio', async (event, options = {}) => {
  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }

  const {
    projectPath = '',
    outputPath,
    rangeStart = 0,
    rangeEnd = 0,
    sampleRate = 44100,
    channels = 2,
    clips = [],
    tracks = [],
    assets = [],
    timeoutMs = 180000,
  } = options

  if (!outputPath) {
    return { success: false, error: 'Missing output path for audio mix.' }
  }

  const start = Number(rangeStart)
  const end = Number(rangeEnd)
  const rangeStartSec = Number.isFinite(start) ? start : 0
  const rangeEndSec = Number.isFinite(end) ? end : rangeStartSec
  const totalDuration = Math.max(0, rangeEndSec - rangeStartSec)
  if (totalDuration <= 0.000001) {
    return { success: false, error: 'Invalid export range for audio mix.' }
  }

  const trackMap = new Map((tracks || []).map((track) => [track.id, track]))
  const assetMap = new Map((assets || []).map((asset) => [asset.id, asset]))
  const preparedInputs = []

  for (const clip of clips || []) {
    if (!clip || clip.type !== 'audio') continue
    const track = trackMap.get(clip.trackId)
    if (!track || track.type !== 'audio' || track.muted || track.visible === false) continue
    if (clip.reverse) continue // Matches timeline preview behavior (reverse audio is silent).

    const asset = assetMap.get(clip.assetId)
    if (!asset) continue

    // Resolve the on-disk path. Re-edit assets (stems, extracted sub-
    // clips, optimized versions) ship absolute paths because they live
    // outside the project root, so path.join would silently mangle
    // them on Windows when the drive letters don't match. We honour
    // absolute paths verbatim and only join for relative ones.
    let inputPath = null
    const candidatePath = asset.absolutePath || asset.path
    if (candidatePath) {
      const isAbs = path.isAbsolute(candidatePath) || /^[a-zA-Z]:[\\/]/.test(candidatePath)
      if (isAbs) {
        inputPath = candidatePath
      } else if (projectPath) {
        inputPath = path.join(projectPath, candidatePath)
      }
    }
    if ((!inputPath || !fsSync.existsSync(inputPath)) && asset.url) {
      const fromUrl = resolveMediaInputPath(asset.url)
      if (fromUrl) inputPath = fromUrl
    }
    if ((!inputPath || !fsSync.existsSync(inputPath)) && clip.url) {
      const fromClipUrl = resolveMediaInputPath(clip.url)
      if (fromClipUrl) inputPath = fromClipUrl
    }
    if (!inputPath || !fsSync.existsSync(inputPath)) continue

    const clipStart = Number(clip.startTime) || 0
    const clipDuration = Math.max(0, Number(clip.duration) || 0)
    if (clipDuration <= 0.000001) continue
    const clipEnd = clipStart + clipDuration

    const visibleStart = Math.max(rangeStartSec, clipStart)
    const visibleEnd = Math.min(rangeEndSec, clipEnd)
    if (visibleEnd <= visibleStart) continue

    const clipOffsetOnTimeline = visibleStart - clipStart
    const timeScale = getExportClipTimeScale(clip)
    if (!Number.isFinite(timeScale) || timeScale <= 0) continue

    const trimStart = Math.max(0, Number(clip.trimStart) || 0)
    const sourceOffsetSec = Math.max(0, trimStart + clipOffsetOnTimeline * timeScale)
    const timelineVisibleSec = visibleEnd - visibleStart
    const sourceDurationSec = Math.max(0, timelineVisibleSec * timeScale)
    if (sourceDurationSec <= 0.000001) continue

    const delayMs = Math.max(0, Math.round((visibleStart - rangeStartSec) * 1000))
    preparedInputs.push({
      inputPath,
      sourceOffsetSec,
      sourceDurationSec,
      delayMs,
      timeScale,
      clipDuration,
      clipOffsetOnTimeline,
      gainDb: normalizeAudioClipGainDb(clip.gainDb),
      fadeIn: clampAudioFadeSeconds(clip.fadeIn, clipDuration),
      fadeOut: clampAudioFadeSeconds(clip.fadeOut, clipDuration),
      trackVolume: track.volume ?? 100,
      forceMono: track.channels === 'mono',
    })
  }

  if (preparedInputs.length === 0) {
    return { success: false, error: 'No eligible audio clips for mix.' }
  }

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
  } catch (err) {
    return { success: false, error: err.message || 'Failed to prepare audio mix output folder.' }
  }

  const normalizedSampleRate = Math.max(8000, Math.min(192000, Math.round(Number(sampleRate) || 44100)))
  const normalizedChannels = Math.max(1, Math.min(2, Math.round(Number(channels) || 2)))
  const normalizedTimeout = Math.max(30000, Math.round(Number(timeoutMs) || 180000))

  const args = ['-y']
  for (const entry of preparedInputs) {
    args.push('-i', entry.inputPath)
  }

  const inputFilters = []
  const mixLabels = []
  preparedInputs.forEach((entry, index) => {
    const filters = [
      `atrim=start=${formatFilterNumber(entry.sourceOffsetSec)}:duration=${formatFilterNumber(entry.sourceDurationSec)}`,
      'asetpts=PTS-STARTPTS',
    ]

    // atempo only when there's a real time-scale change. atempo=1.0 is
    // a no-op but it still buffers samples internally and (in ffmpeg 8)
    // interferes with `volume:eval=frame` evaluating correctly when
    // followed by adelay — the volume output for the rest of the clip
    // gets stuck at the t=0 evaluation, which is 0 if the clip has a
    // fade-in. That's exactly the bug we hit with auto-ducked music
    // splits going silent past their fade-in point. So skip atempo for
    // 1.0 and skip the eval=frame expression entirely.
    if (Math.abs(entry.timeScale - 1) > 0.000001) {
      filters.push(...buildAtempoFilterChain(entry.timeScale))
    }

    if (entry.forceMono) {
      filters.push('aformat=channel_layouts=mono')
    }

    // Fades: use ffmpeg's standard afade filter instead of a custom
    // volume expression. afade is well-tested, handles edge cases (very
    // short clips, overlapping fade windows) sanely, and doesn't carry
    // the eval=frame baggage that was breaking the previous design.
    if (entry.fadeIn > 0) {
      filters.push(`afade=t=in:st=0:d=${formatFilterNumber(entry.fadeIn)}`)
    }
    if (entry.fadeOut > 0) {
      const fadeOutStart = Math.max(0, entry.clipDuration - entry.fadeOut)
      filters.push(`afade=t=out:st=${formatFilterNumber(fadeOutStart)}:d=${formatFilterNumber(entry.fadeOut)}`)
    }

    // Static gain: clip gainDb (e.g. -12 for ducked music) + per-track
    // volume slider. One `volume=N` filter, no expressions, no eval.
    const gainLinear = audioGainDbToLinear(entry.gainDb) * Math.max(0, Math.min(1, entry.trackVolume / 100))
    if (Math.abs(gainLinear - 1) > 0.000001) {
      filters.push(`volume=${formatFilterNumber(gainLinear)}`)
    }

    if (entry.delayMs > 0) {
      filters.push(`adelay=${entry.delayMs}:all=1`)
    }

    const label = `mix${index}`
    inputFilters.push(`[${index}:a]${filters.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  // amix' default `normalize=1` divides each input by the active input
  // count, which collapses our audio when many split clips are in play
  // (auto-ducking turns one music clip into 7+ alternating segments —
  // combined with VO clips that can push N past 10, every input gets
  // attenuated by ~-20 dB and the mix becomes inaudible after the first
  // duck. Disable normalization so the mixer truly sums; clamp the
  // final mix at -3 dB so peaks don't clip when music + VO overlap.
  const finalMixFilter = mixLabels.length === 1
    ? `${mixLabels[0]}atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
    : `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0,volume=0.7071,atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
  const filterComplex = `${inputFilters.join(';')};${finalMixFilter}`

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outa]',
    '-ar', String(normalizedSampleRate),
    '-ac', String(normalizedChannels),
    '-c:a', 'pcm_s16le',
    outputPath
  )

  // Diagnostic: log the audio mix recipe to the main-process console
  // every export until the auto-ducking + amix issue is conclusively
  // closed. Once the user confirms exports are clean, gate this back
  // behind `process.env.REEDIT_LOG_AUDIO_MIX === '1'`.
  {
    const summary = preparedInputs.map((e, i) => ({
      i,
      inputPath: path.basename(e.inputPath),
      sourceOffsetSec: +e.sourceOffsetSec.toFixed(4),
      sourceDurationSec: +e.sourceDurationSec.toFixed(4),
      delayMs: e.delayMs,
      clipDuration: +e.clipDuration.toFixed(4),
      clipOffsetOnTimeline: +e.clipOffsetOnTimeline.toFixed(4),
      gainDb: e.gainDb,
      fadeIn: +e.fadeIn.toFixed(4),
      fadeOut: +e.fadeOut.toFixed(4),
      trackVolume: e.trackVolume,
    }))
    console.log('[mixAudio] range', { rangeStartSec, rangeEndSec, totalDuration, inputCount: preparedInputs.length })
    console.log('[mixAudio] inputs', JSON.stringify(summary, null, 2))
    console.log('[mixAudio] filter_complex', filterComplex)
  }

  return await new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''
    let killedByTimeout = false
    const timeoutHandle = setTimeout(() => {
      killedByTimeout = true
      ffmpeg.kill('SIGKILL')
    }, normalizedTimeout)

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      clearTimeout(timeoutHandle)
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      clearTimeout(timeoutHandle)
      if (killedByTimeout) {
        resolve({ success: false, error: `Audio mix timed out after ${Math.round(normalizedTimeout / 1000)}s` })
        return
      }
      if (code === 0) {
        resolve({ success: true, clipCount: preparedInputs.length })
        return
      }
      resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
    })
  })
})

ipcMain.handle('export:encodeVideo', async (event, options = {}) => {
  const {
    framePattern,
    fps = 24,
    outputPath,
    audioPath = null,
    format = 'mp4',
    duration = null,
    videoCodec = 'h264',
    audioCodec = 'aac',
    proresProfile = '3',
    useHardwareEncoder = false,
    nvencPreset = 'p5',
    preset = 'medium',
    qualityMode = 'crf',
    crf = 18,
    bitrateKbps = 8000,
    keyframeInterval = null,
    audioBitrateKbps = 192,
    audioSampleRate = 44100
  } = options

  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!framePattern || !outputPath) {
    return { success: false, error: 'Missing export inputs.' }
  }

  let encoderUsed = null
  const args = ['-y', '-framerate', String(fps), '-i', framePattern]
  if (audioPath) {
    args.push('-i', audioPath)
  }
  if (duration) {
    args.push('-t', String(duration))
  }

  const isProRes = videoCodec === 'prores' || (format === 'mov' && options.proresProfile != null)
  const normalizedCodec = isProRes
    ? 'prores'
    : (format === 'webm' || videoCodec === 'vp9'
      ? 'vp9'
      : (videoCodec === 'h265' ? 'h265' : 'h264'))

  if (normalizedCodec === 'prores') {
    const profileNum = Math.min(4, Math.max(0, parseInt(String(proresProfile), 10) || 3))
    args.push(
      '-c:v', 'prores_ks',
      '-profile:v', String(profileNum),
      '-pix_fmt', profileNum === 4 ? 'yuva444p10le' : 'yuv422p10le'
    )
    encoderUsed = 'prores_ks'
  } else if (normalizedCodec === 'vp9') {
    const vp9SpeedMap = {
      ultrafast: 8,
      superfast: 7,
      veryfast: 6,
      faster: 5,
      fast: 4,
      medium: 3,
      slow: 2,
      slower: 1,
      veryslow: 0,
    }
    args.push(
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuv420p',
      '-row-mt', '1',
      '-cpu-used', String(vp9SpeedMap[preset] ?? 3)
    )
    encoderUsed = 'libvpx-vp9'
    if (qualityMode === 'bitrate') {
      args.push('-b:v', `${bitrateKbps}k`)
    } else {
      args.push('-crf', String(crf), '-b:v', '0')
    }
  } else if (normalizedCodec === 'h265') {
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'hevc_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'hevc_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx265',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx265'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
    args.push('-tag:v', 'hvc1')
  } else {
    // Default to H.264
    if (useHardwareEncoder) {
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-pix_fmt', 'yuv420p',
        '-rc', qualityMode === 'bitrate' ? 'vbr' : 'vbr'
      )
      encoderUsed = 'h264_nvenc'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-cq', String(crf))
      }
    } else {
      args.push(
        '-c:v', 'libx264',
        '-preset', preset,
        '-pix_fmt', 'yuv420p'
      )
      encoderUsed = 'libx264'
      if (qualityMode === 'bitrate') {
        args.push('-b:v', `${bitrateKbps}k`)
      } else {
        args.push('-crf', String(crf))
      }
    }
  }

  if (keyframeInterval && Number(keyframeInterval) > 0) {
    args.push('-g', String(keyframeInterval), '-keyint_min', String(keyframeInterval))
  }

  if (format === 'mp4') {
    args.push('-movflags', '+faststart')
  }

  if (audioPath) {
    const useOpus = format === 'webm' || audioCodec === 'opus'
    args.push('-c:a', useOpus ? 'libopus' : 'aac')
    args.push('-b:a', `${audioBitrateKbps}k`)
    args.push('-ar', String(audioSampleRate))
  }

  args.push(outputPath)
  console.log(`[Export] Encoding with ${encoderUsed} (${useHardwareEncoder ? 'NVENC' : 'software'})`)

  return await new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, encoderUsed })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}`, encoderUsed })
      }
    })
  })
})

// ============================================
// Playback cache (Flame-style: transcode for smooth playback)
// ============================================
ipcMain.handle('playback:transcode', async (event, { inputPath, outputPath }) => {
  if (!ffmpegPath) {
    return { success: false, error: 'FFmpeg binary not available.' }
  }
  if (!inputPath || !outputPath) {
    return { success: false, error: 'Missing inputPath or outputPath.' }
  }

  // Same dimensions, H.264, keyframe every 6 frames, no B-frames = easy decode
  const args = [
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-g', '6',
    '-keyint_min', '6',
    '-bf', '0',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath
  ]

  return await new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true })
    let stderr = ''

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    ffmpeg.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true })
      } else {
        resolve({ success: false, error: stderr || `FFmpeg exited with code ${code}` })
      }
    })
  })
})

ipcMain.handle('export:checkNvenc', async () => {
  const gpuName = await detectNvidiaGpuName()

  if (!ffmpegPath) {
    return { available: false, h264: false, h265: false, gpuName, error: 'FFmpeg binary not available.' }
  }
  
  return await new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true })
    let output = ''
    
    ffmpeg.stdout.on('data', (data) => {
      output += data.toString()
    })
    ffmpeg.stderr.on('data', (data) => {
      output += data.toString()
    })
    
    ffmpeg.on('error', (err) => {
      resolve({ available: false, h264: false, h265: false, gpuName, error: err.message })
    })
    
    ffmpeg.on('close', () => {
      const hasH264 = output.includes('h264_nvenc')
      const hasH265 = output.includes('hevc_nvenc')
      resolve({
        available: hasH264 || hasH265,
        h264: hasH264,
        h265: hasH265,
        gpuName,
      })
    })
  })
})

// ============================================
// App Lifecycle
// ============================================

app.whenReady().then(() => {
  registerFileProtocol()
  // Auto-approve `local-fonts` so window.queryLocalFonts() works
  // without a permission prompt — the Text panel and Inspector need
  // it to enumerate the user's installed fonts. Every other
  // permission stays default-deny.
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      if (permission === 'local-fonts') return callback(true)
      return callback(false)
    })
  } catch (err) {
    console.warn('[main] could not install local-fonts permission handler:', err?.message || err)
  }
  initComfyLauncher()
    .then(() => maybeAutoStartComfyLauncher())
    .catch((error) => {
      console.warn('[comfyLauncher] init failed:', error?.message || error)
    })
  const splash = createSplashWindow()
  splash.webContents.once('did-finish-load', () => {
    runStartupChecks()
      .then(() => {
        createWindow()
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close()
          splashWindow = null
        }
      })
      .catch((err) => {
        console.error('Startup checks failed:', err)
        createWindow()
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close()
          splashWindow = null
        }
      })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', async (event) => {
  if (launcherQuitConfirmed) return
  const state = comfyLauncher.getState()
  const ownsRunning = state.ownership === 'ours' && (state.state === 'running' || state.state === 'starting')
  if (!ownsRunning) return

  event.preventDefault()
  try {
    const choice = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: 'question',
      buttons: ['Stop ComfyUI & quit', 'Leave ComfyUI running', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Quit ComfyStudio?',
      message: 'ComfyUI is still running.',
      detail: 'ComfyStudio started ComfyUI. Choose what happens to it when you quit.\n\n• Stop ComfyUI & quit — shuts down ComfyUI and cancels any in-flight generation jobs.\n• Leave ComfyUI running — ComfyStudio will quit but ComfyUI stays up. Handy when you\'re just relaunching ComfyStudio and don\'t want to wait for ComfyUI to boot again.',
    })
    if (choice.response === 2) {
      return
    }
    if (choice.response === 1) {
      await comfyLauncher.detach()
    } else {
      await comfyLauncher.shutdown({ confirmStop: true })
    }
  } catch (error) {
    console.warn('[comfyLauncher] before-quit shutdown error:', error?.message || error)
  }
  launcherQuitConfirmed = true
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Handle any uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error)
})
