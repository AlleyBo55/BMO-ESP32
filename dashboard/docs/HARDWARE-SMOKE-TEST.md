# Hardware Smoke Test

End-to-end test that exercises the full BMO loop: physical button → mic → dashboard → OpenRouter → speaker. If all six steps below pass, the firmware-dashboard contract is healthy and a real user can talk to BMO.

Run this test:
- After the very first deploy
- After any change to `/api/brain`, `/api/voice/stt`, or `/api/voice/tts`
- After any change to the firmware's `bmo_brain_client` module
- Before tagging a release

Expected duration: 10 minutes.

---

## Equipment checklist

- BMO board (ESP32-C3 Super Mini) wired per `firmware/bmo_face_anim/README-WIRING.md`
- INMP441 mic, MAX98357A speaker, TTP223 touch button, ST7735 face display — all connected and working in isolation (run the existing face animation test first if unsure)
- USB-C cable to flash and monitor
- A working dashboard deploy (per `docs/DEPLOY.md`) reachable from the BMO's WiFi network
- A 2.4 GHz WiFi network the ESP32-C3 can join (the chip does not support 5 GHz)
- The plaintext fingerprint from onboarding, in your scratch buffer

---

## The six steps

### Step 1 — Deploy the dashboard and complete onboarding

Follow `docs/DEPLOY.md` steps 1–6. By the end you have:
- A dashboard URL that returns the login page when visited
- A username + password you can sign in with
- A plaintext fingerprint copied to your scratch buffer

Verify by signing in and clicking around. The home page should show your OpenRouter credit balance.

### Step 2 — Paste the fingerprint and dashboard URL into `secrets.h`

In the firmware repo:

```bash
cd firmware/bmo_face_anim
cp include/secrets.h.in include/secrets.h
$EDITOR include/secrets.h
```

Replace the four `@…@` placeholders:

```cpp
#define BMO_WIFI_SSID     "your-wifi-ssid"
#define BMO_WIFI_PASS     "your-wifi-password"
#define BMO_DASHBOARD_URL "https://bmo-dashboard.vercel.app"
#define BMO_FINGERPRINT   "<the-fingerprint-from-step-1>"
```

The file is gitignored. Verify with `git status` — `include/secrets.h` should not appear.

### Step 3 — Build and flash via PlatformIO

Plug the BMO into USB. Then:

```bash
pio run -e esp32c3_supermini -t upload
pio device monitor -e esp32c3_supermini
```

The pre-build hook (`scripts/check_secrets_h.py`) will fail the build with a clear error if `include/secrets.h` is missing or still contains `@PLACEHOLDER@` markers. If you see that error, go back to step 2.

In the serial monitor you should see, within ~5 seconds of boot:

```
[wifi] connecting to <SSID>…
[wifi] connected, ip=192.168.x.x, rssi=-47
[brain] dashboard=https://bmo-dashboard.vercel.app, fingerprint=********
[brain] ready
```

### Step 4 — Power BMO, hold the touch button, speak

With the firmware running:

1. Hold the touch button on top of BMO.
2. Speak into the mic: **"tell me a story"**.
3. Release the button when you finish speaking.

The board should:
- Show the **listening** mood (eyes wide) while you hold
- Show the **thinking** mood (eyes narrowing, slow blink) the moment you release
- Show the **talking** mood (mouth animating in sync) when audio starts coming back

In the serial monitor:

```
[touch] press
[mic] capturing 16k mono pcm…
[touch] release, captured 38400 samples (2.4s)
[brain] POST /api/brain status=200 in 1820ms
[brain] streaming audio, first chunk 1187ms after request
[brain] stream ended after 4.6s, 110592 bytes
[touch] idle
```

### Step 5 — Verify expected behavior

Expected outcomes:

- **Face**: animates listening → thinking → talking → idle in that order
- **Audio**: a clearly audible BMO reply through the speaker, recognisable as a short story
- **Latency**: first audible chunk within ~2 seconds of releasing the button (Property 17 SLO)
- **Dashboard**: visit the **Activity** page in the dashboard. There should be a new row with `type=brain`, `status=ok`, `input_text` containing "tell me a story", `reply_text` containing the start of the response, and `total_ms` < 5000

If all four hold: **smoke test passes.** Move to step 6 for the negative test.

### Step 6 — Negative test: rotate the fingerprint, verify firmware fails

This proves the auth boundary works.

1. In the dashboard, navigate to **Fingerprint** → click **Rotate**.
2. **Do not** copy the new fingerprint. Leave the firmware on its old value.
3. Wait 10 seconds (longer than the 5-second config cache).
4. On the BMO, hold the touch button and speak again.
5. The serial monitor should show:
   ```
   [brain] POST /api/brain status=401 in 380ms
   [brain] error mood for 1s
   ```
