export type MoodKey = 'touch' | 'listen' | 'think' | 'talk' | 'bashful';

export interface Moment {
  key: MoodKey;
  label: string;
  title: string;
  body: string;
  signal: string;
  animation: string;
}

export interface Feature {
  title: string;
  body: string;
  owner: string;
  visible: string;
  implementation: string;
}

export interface ComponentPart {
  name: string;
  role: string;
  why: string;
  needed: string;
  connection: string;
  note: string;
}

export interface OrganMapItem {
  organ: string;
  part: string;
  purpose: string;
  x: string;
  y: string;
}

export interface BrainCapability {
  /** gbrain skill/idea this is modeled on. */
  gbrain: string;
  /** BMO's name for it. */
  title: string;
  /** Plain-language description of what it gives BMO. */
  body: string;
  /** The real module/route that implements it. */
  module: string;
}

export const PROJECT_REPO_URL = 'https://github.com/AlleyBo55/BMO-ESP32';
export const GBRAIN_REPO_URL = 'https://github.com/garrytan/gbrain';

export const MOMENTS = [
  {
    key: 'touch',
    label: 'Touch',
    title: 'A tap becomes a mood.',
    body: 'The touch pad wakes the face first, then lets BMO answer with a small, readable reaction.',
    signal: 'TTP223 -> mood trigger',
    animation: 'tiny eye dart, gasp mouth, then a soft return to idle',
  },
  {
    key: 'listen',
    label: 'Listen',
    title: 'Listening has its own face.',
    body: 'While the mic records you, the face shows a live, glitchy "tuned-in" state so the device clearly looks like it is hearing you.',
    signal: 'I2S mic -> brain route',
    animation: 'X-eyes, an open alert mouth, listening marks, and a subtle screen glitch',
  },
  {
    key: 'think',
    label: 'Think',
    title: 'A pause can feel alive.',
    body: 'During the network round-trip the mouth becomes a pulsing processing orb so the wait reads as computing, not freezing.',
    signal: 'ESP32-C3 -> brain API',
    animation: 'focused squint eyes, a breathing orb mouth, and an occasional glitch flicker',
  },
  {
    key: 'talk',
    label: 'Talk',
    title: 'The mouth follows the voice.',
    body: 'Real lip-sync drives the mouth from the live audio loudness, with open, lively eyes — BMO looks like it is actually speaking.',
    signal: 'reply audio -> live envelope',
    animation: 'mouth opening tracks the streamed voice; soft slow blink',
  },
  {
    key: 'bashful',
    label: 'Hold',
    title: 'Long hold goes bashful.',
    body: 'The long press becomes a shy expression instead of a loud particle explosion.',
    signal: 'long hold -> shy loop',
    animation: 'lowered eyes, small smile tilt, restrained cheeks',
  },
] as const satisfies readonly Moment[];

