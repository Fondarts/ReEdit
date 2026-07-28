# ReEdit

AI-assisted re-editing of finished commercials. Import a scored ad, let the pipeline cut it into shots, analyze each one, propose a new edit optimized for a performance metric, and export the re-cut — with AI tooling (inpaint, reframe/outpaint, extend, generated fills, VO, music) to execute the proposal.

Private fork of [ComfyStudio](https://github.com/JaimeIsMe/comfystudio) (MIT) by Kissd.

## The pipeline

`Projects → Analysis → Optimization → Proposal → Editor → Review → Export`

1. **Import** — drop a finished ad. Scene detection (PySceneDetect) cuts it into shots; Demucs separates VO/music stems in the background.
2. **Analysis** — each shot goes to Gemini with a closed cinematography taxonomy (shot size, camera, lens, lighting, composition…). An ad report (Sundogs PDF or Gemini-generated) scores the original cut.
3. **Optimization** — per-shot cleanup: remove supers/graphics (Wan VACE masked inpaint `V`, LTX IC-Edit `L`, or Kling Omni Edit cloud `K`), reframe by crop (`R`) or **outpaint** to a new aspect (`O`, Luma Ray 3.2 or local LTX IC-LoRA), extend shots (`E`, local last-frame or Vidu video-context via cloud).
4. **Proposal** — an LLM director writes a new EDL optimized for the chosen metric. Placeholder rows are filled by i2v models (Kling / Grok / Vidu / Seedance multi-ref / Veo first-last-frame bridges) or local LTX/WAN.
5. **Editor** — full NLE (timeline, keyframes, transitions) with the proposal materialized; every AI version is A/B-swappable per shot.
6. **Review / Export** — compare original vs re-cut, export via ffmpeg (NVENC when available).

Two UI modes: **Advanced** (step-by-step) and **Auto** ("Go" runs detect → analyze → propose unattended).

## Setup (dev)

```bash
npm install
npm run electron:dev     # vite + electron
```

- **Windows note:** if `ELECTRON_RUN_AS_NODE` is set in your environment, unset it first or Electron starts as plain Node and no window opens.
- **Python sidecars** (optional but recommended): `pip install scenedetect[opencv] demucs` — used for scene detection, mask generation and stem separation.
- **ComfyUI**: local instance (default `127.0.0.1:8188`, configurable) for LTX/WAN/VACE work, or **Comfy Cloud** (Settings → ComfyUI → Cloud + API key) for the partner models (Kling, Seedance, Vidu, Veo, Luma, Grok).
- **LLM**: Gemini API key (Settings → LLM), or Anthropic / LM Studio backends.

## Commands

| Command | What |
|---|---|
| `npm run electron:dev` | run the app in dev |
| `npm run lint` | ESLint (errors fail CI; warnings are ratcheted down over time) |
| `npm test` | Vitest — unit + golden tests (no LLM calls) |
| `npm run eval:proposer` | tier-2 live-Gemini eval of the proposal prompts (needs `GEMINI_API_KEY`) |
| `npm run electron:build:win` | package |

## Architecture

- **Renderer** (`src/`): React 18 + Zustand. Pipeline views in `src/components/reedit/`, services in `src/services/` (the proposer — prompts + EDL parsing — lives in `reeditProposer.js`; `parseProposalResponse` is pure and golden-tested).
- **Main process** (`electron/`): all generation runs here.
  - `electron/comfy/client.js` — the ONE ComfyUI transport (local + Cloud: auth, upload/download, queue, polling).
  - `electron/comfy/adapters/` — one file per generation model; `buildWorkflow()` is pure and owns every node id. Adding a model = one adapter + one registry line.
  - `electron/main.js` — IPC handlers orchestrating ffmpeg pre/post work around Comfy jobs.
- **Tests** (`tests/`, `electron/**/*.test.js`): golden fixtures replay real projects' LLM responses through the parser; prompt snapshots make any wording change visible in PR diffs; adapter tests validate every generated graph.

Project files: `project.kred` + `.reedit/` (clips, optimized versions, fills, stems, generated VO/music) next to it.

> Packaging note: `name`/`productName` intentionally still say "comfystudio" — Electron derives the userData path from them, and renaming would orphan existing settings/localStorage. Rename alongside a userData migration when it matters.
