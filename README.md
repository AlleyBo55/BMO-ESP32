<div align="center">

# BMO

### A tiny living friend, built from a pocket of parts.

![BMO — animated face on a 1.8 inch ST7735 TFT, running on an ESP32-C3 Super Mini](src/bmo.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-5DCBC2?style=for-the-badge)](LICENSE)
[![ESP32-C3](https://img.shields.io/badge/ESP32--C3-Super%20Mini-1A2D63?style=for-the-badge)](https://www.espressif.com/en/products/socs/esp32-c3)
[![AI Coming Soon](https://img.shields.io/badge/AI-coming%20soon-F81F40?style=for-the-badge)](#-ai-features-coming-soon)
[![Made with ♥](https://img.shields.io/badge/made%20with-♥-FFE066?style=for-the-badge)](#)

> ## ⭐ **Star it. Fork it. Build it.** ⭐

*"Hi friend!"*

</div>

---

## 🤖 AI features — coming soon

BMO is about to learn to listen.

The microphone is already wired. The conversation pipeline is already sketched. The next release ships:

- **🎙️ Push-to-talk via the touch sensor.** Press BMO. Tell it anything. Let go.
- **🧠 Real conversations** — Whisper for speech-to-text → Claude or GPT-4o-mini for the reply → OpenAI TTS streamed back through the speaker.
- **🎭 Mood-aware responses.** BMO listens with `MOOD_LISTEN`, thinks with `MOOD_THINK`, talks with `MOOD_TALK` — and chooses voice tone based on what it just said.
- **🌐 Wi-Fi setup over the web simulator.** No serial-cable provisioning. No hardcoded credentials in flash.
- **🎨 BMO-style voice synthesis.** TTS output gets pitch-shifted and bit-crushed to match BMO's chiptune cadence, automatically.

This isn't vaporware — most of the path is already in [`documentation.html`](documentation.html) under "Extending BMO." The hardware is ready today. Stay tuned, or [fork the repo](#) and beat us to it.

---

## Why does this exist?

Most people walk past a screen on a desk and feel nothing. We thought you deserved better.

So we built BMO. Not a copy. Not a tribute. A small friend who happens to live on a 1.8-inch screen and a five-dollar microcontroller — and who blinks, laughs, gets shy when you touch it, and yells "Hooray!" when you hold it long enough.

This is what happens when you stop making things to *do* things, and start making things that simply make you smile.

---

## ✨ What it is

A complete, hackable BMO — face animation, voice, touch reactions, pre-baked sound clips — built from parts that fit in your palm and total well under **Rp 200,000** (about $12).

- **25 moods.** Idle, blink, happy, laugh, wink, love, talk, listen, focused, surprise, excited, scared, hungry, hot, cold, sick, dizzy, glitch, confused, bored, sad, angry, cool, wake, sleepy. Each one is a real animation, not a static pose.
- **Touch reactions you can feel.** Quick poke makes BMO gasp and dart its eyes. Hold it and it blushes and purrs. Hold it longer and its eyes turn into hearts. Tickle it (three rapid taps) and it loses its mind laughing.
- **A real voice.** Drop in WAV clips of BMO saying anything you want, run one Python script, and BMO speaks them back to you on touch.
- **30 fps, double-buffered, no flicker.** A 40 KB framebuffer in RAM is composed every frame and pushed in one hardware-SPI burst. Smooth as butter.
- **Built by hand. Open by design.** No closed firmware. No mystery sauce. Just C++ and Python you can read in an afternoon.

---

## 🎨 The cast

```
ESP32-C3 Super Mini   ~Rp  60,000   the brain
ST7735 1.8" TFT       ~Rp  30,000   the face
MAX98357A I2S amp     ~Rp  35,000   the voice box
8Ω 1W speaker         ~Rp  15,000   the actual voice
INMP441 I2S mic       ~Rp  35,000   the ears (ready for AI conversation)
TTP223 touch sensor   ~Rp  10,000   the soul
breadboard + wires    ~Rp  20,000
─────────────────────────────────
total                 ~Rp 205,000   (≈ $12 USD)
```

That's it. No PCB. No surface mount. No dark magic. Anyone with a soldering iron and patience can build BMO this weekend.

---

## 📦 Prerequisites

A few things to install before the magic starts. Pick the camp you live in:

### Required (everyone)

- **PlatformIO** — the unified build system that flashes the firmware. Two ways:
  - **VS Code extension** (recommended): install [VS Code](https://code.visualstudio.com/), then add the [PlatformIO IDE](https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide) extension. Done.
  - **Or CLI only**: `pip install platformio` if you prefer the terminal.

- **A USB-C data cable**. Charge-only cables are a real thing and they'll cost you an hour. Use the one that came with your phone for sync.

- **Drivers** for the ESP32-C3's native USB-CDC. macOS and recent Linux work out of the box. On Windows you may need the [USB-CDC driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers) if the port doesn't appear.

### Optional (for the web simulator)

The Next.js + Tailwind simulator is on the roadmap (see [AI features coming soon](#-ai-features--coming-soon)). It will use the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API), so once it lands you'll need:

- **Node.js 22+** — [nodejs.org](https://nodejs.org/) or use [nvm](https://github.com/nvm-sh/nvm)
- **Chrome or Edge** desktop browser. Safari and Firefox don't support Web Serial yet.

### Optional (for baking real BMO voice clips)

- **Python 3.10+** with `pydub`:
  ```bash
  pip install pydub
  ```
- **ffmpeg** — only if you want to bake `.mp3` files (`.wav` works without it):
  ```bash
  brew install ffmpeg          # macOS
  sudo apt install ffmpeg      # Ubuntu/Debian
  ```

### Optional (for designing BMO's 3D-printed shell)

- **Python 3.11+** with `build123d`:
  ```bash
  pip install build123d
  ```
- A 3D printer or a friend who has one. FDM with PLA is plenty for BMO.

---

## 🚀 Get started in five minutes

```bash
git clone git@github.com:AlleyBo55/BMO-ESP32.git bmo
cd bmo

# Firmware
cd firmware/bmo_face_anim
pio run -t upload
```

Plug in your USB cable. BMO comes alive. Touch it. Hear it greet you back.

---

## 📖 Wiring & how it all works

**Everything you need is in [`documentation.html`](documentation.html).**

Open it in any browser. The full pin map, the troubleshooting guide, the animation pipeline, the touch reaction breakdown, the voice clip baking workflow — it's all there with diagrams, code samples, and the painful debugging history we went through so you don't have to.

Highlights:
- 14 GPIOs mapped across 4 components, with rationale for every choice
- The exact wire-by-wire recovery sequence if your screen turns white
- Why both Adafruit_ST7735 and TFT_eSPI silently broke on the C3, and how we fixed it
- The 4-phase animation breakdown for every touch gesture
- Power budget math and why you need a 1A wall adapter, not a laptop USB port

---

## 🏗️ What's in the project

```
BMO/
├── documentation.html          ← read this first
├── firmware/bmo_face_anim/     ← the embedded C++ that makes BMO live
│   ├── src/main.cpp
│   ├── audio/                  ← drop your WAV files here
│   └── tools/bake_audio.py     ← turns WAVs into a C header
└── .kiro/steering/             ← CAD skills for designing BMO's 3D-printed shell
```

---

## 🎨 Design BMO's shell with Kiro steering

A face floating in the air on a breadboard is a prototype. A face inside a real chassis is a **friend**.

This repo ships with a full set of **Kiro steering files** under `.kiro/steering/` that turn any Kiro-powered editor into a CAD designer for BMO. Open the workspace in [Kiro](https://kiro.dev) and ask for things like:

> *"Design a 3D-printable face plate for the 1.8 inch ST7735 with M2 mounting holes and a recessed bezel."*
>
> *"Make a back shell that fits the C3 Super Mini and a 1000 mAh LiPo with a USB-C cutout."*
>
> *"Generate the BMO body assembly, ready for FDM printing in PLA."*

The steering set is the **CAD Skills suite** from [`earthtojake/text-to-cad`](https://github.com/earthtojake/text-to-cad), broken out as one steering doc per skill so each loads only when relevant:

- `cad-skill.md` — parametric build123d/Python parts, STEP-first workflow
- `step-parts-skill.md` — sourcing real screws, bearings, standoffs from [step.parts](https://step.parts)
- `render-skill.md` — CAD Explorer live preview + snapshot CLI
- `urdf-skill.md` / `srdf-skill.md` / `sdf-skill.md` — when BMO grows arms or wheels
- `sendcutsend-skill.md` — laser-cut metal preflight for SendCutSend orders
- `cad-harness.md` — repo-level discipline (source of truth, LFS, derived artifacts)
- `cad-skills-overview.md` — the dispatcher that routes tasks to the right skill

Workflow once installed:

```bash
# Optionally install the bundle for the live CAD Explorer viewer
npx skills add earthtojake/text-to-cad

# Set up the build123d Python env
python3.11 -m venv .venv
./.venv/bin/pip install build123d ocp-vscode

# Ask Kiro to design a part. It will write hardware/parts/<name>.py for you.
# Then export STEP/STL/3MF in one go:
./.venv/bin/python hardware/parts/bmo_face_plate.py
```

3D-print the result, screw the screen in, and BMO has a body.

---

## 🛠️ Build your own. Make it yours.

BMO is a starting point, not a finish line. Things people have already started:

- **Add a camera** (ESP32-S3-CAM upgrade) — BMO sees you
- **Wire in WiFi + Whisper + Claude + TTS** — BMO actually talks back
- **3D print a real chassis** — the `.kiro/steering/cad-skills-overview.md` has the parametric build123d workflow ready to go
- **Make BB8 instead** — same firmware shape, different face palette
- **Mount it on wheels** — patrol robot, daughter-watching robot, weather-station robot

Pull requests welcome. Issues welcome. Forks especially welcome. The most BMO thing you can do is take this and make it weirder.

---

## 💡 The honest truth

This started as one developer wiring an ST7735 to an ESP32 at 1 AM and getting a white screen for two hours. That's how every BMO begins. If you get stuck, the troubleshooting section was written from real scars.

The point was never to ship a product. The point was to remind ourselves that the small, useless, joyful things — the ones that don't optimize for anything except making you smile — are still the most fun to build.

Build BMO. Show your friend. Watch them try to tickle it. That's the whole prize.

---

<div align="center">

## License

[MIT](LICENSE) — do whatever you want, just keep the copyright line.

The BMO character is © Cartoon Network. This project is a fan tribute and personal-use educational kit. If you want to ship a commercial product based on this, replace the BMO likeness with your own design — the firmware shape ports cleanly to any character.

---

### One more thing

> *"Who wants to play video games?"* — BMO

⭐ **[Star this project](#)** if it made you smile.
🔱 **[Fork it](#)** if you're going to build one.
🛠️ **[Build it](documentation.html)** if you're ready to make a friend.

</div>
