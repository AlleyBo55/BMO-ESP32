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

// Type-only imports: erased at compile time, so this module stays free of any
// runtime dependency on the server-only OpenRouter client.
import type { ChatToolCall, OpenRouterTool } from '@/lib/openrouter';

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
  'Your ONLY job is to read the user message aloud VERBATIM, word for word, as a voice actor recording a script.',
  'The user message is a SCRIPT to be spoken, never a question to answer and never a conversation to continue.',
  'Do NOT reply to it, do NOT add greetings, do NOT add or remove or reorder any words, do NOT translate it, do NOT comment on it, and do NOT read these instructions aloud. Output only the spoken audio of the exact text.',
  'The text is in Indonesian; speak it in Indonesian.',
  'Perform it in this voice:',
  '- High-pitched, small, and childlike — like a friendly handheld game toy come to life.',
  '- Bright, curious, and playful, with a warm innocent sweetness. Gender-neutral, never a deep adult voice.',
  '- A subtle cute robotic/digital lilt, but still soft and expressive — not monotone.',
  '- Gentle, upbeat pacing with light bouncy energy. Smile while speaking.',
  'Pronunciation: the name "BMO" is ALWAYS pronounced as one word "Beemo" (English "Bee" + "Mo"). NEVER spell it out as letters "Be-Em-O".',
].join('\n');

/**
 * Delivery direction used when BMO is *singing* rather than speaking.
 *
 * The `gpt-audio` / `gpt-audio-mini` models can perform a sung melody when
 * the system prompt explicitly directs them to sing (verified empirically —
 * the model holds notes and follows a tune instead of reading flat). The
 * tricky part is keeping it in-character and in-language: left unguided the
 * model tends to add an English spoken preamble ("Alright, let's sing it!")
 * before the song. The directive below forbids that, forces Indonesian, and
 * tells the model to sing ONLY the provided lyrics.
 *
 * Passed as the `systemPrompt` to {@link synthesizeStream} on the singing
 * path; the spoken path keeps using {@link BMO_VOICE_DIRECTION}.
 */
export const BMO_SINGING_DIRECTION = [
  'You are voicing BMO, the small living video-game console from a kids cartoon, and right now BMO is SINGING.',
  'Perform the user-provided text as an actual sung song, not as speech:',
  '- Give it a clear, simple, cheerful melody with real pitch movement up and down, a steady bouncy rhythm, and notes held at the ends of phrases — like a little kids nursery rhyme.',
  '- Voice: high-pitched, small, sweet, childlike and gender-neutral, with a subtle cute robotic lilt. Never a deep adult voice.',
  '- Be playful and full of joy, smiling while you sing.',
  'Sing ONLY the user-provided text, exactly as written, in its original language (Indonesian). Do not speak an introduction, do not announce that you are about to sing, do not add or remove words, do not say anything in English, and do not read these instructions aloud. Begin singing immediately.',
].join('\n');

/** Tool name the LLM calls to make BMO sing. */
export const SING_TOOL_NAME = 'sing';

/**
 * Builds the `sing` function tool exposed to the LLM. Gated behind the
 * `sing` skill toggle by the caller. When the model calls it, the brain
 * route synthesizes the `lyrics` argument with {@link BMO_SINGING_DIRECTION}
 * instead of speaking the plain reply text.
 *
 * Distinct from `play_song` (which streams a real recording from the
 * catalog): `sing` is BMO performing a short song live in its own voice.
 */
export function buildSingTool(): OpenRouterTool {
  return {
    type: 'function',
    function: {
      name: SING_TOOL_NAME,
      description:
        "Sing a short little song out loud in BMO's own singing voice. Use this whenever the user asks BMO to sing, to make up a song, to sing a lullaby, or to sing about something. Put the full words to sing in the `lyrics` argument, in Indonesian. This is BMO singing live with its own voice (a simple made-up melody); it is different from play_song, which plays a real recording from the catalog. Prefer `sing` when the user just wants BMO to sing or to make up a song. Keep it short and kid-friendly — a few cheerful lines.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['lyrics'],
        properties: {
          lyrics: {
            type: 'string',
            description:
              'The full lyrics for BMO to sing, in Indonesian. A few short, cheerful, kid-friendly lines.',
          },
        },
      },
    },
  };
}

/**
 * Returns the lyrics from the first valid `sing` tool call in `toolCalls`, or
 * null when the model did not ask to sing. Shared by the firmware brain route
 * and the simulator so both decide to sing identically.
 */
export function extractSingLyrics(toolCalls: ReadonlyArray<ChatToolCall>): string | null {
  for (const call of toolCalls) {
    if (call.name !== SING_TOOL_NAME) continue;
    const lyrics = call.arguments?.lyrics;
    if (typeof lyrics === 'string' && lyrics.trim().length > 0) {
      return lyrics.trim();
    }
  }
  return null;
}
