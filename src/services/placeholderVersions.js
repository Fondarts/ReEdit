/**
 * project:re-edit — version bookkeeping for generated placeholder fills.
 *
 * Two generation backends store their output differently:
 *   - Advanced (`ProposalView` + `reeditGenerate.js`): a single video on
 *     `row.genSpec.generatedPath`.
 *   - Simple / Auto (`ProposalViewSimple` + `reeditFills.js`): a single
 *     fill object on `project.fills[placeholderId]`.
 *
 * Both used to OVERWRITE on re-generation. This module adds a versions
 * array next to the existing "active" field so the user can keep several
 * renders and switch between them — WITHOUT changing what the timeline
 * populator reads (it still reads the mirrored top-level `path` /
 * `generatedPath`). Migration is lazy: a legacy flat fill / genSpec is
 * wrapped as `versions[0]` the first time we touch it.
 *
 * All transforms here are pure (no store access): callers hand in the
 * fill/genSpec object, get a new one back, and persist it themselves.
 */

export function newVersionId() {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ─────────────────────────────────────────────────────────────────────
// Simple / Auto — project.fills[pid]
// ─────────────────────────────────────────────────────────────────────

// Fields that make up a single fill version. The top-level fill object
// mirrors the ACTIVE version's fields so existing readers (timeline,
// thumbnails) keep working untouched.
const FILL_VERSION_FIELDS = [
  'path', 'referenceFramePath', 'modelId', 'createdAt',
  'promptSnapshot', 'referenceFrameSnapshot', 'durationSec',
]

function pickFillVersionFields(obj) {
  const out = {}
  for (const k of FILL_VERSION_FIELDS) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

// Return a fill guaranteed to carry `versions[]` + `activeVersionId`,
// migrating a legacy flat fill into `versions[0]`. Returns null for an
// empty/absent fill.
export function normalizeFill(fill) {
  if (!fill || typeof fill !== 'object') return null
  if (Array.isArray(fill.versions) && fill.versions.length > 0) {
    const activeVersionId = fill.activeVersionId && fill.versions.some((v) => v.id === fill.activeVersionId)
      ? fill.activeVersionId
      : fill.versions[fill.versions.length - 1].id
    return mirrorActiveFill({ ...fill, activeVersionId })
  }
  if (!fill.path) return null
  const v0 = { id: newVersionId(), ...pickFillVersionFields(fill) }
  return mirrorActiveFill({ ...fill, versions: [v0], activeVersionId: v0.id })
}

// Copy the active version's fields up to the top level so the timeline /
// thumbnails read the right MP4 without knowing about versions.
function mirrorActiveFill(fill) {
  const active = fill.versions.find((v) => v.id === fill.activeVersionId) || fill.versions[fill.versions.length - 1]
  return { ...fill, ...pickFillVersionFields(active), activeVersionId: active.id }
}

export function fillVersionList(fill) {
  const n = normalizeFill(fill)
  return n ? n.versions : []
}

export function activeFillVersionId(fill) {
  const n = normalizeFill(fill)
  return n ? n.activeVersionId : null
}

// Append a brand-new render and make it active. `versionFields` is the
// flat result (path, modelId, createdAt, …); we tag it with an id.
export function appendFillVersion(fill, versionFields) {
  const base = normalizeFill(fill) || { versions: [], activeVersionId: null }
  const version = { id: newVersionId(), ...pickFillVersionFields(versionFields) }
  const versions = [...base.versions, version]
  return { fill: mirrorActiveFill({ ...base, versions, activeVersionId: version.id }), versionId: version.id }
}

export function setActiveFillVersion(fill, versionId) {
  const n = normalizeFill(fill)
  if (!n || !n.versions.some((v) => v.id === versionId)) return n
  return mirrorActiveFill({ ...n, activeVersionId: versionId })
}

export function removeFillVersion(fill, versionId) {
  const n = normalizeFill(fill)
  if (!n) return null
  const versions = n.versions.filter((v) => v.id !== versionId)
  if (versions.length === 0) return null
  const activeVersionId = n.activeVersionId === versionId
    ? versions[versions.length - 1].id
    : n.activeVersionId
  return mirrorActiveFill({ ...n, versions, activeVersionId })
}

// ─────────────────────────────────────────────────────────────────────
// Advanced — row.genSpec
// ─────────────────────────────────────────────────────────────────────

// Output fields that describe one i2v video render. Mirrored to the
// top level of genSpec so `reeditEdlToTimeline.js` keeps reading
// `genSpec.generatedPath` / `genSpec.durationSec`.
const VIDEO_VERSION_FIELDS = [
  'generatedPath', 'prompt', 'model', 'generatedAt',
  'durationSec', 'frames', 'fps', 'width', 'height', 'refSceneId', 'frameId',
]

function pickVideoVersionFields(obj) {
  const out = {}
  for (const k of VIDEO_VERSION_FIELDS) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

// Only the playback-relevant fields get mirrored up; `prompt` is left
// alone because genSpec.prompt is the user's live editable prompt, not
// necessarily the one a past version was rendered with.
const VIDEO_MIRROR_FIELDS = VIDEO_VERSION_FIELDS.filter((k) => k !== 'prompt')

function mirrorActiveVideo(genSpec) {
  const active = genSpec.videoVersions.find((v) => v.id === genSpec.activeVideoVersionId)
    || genSpec.videoVersions[genSpec.videoVersions.length - 1]
  const mirror = {}
  for (const k of VIDEO_MIRROR_FIELDS) if (active[k] !== undefined) mirror[k] = active[k]
  return { ...genSpec, ...mirror, activeVideoVersionId: active.id }
}

// Ensure genSpec carries `videoVersions[]` + `activeVideoVersionId`,
// migrating a legacy single `generatedPath` into `versions[0]`.
export function normalizeGenSpecVersions(genSpec) {
  if (!genSpec || typeof genSpec !== 'object') return genSpec
  if (Array.isArray(genSpec.videoVersions) && genSpec.videoVersions.length > 0) {
    const activeVideoVersionId = genSpec.activeVideoVersionId
      && genSpec.videoVersions.some((v) => v.id === genSpec.activeVideoVersionId)
      ? genSpec.activeVideoVersionId
      : genSpec.videoVersions[genSpec.videoVersions.length - 1].id
    return mirrorActiveVideo({ ...genSpec, activeVideoVersionId })
  }
  if (!genSpec.generatedPath) return genSpec
  const v0 = { id: newVersionId(), ...pickVideoVersionFields(genSpec) }
  return mirrorActiveVideo({ ...genSpec, videoVersions: [v0], activeVideoVersionId: v0.id })
}

export function videoVersionList(genSpec) {
  if (!genSpec) return []
  const n = normalizeGenSpecVersions(genSpec)
  return Array.isArray(n?.videoVersions) ? n.videoVersions : []
}

export function activeVideoVersionId(genSpec) {
  const n = normalizeGenSpecVersions(genSpec)
  return n?.activeVideoVersionId || null
}

export function appendVideoVersion(genSpec, versionFields) {
  const base = normalizeGenSpecVersions(genSpec) || {}
  const existing = Array.isArray(base.videoVersions) ? base.videoVersions : []
  const version = { id: newVersionId(), ...pickVideoVersionFields(versionFields) }
  const videoVersions = [...existing, version]
  return {
    genSpec: mirrorActiveVideo({ ...base, videoVersions, activeVideoVersionId: version.id }),
    versionId: version.id,
  }
}

export function setActiveVideoVersion(genSpec, versionId) {
  const n = normalizeGenSpecVersions(genSpec)
  if (!n || !Array.isArray(n.videoVersions) || !n.videoVersions.some((v) => v.id === versionId)) return n
  return mirrorActiveVideo({ ...n, activeVideoVersionId: versionId })
}

export function removeVideoVersion(genSpec, versionId) {
  const n = normalizeGenSpecVersions(genSpec)
  if (!n || !Array.isArray(n.videoVersions)) return genSpec
  const videoVersions = n.videoVersions.filter((v) => v.id !== versionId)
  if (videoVersions.length === 0) {
    // Drop the video entirely — strip the mirrored output fields too so
    // the timeline falls back to a frame candidate / placeholder card.
    const stripped = { ...n }
    for (const k of VIDEO_MIRROR_FIELDS) delete stripped[k]
    delete stripped.videoVersions
    delete stripped.activeVideoVersionId
    return stripped
  }
  const activeVideoVersionId = n.activeVideoVersionId === versionId
    ? videoVersions[videoVersions.length - 1].id
    : n.activeVideoVersionId
  return mirrorActiveVideo({ ...n, videoVersions, activeVideoVersionId })
}

// ─────────────────────────────────────────────────────────────────────
// Unified resolver — used by the timeline (clip → versions) and any UI
// that wants one shape regardless of which backend produced the fill.
// ─────────────────────────────────────────────────────────────────────

// Given a project + the EDL row's ARRAY index (0-based, the same index
// reeditFills / the timeline use for `placeholder-<i>`), return a single
// normalized view of the row's generated versions.
//
//   { source: 'fills' | 'genSpec' | null, pid, row, activeId,
//     versions: [{ id, path, durationSec, model, prompt, createdAt, isActive }] }
export function placeholderVersionsFor({ project, rowArrayIndex }) {
  const edl = Array.isArray(project?.proposal?.edl) ? project.proposal.edl : []
  const row = edl[rowArrayIndex] || null
  const pid = row?.fillId || `placeholder-${rowArrayIndex}`
  const fills = (project?.fills && typeof project.fills === 'object') ? project.fills : {}

  const fill = normalizeFill(fills[pid])
  if (fill && fill.versions.length > 0) {
    return {
      source: 'fills', pid, row, activeId: fill.activeVersionId,
      versions: fill.versions.map((v) => ({
        id: v.id, path: v.path, durationSec: v.durationSec,
        model: v.modelId, prompt: v.promptSnapshot, createdAt: v.createdAt,
        isActive: v.id === fill.activeVersionId,
      })),
    }
  }

  const versions = videoVersionList(row?.genSpec)
  if (versions.length > 0) {
    const activeId = activeVideoVersionId(row?.genSpec)
    return {
      source: 'genSpec', pid, row, activeId,
      versions: versions.map((v) => ({
        id: v.id, path: v.generatedPath, durationSec: v.durationSec,
        model: v.model, prompt: v.prompt, createdAt: v.generatedAt,
        isActive: v.id === activeId,
      })),
    }
  }

  return { source: null, pid, row, activeId: null, versions: [] }
}

// Build the saveProject() patch that flips a placeholder's active
// version, plus the active path/duration the caller needs to re-point a
// timeline clip. Returns null when nothing changed.
export function buildActiveVersionPatch({ project, rowArrayIndex, versionId }) {
  const info = placeholderVersionsFor({ project, rowArrayIndex })
  if (!info.source) return null
  const target = info.versions.find((v) => v.id === versionId)
  if (!target) return null

  if (info.source === 'fills') {
    const fills = project.fills || {}
    const nextFill = setActiveFillVersion(fills[info.pid], versionId)
    if (!nextFill) return null
    return {
      patch: { fills: { ...fills, [info.pid]: nextFill } },
      activePath: nextFill.path,
      activeDurationSec: nextFill.durationSec,
      pid: info.pid,
    }
  }

  // genSpec — rewrite the row in the EDL
  const edl = project.proposal.edl
  const nextGenSpec = setActiveVideoVersion(edl[rowArrayIndex]?.genSpec, versionId)
  if (!nextGenSpec) return null
  const nextEdl = edl.map((r, i) => (i === rowArrayIndex ? { ...r, genSpec: nextGenSpec } : r))
  return {
    patch: { proposal: { ...project.proposal, edl: nextEdl } },
    activePath: nextGenSpec.generatedPath,
    activeDurationSec: nextGenSpec.durationSec,
    pid: info.pid,
  }
}
