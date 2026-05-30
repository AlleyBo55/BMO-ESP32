#!/usr/bin/env python3
"""Guardrails for the tiny generic toy-voice pipeline."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "src" / "main.cpp"
HEADER = ROOT / "src" / "audio_clips.h"
BAKER = ROOT / "tools" / "bake_audio.py"
GENERATOR = ROOT / "tools" / "generate_tiny_voice.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}")
        sys.exit(1)


def main() -> None:
    main_cpp = MAIN.read_text(encoding="utf-8")
    header = HEADER.read_text(encoding="utf-8")
    baker = BAKER.read_text(encoding="utf-8")

    require(GENERATOR.exists(),
            "generic toy-voice generator should exist")
    generator = GENERATOR.read_text(encoding="utf-8")
    require("BMO-inspired" in generator and "exact clone" in generator,
            "generator should document generic inspired voice, not exact cloning")

    require("IMA ADPCM" in baker,
            "baker should encode clips as 4-bit IMA ADPCM")
    require("TARGET_RATE = 16000" in baker,
            "voice clips should stay at the firmware audio rate")
    require("TARGET_SAMPLEWIDTH = 1" not in baker,
            "baker should no longer emit raw 8-bit PCM")

    require("sample_count" in header and "predictor" in header and "step_index" in header,
            "audio clip header should include ADPCM decode metadata")
    require("bmo_clip_bmo_hi_friend_data" in header,
            "generated tiny voice pack should include bmo_hi_friend")
    require("bmo_clip_bmo_what_data" in header,
            "generated tiny voice pack should include bmo_what")
    require("BMO_CLIP_COUNT = 7" in header,
            "voice pack should include the seven firmware-referenced clips")

    byte_counts = [int(value) for value in re.findall(r": (\d+) bytes", header)]
    require(byte_counts and sum(byte_counts) < 80_000,
            "compressed voice pack should stay under 80 KB")

    require("static int16_t decodeImaNibble(" in main_cpp,
            "firmware should decode ADPCM nibbles")
    require("clip->sample_count" in main_cpp and "clip->step_index" in main_cpp,
            "playClip() should use ADPCM metadata")
    require("clip->rate != AUDIO_RATE" in main_cpp,
            "playClip() should enforce firmware-rate clips")

    print("tiny voice pipeline guardrails ok")


if __name__ == "__main__":
    main()
