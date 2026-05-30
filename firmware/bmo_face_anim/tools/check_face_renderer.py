#!/usr/bin/env python3
"""Static guardrails for the tiny BMO face renderer.

This firmware is mostly embedded drawing code, so the cheapest useful host-side
check is to keep the render paths unified and make sure color erasing follows
the active frame background.
"""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "main.cpp"


def require(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}")
        sys.exit(1)


def extract_function_body(source: str, signature: str) -> str:
    start = source.find(signature)
    require(start >= 0, f"missing {signature}")
    brace = source.find("{", start)
    require(brace >= 0, f"{signature} has no body")
    depth = 0
    for index in range(brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[brace + 1:index]
    require(False, f"{signature} body is unterminated")
    return ""


def main() -> None:
    source = SOURCE.read_text(encoding="utf-8")

    require("static void drawFaceToBuffer(const FaceState &s, uint32_t now)" in source,
            "face drawing should live in shared drawFaceToBuffer()")
    require("static uint16_t g_frameBg = C_BG;" in source,
            "erase operations should track the active frame background")
    require("static constexpr uint16_t C_BG       = 0xCF3A;" in source,
            "screen color should use the sampled pale mint BMO palette")
    require("static constexpr uint16_t C_MOUTH    = 0x3AA7;" in source,
            "open mouth fill should use sampled dark green, not pure black")
    require("static constexpr uint16_t C_TONGUE   = 0xB593;" in source,
            "tongue/lower-mouth color should be muted olive-gray, not red")
    require("static constexpr int EYE_W = 8;" in source,
            "normal eyes should be tiny round BMO dots")
    require("static constexpr int EYE_H = 8;" in source,
            "normal eyes should be tiny round BMO dots")
    require("static constexpr int EYE_DX = 46;" in source,
            "eyes should use wide BMO-like spacing")
    require("static constexpr int MOUTH_Y  = 80;" in source,
            "mouth should sit higher like the BMO reference")
    require("EYE_CRESCENT" in source,
            "happy/laugh states should have crescent eyes")
    require("static void fbDrawCrescentEye(" in source,
            "crescent eye primitive should exist")
    require("static void fbDrawListeningMarks(" in source,
            "listening state should have a dedicated visual cue")
    require("static void fbDrawThinkingDots(" in source,
            "thinking state should have a dedicated processing cue")
    require("MOOD_THINKING" in source,
            "thinking should be its own mood, not overloaded onto confused")
    require("static void applyMoodTransition(FaceState &s, float t)" in source,
            "moods should share a soft in/out transition helper")
    require("static void playReactionGlance(TouchKind k)" in source,
            "touch reactions should begin with a tiny eye glance")
    require("int smileWidth = 46;" in source and "int smileDip = 8;" in source,
            "line-smile reactions should be able to vary subtly")

    eye_body = extract_function_body(source, "static void fbDrawEye(")
    question_body = extract_function_body(source, "static void fbDrawQuestion(")
    require("g_frameBg" in eye_body and "C_BG" not in re.sub(r"g_frameBg", "", eye_body),
            "eye lid erase should use g_frameBg, not hard-coded C_BG")
    require("fbFillEllipse(cx, cy, rx, ry, C_INK);" in eye_body,
            "default eyes should render as round dot eyes")
    require("C_SHINE" not in eye_body,
            "default eyes should be plain black, without anime-style highlights")
    require("g_frameBg" in question_body and "C_BG" not in re.sub(r"g_frameBg", "", question_body),
            "question mark erase should use g_frameBg, not hard-coded C_BG")

    particle_body = extract_function_body(
        source,
        "static void renderFrameWithParticles(const FaceState &s, uint32_t now)",
    )
    require("drawFaceToBuffer(s, now);" in particle_body,
            "particle renderer should reuse the shared face renderer")
    require("switch (s.eyeShape)" not in particle_body,
            "particle renderer should not duplicate the eye switch")
    require("switch (s.mouth)" not in particle_body,
            "particle renderer should not duplicate the mouth switch")

    draw_body = extract_function_body(
        source,
        "static void drawFaceToBuffer(const FaceState &s, uint32_t now)",
    )
    require("fbDrawBlush(leftCx - 18" in draw_body,
            "left cheek should track the left eye instead of the screen edge")
    require("fbDrawBlush(rightCx + 18" in draw_body,
            "right cheek should track the right eye instead of the screen edge")
    require("fbDrawSmile(MOUTH_CX + s.shakeX, MOUTH_Y - 4 + s.shakeY, s.smileWidth, s.smileDip, 3, 2, C_MOUTH)" in draw_body,
            "default smile should use the smaller variable BMO smile")
    require("s.smileWidth" in draw_body and "s.smileDip" in draw_body,
            "default smile should use FaceState smile variation")
    require("talkPhase" in draw_body and "case 0" in draw_body and "case 1" in draw_body,
            "talk mouth should use multiple mouth shapes")
    require("s.listeningMarks" in draw_body and "fbDrawListeningMarks" in draw_body,
            "drawFaceToBuffer() should render listening marks from FaceState")
    require("s.thinkingDots" in draw_body and "fbDrawThinkingDots" in draw_body,
            "drawFaceToBuffer() should render thinking dots from FaceState")
    open_mouth_body = extract_function_body(source, "static void fbDrawOpenMouth(")
    bmo_mouth_body = extract_function_body(source, "static void fbDrawBmoMouth(")
    require("fbDrawOpenMouth" in draw_body and "C_SHINE" in bmo_mouth_body,
            "open mouth should include a bright tooth/shine detail")
    require("fbDrawBmoMouth" in open_mouth_body and "C_MOUTH" in bmo_mouth_body,
            "open mouth should use the BMO dark-green mouth helper")
    shades_body = extract_function_body(source, "static void fbDrawShades(")
    require("leftCx  - 26" in shades_body and "rightCx + 26" in shades_body,
            "Viper shades should be an oversized wraparound shield lens")
    require("noseX" in shades_body and "center nose notch" in shades_body,
            "Viper shades should include the small dark nose cutout from the reference")
    require("C_LENS_SKY" in shades_body and "C_LENS_AQUA" in shades_body
            and "C_LENS_TEAL" in shades_body and "C_LENS_NAVY" in shades_body,
            "Viper shades should use stacked blue/cyan/teal mirror bands")
    require("upper swept-back arms" in shades_body and "lower swept-back arms" in shades_body,
            "Viper shades should have thick swept-back side arms")

    play_mood_start = source.find("static void playMood(")
    require(play_mood_start >= 0, "missing playMood()")
    happy_start = source.find("case MOOD_HAPPY:", play_mood_start)
    idle_start = source.find("case MOOD_IDLE:", play_mood_start)
    talk_start = source.find("case MOOD_TALK:", play_mood_start)
    listen_start = source.find("case MOOD_LISTEN:", play_mood_start)
    thinking_start = source.find("case MOOD_THINKING:", play_mood_start)
    laugh_start = source.find("case MOOD_LAUGH:", play_mood_start)
    require(idle_start >= 0 and happy_start >= 0 and talk_start >= 0
            and listen_start >= 0 and thinking_start >= 0 and laugh_start >= 0,
            "playMood() should define idle, happy, talk, listen, thinking, and laugh cases")
    idle_body = source[idle_start:source.find("case MOOD_BLINK:", idle_start)]
    happy_body = source[happy_start:talk_start]
    talk_body = source[talk_start:listen_start]
    listen_body = source[listen_start:thinking_start]
    thinking_body = source[thinking_start:source.find("case MOOD_SURPRISE:", thinking_start)]
    laugh_body = source[laugh_start:source.find("default: break;", laugh_start)]
    play_mood_body = extract_function_body(source, "static void playMood(")
    require("applyMoodTransition(s, t);" in play_mood_body,
            "playMood() should apply the shared in/out transition")
    require("now % 5200" in idle_body and "M_OPEN" in idle_body and "mouthOpen" in idle_body,
            "idle should use rare blink, eye drift, and compact BMO mouth variation")
    require("((now / 120) % 3)" in talk_body,
            "talk mood should drive three mouth phases")
    require("listeningMarks = true" in listen_body and "mouthOpen" in listen_body,
            "listening mood should show active listening marks and a small attentive mouth")
    require("thinkingDots = true" in thinking_body and "pupilDy = -2" in thinking_body,
            "thinking mood should show processing dots and an up-looking gaze")
    require("EYE_CRESCENT" in happy_body,
            "happy mood should use crescent eyes")
    require("EYE_CRESCENT" in laugh_body,
            "laugh mood should use crescent eyes")

    reaction_body = extract_function_body(source, "static void playReaction(TouchKind k)")
    poke_start = reaction_body.find("case TOUCH_QUICK_POKE:")
    hold_start = reaction_body.find("case TOUCH_HOLD:", poke_start)
    require(poke_start >= 0 and hold_start >= 0,
            "touch reactions should define quick poke before hold")
    poke_body = reaction_body[poke_start:hold_start]
    require("playReactionGlance(k);" in reaction_body,
            "playReaction() should glance before the reaction")
    require("particlesEmit(" not in poke_body,
            "quick poke should not draw center exclamation/arrow particles")
    require("particlesEmit(MAX_PARTICLES" not in reaction_body,
            "touch reactions should avoid max-particle heart bursts")
    require("particlesEmit(6," not in reaction_body and "particlesEmit(3," not in reaction_body,
            "touch reactions should use toned-down particle counts")
    require("now - lastPuff > 420" in reaction_body and "now - lastHeart > 650" in reaction_body,
            "hold and long-hold ambient particles should be less noisy")
    require("bashful" in reaction_body,
            "hold/long-hold should be documented and tuned as bashful BMO")

    print("face renderer guardrails ok")


if __name__ == "__main__":
    main()
