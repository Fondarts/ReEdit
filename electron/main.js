const { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard, shell } = require('electron')
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

    try {
      const normalizedPath = path.normalize(filePath)
      const res = await net.fetch(`file://${normalizedPath}`)
      // Tell Chromium not to heuristically cache this response. The
      // files these URLs point at (scene thumbnails, generated clips)
      // routinely get overwritten in place between analysis /
      // generation runs, so caching served stale frames and made it
      // look like new analyses were producing the wrong thumbnails.
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      headers.set('Pragma', 'no-cache')
      headers.set('Expires', '0')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
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
  // Match your splash image aspect ratio (1632×656); extra height for status bar
  const SPLASH_ASPECT = 1632 / 656
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
  // Windows ships `python` (the py launcher shim); other platforms
  // typically only expose `python3` as a first-class executable.
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
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
          error: `Python interpreter not found (looked for "${pythonCmd}" in PATH). Install Python 3 and retry.`,
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

// Dilate kernel size used by make_mask.py. 25 keeps the mask tight
// around the graphic itself; the composite feather (σ=15) now does
// most of the work softening the patch edge, so we can afford to stop
// over-expanding the mask into background pixels.
const MASK_DILATE_KERNEL = '25'

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
function extractBboxes(graphics) {
  if (!graphics || typeof graphics !== 'object') return []
  const direct = Array.isArray(graphics.bboxes) ? graphics.bboxes : null
  const nested = Array.isArray(graphics.removal_hint?.bboxes) ? graphics.removal_hint.bboxes : null
  const source = (direct && direct.length) ? direct : (nested && nested.length) ? nested : []
  const out = []
  for (const b of source) {
    if (!b) continue
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
    out.push({ box_2d: [ymin, xmin, ymax, xmax], role: b.role || null, label: b.label || null })
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
  // Prefer an explicit env override (user can pin to a venv). Fall back
  // to plain `python` which Windows resolves via the launcher.
  return process.env.REEDIT_PYTHON || process.env.PYTHON || 'python'
}

// Read ComfyUI's `--input-directory` argv by hitting /system_stats.
// The script-copied source/mask/blank files need to sit somewhere
// ComfyUI's VHS_LoadVideo node can find them by relative name.
async function resolveComfyInputDir(comfyUrl) {
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

  const maskScriptPath = path.resolve(__dirname, '..', '..', 'make_mask.py')
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
  const { scene, projectDir, comfyUrl: comfyUrlOpt } = options || {}
  if (!scene?.id) return { success: false, error: 'scene.id required.' }
  if (!projectDir) return { success: false, error: 'projectDir required.' }
  const sceneId = scene.id
  const comfyUrl = comfyUrlOpt || 'http://localhost:8000'

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
  // Locate make_mask.py one level above the reedit package (project
  // root has `make_mask.py` next to the other standalone helpers).
  const maskScriptPath = path.resolve(__dirname, '..', '..', 'make_mask.py')
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

  // 4. Copy (source / mask / blank) into ComfyUI's input dir with a
  //    project-prefixed filename so two re-edit projects optimizing the
  //    same scene id don't stomp each other's inputs.
  const comfyInputDir = await resolveComfyInputDir(comfyUrl)
  if (!comfyInputDir) {
    return { success: false, error: `Could not determine ComfyUI input dir from ${comfyUrl}/system_stats — is ComfyUI running?` }
  }
  const prefix = `reedit_${sanitizeForFilename(path.basename(projectDir))}_${sanitizeForFilename(sceneId)}`
  const comfySrcName = `${prefix}_blank.mp4`
  const comfyMaskName = `${prefix}_mask.mp4`
  const comfySrcFullPath = path.join(comfyInputDir, comfySrcName)
  const comfyMaskFullPath = path.join(comfyInputDir, comfyMaskName)
  try {
    await copyFileOverwrite(blankPath, comfySrcFullPath)
    await copyFileOverwrite(maskPath, comfyMaskFullPath)
  } catch (err) {
    return { success: false, error: `Failed to copy inputs into ComfyUI input dir: ${err.message}` }
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
    const submitRes = await net.fetch(`${comfyUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
    })
    if (!submitRes.ok) {
      const body = await submitRes.text().catch(() => '')
      return { success: false, error: `ComfyUI rejected the workflow (${submitRes.status}): ${body.slice(0, 400)}` }
    }
    const submitJson = await submitRes.json()
    promptId = submitJson?.prompt_id
    if (!promptId) return { success: false, error: 'ComfyUI returned no prompt_id.' }
  } catch (err) {
    return { success: false, error: `Could not reach ComfyUI at ${comfyUrl}: ${err.message}` }
  }

  emit('queued', { promptId })

  // 6. Poll /history until the job finishes. 10-minute hard cap — Wan
  //    VACE 1.3B at 768×432 + upscale runs ~12 min in our tests, so the
  //    cap is generous for shots up to ~90 frames. Bigger jobs should
  //    raise it in the renderer.
  const MAX_POLL_MS = 20 * 60 * 1000
  const POLL_EVERY_MS = 4000
  const startedAt = Date.now()
  let result
  while (true) {
    if (Date.now() - startedAt > MAX_POLL_MS) {
      return { success: false, error: `Timed out waiting for ${promptId} after ${MAX_POLL_MS / 60000} min.` }
    }
    try {
      const histRes = await net.fetch(`${comfyUrl}/history/${promptId}`)
      if (histRes.ok) {
        const hist = await histRes.json()
        const entry = hist?.[promptId]
        if (entry?.status?.completed) {
          result = entry
          break
        }
        if (entry?.status?.status_str === 'error') {
          const msgs = (entry.status.messages || []).map((m) => JSON.stringify(m)).join(' | ')
          return { success: false, error: `ComfyUI reported workflow error: ${msgs.slice(0, 600)}` }
        }
      }
    } catch (err) {
      emit('poll_warn', { message: err.message })
    }
    emit('running', { elapsedSec: Math.round((Date.now() - startedAt) / 1000) })
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS))
  }

  // 7. Extract the output filename from the history entry and copy the
  //    finished video back into the project's `.reedit/optimized` dir
  //    so it travels with the project and shows up in the UI.
  let outputFile = null
  for (const out of Object.values(result.outputs || {})) {
    const gifs = Array.isArray(out?.gifs) ? out.gifs : []
    for (const g of gifs) {
      if (g?.fullpath) { outputFile = g.fullpath; break }
    }
    if (outputFile) break
  }
  if (!outputFile) {
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
    await copyFileOverwrite(outputFile, vaceRawPath)
  } catch (err) {
    // Non-fatal: leave the file at the ComfyUI output location and
    // skip the composite step. Return the ComfyUI path so the UI can
    // still link to it.
    emit('note', { message: `Could not copy VACE output to project dir (${err.message}); using ComfyUI output path.` })
    return { success: true, promptId, outputPath: outputFile, inProjectDir: false, composited: false, version: versionTag }
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
    feather: 15,
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
    emit('done', { promptId, outputPath: vaceRawPath, version: versionTag })
    return { success: true, promptId, outputPath: vaceRawPath, inProjectDir: true, composited: false, compositeError: compRes.error, version: versionTag }
  }

  emit('done', { promptId, outputPath: finalPath, version: versionTag })
  return { success: true, promptId, outputPath: finalPath, inProjectDir: true, composited: true, vaceRawPath, version: versionTag }
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

  const cacheKey = `${filePath}|${sampleCount}|${sampleRate}|${stat.mtimeMs}`
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
        const bucketSize = Math.max(1, Math.floor(floatCount / bucketCount))
        const peaks = new Array(bucketCount).fill(0)
        let maxPeak = 0

        for (let i = 0; i < bucketCount; i++) {
          const start = i * bucketSize
          const end = i === bucketCount - 1 ? floatCount : Math.min(floatCount, start + bucketSize)
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

    let inputPath = null
    if (asset.path && projectPath) {
      inputPath = path.join(projectPath, asset.path)
    }
    if (!inputPath && asset.url) {
      inputPath = resolveMediaInputPath(asset.url)
    }
    if (!inputPath && clip.url) {
      inputPath = resolveMediaInputPath(clip.url)
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
      ...buildAtempoFilterChain(entry.timeScale),
    ]

    if (entry.forceMono) {
      filters.push('aformat=channel_layouts=mono')
    }
    if (entry.fadeIn > 0 || entry.fadeOut > 0 || entry.gainDb !== 0 || entry.trackVolume !== 100) {
      filters.push(`volume='${buildAudioFadeVolumeExpression(entry.clipDuration, entry.fadeIn, entry.fadeOut, entry.clipOffsetOnTimeline, entry.gainDb, entry.trackVolume)}':eval=frame`)
    }
    if (entry.delayMs > 0) {
      filters.push(`adelay=${entry.delayMs}:all=1`)
    }

    const label = `mix${index}`
    inputFilters.push(`[${index}:a]${filters.join(',')}[${label}]`)
    mixLabels.push(`[${label}]`)
  })

  const finalMixFilter = mixLabels.length === 1
    ? `${mixLabels[0]}atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
    : `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${formatFilterNumber(totalDuration)},asetpts=PTS-STARTPTS[outa]`
  const filterComplex = `${inputFilters.join(';')};${finalMixFilter}`

  args.push(
    '-filter_complex', filterComplex,
    '-map', '[outa]',
    '-ar', String(normalizedSampleRate),
    '-ac', String(normalizedChannels),
    '-c:a', 'pcm_s16le',
    outputPath
  )

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
