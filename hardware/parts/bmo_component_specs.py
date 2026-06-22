"""Measured/researched electronics envelopes used by the Static BMO CAD.

Dimensions are millimeters. Width and height describe the board footprint;
depth is the installed stack height including the tallest fixed component.
Cable bend space is added by the containing pod, not hidden in these values.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Envelope:
    width: float
    height: float
    depth: float


# FDM cavities need room for extrusion variation, tape, solder, and removal.
MIN_TOTAL_XY_CLEARANCE = 1.2
MIN_Z_CLEARANCE = 1.0
DISPLAY_OPENING_CLEARANCE = 0.8

# Common red 1.8 inch ST7735 module and its active LCD area.
TFT_BOARD = Envelope(58.0, 35.0, 5.0)
TFT_ACTIVE = Envelope(35.0, 28.0, 0.0)

ESP32_C3_SUPER_MINI = Envelope(22.5, 18.0, 4.0)
MINI_BREADBOARD = Envelope(47.0, 36.0, 8.5)

# Installed height includes the breadboard, male headers, ESP32 PCB/components,
# and room for wires to leave through the heart's side ports.
BREADBOARD_ESP32_STACK = Envelope(47.0, 36.0, 26.0)

MAX98357_TERMINAL = Envelope(24.6, 19.4, 8.0)
INMP441 = Envelope(14.0, 12.0, 4.0)
TTP223 = Envelope(24.0, 24.0, 4.0)
BATTERY_103450 = Envelope(34.0, 50.0, 10.0)
TP4056_TYPE_C = Envelope(28.0, 18.0, 5.0)
MT3608 = Envelope(36.0, 17.0, 14.0)
SPEAKER = Envelope(70.0, 30.0, 13.5)

# ---------- Quarter-turn CAM LOCK geometry (shared by shell + rack) ----------
# Printable twist-lock: drop the wings through the keyhole, twist 90 deg, the
# wings hook the rack catch-post's internal ledge and clamp the cover + rack.
CAM_HEAD_R = 6.5
CAM_HEAD_T = 2.6
CAM_SHAFT_R = 2.7
CAM_WING_L = 13.6           # tip-to-tip hook span
CAM_WING_W = 4.2            # across the keyhole slot
CAM_WING_T = 2.4           # wing height (what the ledge grabs)
CAM_CLR = 0.30             # A1 PLA running clearance
CAM_POST_R = 9.5           # rack catch-post outer radius
CAM_LEDGE_DROP = 3.0       # how far below the post top the catch ledge sits
