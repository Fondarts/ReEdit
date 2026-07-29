// Flatten a ComfyUI "save format" workflow that uses SUBGRAPHS into the
// flat prompt-API format the /prompt endpoint accepts.
//
// Why this exists: newer comfy.org templates ship their real graph inside
// `definitions.subgraphs`, with only a handful of wrapper nodes at the top
// level. Our runtime converter (electron/main.js convertUiWorkflowToApi)
// only walks top-level `nodes`, so those templates can't be submitted as
// downloaded. Rather than teach the runtime about subgraph boundaries,
// bypass semantics and dual link formats, we flatten ONCE here and commit
// the API-format result — the same convention the other bundled workflows
// already follow.
//
// Usage:
//   node scripts/flatten-comfy-subgraphs.mjs <input.json> <output.json> [--keep-output <nodeId>]
//
// --keep-output prunes the graph to only what feeds that output node,
// which is how we drop a template's side-by-side "comparison video"
// branch and keep just the clean render.
//
// Handled semantics:
//   * subgraph instances (node.type === a subgraph uuid) are inlined with
//     path-namespaced ids so inner ids can't collide across instances
//   * boundary links: origin_id -10 = the subgraph's input slots,
//     target_id -20 = its output slots
//   * both link encodings: top-level arrays
//     [id, srcNode, srcSlot, dstNode, dstSlot, type] and subgraph dicts
//     { id, origin_id, origin_slot, target_id, target_slot, type }
//   * mode 4 / 2 (bypass / mute): the node is removed and each of its
//     output slots resolves to its first same-typed input, matching
//     ComfyUI's pass-through behaviour
//   * widget values: pulled from widgets_values positionally, skipping
//     inputs that are satisfied by a link
//   * UI-only annotation nodes (Note / MarkdownNote) are dropped

import { readFileSync, writeFileSync } from 'node:fs'

const [inPath, outPath, ...rest] = process.argv.slice(2)
if (!inPath || !outPath) {
  console.error('Usage: node scripts/flatten-comfy-subgraphs.mjs <input.json> <output.json> [--keep-output <nodeId>]')
  process.exit(1)
}
const keepIdx = rest.indexOf('--keep-output')
const keepOutput = keepIdx >= 0 ? rest[keepIdx + 1] : null

const UI_ONLY_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute'])

const doc = JSON.parse(readFileSync(inPath, 'utf-8'))
const subgraphs = new Map((doc.definitions?.subgraphs || []).map((s) => [s.id, s]))

// Normalise either link encoding into a common shape.
function normalizeLinks(links) {
  const out = []
  for (const l of links || []) {
    if (Array.isArray(l)) {
      out.push({ id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] })
    } else if (l && typeof l === 'object') {
      out.push(l)
    }
  }
  return out
}

// A resolved source is { nodeKey, slot } where nodeKey is the flattened id.
// Collected per (scope, nodeId, inputSlot) while walking.
const flat = new Map()   // nodeKey -> { class_type, inputs, _meta, _node }
let resolveCount = 0

