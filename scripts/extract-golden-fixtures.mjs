// Extracts proposer golden-test fixtures from real project files.
//
// Reads each project's saved analysis + proposal (which includes the raw
// LLM response text) and writes a trimmed fixture JSON that the golden
// tests replay through parseProposalResponse — no LLM call involved.
//
// Usage: node scripts/extract-golden-fixtures.mjs [projectDir ...]
// Defaults to the three reference projects that live next to the repo.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultProjects = [
  ['apple', path.resolve(repoRoot, '..', 'Apple')],
  ['bmw-x3', path.resolve(repoRoot, '..', 'BMW The new X3')],
  ['rise-of-electric', path.resolve(repoRoot, '..', 'The Rise of Electric')],
]

// Strip fields that carry absolute paths or heavy payloads; keep only
// what parseProposalResponse and the prompt builders consume.
function trimScene(scene) {
  const { thumbnailDataUrl, thumbnailPath, clipPath, optimizedPath, embedding, ...rest } = scene || {}
  return rest
}

const outDir = path.join(repoRoot, 'tests', 'fixtures', 'proposer')
await mkdir(outDir, { recursive: true })

const targets = process.argv.length > 2
  ? process.argv.slice(2).map((p) => [path.basename(p).toLowerCase().replace(/\s+/g, '-'), path.resolve(p)])
  : defaultProjects

for (const [slug, dir] of targets) {
  const candidates = ['project.kred', 'project.comfystudio'].map((f) => path.join(dir, f))
  const file = candidates.find((f) => existsSync(f))
  if (!file) {
    console.warn(`skip ${slug}: no project file in ${dir}`)
    continue
  }
  const project = JSON.parse(await readFile(file, 'utf-8'))
  const proposal = project.proposal || {}
  const analysis = project.analysis || {}
  if (!proposal.rawText || !Array.isArray(proposal.edl)) {
    console.warn(`skip ${slug}: project has no saved proposal rawText/edl`)
    continue
  }
  const fixture = {
    source: path.basename(file),
    scenes: (analysis.scenes || []).map(trimScene),
    voSegments: analysis?.overall?.voiceover_segments || [],
    rawText: proposal.rawText,
    expectedEdl: proposal.edl,
    expectedRationale: proposal.rationale || '',
    capabilities: proposal.capabilities || null,
    metric: proposal.metric || null,
    targetDurationSec: proposal.targetDurationSec ?? null,
    brandBrief: proposal.brandBrief || '',
  }
  const outPath = path.join(outDir, `${slug}.json`)
  await writeFile(outPath, JSON.stringify(fixture, null, 2))
  console.log(`wrote ${path.relative(repoRoot, outPath)} (${fixture.scenes.length} scenes, ${fixture.expectedEdl.length} EDL rows)`)
}
