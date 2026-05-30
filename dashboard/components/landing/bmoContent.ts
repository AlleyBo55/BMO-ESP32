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
    body: 'The mic state becomes visible, patient, and calm before any voice response happens.',
    signal: 'I2S mic -> voice route',
    animation: 'round listening mouth, slow eye glances, patient blink',
  },
  {
    key: 'think',
    label: 'Think',
    title: 'A pause can feel alive.',
    body: 'A glance and tiny thought bubbles make the brain request read as thinking, not waiting.',
    signal: 'ESP32-C3 -> brain API',
    animation: 'side glance, small smile, two tiny thought bubbles',
  },
  {
    key: 'talk',
    label: 'Talk',
    title: 'The mouth has rhythm.',
    body: 'Small mouth shapes let speech feel playful while staying cheap enough for tiny hardware.',
    signal: 'text -> tiny voice pack',
    animation: 'three mouth shapes timed like a compact voice waveform',
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
    body: 'BMO can move from listening to thinking to talking, so voice input has a visible status at every step.',
    owner: 'INMP441, brain API, MAX98357A',
    visible:
      'The face says listening while audio is captured, thinking while the reply is prepared, and talking while sound plays.',
    implementation:
      'Captured audio is sent to the brain route; streamed PCM16 output feeds the I2S speaker path.',
  },
  {
    title: 'Tiny voice pack',
    body: 'Small local clips keep instant reactions fast, while streamed replies cover conversation.',
    owner: 'Audio clips + voice service',
    visible:
      'BMO can chirp instantly on touch and still speak longer generated replies when the brain route answers.',
    implementation:
      'Short clips are baked into firmware assets; generated replies are streamed to avoid storing large audio on the ESP32.',
  },
  {
    title: 'Memory core',
    body: 'A GBrain-inspired idea helps BMO remember useful facts, recent moments, and preferences.',
    owner: 'Brain service + Supabase memory',
    visible:
      'Replies can feel continuous because BMO can recall what matters before answering.',
    implementation:
      'The brain layer recalls durable context before a response and can enrich memory after successful exchanges.',
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
    connection: 'Shares the ESP32-C3 I2S clock path; data pin follows the live firmware pin map.',
    note: 'Used when hold-to-talk captures audio for the brain route.',
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