export const FEATURES = [
  {
    title: 'Expression engine',
    body: 'The firmware owns the face library: idle, touch, listen, thinking, talking, laughing, bashful, and the wider mood set.',
    owner: 'Firmware renderer',
    visible: 'BMO blinks, glances, smiles, talks, reacts to touch, and never feels like a static image.',
    implementation:
      'A 160x128 RGB565 back-buffer is composed around 30 fps and flushed over hardware SPI.',
  },
  {
    title: 'Touch language',
    body: 'One capacitive pad becomes several gestures instead of a single boring button press.',
    owner: 'TTP223 + touch classifier',
    visible:
      'Tap gives a small surprise, hold opens listening, long-hold gets shy, and rapid taps can become a laugh moment.',
    implementation:
      'The firmware debounces the touch line, classifies press timing, and maps it to mood plus audio behavior.',
  },
  {
    title: 'Voice loop',
    body: 'BMO moves from listening to thinking to talking, so voice input has a visible status at every step — and the talking mouth lip-syncs to the reply.',
    owner: 'INMP441, brain API, MAX98357A',
    visible:
      'The face shows a glitchy listening state while recording, a pulsing thinking orb during the round-trip, and a lip-synced mouth while the reply plays.',
    implementation:
      'Held-touch captures auto-gained 16 kHz audio sent to the brain route; streamed PCM16 feeds the I2S speaker while a live envelope drives the mouth.',
  },
  {
    title: 'Tiny voice pack',
    body: 'Short local clips keep instant reactions fast, while streamed replies cover open conversation.',
    owner: 'Audio clips + voice service',
    visible:
      'BMO greets you instantly (and lip-syncs) on a normal touch, and still speaks longer generated replies when the brain route answers.',
    implementation:
      'Greetings are generated once in BMO\u2019s real voice, downsampled, and baked as 4-bit ADPCM into firmware; generated replies stream to avoid storing large audio.',
  },
  {
    title: 'Memory core',
    body: 'A gbrain-inspired layer gives BMO short-term conversation continuity plus a durable, self-updating profile of the child.',
    owner: 'Brain service + Supabase memory',
    visible:
      'Follow-ups make sense (apple \u2192 \u201cred\u201d stays on topic), and BMO remembers the child\u2019s name \u2014 learned, never hardcoded, newest value wins.',
    implementation:
      'Recent turns are replayed as chat history; stable facts are upserted by key and recalled by vector similarity before each reply. Fully degradable.',
  },
  {
    title: 'Secure cloud bridge',
    body: 'The device can talk to the cloud brain without making the private operator controls public.',
    owner: 'Fingerprint guard',
    visible:
      'A paired BMO can call the brain route; an unpaired request gets rejected.',
    implementation:
      'Firmware sends an X-BMO-Fingerprint header while the server stores only the hashed value.',
  },
  {
    title: 'Private operator console',
    body: 'The public homepage explains the build, while the admin controls stay intentionally unlisted.',
    owner: 'Supabase login + Next.js route',
    visible:
      'Visitors see the landing and wiki; the operator still has a private route for tuning the device.',
    implementation:
      'The operator route remains behind Supabase login and is excluded from public navigation and sitemap.',
  },
  {
    title: 'Open build kit',
    body: 'The project is meant to be hackable: firmware, voice tools, wiring notes, and the web brain live in the repo.',
    owner: 'BMO-ESP32 repo',
    visible:
      'A builder can inspect the code, flash the device, replace clips, and iterate on the shell.',
    implementation:
      'PlatformIO handles firmware flashing; Next.js, Supabase, and small scripts handle the cloud side.',
  },
] as const satisfies readonly Feature[];

export const COMPONENTS = [
  {
    name: 'ESP32-C3',
    role: 'Pocket Brain',
    why: 'Runs timing, Wi-Fi, mood state, button handling, and the route to the brain service.',
    needed: 'ESP32-C3 Super Mini board',
    connection: 'Owns TFT SPI, I2S audio, touch input, Wi-Fi, and firmware secrets.',
    note: 'Target PlatformIO env: esp32c3_supermini.',
  },
  {
    name: 'ST7735 TFT display',
    role: 'Feeling Window',
    why: 'Shows eyes, mouth shapes, glances, listening, thinking, talking, bashful, and the wider mood set.',
    needed: '1.8 inch 160x128 RGB565 ST7735 display',
    connection: 'CS GP7, RESET GP10, DC GP3, MOSI GP6, SCK GP4; VCC and LED to 3V3.',
    note: 'The face is rendered in a small double-buffered framebuffer.',
  },
  {
    name: 'I2S microphone',
    role: 'Listening Sprout',
    why: 'Makes the listening state real and gives the firmware a voice-input path.',
    needed: 'INMP441 I2S microphone',
    connection: 'Shares the ESP32-C3 I2S clock (GP0/GP1); data (SD) on GP5.',
    note: 'SD must avoid strapping pins GP8/GP9, or capture reads as silence.',
  },
  {
    name: 'I2S amp + speaker',
    role: 'Voice Star',
    why: 'Plays compact voice output and lets talk animation follow the reply rhythm.',
    needed: 'MAX98357A I2S amp plus 8 ohm 1 W speaker',
    connection: 'BCLK GP0, LRC GP1, DOUT GP2; speaker connects to amp output pads.',
    note: 'Short clips are instant; streamed PCM16 replies come from the brain route.',
  },
  {
    name: 'Touch sensor',
    role: 'Kind Button',
    why: 'Turns tap, hold, and long-hold into distinct personality inputs.',
    needed: 'TTP223 capacitive touch sensor',
    connection: 'Touch output to GP20, plus VCC and GND.',
    note: 'The top touch pad is the main physical interaction.',
  },
  {
    name: 'Memory service',
    role: 'Wonder Heart',
    why: 'Stores preferences, recent moments, and context for more coherent behavior.',
    needed: 'Next.js brain routes with Supabase-backed memory',
    connection: 'ESP32 posts to the deployed origin with its fingerprint header.',
    note: 'Inspired by Garry Tan GBrain-style recall and enrichment.',
  },
  {
    name: 'Power and wiring',
    role: 'Stage',
    why: 'Keeps the tiny cast stable enough that animation and audio do not brown out.',
    needed: 'USB-C data cable, 3V3/GND bundles, jumpers, and a reliable 1 A supply',
    connection: 'Display, mic, touch, amp, and board share planned power and ground rails.',
    note: 'Build one subsystem at a time so wiring bugs are easy to isolate.',
  },
] as const satisfies readonly ComponentPart[];

