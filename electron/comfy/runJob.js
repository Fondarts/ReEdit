// Generic ComfyUI job runner: upload inputs → build workflow via an
// adapter → queue → poll → download outputs. IPC handlers stay thin —
// they do project-dir bookkeeping and ffmpeg pre/post work, then call
// this for the ComfyUI leg.

const path = require('path')
const { getAdapter } = require('./adapters')
const {
  uploadFileToComfy,
  downloadFromComfy,
  queuePromptToComfy,
  waitForComfyJob,
} = require('./client')

// Pull every downloadable artifact out of a history-shaped result:
// { outputs: { [nodeId]: { images|gifs|videos|audio: [{filename, subfolder, type}] } } }
function collectOutputFiles(result) {
  const files = []
  const outputs = result?.outputs || {}
  for (const record of Object.values(outputs)) {
    for (const kind of ['gifs', 'videos', 'images', 'audio']) {
      for (const f of record?.[kind] || []) {
        if (f?.filename) files.push({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })
      }
    }
  }
  return files
}

// Run one generation job end to end.
//
//   runComfyJob({
//     comfyUrl, apiKey,
//     adapterId: 'kling-v3-omni',
//     params: { prompt, durationSec, … },       // adapter buildWorkflow params
//     inputs: [{ localPath, filename, as }],     // uploaded before the build;
//                                                // `as` names the params key that
//                                                // receives the uploaded filename
//     outputDir,                                 // where downloads land
//     timeoutMs, pollMs, onProgress,
//   }) → { promptId, files: [absolute paths] }
async function runComfyJob({
  comfyUrl, apiKey, adapterId, params = {}, inputs = [],
  outputDir, timeoutMs = 30 * 60 * 1000, pollMs = 3000, onProgress,
}) {
  const adapter = getAdapter(adapterId)
  if (!adapter) throw new Error(`Unknown model adapter "${adapterId}".`)

  const resolvedParams = { ...params }
  for (const input of inputs) {
    onProgress?.('uploading', { filename: input.filename })
    const uploaded = await uploadFileToComfy({
      comfyUrl, apiKey,
      localFilePath: input.localPath,
      filename: input.filename,
    })
    if (input.as) resolvedParams[input.as] = uploaded?.name || input.filename
  }

  const workflow = adapter.buildWorkflow(resolvedParams)

  onProgress?.('queued_submit')
  const promptId = await queuePromptToComfy({
    comfyUrl, apiKey, workflow,
    includeComfyOrgKey: Boolean(adapter.partner),
  })
  onProgress?.('queued', { promptId })

  const startedAt = Date.now()
  const result = await waitForComfyJob({
    comfyUrl, apiKey, promptId, timeoutMs, pollMs,
    onTick: () => onProgress?.('running', { promptId, elapsedSec: Math.round((Date.now() - startedAt) / 1000) }),
  })

  const remoteFiles = collectOutputFiles(result)
  if (remoteFiles.length === 0) throw new Error(`Job ${promptId} finished but produced no downloadable outputs.`)

  const files = []
  for (const rf of remoteFiles) {
    onProgress?.('downloading', { filename: rf.filename })
    const destPath = path.join(outputDir, rf.filename)
    await downloadFromComfy({ comfyUrl, apiKey, ...rf, destPath })
    files.push(destPath)
  }
  onProgress?.('done', { promptId, files })
  return { promptId, files }
}

module.exports = { runComfyJob, collectOutputFiles }