6. The face should flash the **error** mood for 1 second then return to idle.
7. No audio plays.

To restore connectivity:

1. Click **Rotate** again in the dashboard (or use the value from step 6's rotate, if you copied it).
2. Copy the new plaintext fingerprint.
3. Paste into `firmware/bmo_face_anim/include/secrets.h`, re-flash:
   ```bash
   pio run -e esp32c3_supermini -t upload
   ```
4. Repeat step 4. The board should respond normally again.

If the negative test fails (firmware still gets 200 after rotation), check the troubleshooting matrix below — specifically the "401 not returned after rotation" row.

---

## Troubleshooting matrix

| Visible failure                                    | First place to check                                                                                                       | Second place to check                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Build fails with "missing secrets.h"               | You skipped step 2. Run `cp include/secrets.h.in include/secrets.h` and edit.                                              | The pre-build hook path in `platformio.ini` if you've customized it.           |
| Build fails with "secrets.h still contains @…@"    | An unfilled placeholder. `grep '@.*@' include/secrets.h` to find it.                                                        | -                                                                              |
| WiFi never connects                                | SSID + password typos in `secrets.h`. The router must be 2.4 GHz; ESP32-C3 does not support 5 GHz.                          | Antenna seating on the Super Mini board.                                       |
| `[brain] dashboard URL not reachable`              | `BMO_DASHBOARD_URL` typo. Must include `https://` and no trailing slash.                                                   | DNS on the WiFi network — try the curl from `DEPLOY.md` step 8 from a laptop on the same WiFi. |
| Dashboard returns 401 even with correct fingerprint | Fingerprint was rotated since you flashed. Re-flash with the latest value.                                                  | Trailing whitespace or newline in `BMO_FINGERPRINT` — the `#define` value must be exactly the dashboard string with no extras. |
| Dashboard returns 401 only intermittently          | Two boards flashed with different fingerprints sharing one config row. Rotate, then flash both with the new value.          | A reverse proxy stripping the `X-BMO-Fingerprint` header. Vercel does not strip it; check any in-between infra. |
| 401 not returned after rotation (negative test fails) | The 5-second config cache hasn't expired. Wait 10 seconds and retry.                                                    | The firmware's HTTP client is reusing a stale TCP connection — power-cycle BMO. |
| No face animation                                  | Firmware not actually running — check serial monitor for boot logs.                                                         | Display SPI wiring (face animation runs independently of network).             |
| Face animates but no audio                         | I2S wiring on MAX98357A (BCLK=GP0, LRC=GP1, DOUT=GP2 per `main.cpp`).                                                      | Speaker volume jumper on the MAX98357A board (GAIN pin).                       |
| Audio plays but it's noise / clipped               | TTS sample rate mismatch — firmware must consume at 24 kHz mono PCM16. Check the I2S config matches `Content-Type: audio/L16;rate=24000;channels=1`. | -                                                                              |
| Wrong response (BMO answers a different question)  | STT misheard. Check `activity_log.input_text` in the dashboard to see what the transcriber heard. Mic placement / gain.     | Background noise — try in a quiet room first.                                  |
| Replies are very slow (> 5s first byte)            | OpenRouter cold start on the chosen model. Try a different `llm_model` in **Providers**.                                    | WiFi RSSI < -75 dBm; move closer to the router.                                |
| Activity log shows `status=error, error_stage=stt` | OpenRouter STT outage or audio format mismatch. Check `activity_log.error_message` for the upstream error.                  | Audio body > 25 MB → 413 — the firmware should not produce captures that big.  |
| Activity log shows `status=error, error_stage=llm` | OpenRouter LLM outage or out-of-credits. Check the **Home** page credit balance.                                            | LLM model name typo in **Providers** page.                                     |
| Activity log shows `status=error, error_stage=tts` | OpenRouter TTS outage or unsupported voice for the chosen model. Try voice `nova` and model `openai/gpt-audio-mini`.        | Mid-stream abort because the user released the touch button — this is benign.  |
| No row in activity log at all                      | Request never passed the fingerprint guard. Look for a 401 in the serial monitor.                                          | Vercel function cold-start timeout — re-run, second request should be fast.    |

---

## After a passing run

- Tick this test off in the deploy checklist
- Save the serial-monitor log as `smoke-test-<date>.log` if shipping a release
- If anything fell into a troubleshooting row, file an issue with the row name and the serial-monitor output before tagging
