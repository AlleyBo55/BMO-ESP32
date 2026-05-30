/**
 * BMO voice character + delivery steering.
 *
 * OpenRouter/OpenAI TTS cannot clone BMO's exact Adventure Time voice (that's
 * a specific human performance; exact cloning needs a custom voice model we
 * don't have). What we CAN do is two things that get much closer than the
 * stock adult-female default:
 *
 *   1. Pick the most BMO-like base voice (youthful, bright, slightly
 *      androgynous) — see {@link RECOMMENDED_BMO_VOICE}.
 *   2. Steer the *delivery* with an instruction. The `gpt-audio` /
 *      `gpt-audio-mini` models follow tone/character directions given as a
 *      system message, so we describe how BMO should sound and pass it as the
 *      `systemPrompt` to `synthesizeStream`.
 *
 * Both the firmware path (`/api/brain`) and the simulator (`/api/sim/tts`)
 * import this so the device and the in-browser test sound identical.
 */

/**
 * Closest stock voice to BMO among the allow-list. `fable` is the most
 * youthful / gender-ambiguous "little character" voice OpenAI ships; `coral`
 * is a good brighter alternative. Anything but `nova`/`shimmer` (clearly
 * adult-female) is an improvement.
 */
export const RECOMMENDED_BMO_VOICE = 'fable';

/**
 * Delivery direction passed as the TTS system prompt. Describes BMO's vocal
 * character so the audio model performs the line in-character instead of
 * reading it flat. Kept in English (the models follow English stage
 * directions most reliably) even though the spoken line itself is Indonesian.
 */
export const BMO_VOICE_DIRECTION = [
  'You are voicing BMO, the small living video-game console from a kids cartoon.',
  'Perform the line with this voice:',
  '- High-pitched, small, and childlike — like a friendly handheld game toy come to life.',
  '- Bright, curious, and playful, with a warm innocent sweetness. Gender-neutral, never a deep adult voice.',
  '- A subtle cute robotic/digital lilt, as if a little gadget is talking, but still soft and expressive — not monotone.',
  '- Gentle, upbeat pacing with light bouncy energy. Smile while speaking.',
  'Speak the user-provided text exactly as written, in its original language (Indonesian). Do not translate it, do not add or remove words, do not read these instructions aloud.',
].join('\n');
