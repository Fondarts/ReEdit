/**
 * Lucky-run store. The "Auto" pipeline can take minutes — long enough
 * that a user will switch tabs / flip UI modes mid-run. The previous
 * version kept the run state on `ImportLuckyView`'s component state, so
 * unmounting (e.g. flipping to Advanced and back) wiped the progress
 * list even though the pipeline was still running in background.
 *
 * Holding it in a Zustand store survives any remount. The view becomes
 * a thin reader — it subscribes, renders the step list, and dispatches
 * `start` / `update` / `finish` / `abort` actions. The pipeline itself
 * doesn't import this store directly; the view passes `updateStep` as
 * the `onProgress` callback so the orchestrator stays unaware of the
 * UI layer (matches the pattern the other services use).
 *
 * NOT persisted to disk: a run that's actually still in flight when the
 * app closes will lose its UI state on reload (the pipeline Promise
 * dies with the renderer anyway). Persisting would just leave us with
 * a frozen "active" step pointing at nothing.
 */

import { create } from 'zustand'
import { LUCKY_STEPS } from '../services/reeditLuckyPipeline'

function freshStepState() {
  const out = {}
  for (const s of LUCKY_STEPS) out[s.id] = 'pending'
  return out
}

const useLuckyRunStore = create((set, get) => ({
  running: false,
  stepState: {},                  // { stepId: 'pending'|'active'|'done'|'error' }
  stepDetail: {},                 // { stepId: string }
  activeStep: null,
  runError: null,
  lastFinishedAt: null,           // ISO timestamp — lets the view show "done X ago"
  // `cancelling` flips to true the moment the user clicks Cancel. The
  // run usually can't stop instantly — it has to wait for the current
  // long-running IPC (a ComfyUI generation, a Demucs split…) to yield
  // — so we use this flag to render "Cancelling…" on the button and
  // disable it, giving the user immediate visual feedback that the
  // click registered. Cleared by reset / startRun.
  cancelling: false,
  // The abort flag is a plain object (not a primitive) so the
  // orchestrator can mutate it via the same reference the view holds.
  // Wrapping it in the store keeps a single source of truth.
  abortFlag: { aborted: false },

  // Reset everything to "no run in progress". Used both for a fresh
  // start and after a successful navigation away from Auto.
  reset: () => set({
    running: false,
    stepState: {},
    stepDetail: {},
    activeStep: null,
    runError: null,
    cancelling: false,
    abortFlag: { aborted: false },
  }),

  // Flip into "running" with a clean step list. The view calls this
  // right before invoking runLuckyPipeline.
  startRun: () => set({
    running: true,
    stepState: freshStepState(),
    stepDetail: {},
    activeStep: null,
    runError: null,
    cancelling: false,
    abortFlag: { aborted: false },
  }),

  // onProgress dispatcher. Walks LUCKY_STEPS in order — every emit
  // paints the whole list (earlier indices = done, matching = active,
  // later = pending) so a single update always leaves the list
  // coherent regardless of re-render order. Identical to what the old
  // local-state version did before the move.
  updateStep: (step, payload) => set((state) => {
    const idx = LUCKY_STEPS.findIndex((s) => s.id === step)
    if (idx < 0) return state  // unknown step id
    const nextStepState = {}
    for (let i = 0; i < LUCKY_STEPS.length; i++) {
      const id = LUCKY_STEPS[i].id
      if (state.stepState[id] === 'error') { nextStepState[id] = 'error'; continue }
      if (i < idx)        nextStepState[id] = 'done'
      else if (i === idx) nextStepState[id] = 'active'
      else                nextStepState[id] = 'pending'
    }
    let nextDetail = state.stepDetail
    if (payload?.message || Number.isFinite(payload?.current)) {
      const detailStr = payload?.message
        ? (Number.isFinite(payload?.current) && Number.isFinite(payload?.total))
          ? `${payload.message} (${payload.current}/${payload.total})`
          : payload.message
        : `${payload.current}/${payload.total}`
      nextDetail = { ...state.stepDetail, [step]: detailStr }
    }
    return {
      stepState: nextStepState,
      stepDetail: nextDetail,
      activeStep: step,
    }
  }),

  // The pipeline resolved without throwing. Paint every non-errored
  // step as done so a re-mount shows the user a clean list of greens.
  finishRunOk: () => set((state) => {
    const next = {}
    for (const s of LUCKY_STEPS) {
      next[s.id] = state.stepState[s.id] === 'error' ? 'error' : 'done'
    }
    return {
      running: false,
      cancelling: false,
      activeStep: null,
      stepState: next,
      lastFinishedAt: new Date().toISOString(),
    }
  }),

  // The pipeline threw. Mark the active step as error and freeze the
  // rest in whatever state they were in. The error string drives the
  // inline red banner in the view.
  finishRunError: (errMessage) => set((state) => {
    const next = { ...state.stepState }
    if (state.activeStep && next[state.activeStep] !== 'done') {
      next[state.activeStep] = 'error'
    }
    return {
      running: false,
      cancelling: false,
      runError: errMessage || 'Pipeline failed.',
      stepState: next,
      lastFinishedAt: new Date().toISOString(),
    }
  }),

  // Cooperative cancel. The orchestrator checks `signal.aborted`
  // between stages and throws "Cancelled by user." Sets `cancelling`
  // immediately so the UI can swap to a "Cancelling…" indicator while
  // the in-flight IPC drains.
  abortRun: () => set((state) => {
    state.abortFlag.aborted = true
    return { cancelling: true }
  }),

  // Called after finishRunOk / finishRunError naturally clear the
  // running flag — keeps `cancelling` from sticking around between
  // runs if the user navigates back to Auto without clicking Go.
  clearCancelling: () => set({ cancelling: false }),
}))

export default useLuckyRunStore