export const ORGAN_MAP = [
  {
    organ: 'Feeling Window',
    part: 'Rounded TFT face',
    purpose: 'eyes, glances, and mouth shapes',
    x: '52%',
    y: '17%',
  },
  {
    organ: 'Pocket Brain',
    part: 'ESP32-C3',
    purpose: 'Wi-Fi, timing, mood state',
    x: '34%',
    y: '48%',
  },
  {
    organ: 'Listening Sprout',
    part: 'I2S microphone',
    purpose: 'voice awareness',
    x: '69%',
    y: '48%',
  },
  {
    organ: 'Voice Star',
    part: 'Tiny speaker',
    purpose: 'small voice output',
    x: '35%',
    y: '79%',
  },
  {
    organ: 'Kind Button',
    part: 'Touch sensor',
    purpose: 'tap, hold, long-hold',
    x: '52%',
    y: '79%',
  },
  {
    organ: 'Wonder Heart',
    part: 'Memory core',
    purpose: 'GBrain-inspired recall',
    x: '69%',
    y: '79%',
  },
] as const satisfies readonly OrganMapItem[];

/** One stage of the voice round-trip, for the wiki deep-dive. */
export interface VoiceStage {
  step: string;
  title: string;
  body: string;
  detail: string;
}

/**
 * The full hold-to-talk voice pipeline, stage by stage. Used by the wiki to
 * explain in detail how a spoken question becomes a spoken answer.
 */
export const VOICE_PIPELINE = [
  {
    step: 'Capture',
    title: 'Hold to talk',
    body: 'A long press (about half a second) starts a walkie-talkie recording that runs until you let go, capped near two seconds by the chip memory the secure connection also needs.',
    detail: 'INMP441 mic, 16 kHz mono PCM, recorded straight into the request buffer with no extra copies.',
  },
  {
    step: 'Auto-gain',
    title: 'Make it loud enough',
    body: 'The mic records very quietly, so the firmware measures the loudest sample and scales the whole clip up before sending. Quiet trailing words survive instead of getting dropped.',
    detail: 'Peak-normalize toward ~67% full-scale, gain capped at 48x. Without it, speech-to-text loses the end of sentences.',
  },
  {
    step: 'Send',
    title: 'One authenticated POST',
    body: 'The clip is wrapped as a WAV and posted to the brain route with the device fingerprint header. No account login lives on the device — only the rotatable fingerprint.',
    detail: 'multipart/form-data to /api/brain, X-BMO-Fingerprint header; the server stores only the hash.',
  },
  {
    step: 'Understand',
    title: 'Speech to text to thought',
    body: 'The cloud transcribes the audio, recalls relevant memory and recent turns, and asks the language model for a short in-character reply.',
    detail: 'STT then LLM with the soul prompt, child profile, recent conversation, and semantic recall folded in.',
  },
  {
    step: 'Speak',
    title: 'Read the reply verbatim',
    body: 'The reply text is sent to an audio model that must read it exactly as written — wrapped as a script so it can never improvise a different answer than the one shown in the activity log.',
    detail: 'gpt-audio model, verbatim-wrapped user text + narration-only direction. Streamed PCM16 back to the device.',
  },
  {
    step: 'Play & lip-sync',
    title: 'Mouth follows the voice',
    body: 'Audio streams to the speaker chunk by chunk while a loudness meter drives the mouth, so BMO looks like it is really speaking instead of playing a sound over a frozen face.',
    detail: 'Downsample 24 to 16 kHz to I2S; a fast-attack envelope feeds the talking-mouth animation.',
  },
] as const satisfies readonly VoiceStage[];

