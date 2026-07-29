/**
 * LLM models settings section — embedded inside the main SettingsModal.
 *
 * Mirrors the standalone `LlmSettingsModal` content but writes changes
 * directly to localStorage on every interaction (no separate Save
 * button), matching the in-place behavior of the other Settings tabs.
 * The standalone modal stays for callers that prefer the dialog flow
 * (Getting Started, LLM-only popovers).
 *
 * Per-step pickers Gemini exposes:
 *   - Analysis   → per-shot video analysis (runs N times per project)
 *   - Proposal   → re-edit reasoning (runs once per re-edit)
 *   - Embedding  → multimodal retrieval (text + shot frames)
 * Plus the shared API key and the "send source video to proposal" flag.
 *
 * For LM Studio + Claude backends, the section also surfaces their
 * model picker and API key field so the user has one place to
 * configure every LLM-related setting.
 */

import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, ExternalLink } from 'lucide-react'
import {
  LLM_BACKENDS,
  BACKEND_LABELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GEMINI_EMBEDDING_MODELS,
  loadLlmSettings,
  saveLlmSettings,
} from '../../services/reeditLlmClient'

export default function LlmSettingsSection() {
  // Hydrate once on mount. We re-read on every save callback (via the
  // returned `next` from saveLlmSettings) so the UI stays in lock-step
  // with the service-side defaults even when other components flip a
  // value.
  const [settings, setSettingsLocal] = useState(() => loadLlmSettings())
  const [showKey, setShowKey] = useState(false)
  // The Gemini key field is uncontrolled-ish: we let the user type
  // freely and commit on blur, so dropping a long key doesn't write to
  // localStorage on every keystroke (each write fires a
  // `reedit-llm-settings-changed` event that ripples through hooks).
  const apiKeyInputRef = useRef(null)

  useEffect(() => {
    // Re-pull when something else writes settings (e.g. the standalone
    // modal saves while this section is mounted). Cheap subscription:
    // re-read everything on the broadcast event.
    const handler = () => setSettingsLocal(loadLlmSettings())
    window.addEventListener('reedit-llm-settings-changed', handler)
    return () => window.removeEventListener('reedit-llm-settings-changed', handler)
  }, [])

  // Helper: write a patch and reflect it locally so the UI updates
  // without waiting on the event roundtrip.
  const patch = (p) => {
    const next = saveLlmSettings(p)
    if (next) setSettingsLocal(next)
  }

  const backend = settings?.backend || LLM_BACKENDS.LM_STUDIO
  const anthropicModel = settings?.anthropicModel || ANTHROPIC_MODELS[0].id
  const geminiAnalysisModel  = settings?.geminiAnalysisModel || settings?.geminiModel || 'gemini-3.6-flash'
  const geminiProposalModel  = settings?.geminiProposalModel || 'gemini-3.6-flash'
  const geminiReviewModel    = settings?.geminiReviewModel    || settings?.geminiAnalysisModel || 'gemini-3.6-flash'
  const geminiEmbeddingModel = settings?.geminiEmbeddingModel || GEMINI_EMBEDDING_MODELS[GEMINI_EMBEDDING_MODELS.length - 1].id
  const geminiSendSourceVideo = Boolean(settings?.geminiSendSourceVideo)

  const backendBlurb = (id) => {
    if (id === LLM_BACKENDS.LM_STUDIO) return 'Free, runs on your machine. Needs a chat / vision model loaded.'
    if (id === LLM_BACKENDS.ANTHROPIC) return 'Cloud. Best reasoning, ~$0.01–$0.05 per proposal.'
    if (id === LLM_BACKENDS.GEMINI) return 'Cloud. Native video input — per-shot motion analysis + multimodal embeddings.'
    return ''
  }

  // Card list helper — same visual treatment as the standalone modal so
  // a user toggling between this section and the dialog sees the same UI.
  const ModelCard = ({ selected, onClick, label, blurb }) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-2.5 rounded-lg border transition-colors
        ${selected
          ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
    >
      <div className="text-sm font-medium">{label}</div>
      {blurb && <div className="text-[10px] leading-snug opacity-80">{blurb}</div>}
    </button>
  )

  // Dropdown variant for the per-step Gemini pickers. Vertical lists of
  // cards turned this page into a wall of text once each step (Analysis
  // / Proposal / Review) repeated the same 7 model options. A native
  // <select> shrinks the section to three short rows + a small blurb
  // for the currently-selected model.
  const ModelDropdown = ({ label, sublabel, value, onChange, models, blurbFor }) => {
    const current = models.find((m) => m.id === value)
    return (
      <div>
        <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
          {label}
          {sublabel && (
            <span className="normal-case text-sf-text-muted/70"> · {sublabel}</span>
          )}
        </label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-3 py-2 text-sm text-sf-text-primary focus:outline-none focus:border-sf-accent"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        {(current?.blurb || blurbFor?.(current)) && (
          <p className="mt-1.5 text-[11px] text-sf-text-muted leading-snug">
            {blurbFor ? blurbFor(current) : current.blurb}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* ─── Backend picker ─── */}
      <div>
        <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Backend</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {Object.entries(BACKEND_LABELS).map(([id, label]) => (
            <ModelCard
              key={id}
              selected={backend === id}
              onClick={() => patch({ backend: id })}
              label={label}
              blurb={backendBlurb(id)}
            />
          ))}
        </div>
      </div>

      {/* ─── Claude branch ─── */}
      {backend === LLM_BACKENDS.ANTHROPIC && (
        <>
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Claude model</label>
            <div className="space-y-1.5">
              {ANTHROPIC_MODELS.map((m) => (
                <ModelCard
                  key={m.id}
                  selected={anthropicModel === m.id}
                  onClick={() => patch({ anthropicModel: m.id })}
                  label={m.label}
                  blurb={m.blurb}
                />
              ))}
            </div>
          </div>
          <ApiKeyField
            label="Anthropic API key"
            href="https://console.anthropic.com/settings/keys"
            placeholder="sk-ant-..."
            value={settings?.anthropicApiKey || ''}
            onCommit={(v) => patch({ anthropicApiKey: v.trim() })}
            show={showKey}
            onToggleShow={() => setShowKey((s) => !s)}
          />
        </>
      )}

      {/* ─── Gemini branch ─── */}
      {backend === LLM_BACKENDS.GEMINI && (
        <>
          <ModelDropdown
            label="Analysis model"
            sublabel="per-shot video analysis"
            value={geminiAnalysisModel}
            onChange={(id) => patch({
              geminiAnalysisModel: id,
              // Keep legacy `geminiModel` in sync so older code paths
              // that haven't migrated to task-specific resolution still
              // pick the user's intent.
              geminiModel: id,
            })}
            models={GEMINI_MODELS}
          />

          <ModelDropdown
            label="Proposal model"
            sublabel="re-edit reasoning (EDL)"
            value={geminiProposalModel}
            onChange={(id) => patch({ geminiProposalModel: id })}
            models={GEMINI_MODELS}
          />

          <ModelDropdown
            label="Review model"
            sublabel="Sundogs-style AI review of the new cut"
            value={geminiReviewModel}
            onChange={(id) => patch({ geminiReviewModel: id })}
            models={GEMINI_MODELS}
          />

          <ModelDropdown
            label="Embedding model"
            sublabel="multimodal retrieval"
            value={geminiEmbeddingModel}
            onChange={(id) => patch({ geminiEmbeddingModel: id })}
            models={GEMINI_EMBEDDING_MODELS}
          />

          <ApiKeyField
            label="Gemini API key"
            href="https://aistudio.google.com/app/apikey"
            placeholder="AIza..."
            value={settings?.geminiApiKey || ''}
            onCommit={(v) => patch({ geminiApiKey: v.trim() })}
            show={showKey}
            onToggleShow={() => setShowKey((s) => !s)}
            footer="Stored in localStorage. Sent only to Google's Gemini API when a request runs. Covers chat + embeddings."
          />

          <label className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors
            ${geminiSendSourceVideo
              ? 'border-sf-accent bg-sf-accent/10'
              : 'border-sf-dark-700 bg-sf-dark-900 hover:border-sf-dark-500'}`}
          >
            <input
              type="checkbox"
              checked={geminiSendSourceVideo}
              onChange={(e) => patch({ geminiSendSourceVideo: e.target.checked })}
              className="mt-0.5 accent-sf-accent"
            />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${geminiSendSourceVideo ? 'text-sf-text-primary' : 'text-sf-text-secondary'}`}>
                Send source video to proposal
                <span className="text-sf-text-muted/70 normal-case text-[10px] ml-2">Gemini only</span>
              </div>
              <div className="text-[10px] leading-snug text-sf-text-muted mt-0.5">
                When ON, the proposer attaches the source video alongside the text shot log. Gemini can reason about continuity, match-cuts, and visual flow instead of only the prose description. Adds 5-20 MB per request.
              </div>
            </div>
          </label>
        </>
      )}

      {/* ─── LM Studio is local — no model dropdown, no key. The
            captioner discovers loaded vision models at request time. */}
      {backend === LLM_BACKENDS.LM_STUDIO && (
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-3 text-[12px] text-sf-text-muted leading-snug">
          LM Studio runs on your machine. Load a vision / chat model in LM Studio and we'll discover it at request time — no model picker needed here.
        </div>
      )}
    </div>
  )
}

// Inline API-key field. Uncontrolled commit-on-blur to avoid firing
// the settings-changed event on every keystroke (each fire ripples
// through every subscriber).
function ApiKeyField({ label, href, placeholder, value, onCommit, show, onToggleShow, footer }) {
  const [draft, setDraft] = useState(value || '')
  useEffect(() => { setDraft(value || '') }, [value])
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
        {label}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="ml-2 inline-flex items-center gap-1 normal-case text-sf-accent hover:underline"
          >
            get one <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit?.(draft)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="w-full font-mono text-xs rounded-lg border border-sf-dark-700 bg-sf-dark-950 pl-3 pr-10 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          title={show ? 'Hide' : 'Show'}
        >
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      {footer && <p className="mt-2 text-[10px] text-sf-text-muted leading-snug">{footer}</p>}
    </div>
  )
}
