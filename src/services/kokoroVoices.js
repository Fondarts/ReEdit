/**
 * project:re-edit — Kokoro-TTS voice catalog.
 *
 * Curated metadata for every voice id the local Kokoro custom node
 * exposes (`stavsap/comfyui-kokoro` → ~50 named voices). Used by the
 * "Pick a voice" mode in the Generate VO panel: the user sees a
 * filterable dropdown grouped by language + gender instead of a flat
 * list of opaque ids like `af_bella`.
 *
 * The id encoding (Kokoro convention):
 *   first letter  = language/accent — a=AmEn, b=BrEn, j=JP, z=ZH,
 *                   e=ES, f=FR, h=HI, i=IT, p=PT-BR
 *   second letter = f (female) | m (male)
 *   rest          = name
 *
 * `vibe` is a 2-4 word subjective descriptor based on community
 * listening tests / TTS Arena scores. Helps the user pick without
 * playing all 50. English voices (American + British) are well-tested;
 * other-language voices have generic descriptors because the model's
 * range there is narrower.
 */

export const KOKORO_VOICES = [
  // ── American English ─────────────────────────────────────────────
  { id: 'af_heart',    gender: 'female', languageLabel: 'American English', name: 'Heart',    vibe: 'warm, expressive (highest quality)' },
  { id: 'af_bella',    gender: 'female', languageLabel: 'American English', name: 'Bella',    vibe: 'mid-20s, conversational' },
  { id: 'af_nicole',   gender: 'female', languageLabel: 'American English', name: 'Nicole',   vibe: 'soft, intimate, ASMR-leaning' },
  { id: 'af_aoede',    gender: 'female', languageLabel: 'American English', name: 'Aoede',    vibe: 'bright, narrative' },
  { id: 'af_kore',     gender: 'female', languageLabel: 'American English', name: 'Kore',     vibe: 'mature, authoritative' },
  { id: 'af_sarah',    gender: 'female', languageLabel: 'American English', name: 'Sarah',    vibe: 'neutral, friendly' },
  { id: 'af_nova',     gender: 'female', languageLabel: 'American English', name: 'Nova',     vibe: 'clear, professional' },
  { id: 'af_sky',      gender: 'female', languageLabel: 'American English', name: 'Sky',      vibe: 'youthful, breezy' },
  { id: 'af_alloy',    gender: 'female', languageLabel: 'American English', name: 'Alloy',    vibe: 'calm, even-toned' },
  { id: 'af_jessica',  gender: 'female', languageLabel: 'American English', name: 'Jessica',  vibe: 'engaging, conversational' },
  { id: 'af_river',    gender: 'female', languageLabel: 'American English', name: 'River',    vibe: 'mellow, narrative' },
  { id: 'am_michael',  gender: 'male',   languageLabel: 'American English', name: 'Michael',  vibe: 'mid-30s, broadcast-ready' },
  { id: 'am_adam',     gender: 'male',   languageLabel: 'American English', name: 'Adam',     vibe: 'youthful, energetic' },
  { id: 'am_eric',     gender: 'male',   languageLabel: 'American English', name: 'Eric',     vibe: 'mature, gravitas' },
  { id: 'am_onyx',     gender: 'male',   languageLabel: 'American English', name: 'Onyx',     vibe: 'deep, noir-narrator' },
  { id: 'am_liam',     gender: 'male',   languageLabel: 'American English', name: 'Liam',     vibe: 'warm, mid-30s' },
  { id: 'am_fenrir',   gender: 'male',   languageLabel: 'American English', name: 'Fenrir',   vibe: 'commanding, dramatic' },
  { id: 'am_echo',     gender: 'male',   languageLabel: 'American English', name: 'Echo',     vibe: 'measured, neutral' },
  { id: 'am_puck',     gender: 'male',   languageLabel: 'American English', name: 'Puck',     vibe: 'playful, animated' },
  { id: 'am_santa',    gender: 'male',   languageLabel: 'American English', name: 'Santa',    vibe: 'jolly, mature' },

  // ── British English ──────────────────────────────────────────────
  { id: 'bf_emma',     gender: 'female', languageLabel: 'British English',  name: 'Emma',     vibe: 'classic RP, refined' },
  { id: 'bf_isabella', gender: 'female', languageLabel: 'British English',  name: 'Isabella', vibe: 'youthful, expressive' },
  { id: 'bf_alice',    gender: 'female', languageLabel: 'British English',  name: 'Alice',    vibe: 'bright, cheerful' },
  { id: 'bf_lily',     gender: 'female', languageLabel: 'British English',  name: 'Lily',     vibe: 'soft, narrative' },
  { id: 'bm_george',   gender: 'male',   languageLabel: 'British English',  name: 'George',   vibe: 'mature, statesman' },
  { id: 'bm_fable',    gender: 'male',   languageLabel: 'British English',  name: 'Fable',    vibe: 'storyteller, warm' },
  { id: 'bm_lewis',    gender: 'male',   languageLabel: 'British English',  name: 'Lewis',    vibe: 'youthful, conversational' },
  { id: 'bm_daniel',   gender: 'male',   languageLabel: 'British English',  name: 'Daniel',   vibe: 'measured, professional' },

  // ── Japanese ─────────────────────────────────────────────────────
  { id: 'jf_alpha',     gender: 'female', languageLabel: 'Japanese', name: 'Alpha',     vibe: 'standard female' },
  { id: 'jf_gongitsune', gender: 'female', languageLabel: 'Japanese', name: 'Gongitsune', vibe: 'narrative female' },
  { id: 'jf_nezumi',    gender: 'female', languageLabel: 'Japanese', name: 'Nezumi',    vibe: 'youthful female' },
  { id: 'jf_tebukuro',  gender: 'female', languageLabel: 'Japanese', name: 'Tebukuro',  vibe: 'soft female' },
  { id: 'jm_kumo',      gender: 'male',   languageLabel: 'Japanese', name: 'Kumo',      vibe: 'standard male' },

  // ── Mandarin Chinese ─────────────────────────────────────────────
  { id: 'zf_xiaobei',   gender: 'female', languageLabel: 'Mandarin Chinese', name: 'Xiaobei',   vibe: 'warm female' },
  { id: 'zf_xiaoni',    gender: 'female', languageLabel: 'Mandarin Chinese', name: 'Xiaoni',    vibe: 'youthful female' },
  { id: 'zf_xiaoxiao',  gender: 'female', languageLabel: 'Mandarin Chinese', name: 'Xiaoxiao',  vibe: 'standard female (Azure-style)' },
  { id: 'zf_xiaoyi',    gender: 'female', languageLabel: 'Mandarin Chinese', name: 'Xiaoyi',    vibe: 'bright female' },
  { id: 'zm_yunjian',   gender: 'male',   languageLabel: 'Mandarin Chinese', name: 'Yunjian',   vibe: 'mature male' },
  { id: 'zm_yunxi',     gender: 'male',   languageLabel: 'Mandarin Chinese', name: 'Yunxi',     vibe: 'youthful male' },
  { id: 'zm_yunxia',    gender: 'male',   languageLabel: 'Mandarin Chinese', name: 'Yunxia',    vibe: 'expressive male' },
  { id: 'zm_yunyang',   gender: 'male',   languageLabel: 'Mandarin Chinese', name: 'Yunyang',   vibe: 'standard male' },

  // ── Spanish ──────────────────────────────────────────────────────
  { id: 'ef_dora',      gender: 'female', languageLabel: 'Spanish', name: 'Dora',      vibe: 'standard female' },
  { id: 'em_alex',      gender: 'male',   languageLabel: 'Spanish', name: 'Alex',      vibe: 'standard male' },
  { id: 'em_santa',     gender: 'male',   languageLabel: 'Spanish', name: 'Santa',     vibe: 'mature male' },

  // ── French ───────────────────────────────────────────────────────
  { id: 'ff_siwis',     gender: 'female', languageLabel: 'French', name: 'Siwis',     vibe: 'standard female' },

  // ── Hindi ────────────────────────────────────────────────────────
  { id: 'hf_alpha',     gender: 'female', languageLabel: 'Hindi', name: 'Alpha',     vibe: 'standard female' },
  { id: 'hf_beta',      gender: 'female', languageLabel: 'Hindi', name: 'Beta',      vibe: 'alt female' },
  { id: 'hm_omega',     gender: 'male',   languageLabel: 'Hindi', name: 'Omega',     vibe: 'standard male' },
  { id: 'hm_psi',       gender: 'male',   languageLabel: 'Hindi', name: 'Psi',       vibe: 'alt male' },

  // ── Italian ──────────────────────────────────────────────────────
  { id: 'if_sara',      gender: 'female', languageLabel: 'Italian', name: 'Sara',      vibe: 'standard female' },
  { id: 'im_nicola',    gender: 'male',   languageLabel: 'Italian', name: 'Nicola',    vibe: 'standard male' },

  // ── Brazilian Portuguese ─────────────────────────────────────────
  { id: 'pf_dora',      gender: 'female', languageLabel: 'Brazilian Portuguese', name: 'Dora',      vibe: 'standard female' },
  { id: 'pm_alex',      gender: 'male',   languageLabel: 'Brazilian Portuguese', name: 'Alex',      vibe: 'standard male' },
  { id: 'pm_santa',     gender: 'male',   languageLabel: 'Brazilian Portuguese', name: 'Santa',     vibe: 'mature male' },
]

// Convenience: the languages we know voices exist for, in the order
// the picker should render them. The empty-male French case is
// handled by the renderer (filter out empty groups).
export const KOKORO_LANGUAGE_ORDER = [
  'American English',
  'British English',
  'Spanish',
  'Brazilian Portuguese',
  'French',
  'Italian',
  'Japanese',
  'Mandarin Chinese',
  'Hindi',
]

// Pick a sensible default voice id for a given app-level language code
// (the same codes the script writer uses: en / es / pt / fr / it / ja
// / zh / hi). Falls back to a high-quality American English voice.
export function defaultKokoroVoiceForLanguage(code) {
  const map = {
    en: 'af_heart',
    es: 'ef_dora',
    pt: 'pf_dora',
    fr: 'ff_siwis',
    it: 'if_sara',
    ja: 'jf_alpha',
    zh: 'zf_xiaoxiao',
    hi: 'hf_alpha',
  }
  return map[code] || 'af_heart'
}
