// Guards the bundled LTX text-removal workflow (the flattened comfy.org
// "Remove Subtitles from Video" template). ComfyUI rejects a whole submit
// on the first structural problem it finds, and that failure only shows up
// in the app at click time — these assertions move it to CI.
//
// Regenerate the JSON with:
//   node scripts/flatten-comfy-subgraphs.mjs <downloaded.json> \
//     workflows/optimize_ltx23_remove_subtitles_api.json --keep-output 5159
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const graph = JSON.parse(readFileSync(
  path.join(__dirname, '..', 'workflows', 'optimize_ltx23_remove_subtitles_api.json'),
  'utf-8',
))

// Kept in sync with LTX_REMOVE_SUBS_SLOTS in electron/main.js. The handler
// addresses nodes by their pre-renumbering `_meta.origId`, so these are the
// contract between the bundled JSON and the builder.
const REQUIRED_SLOTS = {
  LOAD_VIDEO: '5160',
  SAVE_VIDEO: '5159',
  POSITIVE_PROMPT: '5161:5091',
  NEGATIVE_PROMPT: '5161:5057',
  SEED_A: '5161:5058',
  SEED_B: '5161:5078',
  TEXT_ENCODER: '5161:5084',
  CHECKPOINT: '5161:5085',
  IC_LORA: '5161:5087',
}

const byOrigId = new Map(
  Object.entries(graph).map(([id, node]) => [String(node?._meta?.origId), { id, node }]),
)

describe('bundled LTX text-removal workflow', () => {
  it('is a non-empty flat API graph', () => {
    const ids = Object.keys(graph)
    expect(ids.length).toBeGreaterThan(20)
    for (const [id, node] of Object.entries(graph)) {
      expect(node.class_type, `node ${id} needs a class_type`).toBeTruthy()
      expect(node.inputs, `node ${id} needs inputs`).toBeTypeOf('object')
    }
  })

  it('has no dangling links', () => {
    for (const [id, node] of Object.entries(graph)) {
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') {
          expect(graph[String(value[0])], `${id}.${key} links to missing node ${value[0]}`).toBeDefined()
        }
      }
    }
  })

  it('contains no unflattened subgraph or UI-only nodes', () => {
    // A subgraph instance's class_type is a uuid; annotation nodes aren't
    // executable. Either one makes ComfyUI reject the submit.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    for (const [id, node] of Object.entries(graph)) {
      expect(UUID_RE.test(node.class_type), `${id} is an unflattened subgraph (${node.class_type})`).toBe(false)
      expect(['Note', 'MarkdownNote', 'Reroute']).not.toContain(node.class_type)
    }
  })

  it('depends only on node packs this project actually has', () => {
    // Every custom-node type the graph may use. The five packs the old
    // joyfox workflow needed (rgthree, ComfyRoll, Easy-Use, WAS,
    // Essentials) are NOT installed — if a regenerated template
    // reintroduces one, fail here instead of at click time.
    const FORBIDDEN = [
      /rgthree/i, /^CR /, /^easy /, /^Image To Mask$/, /^SimpleMath\+$/,
      /^LayerUtility:/, /\bWAS\b/,
    ]
    for (const [id, node] of Object.entries(graph)) {
      for (const pattern of FORBIDDEN) {
        expect(pattern.test(node.class_type), `${id} uses an uninstalled pack node: ${node.class_type}`).toBe(false)
      }
    }
  })

  it('exposes every slot the builder patches, exactly once', () => {
    for (const [name, origId] of Object.entries(REQUIRED_SLOTS)) {
      const hit = byOrigId.get(origId)
      expect(hit, `slot ${name} (origId ${origId}) is missing from the bundled workflow`).toBeDefined()
    }
    // origIds must be unique or the builder could patch the wrong node.
    const origIds = Object.values(graph).map((n) => String(n?._meta?.origId))
    expect(new Set(origIds).size).toBe(origIds.length)
  })

  it('wires the slots to the node types the builder assumes', () => {
    const typeOf = (slot) => byOrigId.get(REQUIRED_SLOTS[slot])?.node?.class_type
    expect(typeOf('LOAD_VIDEO')).toBe('LoadVideo')
    expect(typeOf('SAVE_VIDEO')).toBe('SaveVideo')
    expect(typeOf('POSITIVE_PROMPT')).toBe('CLIPTextEncode')
    expect(typeOf('NEGATIVE_PROMPT')).toBe('CLIPTextEncode')
    expect(typeOf('SEED_A')).toBe('RandomNoise')
    expect(typeOf('SEED_B')).toBe('RandomNoise')
    expect(typeOf('CHECKPOINT')).toBe('CheckpointLoaderSimple')
    expect(typeOf('IC_LORA')).toBe('LTXICLoRALoaderModelOnly')
  })

  it('renders exactly one video (the comparison branch is pruned)', () => {
    const savers = Object.values(graph).filter((n) => /^Save(Video|Image|Animated)/.test(n.class_type))
    expect(savers).toHaveLength(1)
  })
})
