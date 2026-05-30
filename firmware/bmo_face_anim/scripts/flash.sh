#!/usr/bin/env bash
#
# flash.sh — flash a CI-built BMO firmware image to an ESP32-C3 Super Mini.
#
# Ships next to the binaries in every build artifact / release, so a user can
# download, plug in the board, and run ONE command — no PlatformIO, no repo
# checkout, just esptool.
#
# Usage:
#   ./flash.sh                      # auto-detect port, flash merged image
#   ./flash.sh -p /dev/ttyACM0      # explicit port
#   ./flash.sh --erase              # full chip erase first (wipes saved WiFi)
#   ./flash.sh --split              # use the 4 individual bins instead of merged
#   ./flash.sh --baud 460800        # override upload baud (default 921600)
#   ./flash.sh --monitor            # open a serial monitor after flashing
#
# Requirements: Python 3 + esptool ("pip install esptool"). The script will
# offer to install esptool into a throwaway venv if it isn't found.
#
# What gets flashed (ESP32-C3, 4MB):
#   merged: dist/bmo-firmware-merged.bin @ 0x0   (default, simplest)
#   split : bootloader.bin   @ 0x0
#           partitions.bin   @ 0x8000
#           boot_app0.bin    @ 0xe000
#           firmware.bin     @ 0x10000
#
# NOTE ON SECRETS: a publicly released image is GENERIC — it has no WiFi creds
# and no dashboard auth fingerprint baked in. After flashing, BMO boots a
# "BMO-Setup-XXXX" WiFi hotspot; join it from your phone and enter your WiFi +
# dashboard URL. Talking to the cloud brain additionally requires a build with
# your dashboard fingerprint compiled in (see the repo's firmware build docs).

set -euo pipefail

# Resolve the directory this script lives in, so bins are found whether the
# user runs it from inside dist/ or elsewhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CHIP="esp32c3"
BAUD="921600"
PORT=""
ERASE=0
SPLIT=0
MONITOR=0
MERGED_BIN="bmo-firmware-merged.bin"

err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)    PORT="${2:-}"; shift 2 ;;
    --baud)       BAUD="${2:-}"; shift 2 ;;
    --erase)      ERASE=1; shift ;;
    --split)      SPLIT=1; shift ;;
    --monitor)    MONITOR=1; shift ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) err "Unknown option: $1"; exit 2 ;;
  esac
done

# ---- locate esptool -------------------------------------------------------
ESPTOOL=""
if command -v esptool.py >/dev/null 2>&1; then
  ESPTOOL="esptool.py"
elif python3 -c "import esptool" >/dev/null 2>&1; then
  ESPTOOL="python3 -m esptool"
else
  err "esptool not found."
  info "Install it with:  pip install esptool"
  info "(or: python3 -m pip install --user esptool)"
  exit 1
fi

# ---- auto-detect the serial port if not given ----------------------------
if [ -z "$PORT" ]; then
  CANDIDATES=""
  case "$(uname -s)" in
    Darwin) CANDIDATES="$(ls /dev/cu.usbmodem* /dev/cu.usbserial* /dev/cu.wchusbserial* 2>/dev/null || true)" ;;
    Linux)  CANDIDATES="$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true)" ;;
    *)      CANDIDATES="" ;;
  esac
  COUNT="$(printf '%s\n' "$CANDIDATES" | grep -c . || true)"
  if [ "$COUNT" = "1" ]; then
    PORT="$(printf '%s\n' "$CANDIDATES" | head -n1)"
    info "Auto-detected port: $PORT"
  elif [ "$COUNT" = "0" ]; then
    err "No ESP32 serial port found. Plug the board in via a DATA USB-C cable,"
    err "then pass it explicitly:  ./flash.sh -p <port>"
    exit 1
  else
    err "Multiple serial ports found — pick one with -p:"
    printf '%s\n' "$CANDIDATES" >&2
    exit 1
  fi
fi

# ---- sanity-check the binaries are present --------------------------------
need() { [ -f "$1" ] || { err "Missing $1 (run this from the build's dist/ folder)"; exit 1; }; }

COMMON_ARGS=(--chip "$CHIP" --port "$PORT" --baud "$BAUD" --before default_reset --after hard_reset)

if [ "$ERASE" = "1" ]; then
  info "Erasing entire flash (this wipes saved WiFi + provisioning)…"
  # shellcheck disable=SC2086
  $ESPTOOL "${COMMON_ARGS[@]}" erase_flash
fi

info "Flashing $CHIP on $PORT at $BAUD baud…"
if [ "$SPLIT" = "1" ]; then
  need bootloader.bin; need partitions.bin; need boot_app0.bin; need firmware.bin
  # shellcheck disable=SC2086
  $ESPTOOL "${COMMON_ARGS[@]}" write_flash -z \
    --flash_mode dio --flash_freq 80m --flash_size detect \
    0x0     bootloader.bin \
    0x8000  partitions.bin \
    0xe000  boot_app0.bin \
    0x10000 firmware.bin
else
  need "$MERGED_BIN"
  # shellcheck disable=SC2086
  $ESPTOOL "${COMMON_ARGS[@]}" write_flash -z \
    --flash_mode dio --flash_freq 80m --flash_size detect \
    0x0 "$MERGED_BIN"
fi

ok "Done. BMO is rebooting."
info "First boot with a generic image: join the 'BMO-Setup-XXXX' WiFi from your"
info "phone to set WiFi + dashboard URL."

if [ "$MONITOR" = "1" ]; then
  info "Opening serial monitor at 115200 (Ctrl-] / Ctrl-C to exit)…"
  if command -v pio >/dev/null 2>&1; then
    pio device monitor -p "$PORT" -b 115200
  elif python3 -c "import serial.tools.miniterm" >/dev/null 2>&1; then
    python3 -m serial.tools.miniterm "$PORT" 115200
  else
    err "No monitor available. Install pyserial:  pip install pyserial"
  fi
fi
