import { useCallback, useEffect, useState } from 'react'
import { Film, Maximize2, Music2, Mic, Expand } from 'lucide-react'
import {
  DEFAULT_CAPABILITY_SETTINGS,
  I2V_MODEL_OPTIONS,
  UPSCALE_MODEL_OPTIONS,
  loadCapabilitySettings,
  saveCapabilitySettings,
} from '../services/reeditCapabilitySettings'

/**
 * Capabilities settings panel — one card per capability. Each card
 * holds the knobs that configure the capability's behaviour when it
 * is enabled in Proposal → Capabilities. The toggles themselves live
 * in the Proposal view; here we tune how the tool behaves.
 *
 * All changes persist immediately to localStorage via
 * saveCapabilitySettings so the proposer / commit handlers pick the
 * latest values up on the next run without needing an explicit "Save".
 */
function Section({ icon: Icon, title, children, tone = 'default' }) {
  const toneClass = tone === 'muted'
    ? 'border-sf-dark-700 bg-sf-dark-900/40'
    : 'border-sf-dark-700 bg-sf-dark-900'
  return (
    <div className={`rounded-xl border ${toneClass}`}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-sf-dark-700">
        <Icon className="w-4 h-4 text-sf-text-muted" />
        <h4 className="text-sm font-semibold text-sf-text-primary">{title}</h4>
      </div>
      <div className="px-4 py-3 space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 items-start">
      <div>
        <div className="text-[11px] font-medium text-sf-text-primary">{label}</div>
        {hint && <div className="text-[10px] text-sf-text-muted mt-0.5 leading-snug">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function NumberField({ value, min, max, step, suffix, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)))
        }}
        className="w-24 px-2 py-1 rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-primary text-[11px] focus:outline-none focus:border-sf-accent"
      />
      {suffix && <span className="text-[10px] text-sf-text-muted">{suffix}</span>}
    </div>
  )
}

function SelectField({ value, options, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full max-w-md px-2 py-1 rounded border border-sf-dark-700 bg-sf-dark-800 text-sf-text-primary text-[11px] focus:outline-none focus:border-sf-accent"
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  )
}

function CheckboxField({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 accent-sf-accent"
      />
      <span className="text-[11px] text-sf-text-secondary">{children}</span>
    </label>
  )
}

function CapabilitiesSettingsSection() {
  const [settings, setSettings] = useState(() => loadCapabilitySettings())

  // Keep state in sync if another tab / view edits the settings while
  // this modal is open. Uses the custom event fired from
  // saveCapabilitySettings so we don't need a full storage listener.
  useEffect(() => {
    const handler = (e) => {
      if (e?.detail) setSettings(e.detail)
    }
    window.addEventListener('reedit-capability-settings-changed', handler)
    return () => window.removeEventListener('reedit-capability-settings-changed', handler)
  }, [])

  const patch = useCallback((section, updates) => {
    const next = saveCapabilitySettings({ [section]: updates })
    setSettings(next)
  }, [])

  const resetSection = useCallback((section) => {
    patch(section, DEFAULT_CAPABILITY_SETTINGS[section])
  }, [patch])

  const gen = settings.footageGeneration
  const ext = settings.footageExtend
  const rfr = settings.footageReframe

  return (
    <div className="space-y-4">
      <p className="text-xs text-sf-text-secondary leading-relaxed">
        These knobs configure HOW each capability behaves when it&apos;s enabled in
        Proposal → Capabilities. Changes save automatically and apply on the next
        proposal generation / commit.
      </p>

      <Section icon={Film} title="Footage generation">
        <Field label="Model" hint="Which i2v workflow to use for placeholder fills.">
          <SelectField
            value={gen.model}
            options={I2V_MODEL_OPTIONS}
            onChange={(v) => patch('footageGeneration', { model: v })}
          />
        </Field>
        <Field label="Max duration" hint="Upper bound for a single generated shot.">
          <NumberField
            value={gen.maxDurationSec}
            min={1} max={10} step={0.5} suffix="seconds"
            onChange={(v) => patch('footageGeneration', { maxDurationSec: v })}
          />
        </Field>
        <Field label="Content filters" hint="What kinds of fills the proposer may request.">
          <div className="flex flex-col gap-1.5">
            <CheckboxField
              checked={gen.allowProducts !== false}
              onChange={(v) => patch('footageGeneration', { allowProducts: v })}
            >
              Allow product shots (hero product, packaging, labels)
            </CheckboxField>
            <CheckboxField
              checked={gen.allowFaces !== false}
              onChange={(v) => patch('footageGeneration', { allowFaces: v })}
            >
              Allow human faces (actors, drivers, hands on faces)
            </CheckboxField>
            <CheckboxField
              checked={Boolean(gen.allowText)}
              onChange={(v) => patch('footageGeneration', { allowText: v })}
            >
              Allow on-screen text / wordmarks (off by default — text generation is unreliable)
            </CheckboxField>
          </div>
        </Field>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => resetSection('footageGeneration')}
            className="text-[10px] text-sf-text-muted hover:text-sf-text-primary"
          >
            Reset to defaults
          </button>
        </div>
      </Section>

      <Section icon={Expand} title="Footage extend">
        <Field label="Model" hint="Which i2v model drives the tail continuation.">
          <SelectField
            value={ext.model}
            options={I2V_MODEL_OPTIONS}
            onChange={(v) => patch('footageExtend', { model: v })}
          />
        </Field>
        <Field label="Max extension" hint="Parser clamps any EXTEND directive to this. Longer extensions drift.">
          <NumberField
            value={ext.maxExtendSec}
            min={0.5} max={5} step={0.1} suffix="seconds"
            onChange={(v) => patch('footageExtend', { maxExtendSec: v })}
          />
        </Field>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => resetSection('footageExtend')}
            className="text-[10px] text-sf-text-muted hover:text-sf-text-primary"
          >
            Reset to defaults
          </button>
        </div>
      </Section>

      <Section icon={Maximize2} title="Footage reframe">
        <Field label="Max scale" hint="Upper bound on REFRAME zoom. 130 % is conservative — raise carefully.">
          <NumberField
            value={rfr.maxScalePct}
            min={101} max={300} step={5} suffix="%"
            onChange={(v) => patch('footageReframe', { maxScalePct: v })}
          />
        </Field>
        <Field label="Upscale model" hint="Runs during Commit reframe (ComfyUI upscale + crop pass).">
          <SelectField
            value={rfr.upscaleModel}
            options={UPSCALE_MODEL_OPTIONS}
            onChange={(v) => patch('footageReframe', { upscaleModel: v })}
          />
        </Field>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => resetSection('footageReframe')}
            className="text-[10px] text-sf-text-muted hover:text-sf-text-primary"
          >
            Reset to defaults
          </button>
        </div>
      </Section>

      <Section icon={Music2} title="Music" tone="muted">
        <div className="text-[11px] text-sf-text-muted italic">
          Configuration coming soon — today the Music capability layers the Demucs-separated stem
          as-is, no knobs.
        </div>
      </Section>

      <Section icon={Mic} title="Voice over" tone="muted">
        <div className="text-[11px] text-sf-text-muted italic">
          Configuration coming soon — today the VO capability reuses the Demucs-separated vocal
          stem, no knobs.
        </div>
      </Section>
    </div>
  )
}

export default CapabilitiesSettingsSection