function walk(graph, prefix, boundaryInputs) {
  const links = normalizeLinks(graph.links)
  const nodes = graph.nodes || []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const key = (id) => (prefix ? `${prefix}:${id}` : String(id))

  // Map: "targetId/targetSlot" -> link
  const incoming = new Map()
  for (const l of links) incoming.set(`${l.target_id}/${l.target_slot}`, l)

  // Resolve what feeds (nodeId, inputSlot) down to a concrete flattened
  // node + slot, following subgraph boundaries and bypassed nodes.
  function resolveSource(nodeId, slot, guard = 0) {
    if (guard > 200) throw new Error('link resolution cycle')
    const l = incoming.get(`${nodeId}/${slot}`)
    if (!l) return null

    // Subgraph INPUT boundary: hand off to the parent's resolver.
    if (l.origin_id === -10) {
      if (!boundaryInputs) return null
      return boundaryInputs(l.origin_slot)
    }

    const src = byId.get(l.origin_id)
    if (!src) return null

    // Bypassed / muted: pass through to the first input of the same type.
    if (src.mode === 4 || src.mode === 2) {
      const outType = (src.outputs || [])[l.origin_slot]?.type
      const inputs = src.inputs || []
      let idx = inputs.findIndex((i) => i.type === outType)
      if (idx < 0) idx = 0
      return resolveSource(src.id, idx, guard + 1)
    }

    // Nested subgraph instance: resolve inside it, from its output slot.
    if (subgraphs.has(src.type)) {
      const inner = subgraphs.get(src.type)
      const innerPrefix = key(src.id)
      // Its output boundary link tells us which inner node produces it.
      const innerLinks = normalizeLinks(inner.links)
      const outLink = innerLinks.find((il) => il.target_id === -20 && il.target_slot === l.origin_slot)
      if (!outLink) return null
      // Resolve within the inner scope (its nodes are already flattened
      // by the walk below; we just need the producing node's key).
      return resolveInnerProducer(inner, innerPrefix, outLink, src.id)
    }

    if (UI_ONLY_TYPES.has(src.type)) return null
    return { nodeKey: key(src.id), slot: l.origin_slot }
  }

  // For a subgraph output boundary link, find the concrete producer,
  // accounting for bypassed nodes inside the subgraph.
  function resolveInnerProducer(inner, innerPrefix, outLink, instanceId) {
    const innerLinks = normalizeLinks(inner.links)
    const innerById = new Map((inner.nodes || []).map((n) => [n.id, n]))
    const innerIncoming = new Map()
    for (const il of innerLinks) innerIncoming.set(`${il.target_id}/${il.target_slot}`, il)

    let originId = outLink.origin_id
    let originSlot = outLink.origin_slot
    for (let hop = 0; hop < 200; hop++) {
      if (originId === -10) {
        // The subgraph just forwards one of its own inputs straight out.
        return resolveSource(instanceId, originSlot)
      }
      const n = innerById.get(originId)
      if (!n) return null
      if (n.mode === 4 || n.mode === 2) {
        const outType = (n.outputs || [])[originSlot]?.type
        const ins = n.inputs || []
        let idx = ins.findIndex((i) => i.type === outType)
        if (idx < 0) idx = 0
        const il = innerIncoming.get(`${originId}/${idx}`)
        if (!il) return null
        originId = il.origin_id
        originSlot = il.origin_slot
        continue
      }
      if (subgraphs.has(n.type)) {
        const deeper = subgraphs.get(n.type)
        const deeperLinks = normalizeLinks(deeper.links)
        const dl = deeperLinks.find((x) => x.target_id === -20 && x.target_slot === originSlot)
        if (!dl) return null
        return resolveInnerProducer(deeper, `${innerPrefix}:${n.id}`, dl, n.id)
      }
      return { nodeKey: `${innerPrefix}:${n.id}`, slot: originSlot }
    }
    return null
  }

  for (const node of nodes) {
    if (!node || node.id === undefined) continue
    if (node.mode === 4 || node.mode === 2) continue          // bypassed: resolved away
    if (UI_ONLY_TYPES.has(node.type)) continue                 // annotations

    // Subgraph instance → recurse, wiring its input boundary to this scope.
    if (subgraphs.has(node.type)) {
      const inner = subgraphs.get(node.type)
      walk(inner, key(node.id), (slotIdx) => resolveSource(node.id, slotIdx))
      continue
    }

    const inputs = {}
    const wv = Array.isArray(node.widgets_values) ? node.widgets_values : null
    const wvObj = (!Array.isArray(node.widgets_values) && node.widgets_values && typeof node.widgets_values === 'object')
      ? node.widgets_values : null
    let widgetIdx = 0

    ;(node.inputs || []).forEach((inp, slotIdx) => {
      if (!inp?.name) return

      // widgets_values is positional over EVERY widget-backed input, and
      // it keeps the slot even when that input is currently driven by a
      // link. So claim this input's index BEFORE deciding whether a link
      // wins — skipping it without advancing shifts every later widget
      // onto the wrong value. (EmptyLTXVLatentVideo is the canary:
      // [960, 544, 121, 1] over width/height/length/batch_size with
      // `length` linked would otherwise assign batch_size = 121.)
      const isWidget = Boolean(inp.widget) || inp.type === 'COMBO' || inp.type === 'STRING'
        || inp.type === 'INT' || inp.type === 'FLOAT' || inp.type === 'BOOLEAN'
        || inp.type === 'IMAGEUPLOAD'
      const myWidgetIdx = isWidget ? widgetIdx++ : -1

      const linked = incoming.get(`${node.id}/${slotIdx}`)
      if (linked) {
        const src = resolveSource(node.id, slotIdx)
        if (src) {
          inputs[inp.name] = [src.nodeKey, src.slot]
          resolveCount++
          return
        }
        // Link that resolved to nothing (e.g. it came from a bypassed
        // node with no compatible input): fall through to the widget
        // value, which is the sane default ComfyUI would show.
      }

      if (!isWidget) return
      if (wvObj && inp.name in wvObj) { inputs[inp.name] = wvObj[inp.name]; return }
      if (wv && myWidgetIdx >= 0 && myWidgetIdx < wv.length) inputs[inp.name] = wv[myWidgetIdx]
    })

    flat.set(key(node.id), {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || node.type },
    })
  }
}

