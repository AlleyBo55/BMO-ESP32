#!/usr/bin/env python3
"""Generate a tiny generic toy-computer voice pack.

This intentionally makes a BMO-inspired high, bright, musical toy voice, not an
exact clone of any actor or copyrighted character voice. On macOS it uses the
system `say` voice as an intelligible seed and then pitch-shifts/bit-crushes it
with ffmpeg. If `say` is unavailable, it falls back to simple procedural chirps.
"""

from pathlib import Path
import math
import shutil
import struct
import subprocess
import tempfile
import wave


ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "audio"
RATE = 16000

PHRASES = {
    "bmo_hi_friend": "hi friend",
    "bmo_what": "what",
    "bmo_chant": "bee mo bee mo",
    "bmo_hooray": "hooray",
    "bmo_games": "who wants to play",
    "bmo_laugh": "hee hee hee",
    "bmo_sigh": "hmm",
}


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def have(command: str) -> bool:
    return shutil.which(command) is not None


def normalize_wav(path: Path) -> None:
    with wave.open(str(path), "rb") as wav:
        frames = wav.readframes(wav.getnframes())
        samples = list(struct.unpack("<" + "h" * (len(frames) // 2), frames))
    peak = max(1, max(abs(s) for s in samples))
    gain = min(2.8, 28000 / peak)
    samples = [max(-32768, min(32767, int(s * gain))) for s in samples]
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))


def generate_with_say(name: str, text: str, out_path: Path) -> bool:
    if not (have("say") and have("ffmpeg")):
        return False

    with tempfile.TemporaryDirectory() as tmp:
        seed = Path(tmp) / f"{name}.aiff"
        # Samantha is intelligible and generic. The filtering below makes the
        # result smaller-speaker, higher, and more toy-like.
        run(["say", "-v", "Samantha", "-r", "245", "-o", str(seed), text])
        filters = ",".join([
            "aresample=44100",
            "asetrate=58000",
            "atempo=0.82",
            "aresample=16000",
            "highpass=f=280",
            "lowpass=f=5200",
            "acrusher=bits=7:mix=0.45",
            "volume=1.6",
        ])
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(seed),
            "-af", filters,
            "-ac", "1",
            "-ar", str(RATE),
            "-sample_fmt", "s16",
            str(out_path),
        ])
    normalize_wav(out_path)
    return True


def chirp_samples(text: str) -> list[int]:
    syllables = max(1, min(5, len(text.split())))
    samples: list[int] = []
    base = 720
    for i in range(syllables):
        dur = 0.18 if syllables > 1 else 0.26
        count = int(RATE * dur)
        start = base + i * 80
        end = start + (180 if i % 2 == 0 else -120)
        phase = 0.0
        for n in range(count):
            t = n / max(1, count - 1)
            env = math.sin(math.pi * t)
            hz = start + (end - start) * (t * t * (3 - 2 * t))
            hz *= 1.0 + 0.025 * math.sin(2 * math.pi * 7 * n / RATE)
            phase += 2 * math.pi * hz / RATE
            # A small second harmonic gives the fallback a vowel-ish edge.
            v = math.sin(phase) * 0.72 + math.sin(phase * 2.0) * 0.20
            samples.append(int(v * env * 22000))
        samples.extend([0] * int(RATE * 0.035))
    return samples


def generate_procedural(text: str, out_path: Path) -> None:
    samples = chirp_samples(text)
    with wave.open(str(out_path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack("<" + "h" * len(samples), *samples))


def main() -> None:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in PHRASES.items():
        out_path = AUDIO_DIR / f"{name}.wav"
        if generate_with_say(name, text, out_path):
            source = "say+ffmpeg"
        else:
            generate_procedural(text, out_path)
            source = "procedural"
        print(f"{name:18s} {source:12s} -> {out_path}")


if __name__ == "__main__":
    main()
