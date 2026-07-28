// Tier-2 eval: runs the proposal prompt against the real Gemini API for
// each golden fixture and scores the returned EDL with programmatic
// checks. Does NOT run in CI — invoke by hand before/after touching the
// proposer prompts:
//
//   GEMINI_API_KEY=... npm run eval:proposer
//
// This is intentionally a plain-fetch reimplementation of the chat path
// (the app's geminiClient assumes a browser/localStorage environment).
// It scores structure, not taste: duration windows, scene-id validity,
// directive parseability. A human still judges creative quality.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) {
  console.error('GEMINI_API_KEY is required (the eval calls the live API).')
  process.exit(1)
}
const model = process.env.EVAL_GEMINI_MODEL || 'gemini-2.5-flash'

// The proposer module is browser-flavoured (localStorage reads at call
// time). Stub the bits it touches before importing.
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = undefined

const { buildSystemPrompt, buildUserPrompt, parseProposalResponse, DEFAULT_RULES } =
  await import(path.join('file://', repoRoot, 'src/services/reeditProposer.js').replace(/\\/g, '/'))

const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'proposer')
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))

async function geminiChat(systemText, userText) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 12000 },
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
}

let failures = 0
for (const file of fixtures) {
  const fx = JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf-8'))
  const name = file.replace(/\.json$/, '')
  process.stdout.write(`\n=== ${name} (${fx.scenes.length} scenes, target ${fx.targetDurationSec ?? 'n/a'}s)\n`)

  const systemText = buildSystemPrompt(fx.capabilities, { rules: DEFAULT_RULES })
  const userText = buildUserPrompt({
    scenes: fx.scenes,
    brandBrief: fx.brandBrief,
    metric: fx.metric,
    targetDurationSec: fx.targetDurationSec,
    capabilities: fx.capabilities,
    voSegments: fx.voSegments,
    rules: DEFAULT_RULES,
  })

  let rawText
  try {
    rawText = await geminiChat(systemText, userText)
  } catch (err) {
    console.error(`  API call failed: ${err.message}`)
    failures++
    continue
  }

  const checks = []
  const check = (label, ok, detail = '') => {
    checks.push([label, ok, detail])
    if (!ok) failures++
  }

  let result = null
  try {
    result = parseProposalResponse(rawText, { scenes: fx.scenes, voSegments: fx.voSegments })
    check('parses as EDL JSON', true)
  } catch (err) {
    check('parses as EDL JSON', false, err.message)
  }

  if (result) {
    const edl = result.edl
    check('EDL is non-empty', edl.length > 0, `${edl.length} rows`)

    const sceneIds = new Set(fx.scenes.map((s) => s.id))
    const badIds = edl.filter((r) => r.kind === 'original' && !sceneIds.has(r.sourceSceneId))
    check('all sourceSceneIds exist', badIds.length === 0, badIds.map((r) => r.sourceSceneId).join(','))

    const total = edl.length ? edl[edl.length - 1].newTcOut : 0
    if (Number.isFinite(fx.targetDurationSec) && fx.targetDurationSec > 0) {
      const tolerance = fx.targetDurationSec * 0.15
      check(
        `duration within ±15% of ${fx.targetDurationSec}s`,
        Math.abs(total - fx.targetDurationSec) <= tolerance,
        `${total.toFixed(1)}s`,
      )
    }

    const badReframe = edl.filter((r) => r.reframe && (r.reframe.zoom < 1 || r.reframe.zoom > 3))
    check('no out-of-range REFRAME zooms', badReframe.length === 0)

    const placeholders = edl.filter((r) => r.kind === 'placeholder')
    const orphanRefs = placeholders.filter((r) => r.referenceFrame && !sceneIds.has(r.referenceFrame.sourceSceneId))
    check('placeholder referenceFrames valid', orphanRefs.length === 0, `${placeholders.length} placeholders`)
  }

  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
