// Model adapter registry. Every generation backend the pipeline can
// target is described by one adapter object:
//
//   {
//     id: string            — stable model id used by settings/UI
//     label: string         — human-readable picker label
//     kind: 'i2v' | 'r2v' | 'v2v' | 'extend' | 'reframe-outpaint' | …
//     mode: 'cloud' | 'local'
//     partner: boolean      — true → submit with extra_data.api_key_comfy_org
//     caps: { minDurationSec?, maxDurationSec?, needsReferenceImage?, … }
//     buildWorkflow(params) — PURE + synchronous; returns the API-format
//                             graph ready for /prompt. All the node-id
//                             knowledge lives inside the adapter.
//   }
//
// Adding a model = one adapter file + one require here. Handlers look
// adapters up by id and never touch node ids themselves.

const ADAPTERS = [
  require('./kling-i2v'),
  require('./grok-i2v'),
  require('./vidu-i2v'),
  require('./seedance-i2v'),
  require('./veo-flf'),
  require('./vidu-extend'),
  require('./luma-reframe'),
  require('./kling-edit'),
]

const byId = new Map(ADAPTERS.map((a) => [a.id, a]))

function getAdapter(id) {
  return byId.get(id) || null
}

function listAdapters({ kind, mode } = {}) {
  return ADAPTERS.filter((a) => (!kind || a.kind === kind) && (!mode || a.mode === mode))
}

module.exports = { ADAPTERS, getAdapter, listAdapters }
