#!/usr/bin/env python3
"""Generate generic BMO greeting clips in BMO's real dashboard voice.

These are the short "hi!" lines BMO plays on a normal touch (the TOUCH_HOLD
"pet" reaction). They're produced once on your machine using the SAME TTS
voice the live device uses for replies (/api/voice/tts with the BMO voice
direction), then downsampled to 16 kHz mono WAV and dropped into audio/ so the
existing bake step (tools/bake_audio.py) can pack them into flash.

Why generate-then-bake instead of fetching at runtime?
  - A normal touch must feel INSTANT and work OFFLINE. Greetings are tiny,
    fixed, and frequent, so baking them to flash (like the other reaction
    clips) gives zero latency and no network dependency. Reserve the live
    dashboard TTS for the dynamic, unpredictable brain replies.

Usage:
    cd firmware/bmo_face_anim
    # Reads DASHBOARD_URL + FINGERPRINT from .env by default.
    python3 tools/gen_greetings.py
    # then bake into flash:
    python3 tools/bake_audio.py

Requirements: ffmpeg on PATH (used to resample the 24 kHz TTS PCM to the
16 kHz mono WAV the baker expects).
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "audio"
ENV_FILE = ROOT / ".env"

# Source TTS format from /api/voice/tts (pcm16).
SRC_RATE = 24_000
# Target WAV format the baker requires.
DST_RATE = 16_000

# Greeting clip name -> spoken line. The names MUST match kGreetingClips[] in
# src/main.cpp so the firmware can find them. Lines are SHORT (one or two
# words) on purpose: this plays on every normal touch, so it has to be snappy,
# and it has to fit the tight remaining flash budget once baked.
GREETINGS: dict[str, str] = {
    "bmo_hi_friend": "Hai teman!",
    "bmo_hello": "Halo!",
    "bmo_hey": "Hai hai!",
    "bmo_oh_hi": "Oh, hai!",
    "bmo_hi_there": "Hai kamu!",
}

# --- Post-processing knobs ---------------------------------------------------
# The TTS model tends to over-perform a one-word line — drawing it out or
# repeating it for several seconds. For a per-touch greeting we only want the
# FIRST short utterance, so we trim leading silence, cut at the first real
# pause after some speech, hard-cap the length, fade out, and normalize.
SILENCE_DB = -35           # below this is considered "silence"
MIN_SPEECH_S = 0.35        # require this much speech before a pause ends it
PAUSE_S = 0.18             # a gap this long marks the end of the first utterance
MAX_CLIP_S = 1.8           # absolute cap regardless of pauses
FADE_S = 0.06              # fade-out tail so the cut doesn't click


def need(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip()
    return env


def fetch_pcm16(base_url: str, fingerprint: str, text: str) -> bytes:
    """POST text to /api/voice/tts and return raw PCM16 mono 24 kHz bytes."""
    url = base_url.rstrip("/") + "/api/voice/tts"
    payload = json.dumps({"text": text, "format": "pcm16"}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-BMO-Fingerprint": fingerprint,
            "Accept": "audio/L16;rate=24000;channels=1",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        if resp.status != 200:
            need(f"TTS request failed ({resp.status}) for {text!r}")
        return resp.read()


def first_utterance_pcm(pcm: bytes) -> bytes:
    """Extract just the first short utterance from raw 24 kHz PCM16 mono.

    The TTS model often rambles for several seconds on a one-word line. We
    want a snappy per-touch greeting, so: skip leading silence, then keep
    audio until the first PAUSE_S-long quiet gap that follows at least
    MIN_SPEECH_S of speech, hard-capped at MAX_CLIP_S.
    """
    samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
    n = len(samples)
    if n == 0:
        return pcm

    # Frame the signal into 10 ms windows and mark each as speech/silence by
    # RMS against SILENCE_DB.
    frame = max(1, int(SRC_RATE * 0.01))  # 10 ms
    thresh = 32768.0 * (10 ** (SILENCE_DB / 20.0))

    def rms(a: int, b: int) -> float:
        seg = samples[a:b]
        if not seg:
            return 0.0
        return (sum(s * s for s in seg) / len(seg)) ** 0.5

    # Find first speech frame.
    start = 0
    i = 0
    while i < n:
        if rms(i, i + frame) >= thresh:
            start = i
            break
        i += frame
    else:
        return pcm  # all silence; let downstream handle it

    # From start, walk forward tracking speech and accumulating quiet gaps.
    pause_frames_needed = max(1, int(PAUSE_S / 0.01))
    min_speech_frames = max(1, int(MIN_SPEECH_S / 0.01))
    cap_samples = start + int(MAX_CLIP_S * SRC_RATE)

    spoken_frames = 0
    quiet_run = 0
    end = min(n, cap_samples)
    j = start
    while j < min(n, cap_samples):
        is_speech = rms(j, j + frame) >= thresh
        if is_speech:
            spoken_frames += 1
            quiet_run = 0
        else:
            quiet_run += 1
            if spoken_frames >= min_speech_frames and quiet_run >= pause_frames_needed:
                end = j - quiet_run * frame + frame  # cut at start of the gap
                break
        j += frame

    end = max(start + frame, min(end, n))
    return struct.pack("<" + "h" * (end - start), *samples[start:end])


def pcm16_to_wav16k(pcm: bytes, out_path: Path) -> None:
    """Trim to the first utterance, then resample to 16 kHz mono 16-bit WAV.

    Adds a short fade-out so the trim point doesn't click, and loudness-
    normalizes so all greetings sit at a consistent level.
    """
    trimmed = first_utterance_pcm(pcm)
    # Fade-in at the start, fade-out at the end (via the areverse trick, since
    # afade can't address "end" without knowing the duration), then loudness-
    # normalize so every greeting sits at the same level.
    af = (
        f"afade=t=in:st=0:d={FADE_S},"
        f"areverse,afade=t=in:st=0:d={FADE_S},areverse,"
        f"loudnorm=I=-16:TP=-1.5:LRA=11"
    )
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "s16le", "-ar", str(SRC_RATE), "-ac", "1",
        "-i", "pipe:0",
        "-af", af,
        "-ar", str(DST_RATE), "-ac", "1", "-sample_fmt", "s16",
        str(out_path),
    ]
    try:
        subprocess.run(cmd, input=trimmed, check=True)
    except FileNotFoundError:
        need("ffmpeg is required (resamples 24 kHz TTS to 16 kHz WAV).")
    except subprocess.CalledProcessError as exc:
        need(f"ffmpeg failed writing {out_path}: {exc}")


def main() -> None:
    env = load_env()
    base_url = env.get("DASHBOARD_URL", "").strip()
    fingerprint = env.get("FINGERPRINT", "").strip()
    if not base_url or base_url.startswith("https://your-"):
        need("Set DASHBOARD_URL in .env (deployed dashboard origin).")
    if not fingerprint or fingerprint.startswith("your-"):
        need("Set FINGERPRINT in .env (from the dashboard onboarding/rotate UI).")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Generating {len(GREETINGS)} greeting clips from {base_url} ...")
    for name, line in GREETINGS.items():
        print(f"  {name:16s} <- {line!r}")
        pcm = fetch_pcm16(base_url, fingerprint, line)
        if len(pcm) < 2:
            need(f"empty audio returned for {name}")
        out = AUDIO_DIR / f"{name}.wav"
        pcm16_to_wav16k(pcm, out)
        # sanity: confirm it's a non-trivial WAV
        size = out.stat().st_size
        print(f"      -> {out.name} ({size} bytes)")

    print("\nDone. Now bake into flash:")
    print("  python3 tools/bake_audio.py")


if __name__ == "__main__":
    main()