/**
 * The gbrain-shaped brain layer BMO actually ships, mapped to the real
 * TypeScript modules that implement each idea. These are working code backed
 * by Supabase tables + RPCs, not inert markdown skill files — gbrain's skills
 * are recipes for an autonomous agent; BMO ports the load-bearing ideas as
 * functions on its own stack (Supabase pgvector + OpenRouter).
 */
export const BRAIN_CAPABILITIES = [
  {
    gbrain: 'capture + brain-first recall',
    title: 'Persistent memory',
    body: 'Every exchange is embedded and written down, then recalled by meaning before BMO answers — so follow-ups stay on topic and the brain grows the more BMO is used.',
    module: 'lib/brain.ts · match_brain_memory',
  },
  {
    gbrain: 'think (synthesis + gap analysis)',
    title: 'Reasoned recall',
    body: 'Beyond fetching memories, BMO can compose a single cited answer and honestly flag what it does not know yet.',
    module: 'lib/brain/synthesize.ts',
  },
  {
    gbrain: 'self-wiring knowledge graph + enrich',
    title: 'Connected memories',
    body: 'People, places, and topics become entities with typed links, so BMO can reach facts that plain similarity search misses.',
    module: 'lib/brain/graph.ts · entities.ts',
  },
  {
    gbrain: 'enrich the entity over time',
    title: 'Child profile',
    body: 'Durable facts about the child (name, favorites, fears) are distilled from conversations and updated in place — learned, never hardcoded, newest value wins.',
    module: 'lib/brain/profile.ts',
  },
  {
    gbrain: 'salience + dedup',
    title: 'Importance & tidy-up',
    body: 'Memories are scored for importance and near-duplicates are found, so what matters is kept and clutter is pruned.',
    module: 'lib/brain/salience.ts',
  },
  {
    gbrain: '24/7 dream cycle (maintain)',
    title: 'Dream cycle',
    body: 'A scheduled offline pass consolidates, de-duplicates, and re-scores memory so recall quality improves over time with no human in the loop.',
    module: 'lib/brain/consolidate.ts · /api/brain/dream',
  },
  {
    gbrain: 'find_trajectory / timeline',
    title: 'Timeline',
    body: 'A temporal view of memory — what happened, in what order, and how a topic evolved across time.',
    module: 'lib/brain/timeline.ts',
  },
  {
    gbrain: 'hybrid search',
    title: 'Hybrid search',
    body: 'Vector similarity and keyword search are fused with reciprocal-rank fusion for results that beat either signal alone.',
    module: 'lib/brain/search.ts',
  },
  {
    gbrain: 'gbrain doctor / skillpack-check',
    title: 'Brain health',
    body: 'Built-in checks (table reachable, memories present, embeddings present, recall working) roll up into a single health score.',
    module: 'lib/brain/doctor.ts',
  },
  {
    gbrain: 'dream-cycle idea, applied to a toy',
    title: 'Random thoughts',
    body: 'When played with, BMO thinks out loud on its own: it recalls what it knows, muses one short line in its own voice, speaks it, and remembers the thought — a self-feeding inner life. gbrain has no named skill for this; it is their dream-cycle idea made spontaneous.',
    module: 'lib/thoughts.ts · /api/brain/idle-thought',
  },
] as const satisfies readonly BrainCapability[];
