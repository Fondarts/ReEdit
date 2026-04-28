const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,
  isElectron: true,
  
  // ============================================
  // Dialog Operations
  // ============================================
  
  /**
   * Open a directory picker dialog
   * @param {Object} options - { title, defaultPath }
   * @returns {Promise<string|null>} Selected directory path or null if cancelled
   */
  selectDirectory: (options) => ipcRenderer.invoke('dialog:selectDirectory', options),
  
  /**
   * Open a file picker dialog
   * @param {Object} options - { title, defaultPath, filters, multiple }
   * @returns {Promise<string|string[]|null>} Selected file path(s) or null if cancelled
   */
  selectFile: (options) => ipcRenderer.invoke('dialog:selectFile', options),
  
  /**
   * Open a save file dialog
   * @param {Object} options - { title, defaultPath, filters }
   * @returns {Promise<string|null>} Save path or null if cancelled
   */
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  
  // ============================================
  // File System Operations
  // ============================================
  
  /**
   * Check if a file or directory exists
   * @param {string} filePath 
   * @returns {Promise<boolean>}
   */
  exists: (filePath) => ipcRenderer.invoke('fs:exists', filePath),
  
  /**
   * Check if path is a directory
   * @param {string} filePath 
   * @returns {Promise<boolean>}
   */
  isDirectory: (filePath) => ipcRenderer.invoke('fs:isDirectory', filePath),
  
  /**
   * Create a directory (recursive by default)
   * @param {string} dirPath 
   * @param {Object} options - { recursive }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  createDirectory: (dirPath, options) => ipcRenderer.invoke('fs:createDirectory', dirPath, options),
  
  /**
   * Read a file
   * @param {string} filePath 
   * @param {Object} options - { encoding } - null for binary (returns base64)
   * @returns {Promise<{success: boolean, data?: string, encoding?: string, error?: string}>}
   */
  readFile: (filePath, options) => ipcRenderer.invoke('fs:readFile', filePath, options),
  
  /**
   * Read a file as ArrayBuffer
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, data?: ArrayBuffer, error?: string}>}
   */
  readFileAsBuffer: (filePath) => ipcRenderer.invoke('fs:readFileAsBuffer', filePath),
  
  /**
   * Write a file
   * @param {string} filePath 
   * @param {string|Object} data - String, JSON object, or base64 string
   * @param {Object} options - { encoding } - 'base64' for binary data
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeFile: (filePath, data, options) => ipcRenderer.invoke('fs:writeFile', filePath, data, options),
  
  /**
   * Write a file from ArrayBuffer (for binary files like videos, images)
   * @param {string} filePath 
   * @param {ArrayBuffer} arrayBuffer 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeFileFromArrayBuffer: (filePath, arrayBuffer) => ipcRenderer.invoke('fs:writeFileFromArrayBuffer', filePath, arrayBuffer),

  // ============================================
  // Export Operations
  // ============================================

  /**
   * Encode a frame sequence into a video file
   * @param {Object} options - { framePattern, fps, outputPath, audioPath, format }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  encodeVideo: (options) => ipcRenderer.invoke('export:encodeVideo', options),

  /**
   * Mix timeline audio clips into a WAV file using FFmpeg
   * @param {Object} options - { projectPath, outputPath, rangeStart, rangeEnd, sampleRate, channels, clips, tracks, assets, timeoutMs }
   * @returns {Promise<{success: boolean, error?: string, clipCount?: number}>}
   */
  mixAudio: (options) => ipcRenderer.invoke('export:mixAudio', options),

  // Export worker (run export in separate window so main UI stays responsive)
  runExportInWorker: (payload) => ipcRenderer.invoke('export:runInWorker', payload),
  onExportProgress: (cb) => {
    ipcRenderer.on('export:progress', (_, data) => cb(data))
  },
  onExportComplete: (cb) => {
    ipcRenderer.on('export:complete', (_, data) => cb(data))
  },
  onExportError: (cb) => {
    ipcRenderer.on('export:error', (_, err) => cb(err))
  },
  onExportJob: (cb) => {
    ipcRenderer.once('export:job', (_, job) => cb(job))
  },
  sendExportWorkerReady: () => ipcRenderer.send('export:workerReady'),
  sendExportProgress: (data) => ipcRenderer.send('export:progress', data),
  sendExportComplete: (data) => ipcRenderer.send('export:complete', data),
  sendExportError: (err) => ipcRenderer.send('export:error', err),

  /**
   * Check if FFmpeg supports NVIDIA NVENC encoders
   * @returns {Promise<{available: boolean, h264: boolean, h265: boolean, gpuName?: string | null, error?: string}>}
   */
  checkNvenc: () => ipcRenderer.invoke('export:checkNvenc'),

  /**
   * Transcode video for playback cache (same resolution, H.264, keyframe every 6, no B-frames)
   * @param {{ inputPath: string, outputPath: string }}
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  transcodeForPlayback: (options) => ipcRenderer.invoke('playback:transcode', options),
  
  /**
   * Delete a file
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', filePath),
  
  /**
   * Delete a directory
   * @param {string} dirPath 
   * @param {Object} options - { recursive }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteDirectory: (dirPath, options) => ipcRenderer.invoke('fs:deleteDirectory', dirPath, options),
  
  /**
   * Copy a file
   * @param {string} srcPath 
   * @param {string} destPath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  copyFile: (srcPath, destPath) => ipcRenderer.invoke('fs:copyFile', srcPath, destPath),
  
  /**
   * Move/rename a file
   * @param {string} srcPath 
   * @param {string} destPath 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  moveFile: (srcPath, destPath) => ipcRenderer.invoke('fs:moveFile', srcPath, destPath),
  
  /**
   * List directory contents
   * @param {string} dirPath 
   * @param {Object} options - { includeStats }
   * @returns {Promise<{success: boolean, items: Array, error?: string}>}
   */
  listDirectory: (dirPath, options) => ipcRenderer.invoke('fs:listDirectory', dirPath, options),
  
  /**
   * Get file info (stats)
   * @param {string} filePath 
   * @returns {Promise<{success: boolean, info?: Object, error?: string}>}
   */
  getFileInfo: (filePath) => ipcRenderer.invoke('fs:getFileInfo', filePath),
  
  // ============================================
  // Path Operations
  // ============================================
  
  /**
   * Join path segments
   * @param {...string} parts 
   * @returns {Promise<string>}
   */
  pathJoin: (...parts) => ipcRenderer.invoke('path:join', ...parts),
  
  /**
   * Get directory name from path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathDirname: (filePath) => ipcRenderer.invoke('path:dirname', filePath),
  
  /**
   * Get base name from path
   * @param {string} filePath 
   * @param {string} ext - Optional extension to remove
   * @returns {Promise<string>}
   */
  pathBasename: (filePath, ext) => ipcRenderer.invoke('path:basename', filePath, ext),
  
  /**
   * Get extension from path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathExtname: (filePath) => ipcRenderer.invoke('path:extname', filePath),
  
  /**
   * Normalize a path
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  pathNormalize: (filePath) => ipcRenderer.invoke('path:normalize', filePath),
  
  /**
   * Get special app path
   * @param {string} name - home, appData, userData, documents, downloads, temp, etc.
   * @returns {Promise<string>}
   */
  getAppPath: (name) => ipcRenderer.invoke('path:getAppPath', name),
  
  // ============================================
  // Media URL Operations
  // ============================================
  
  /**
   * Get a URL for a local file (using comfystudio:// protocol)
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  getFileUrl: (filePath) => ipcRenderer.invoke('media:getFileUrl', filePath),

  /**
   * Read a local file as a base64 data URL. Needed by renderer code that
   * has to feed image bytes into multimodal APIs (fetch() can't read the
   * comfystudio:// protocol).
   * @param {string} filePath
   * @param {string} [mimeType]
   * @returns {Promise<{success: boolean, dataUrl?: string, bytes?: number, error?: string}>}
   */
  readFileAsDataUrl: (filePath, mimeType) => ipcRenderer.invoke('media:readFileAsDataUrl', filePath, mimeType),

  /**
   * Write text to the OS clipboard via the main-process clipboard.
   * More reliable than navigator.clipboard.writeText when we're about
   * to openExternal and steal focus in the same turn.
   * @param {string} text
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  writeTextToClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),

  /**
   * Reveal a file in the OS file manager (selected/highlighted).
   * @param {string} filePath absolute path
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  
  /**
   * Get video stream info via ffprobe (Electron only)
   * @param {string} filePath
   * @returns {Promise<{success: boolean, fps?: number, hasAudio?: boolean, videoCodec?: string, audioCodec?: string, error?: string}>}
   */
  getVideoFps: (filePath) => ipcRenderer.invoke('media:getVideoFps', filePath),

  // ============================================
  // project:re-edit — analysis pipeline
  // ============================================

  /**
   * Detect scene boundaries via FFmpeg's scene filter.
   * @param {string} videoPath
   * @param {{ threshold?: number, minSceneDurSec?: number, totalDurationSec?: number }} options
   * @returns {Promise<{success: boolean, scenes?: Array<{id, index, tcIn, tcOut, duration}>, error?: string}>}
   */
  detectScenes: (videoPath, options) => ipcRenderer.invoke('analysis:detectScenes', videoPath, options),

  /**
   * Extract a single JPEG frame at tcSec and write it to outputPath.
   * @param {{ videoPath: string, tcSec: number, outputPath: string, width?: number }} options
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  extractThumbnail: (options) => ipcRenderer.invoke('analysis:extractThumbnail', options),

  /**
   * Extract a contiguous sub-clip (tcIn..tcOut) of the source video to
   * its own MP4. Stream-copy (fast, keyframe-aligned).
   * @param {{ videoPath: string, tcIn: number, tcOut: number, outputPath: string }} options
   * @returns {Promise<{success: boolean, path?: string, cached?: boolean, error?: string}>}
   */
  extractSceneClip: (options) => ipcRenderer.invoke('analysis:extractSceneClip', options),

  /**
   * Remove on-screen graphics from a shot's cached clip using Wan VACE
   * in ComfyUI. End-to-end: mask generation → upload → queue → poll →
   * copy back into the project. Progress stream arrives via
   * `onOptimizeFootageProgress`.
   * @param {{ scene: object, projectDir: string, comfyUrl?: string }} options
   * @returns {Promise<{success: boolean, promptId?: string, outputPath?: string, inProjectDir?: boolean, error?: string}>}
   */
  optimizeFootage: (options) => ipcRenderer.invoke('analysis:optimizeFootage', options),

  /**
   * Preview-only mask pass: runs make_mask.py and returns paths to the
   * generated mask / blank videos, skipping ComfyUI + composite. Use to
   * iterate on ROI / threshold / persistence cheaply.
   * @param {{ scene: object, projectDir: string }} options
   * @returns {Promise<{success: boolean, maskPath?: string, blankPath?: string, argsUsed?: string[], scriptStdout?: string, scriptStderr?: string, error?: string}>}
   */
  previewMask: (options) => ipcRenderer.invoke('analysis:previewMask', options),
  onOptimizeFootageProgress: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('analysis:optimizeFootage:progress', handler)
    return () => ipcRenderer.removeListener('analysis:optimizeFootage:progress', handler)
  },

  /**
   * Separate the source video's audio into VO (vocals) and Music
   * (no_vocals) stems using Demucs. Long-running — proportional to
   * clip length, and CUDA vs CPU matters a lot. Progress stream
   * arrives via `onSeparateStemsProgress`.
   * @param {{ sourceVideoPath: string, projectDir: string, model?: string, device?: string }} options
   * @returns {Promise<{success: boolean, vocalsPath?: string, musicPath?: string, model?: string, cached?: boolean, error?: string}>}
   */
  separateStems: (options) => ipcRenderer.invoke('analysis:separateStems', options),
  onSeparateStemsProgress: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('analysis:separateStems:progress', handler)
    return () => ipcRenderer.removeListener('analysis:separateStems:progress', handler)
  },

  /**
   * Bake a zoom/pan reframe into a physical MP4. ffmpeg pre-crops the
   * source sub-clip by the given zoom + anchor; ComfyUI then runs a
   * RealESRGAN upscale-only workflow to bring the resolution back to
   * delivery quality. Output joins the scene's optimization stack
   * with an `R{NN}` tag alongside any existing `V{NN}` VACE entries.
   * @param {{ sceneId: string, sourceVideoPath: string, projectDir: string, zoom: number, anchorX: number, anchorY: number, targetW: number, targetH: number, comfyUrl?: string }} options
   * @returns {Promise<{success: boolean, version?: string, outputPath?: string, kind?: string, error?: string}>}
   */
  commitReframe: (options) => ipcRenderer.invoke('analysis:commitReframe', options),
  onCommitReframeProgress: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('analysis:commitReframe:progress', handler)
    return () => ipcRenderer.removeListener('analysis:commitReframe:progress', handler)
  },

  /**
   * Footage extend: sends the scene's cached sub-clip + its last frame
   * to ComfyUI for LTX 2.3 image-to-video generation, then concats the
   * AI-generated tail onto the original. Output lands under
   * `{projectDir}/.reedit/optimized/{sceneId}_E{NN}.mp4` and joins the
   * scene's optimization stack with an `E{NN}` tag.
   * @param {{ sceneId: string, projectDir: string, extendSec: number, workflow: object, loadImageNodeId: string, comfyUrl?: string }} options
   * @returns {Promise<{success: boolean, version?: string, outputPath?: string, kind?: string, error?: string}>}
   */
  commitExtend: (options) => ipcRenderer.invoke('analysis:commitExtend', options),
  onCommitExtendProgress: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('analysis:commitExtend:progress', handler)
    return () => ipcRenderer.removeListener('analysis:commitExtend:progress', handler)
  },

  /**
   * Synthesise a NEW voiceover by cloning the original speaker's voice
   * with F5-TTS via ComfyUI. Each segment in `segments` is a separate
   * generation job; the handler runs them in series and emits progress
   * after every one. Output WAV files land in
   * `{projectDir}/.reedit/vo_generated/{draftId}/{segId}.wav`.
   *
   * `voiceMode` selects the engine:
   *   - 'clone' (default) — F5-TTS, requires `voiceRef`.
   *   - 'kokoro' — Kokoro-TTS, requires `kokoroVoice` (e.g. 'af_bella').
   *     `voiceRef` is ignored.
   * `nfeSteps` (16-64, default 32) only applies to clone mode (F5).
   * `speed` (0.7-1.4, default 1.0) is a post-time-stretch in BOTH modes;
   * for Kokoro it's the node's `speed` input directly.
   *
   * @param {{
   *   draftId: string,
   *   projectDir: string,
   *   segments: Array<{ id: string, text: string }>,
   *   voiceRef?: { audioPath: string, transcript: string, startSec: number, endSec: number },
   *   voiceMode?: 'clone'|'kokoro',
   *   kokoroVoice?: string,
   *   language?: string,
   *   nfeSteps?: number,
   *   speed?: number,
   *   comfyUrl?: string,
   * }} options
   * @returns {Promise<{success: boolean, segmentAudio?: Object, error?: string}>}
   */
  synthesizeVoiceover: (options) => ipcRenderer.invoke('analysis:synthesizeVoiceover', options),
  onSynthesizeVoiceoverProgress: (cb) => {
    const handler = (_, payload) => cb(payload)
    ipcRenderer.on('analysis:synthesizeVoiceover:progress', handler)
    return () => ipcRenderer.removeListener('analysis:synthesizeVoiceover:progress', handler)
  },

  /**
   * Extract audio waveform peaks via ffmpeg (Electron only)
   * @param {string} mediaInput - file:// URL, comfystudio:// URL, or absolute path
   * @param {object} options - { sampleCount?: number, sampleRate?: number }
   * @returns {Promise<{success: boolean, peaks?: number[], duration?: number, error?: string}>}
   */
  getAudioWaveform: (mediaInput, options = {}) => ipcRenderer.invoke('media:getAudioWaveform', mediaInput, options),

  /**
   * Mix the full timeline's program audio into a single mono 16 kHz WAV file
   * via FFmpeg in the main process. Required for timeline-scope transcription
   * (decoding long videos in the renderer via Web Audio causes renderer OOMs).
   * @param {{ projectPath?: string, clips: Array, tracks: Array, assets: Array, duration: number, sampleRate?: number, timeoutMs?: number }} options
   * @returns {Promise<{success: boolean, outputPath?: string, size?: number, clipCount?: number, error?: string}>}
   */
  mixTimelineAudioForCaptions: (options = {}) => ipcRenderer.invoke('captions:mixTimelineAudio', options),

  /**
   * Get a direct file:// URL for a local file
   * @param {string} filePath 
   * @returns {Promise<string>}
   */
  getFileUrlDirect: (filePath) => ipcRenderer.invoke('media:getFileUrlDirect', filePath),

  // ============================================
  // App Settings (persistent storage in userData)
  // ============================================
  
  /**
   * Get a setting value
   * @param {string} key - Optional, returns all settings if not provided
   * @returns {Promise<any>}
   */
  getSetting: (key) => ipcRenderer.invoke('settings:get', key),
  
  /**
   * Set a setting value
   * @param {string} key 
   * @param {any} value 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  
  /**
   * Delete a setting
   * @param {string} key 
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteSetting: (key) => ipcRenderer.invoke('settings:delete', key),

  // ============================================
  // Workflow Setup Manager
  // ============================================

  loadComfyUiWorkflowGraph: (payload = {}) => ipcRenderer.invoke('comfyui:loadWorkflowGraph', payload),
  validateWorkflowSetupRoot: (rootPath) => ipcRenderer.invoke('workflowSetup:validateRoot', rootPath),
  checkWorkflowSetupFiles: (payload = {}) => ipcRenderer.invoke('workflowSetup:checkFiles', payload),
  openExternalUrl: (url) => ipcRenderer.invoke('shell:openExternal', url),
  installWorkflowSetup: (payload = {}) => ipcRenderer.invoke('workflowSetup:install', payload),
  onWorkflowSetupProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('workflowSetup:progress', handler)
    return () => ipcRenderer.removeListener('workflowSetup:progress', handler)
  },

  // ============================================
  // ComfyUI Launcher (process manager)
  // ============================================

  comfyLauncher: {
    getState: () => ipcRenderer.invoke('comfyLauncher:getState'),
    getConfig: () => ipcRenderer.invoke('comfyLauncher:getConfig'),
    setConfig: (partial) => ipcRenderer.invoke('comfyLauncher:setConfig', partial),
    start: () => ipcRenderer.invoke('comfyLauncher:start'),
    stop: () => ipcRenderer.invoke('comfyLauncher:stop'),
    restart: () => ipcRenderer.invoke('comfyLauncher:restart'),
    detach: () => ipcRenderer.invoke('comfyLauncher:detach'),
    refresh: () => ipcRenderer.invoke('comfyLauncher:refresh'),
    getLogs: (options) => ipcRenderer.invoke('comfyLauncher:getLogs', options),
    appendLog: (payload) => ipcRenderer.invoke('comfyLauncher:appendLog', payload),
    openLogFile: () => ipcRenderer.invoke('comfyLauncher:openLogFile'),
    detectLaunchers: (payload) => ipcRenderer.invoke('comfyLauncher:detectLaunchers', payload),
    pickLauncherScript: () => ipcRenderer.invoke('comfyLauncher:pickLauncherScript'),
    describePortOwner: () => ipcRenderer.invoke('comfyLauncher:describePortOwner'),
    connectExternal: () => ipcRenderer.invoke('comfyLauncher:connectExternal'),
    onState: (cb) => {
      const handler = (_, state) => cb(state)
      ipcRenderer.on('comfyLauncher:state', handler)
      return () => ipcRenderer.removeListener('comfyLauncher:state', handler)
    },
    onLog: (cb) => {
      const handler = (_, entry) => cb(entry)
      ipcRenderer.on('comfyLauncher:log', handler)
      return () => ipcRenderer.removeListener('comfyLauncher:log', handler)
    },
  },

  // ============================================
  // Window Controls
  // ============================================

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  toggleFullScreenWindow: () => ipcRenderer.invoke('window:toggleFullScreen'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  getWindowState: () => ipcRenderer.invoke('window:getState'),
  onWindowStateChanged: (cb) => {
    const handler = (_, state) => cb(state)
    ipcRenderer.on('window:stateChanged', handler)
    return () => ipcRenderer.removeListener('window:stateChanged', handler)
  },
})

// Also expose a simple check for detecting Electron
contextBridge.exposeInMainWorld('isElectron', true)
