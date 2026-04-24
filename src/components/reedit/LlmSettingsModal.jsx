import { useEffect, useRef, useState } from 'react'
import { X, Save, Eye, EyeOff, ExternalLink } from 'lucide-react'
import {
  LLM_BACKENDS,
  BACKEND_LABELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GEMINI_EMBEDDING_MODELS,
} from '../../services/reeditLlmClient'

/**
 * LLM settings modal — wire up a backend (LM Studio, Claude API, or
 * Gemini API), pick a model, and paste the provider key when the
 * backend needs one. Gemini additionally exposes the embedding model
 * (used for per-shot multimodal retrieval — unrelated to chat calls).
 *
 * Storage is localStorage (see reeditLlmClient.js). Moving both keys
 * to Electron safeStorage is a todo before this ships externally.
 */
function LlmSettingsModal({ isOpen, settings, onClose, onSave }) {
  // Defaults for the two Gemini task-specific models. Analysis runs per
  // shot → Flash (cheap + fast); Proposal runs once per re-edit with
  // high quality stakes → Pro. If the user never saved anything, fall
  // back to those picks the first time the modal opens.
  const defaultAnalysis = settings?.geminiAnalysisModel || settings?.geminiModel || 'gemini-2.5-flash'
  const defaultProposal = settings?.geminiProposalModel || 'gemini-2.5-pro'

  const [backend, setBackend] = useState(settings?.backend || LLM_BACKENDS.LM_STUDIO)
  const [anthropicModel, setAnthropicModel] = useState(settings?.anthropicModel || ANTHROPIC_MODELS[0].id)
  const [anthropicApiKey, setAnthropicApiKey] = useState(settings?.anthropicApiKey || '')
  const [geminiAnalysisModel, setGeminiAnalysisModel] = useState(defaultAnalysis)
  const [geminiProposalModel, setGeminiProposalModel] = useState(defaultProposal)
  const [geminiEmbeddingModel, setGeminiEmbeddingModel] = useState(
    settings?.geminiEmbeddingModel || GEMINI_EMBEDDING_MODELS[GEMINI_EMBEDDING_MODELS.length - 1].id,
  )
  const [geminiApiKey, setGeminiApiKey] = useState(settings?.geminiApiKey || '')
  const [showKey, setShowKey] = useState(false)
  const firstInputRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    setBackend(settings?.backend || LLM_BACKENDS.LM_STUDIO)
    setAnthropicModel(settings?.anthropicModel || ANTHROPIC_MODELS[0].id)
    setAnthropicApiKey(settings?.anthropicApiKey || '')
    setGeminiAnalysisModel(settings?.geminiAnalysisModel || settings?.geminiModel || 'gemini-2.5-flash')
    setGeminiProposalModel(settings?.geminiProposalModel || 'gemini-2.5-pro')
    setGeminiEmbeddingModel(settings?.geminiEmbeddingModel || GEMINI_EMBEDDING_MODELS[GEMINI_EMBEDDING_MODELS.length - 1].id)
    setGeminiApiKey(settings?.geminiApiKey || '')
    setShowKey(false)
    setTimeout(() => { firstInputRef.current?.focus() }, 0)
  }, [isOpen, settings])

  if (!isOpen) return null

  const handleSave = () => {
    onSave?.({
      backend,
      anthropicModel,
      anthropicApiKey: anthropicApiKey.trim(),
      // Keep the legacy `geminiModel` in sync with the analysis model
      // so code paths that haven't migrated to task-specific resolution
      // (e.g. pingGemini, experimental scripts) still get a sane pick.
      geminiModel: geminiAnalysisModel,
      geminiAnalysisModel,
      geminiProposalModel,
      geminiEmbeddingModel,
      geminiApiKey: geminiApiKey.trim(),
    })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose?.()
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave()
  }

  const backendBlurb = (id) => {
    if (id === LLM_BACKENDS.LM_STUDIO) return 'Free, runs on your machine. Needs a chat / vision model loaded.'
    if (id === LLM_BACKENDS.ANTHROPIC) return 'Cloud. Best reasoning, ~$0.01–$0.05 per proposal.'
    if (id === LLM_BACKENDS.GEMINI) return 'Cloud. Native video input — per-shot motion analysis + multimodal embeddings.'
    return ''
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="w-full max-w-xl bg-sf-dark-900 border border-sf-dark-700 rounded-xl shadow-2xl overflow-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-sf-dark-800">
          <h2 className="text-sm font-semibold text-sf-text-primary">LLM engine</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Backend</label>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {Object.entries(BACKEND_LABELS).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  ref={id === LLM_BACKENDS.LM_STUDIO ? firstInputRef : null}
                  onClick={() => setBackend(id)}
                  className={`text-left p-3 rounded-lg border transition-colors
                    ${backend === id
                      ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                      : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                >
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-[10px] leading-snug mt-1 opacity-80">
                    {backendBlurb(id)}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {backend === LLM_BACKENDS.ANTHROPIC && (
            <>
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Claude model</label>
                <div className="space-y-1.5">
                  {ANTHROPIC_MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setAnthropicModel(m.id)}
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors
                        ${anthropicModel === m.id
                          ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                    >
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[10px] leading-snug opacity-80">{m.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
                  Anthropic API key
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center gap-1 normal-case text-sf-accent hover:underline"
                  >
                    get one <ExternalLink className="w-3 h-3" />
                  </a>
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={anthropicApiKey}
                    onChange={(e) => setAnthropicApiKey(e.target.value)}
                    placeholder="sk-ant-..."
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full font-mono text-xs rounded-lg border border-sf-dark-700 bg-sf-dark-950 pl-3 pr-10 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
                    title={showKey ? 'Hide' : 'Show'}
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-sf-text-muted leading-snug">
                  Stored in localStorage for this fork. Not transmitted anywhere except directly to Anthropic's API when a request runs.
                </p>
              </div>
            </>
          )}

          {backend === LLM_BACKENDS.GEMINI && (
            <>
              {/* Two task-specific pickers: analysis runs per shot
                  (prefer Flash for cost), proposal runs once per
                  re-edit (prefer Pro for reasoning). */}
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Analysis model <span className="normal-case text-sf-text-muted/70">· per-shot video analysis</span></label>
                <div className="space-y-1.5">
                  {GEMINI_MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setGeminiAnalysisModel(m.id)}
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors
                        ${geminiAnalysisModel === m.id
                          ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                    >
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[10px] leading-snug opacity-80">{m.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Proposal model <span className="normal-case text-sf-text-muted/70">· re-edit reasoning (EDL)</span></label>
                <div className="space-y-1.5">
                  {GEMINI_MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setGeminiProposalModel(m.id)}
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors
                        ${geminiProposalModel === m.id
                          ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                    >
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[10px] leading-snug opacity-80">{m.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">Embedding model (retrieval)</label>
                <div className="space-y-1.5">
                  {GEMINI_EMBEDDING_MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setGeminiEmbeddingModel(m.id)}
                      className={`w-full text-left p-2.5 rounded-lg border transition-colors
                        ${geminiEmbeddingModel === m.id
                          ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'}`}
                    >
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[10px] leading-snug opacity-80">{m.blurb}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-sf-text-muted mb-2">
                  Gemini API key
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center gap-1 normal-case text-sf-accent hover:underline"
                  >
                    get one <ExternalLink className="w-3 h-3" />
                  </a>
                </label>
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={geminiApiKey}
                    onChange={(e) => setGeminiApiKey(e.target.value)}
                    placeholder="AIza..."
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full font-mono text-xs rounded-lg border border-sf-dark-700 bg-sf-dark-950 pl-3 pr-10 py-2 text-sf-text-primary placeholder:text-sf-text-muted/60 focus:outline-none focus:border-sf-accent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-sf-dark-800 text-sf-text-muted hover:text-sf-text-primary transition-colors"
                    title={showKey ? 'Hide' : 'Show'}
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-sf-text-muted leading-snug">
                  Stored in localStorage for this fork. Sent only to Google's Gemini API when a request runs. The key covers both chat and embeddings — same Google AI Studio project.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-sf-dark-800 bg-sf-dark-900/60">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-sf-accent hover:bg-sf-accent-hover text-white transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default LlmSettingsModal