walk(doc, '', null)

// Drop IMAGEUPLOAD pseudo-inputs — they're a frontend upload button, not
// a real model input, and ComfyUI rejects unknown keys on some nodes.
for (const node of flat.values()) {
  for (const k of Object.keys(node.inputs)) {
    if (k === 'upload') delete node.inputs[k]
  }
}

let graph = Object.fromEntries(flat)

// Optional pruning: keep only nodes that feed the requested output.
if (keepOutput) {
  if (!graph[keepOutput]) {
    console.error(`--keep-output ${keepOutput} is not a node in the flattened graph. Available output-ish nodes:`)
    for (const [id, n] of Object.entries(graph)) {
      if (/save|preview/i.test(n.class_type)) console.error(`  ${id} ${n.class_type} ${JSON.stringify(n.inputs.filename_prefix ?? '')}`)
    }
    process.exit(1)
  }
  const keep = new Set()
  const stack = [keepOutput]
  while (stack.length) {
    const id = stack.pop()
    if (keep.has(id)) continue
    keep.add(id)
    for (const v of Object.values(graph[id]?.inputs || {})) {
      if (Array.isArray(v) && typeof v[0] === 'string' && graph[v[0]]) stack.push(v[0])
    }
  }
  const dropped = Object.keys(graph).filter((id) => !keep.has(id))
  graph = Object.fromEntries(Object.entries(graph).filter(([id]) => keep.has(id)))
  console.log(`pruned to ${keep.size} nodes feeding ${keepOutput} (dropped ${dropped.length})`)
}

// Renumber to plain sequential integer ids. Flattening produces
// path-namespaced keys like "5161:5058"; ComfyUI takes string keys fine
// but integer-looking ids match every other workflow we ship and dodge
// any tooling that assumes numeric node ids. The original path is kept in
// _meta.origId so callers can locate a specific node without hardcoding a
// renumbered id (see the LTX subtitle-removal handler in main.js).
{
  const order = Object.keys(graph)
  const idMap = new Map(order.map((oldId, i) => [oldId, String(i + 1)]))
  const renumbered = {}
  for (const oldId of order) {
    const node = graph[oldId]
    const inputs = {}
    for (const [k, v] of Object.entries(node.inputs)) {
      inputs[k] = (Array.isArray(v) && idMap.has(String(v[0])))
        ? [idMap.get(String(v[0])), v[1]]
        : v
    }
    renumbered[idMap.get(oldId)] = {
      class_type: node.class_type,
      inputs,
      _meta: { ...node._meta, origId: oldId },
    }
  }
  graph = renumbered
}

// ── Validation ────────────────────────────────────────────────────────
let problems = 0
for (const [id, node] of Object.entries(graph)) {
  if (subgraphs.has(node.class_type)) {
    console.error(`FAIL ${id}: subgraph type left unflattened (${node.class_type})`); problems++
  }
  if (UI_ONLY_TYPES.has(node.class_type)) {
    console.error(`FAIL ${id}: UI-only node survived (${node.class_type})`); problems++
  }
  for (const [k, v] of Object.entries(node.inputs)) {
    if (Array.isArray(v) && !graph[String(v[0])]) {
      console.error(`FAIL ${id}.${k}: dangling link -> ${v[0]}`); problems++
    }
  }
}

writeFileSync(outPath, JSON.stringify(graph, null, 2))
console.log(`nodes: ${Object.keys(graph).length} | links resolved: ${resolveCount}`)
console.log(problems === 0 ? `OK -> ${outPath}` : `${problems} PROBLEM(S) -> ${outPath}`)
process.exit(problems === 0 ? 0 : 1)
