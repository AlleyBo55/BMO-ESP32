"""Parametric 3D-printable BMO body and full printable parts kit.

The model is designed around common module dimensions, not a measured
vendor-specific board. Measure your real parts and tune the parameters below
before doing a long final print.

Coordinate convention:
- X = body width
- Y = body height
- Z = body depth, with the face/front at Z=0 and internals behind it
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import zipfile
from xml.sax.saxutils import escape

import trimesh
from build123d import (
    Align,
    Axis,
    Box,
    BuildLine,
    BuildPart,
    BuildSketch,
    Circle,
    Compound,
    Cone,
    Cylinder,
    GeomType,
    Location,
    Locations,
    Mode,
    Plane,
    Rectangle,
    RectangleRounded,
    RegularPolygon,
    Sphere,
    Spline,
    Text,
    add,
    export_gltf,
    export_step,
    export_stl,
    extrude,
    fillet,
    sweep,
)

import bmo_component_specs as component_specs


# ---------- Global dimensions ----------

BODY_W = 118.0
BODY_H = 148.0
FRONT_DEPTH = 54.0
WALL = 2.8
FRONT_SKIN = 3.2
CORNER_R = 12.0
FRONT_EDGE_FILLET = 6.0   # soft pillow rounding on the front face perimeter
BACK_EDGE_FILLET = 3.0    # gentler rounding on the back opening edge

LID_T = 3.0
LID_LIP_H = 7.0
LID_CLEARANCE = 0.45

# Common red 1.8" ST7735 module. The separate mint bezel keeps BMO's large
# screen-frame silhouette while exposing only the actual active LCD area.
SCREEN_VISIBLE_W = component_specs.TFT_ACTIVE.width + component_specs.DISPLAY_OPENING_CLEARANCE
SCREEN_VISIBLE_H = component_specs.TFT_ACTIVE.height + component_specs.DISPLAY_OPENING_CLEARANCE
SCREEN_MODULE_W = component_specs.TFT_BOARD.width
SCREEN_MODULE_H = component_specs.TFT_BOARD.height
SCREEN_MODULE_T = component_specs.TFT_BOARD.depth
SCREEN_BEZEL_W = 78.0
SCREEN_BEZEL_H = 57.0
SCREEN_BEZEL_T = 1.0
SCREEN_BEZEL_PEG_X = 32.0
SCREEN_BEZEL_PEG_Y = 21.5
SCREEN_Y = 39.0
DISPLAY_STANDOFF_H = 6.8

# Researched common module envelopes.
ESP32_W = component_specs.ESP32_C3_SUPER_MINI.width
ESP32_H = component_specs.ESP32_C3_SUPER_MINI.height
ESP32_T = component_specs.ESP32_C3_SUPER_MINI.depth
AMP_W = component_specs.MAX98357_TERMINAL.width
AMP_H = component_specs.MAX98357_TERMINAL.height
AMP_T = component_specs.MAX98357_TERMINAL.depth
MIC_W = component_specs.INMP441.width
MIC_H = component_specs.INMP441.height
MIC_T = component_specs.INMP441.depth
TOUCH_W = component_specs.TTP223.width
TOUCH_H = component_specs.TTP223.height
TOUCH_T = component_specs.TTP223.depth
SPEAKER_PLATE_W = component_specs.SPEAKER.width
SPEAKER_PLATE_H = component_specs.SPEAKER.height
SPEAKER_T = component_specs.SPEAKER.depth
BREADBOARD_W = component_specs.MINI_BREADBOARD.width
BREADBOARD_H = component_specs.MINI_BREADBOARD.height
BREADBOARD_T = component_specs.MINI_BREADBOARD.depth
SPEAKER_FIT_CLEARANCE = 1.0
TRAY_LOCATOR_PEG_R = 1.45
TRAY_LOCATOR_PEG_H = 3.0
TRAY_KEY_H = 2.6
ORGAN_LIP_W = BODY_W - 2 * WALL - LID_CLEARANCE
ORGAN_LIP_H = BODY_H - 2 * WALL - LID_CLEARANCE
# ---- Joint fit (FDM friction fit; smaller clearance = firmer) ----
# Radial gap between a pin and its hole. 0.12 mm is a firm hand-press fit on a
# well-calibrated A1. Drop toward 0.08 for tighter, raise toward 0.20 if your
# printer runs fat and parts won't seat. One knob tunes every limb joint.
PIN_FIT_CLEARANCE = 0.12
TAB_FIT_CLEARANCE = 0.16  # per-side gap for keyed (anti-rotation) tabs
PIN_LEAD_IN = 0.6         # chamfer depth at hole mouth so pins start easily

# ---- Gunpla-style snap-fit, upgraded to a no-glue clamping lock ----
# Each limb plugs in like a model kit, but firmer than cheap Gunpla: a split
# arrowhead pin flexes through the socket bore, then the barb springs out
# behind the inner wall face. A shoulder collar on the outside face sits a
# hair CLOSER than the wall is thick, so the wall is CLAMPED between the barb
# back-face and the collar -> preloaded, zero axial play, holds with no glue.
# A wide relief slot lets the prongs flex on insertion but grip hard after.
SNAP_PIN_R = 2.6          # shank radius of a snap pin (beefy = stiff = grippy)
SNAP_BARB = 0.95          # barb overhang past the shank (the bite; bigger=stickier)
SNAP_NOSE_LEN = 2.4       # tapered lead-in so it starts by hand
SNAP_BARB_BACK = 0.0      # back-face undercut: 0 = flat 90 deg ledge = max hold
SNAP_CLEARANCE = 0.10     # tight radial gap in the bore (firm, not rattly)
SNAP_SLOT_W = 1.1         # relief slot width so the barb arm can flex
SNAP_PRELOAD = 0.12       # collar sits this much closer than wall -> clamp force
SNAP_COLLAR_R = 4.2       # outside shoulder that seats flat on the wall face

LEG_TAB_W = 6.0
LEG_TAB_Y = 9.0
LEG_TAB_Z = 7.2
LEG_PIN_R = 1.6           # was 1.5; a touch beefier so the firm fit can't shear
LEG_PIN_SPACING = 11.0    # widened so the two snap barbs don't collide
LEG_PIN_LEN = 12.5        # longer engagement = less wobble
# Legs use a smaller snap pin (tighter spacing than the arms).
LEG_SNAP_R = 1.8
LEG_SNAP_BARB = 0.7
LEG_SNAP_COLLAR_R = 3.0

ARM_PIN_R = 3.7           # was 3.35; fills the socket for a firm fit
ARM_PIN_LEN = 12.0
ARM_KEY_W = 4.1
ARM_KEY_Y = 15.0
ARM_PIVOT_R = 3.1
ARM_PIVOT_CLEARANCE = 0.18
ARM_PIVOT_COLLAR_R = 7.8

CONTROL_PEG_R = 1.1
CONTROL_PEG_H = 3.2
KEYCAP_STEM_R = 1.45
KEYCAP_GUIDE_CLEARANCE = 0.35
KEYCAP_STEM_H = 7.2
KEYCAP_TRAVEL = 1.4
TACTILE_SWITCH_W = 6.2
TACTILE_SWITCH_H = 6.2

# ---- Canonical BMO front control layout (matches the show) ----
# Face coordinates: +x right, +y up, screen centered at SCREEN_Y.
# From the references: yellow D-pad lower-left, cyan triangle center, big red
# circle below the triangle, green circle right of the triangle, and two blue
# dashes (pills) lower-left.
CONTROL_POS = {
    "dpad":         (-30.0, -30.0),
    "triangle":     (  5.0, -27.0),
    "red_button":   (  7.0, -50.0),
    "green_button": ( 31.0, -33.0),
    "pill_left":    (-39.0, -55.0),
    "pill_right":   (-25.0, -55.0),
}
# Local plunger offsets per control. These are not just decoration: each cap
# passes through the face and can press a small tactile switch behind it.
CONTROL_STEMS = {
    "dpad":         [(0.0, 0.0)],
    "triangle":     [(0.0, 0.0)],
    "red_button":   [(0.0, 0.0)],
    "green_button": [(0.0, 0.0)],
    "pill_left":    [(0.0, 0.0)],
    "pill_right":   [(0.0, 0.0)],
}

# ---- Functional ports ----
# USB-C charge port on the lower-left front (matches the popular BMO builds).
# Dimensions pinned to a REAL part per the step.parts skill (no guessed sizes):
#   part id: usb_c_receptacle_gct_usb4085  (GCT USB4085, 16P SMD USB-C receptacle)
#   page: https://www.step.parts/parts/usb_c_receptacle_gct_usb4085
#   measured STEP bbox: 8.94 (W) x 9.17 (depth) x 5.56 (H) mm
# The panel opening clears the plug; the inner pocket clears the receptacle body.
USBC_PART_ID = "usb_c_receptacle_gct_usb4085"
USBC_BODY_W = 8.94      # measured receptacle width
USBC_BODY_DEPTH = 9.17  # measured receptacle depth (into the body)
USBC_BODY_H = 5.56      # measured receptacle height
USBC_PORT_W = USBC_BODY_W + 1.0   # plug opening width + clearance
USBC_PORT_H = 3.6                 # USB-C plug opening height (~3.2 + clearance)
USBC_POS = (-30.0, -64.0)
# Cartridge slot: the dark horizontal slot directly under the screen.
CART_SLOT_W = 64.0
CART_SLOT_H = 6.5
CART_SLOT_Y = 9.0
CART_SLOT_DEPTH = 5.0
BODY_LATCH_Z = FRONT_DEPTH - 4.0
BODY_LATCH_SIDE_Y = 42.0

ORGAN_PLACEMENTS = {
    # These coordinates are packed against the rear tray lip, not the larger
    # outside back plate. Keep all organ wrappers inside +/- ORGAN_LIP_* / 2.
    "esp32_heart": (-20.0, 0.0),
    "battery_cell": (35.5, 0.0),
    "charge_kidney": (-37.0, 52.5),
    "touch_spark": (-1.0, 52.5),
    "boost_gland": (35.0, 52.5),
    "mic_ear": (-34.0, -51.5),
    "i2s_lung": (35.0, -50.0),
}

ORGAN_MOUNT_POINTS = {
    "esp32_heart": [(-24.0, -12.0), (24.0, -12.0), (-16.0, 20.0), (16.0, 20.0)],
    "mic_ear": [(-8.0, 0.0), (8.0, 0.0)],
    "touch_spark": [(-9.0, 0.0), (9.0, 0.0)],
    "charge_kidney": [(-10.0, 0.0), (10.0, 0.0)],
    "boost_gland": [(-11.0, 0.0), (11.0, 0.0)],
    "i2s_lung": [(-10.0, -2.0), (10.0, -2.0)],
    "battery_cell": [(-17.0, 0.0), (17.0, 0.0)],
}

ORGAN_KEY_SLOTS = {
    "esp32_heart": [(0.0, -20.0, 28.0, 4.2), (0.0, 24.0, 18.0, 4.2)],
    "mic_ear": [(0.0, -7.0, 4.2, 13.0)],
    "touch_spark": [(-7.0, 0.0, 4.2, 14.0), (5.0, 7.0, 12.0, 4.2)],
    "charge_kidney": [(0.0, -8.0, 19.0, 4.2), (-11.0, 5.0, 4.2, 10.0)],
    "boost_gland": [(-8.0, -7.0, 17.0, 4.2), (10.0, 5.0, 4.2, 10.0)],
    "i2s_lung": [(0.0, 8.0, 18.0, 4.2)],
    "battery_cell": [(0.0, -12.0, 24.0, 4.2), (12.0, 8.0, 4.2, 12.0)],
}

EXPORT_DIR = Path(__file__).resolve().parents[1] / "exports"


@dataclass(frozen=True)
class ShapeItem:
    name: str
    shape: object


def rounded_prism(width: float, height: float, depth: float, radius: float):
    """Create a rounded rectangle extruded along +Z."""
    with BuildPart() as part:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=depth)
    return part.part


def rounded_box(width: float, height: float, depth: float, radius: float):
    """Rounded rectangular solid centered on its origin."""
    with BuildPart() as part:
        Box(width, height, depth, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        fillet(part.edges(), radius=radius)
    return part.part


def tube_along(points, radius, end_ball=True):
    """Sweep a round cross-section through a smooth 3D path."""
    with BuildLine() as path_builder:
        Spline(*points)
    path = path_builder.edge()
    with BuildSketch(Plane(origin=path.position_at(0), z_dir=path.tangent_at(0))) as profile:
        Circle(radius)
    sweep(sections=profile.sketch, path=path)
    if end_ball:
        for point in (points[0], points[-1]):
            with Locations(point):
                Sphere(radius)


def make_snap_pin(wall_t: float, pin_r: float = SNAP_PIN_R, barb: float = SNAP_BARB,
                  nose_len: float = SNAP_NOSE_LEN, slot_w: float = SNAP_SLOT_W,
                  collar_r: float = SNAP_COLLAR_R, preload: float = SNAP_PRELOAD):
    """A self-locking, no-glue snap pin built along +Z.

    Geometry (from the part face at z=0 going into the socket):
      z<0            : shoulder collar that seats flat on the OUTSIDE wall face
      0 .. shank     : straight shank that fills the socket bore
      shank .. barb  : arrowhead barb wider than the bore; springs out behind
                       the INNER wall face and locks on a flat ledge
    The collar-to-barb-back distance is (wall_t - preload), so the wall is
    clamped between them: preloaded, zero axial play, holds without glue.
    A relief slot down the middle lets the two prongs flex during insertion.
    Dimensions default to the global SNAP_* knobs; legs pass smaller values.
    """
    shank_len = wall_t - preload               # shank spans the wall, minus preload
    barb_r = pin_r + barb
    with BuildPart() as pin:
        # Outside shoulder collar (stays on the part side of the wall).
        with Locations((0, 0, -1.4)):
            Cylinder(collar_r, 1.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Straight shank through the wall bore.
        Cylinder(pin_r, shank_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Barb: a cone flaring OUT to barb_r then back to a point gives a flat
        # 90 deg locking ledge facing the collar (max hold) plus a tapered nose.
        with Locations((0, 0, shank_len)):
            Cone(barb_r, pin_r, nose_len,
                 align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Relief slot so the prongs can flex inward on the way through.
        with Locations((0, 0, shank_len + nose_len / 2)):
            Box(slot_w, 2 * barb_r + 2, 2 * (nose_len + shank_len),
                align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return pin.part


def cut_snap_socket(wall_t: float, pin_r: float = SNAP_PIN_R,
                    clearance: float = SNAP_CLEARANCE):
    """Subtract a clean bore for make_snap_pin through a wall of thickness wall_t.

    The bore is shank radius + clearance. A small lead-in chamfer at the mouth
    helps the barb start; the barb itself is wider than the bore and locks on
    the inner face once it springs back out. Call inside a BuildPart with
    an active Locations/rotation context at the wall.
    """
    bore_r = pin_r + clearance
    Cylinder(bore_r, wall_t + 2.0, align=(Align.CENTER, Align.CENTER, Align.CENTER),
             mode=Mode.SUBTRACT)
    # Conical lead-in at the entry mouth so the nose self-centers.
    with Locations((0, 0, wall_t / 2)):
        Cone(bore_r + 0.8, bore_r, 0.8,
             align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_display_retention_tabs():
    tab_t = 2.0
    tab_z = FRONT_SKIN + 0.2
    pocket_w = SCREEN_MODULE_W + 2.0
    pocket_h = SCREEN_MODULE_H + 2.0
    for y in (SCREEN_Y - pocket_h / 2 - 1.4, SCREEN_Y + pocket_h / 2 + 1.4):
        with Locations((0, y, tab_z)):
            Box(pocket_w, 2.8, tab_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (-pocket_w / 2 - 1.4, pocket_w / 2 + 1.4):
        with Locations((x, SCREEN_Y, tab_z)):
            Box(2.8, pocket_h, tab_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    # Springy printed lips: slide the TFT board under one side, then press
    # the opposite edge until it clicks under these catches.
    for y in (SCREEN_Y - SCREEN_MODULE_H / 2 + 4.0, SCREEN_Y + SCREEN_MODULE_H / 2 - 4.0):
        with Locations((0, y, FRONT_SKIN + DISPLAY_STANDOFF_H - 0.9)):
            Box(SCREEN_MODULE_W - 12.0, 2.2, 1.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for x in (-SCREEN_MODULE_W / 2 + 4.0, SCREEN_MODULE_W / 2 - 4.0):
        with Locations((x, SCREEN_Y, FRONT_SKIN + DISPLAY_STANDOFF_H - 0.9)):
            Box(2.2, SCREEN_MODULE_H - 12.0, 1.5, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_tft_bezel_socket_holes():
    """Four holes receive the separate mint screen bezel's printed pegs."""
    for x in (-SCREEN_BEZEL_PEG_X, SCREEN_BEZEL_PEG_X):
        for y in (SCREEN_Y - SCREEN_BEZEL_PEG_Y, SCREEN_Y + SCREEN_BEZEL_PEG_Y):
            with Locations((x, y, -0.4)):
                Cylinder(
                    CONTROL_PEG_R + 0.3,
                    FRONT_SKIN + 1.2,
                    align=(Align.CENTER, Align.CENTER, Align.MIN),
                    mode=Mode.SUBTRACT,
                )


def honeycomb_points(center_a: float, center_b: float, spacing: float = 5.8):
    rows = (3, 4, 5, 4, 3)
    points = []
    for row_index, count in enumerate(rows):
        a = center_a + (row_index - 2) * spacing * 0.88
        for col_index in range(count):
            b = center_b + (col_index - (count - 1) / 2) * spacing
            points.append((a, b))
    return points


def add_side_speaker_honeycomb():
    """Functional side honeycomb outlets on both sides of the body.

    The right side still has the real speaker mount. The left side gets matching
    cosmetic/vent holes so the shell reads like BMO from both sides.
    """
    for x, rot in ((BODY_W / 2 - 0.2, (0, 90, 0)), (-BODY_W / 2 + 0.2, (0, 90, 0))):
        for y, z in honeycomb_points(32.0, FRONT_DEPTH * 0.50, spacing=5.9):
            with Locations(Location((x, y, z), rot)):
                Cylinder(2.25, WALL + 3.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)


def add_direct_speaker_mount():
    """Internal side-wall cradle for the rectangular 8 ohm 3W speaker plate."""
    inner_wall_x = BODY_W / 2 - WALL
    cradle_depth = SPEAKER_T + SPEAKER_FIT_CLEARANCE + 2.2
    mount_x = inner_wall_x - cradle_depth / 2
    center_y = 32.0
    center_z = FRONT_DEPTH * 0.50 - 2.0
    pocket_w = SPEAKER_PLATE_W + SPEAKER_FIT_CLEARANCE
    pocket_h = SPEAKER_PLATE_H + SPEAKER_FIT_CLEARANCE

    # Two full-depth shelves carry the long edges of the speaker frame.
    for z in (center_z - pocket_h / 2 - 1.1, center_z + pocket_h / 2 + 1.1):
        with Locations((mount_x, center_y, z)):
            Box(cradle_depth, pocket_w + 4.0, 2.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))

    # End stops prevent the 70 mm plate from sliding along the body side.
    for y in (center_y - pocket_w / 2 - 1.1, center_y + pocket_w / 2 + 1.1):
        with Locations((mount_x, y, center_z)):
            Box(cradle_depth, 2.2, pocket_h + 4.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))

    # Four inward lips flex over the speaker's inner face. They leave the cone
    # and screw holes unobstructed while holding the plate against the wall.
    clip_x = inner_wall_x - SPEAKER_T - SPEAKER_FIT_CLEARANCE - 1.0
    for y in (center_y - pocket_w / 2 + 7.0, center_y + pocket_w / 2 - 7.0):
        for z in (center_z - pocket_h / 2 + 4.5, center_z + pocket_h / 2 - 4.5):
            with Locations((clip_x, y, z)):
                Box(2.0, 7.0, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((clip_x - 1.25, y, z)):
                Box(1.1, 7.0, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

    # Small wire bridge leads the speaker/amp cable back toward the heart hub.
    with Locations((BODY_W / 2 - WALL - 2.0, 5.0, center_z - 17.5)):
        Box(3.0, 58.0, 2.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))


def add_arm_socket_holes():
    """Round side shoulder pivots for rotatable arms.

    Each arm uses one centered snap axle, not an anti-rotation key. The wider
    barb holds the arm onto the side wall while the round bore lets the arm
    rotate by hand with friction.
    """
    snap_bore_r = ARM_PIVOT_R + ARM_PIVOT_CLEARANCE
    for x, rot in ((-BODY_W / 2 + 0.2, (0, 90, 0)), (BODY_W / 2 - 0.2, (0, 90, 0))):
        with Locations(Location((x, -23.0, FRONT_DEPTH * 0.48), rot)):
            Cylinder(snap_bore_r, WALL + 3.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations(Location((x, -23.0, FRONT_DEPTH * 0.48), rot)):
            Cone(snap_bore_r + 1.0, snap_bore_r, 0.9,
                 align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_leg_socket_holes():
    """Bottom keyed slots for the leg/foot tabs plus snap-pin bores.

    The keyed tab handles anti-rotation; the two snap pins lock the leg with no
    glue. Bores are sized to the leg snap shank so the barbs catch the inner
    face. The body floor here is WALL thick.
    """
    leg_snap_bore_r = LEG_SNAP_R + SNAP_CLEARANCE
    for x in (-26.0, 26.0):
        with Locations((x, -BODY_H / 2 + 1.2, FRONT_DEPTH * 0.47)):
            Box(
                LEG_TAB_W + 2 * TAB_FIT_CLEARANCE,
                WALL + 8.0,
                LEG_TAB_Z + 2 * TAB_FIT_CLEARANCE,
                align=(Align.CENTER, Align.CENTER, Align.CENTER),
                mode=Mode.SUBTRACT,
            )
        for dx in (-LEG_PIN_SPACING / 2, LEG_PIN_SPACING / 2):
            with Locations(Location((x + dx, -BODY_H / 2 + 1.2, FRONT_DEPTH * 0.47), (90, 0, 0))):
                Cylinder(
                    leg_snap_bore_r,
                    WALL + 8.5,
                    align=(Align.CENTER, Align.CENTER, Align.CENTER),
                    mode=Mode.SUBTRACT,
                )
            # Lead-in chamfer at the outside (bottom) mouth.
            with Locations(Location((x + dx, -BODY_H / 2 + 1.2, FRONT_DEPTH * 0.47), (-90, 0, 0))):
                Cone(leg_snap_bore_r + 0.8, leg_snap_bore_r, 0.8,
                     align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_body_latch_windows():
    """Rectangular latch windows that visibly receive rear-tray snap hooks."""
    for x in (-BODY_W / 2 + 0.1, BODY_W / 2 - 0.1):
        for y in (-BODY_LATCH_SIDE_Y, BODY_LATCH_SIDE_Y):
            with Locations((x, y, BODY_LATCH_Z)):
                Box(WALL + 2.2, 14.0, 6.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    for y in (-BODY_H / 2 + 0.1, BODY_H / 2 - 0.1):
        for x in (-27.0, 27.0):
            with Locations((x, y, BODY_LATCH_Z)):
                Box(14.0, WALL + 2.2, 6.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)


def add_front_control_snap_holes():
    """Guide holes for keycap-style control plungers."""
    guide_r = KEYCAP_STEM_R + KEYCAP_GUIDE_CLEARANCE
    for name, (ox, oy) in CONTROL_POS.items():
        for px, py in CONTROL_STEMS[name]:
            with Locations((ox + px, oy + py, -0.6)):
                Cylinder(guide_r, FRONT_SKIN + KEYCAP_TRAVEL + 1.4,
                         align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_tactile_switch_mounts():
    """Small rear guide frames for 6 x 6 mm tactile switches behind each cap."""
    rail_z = FRONT_SKIN + 0.35
    rail_h = 3.2
    for name, (ox, oy) in CONTROL_POS.items():
        for px, py in CONTROL_STEMS[name]:
            cx = ox + px
            cy = oy + py
            for dx in (-(TACTILE_SWITCH_W / 2 + 1.0), TACTILE_SWITCH_W / 2 + 1.0):
                with Locations((cx + dx, cy, rail_z)):
                    Box(1.1, TACTILE_SWITCH_H + 2.2, rail_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
            for dy in (-(TACTILE_SWITCH_H / 2 + 1.0), TACTILE_SWITCH_H / 2 + 1.0):
                with Locations((cx, cy + dy, rail_z)):
                    Box(TACTILE_SWITCH_W + 2.2, 1.1, rail_h, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_usbc_port():
    """Functional USB-C charge cutout on the lower-left front.

    Opening sized for the USB-C plug; inner pocket clears the real receptacle
    body (USBC_PART_ID, measured from its STEP). The charge board sits behind.
    """
    x, y = USBC_POS
    with Locations((x, y, -0.5)):
        Box(USBC_PORT_W, USBC_PORT_H, FRONT_SKIN + 1.0,
            align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    # Inner relief sized to the real receptacle body so it seats flush.
    with Locations((x, y, FRONT_SKIN - 0.4)):
        Box(USBC_BODY_W + 2.0, USBC_BODY_H + 2.0, USBC_BODY_DEPTH + 1.0,
            align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_cartridge_slot():
    """The dark horizontal game-cartridge slot directly under the screen."""
    with Locations((0, CART_SLOT_Y, -0.5)):
        Box(CART_SLOT_W, CART_SLOT_H, CART_SLOT_DEPTH,
            align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_side_text_snap_holes():
    for x in (-BODY_W / 2 + 0.2, BODY_W / 2 - 0.2):
        for y in (-24.0, 16.0):
            with Locations(Location((x, y, FRONT_DEPTH * 0.64), (0, 90, 0))):
                Cylinder(CONTROL_PEG_R + 0.35, WALL + 2.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)


def make_front_shell(preview: bool = False):
    """Front half of the body: visual shell, screen window, clips, grille."""
    with BuildPart() as shell:
        with BuildSketch():
            RectangleRounded(BODY_W, BODY_H, CORNER_R)
        extrude(amount=FRONT_DEPTH)

        # Soft pillow rounding: fillet the front-face perimeter (and a gentler
        # round on the rear opening edge) so every visible edge reads as the
        # injection-molded BMO look, not a sharp printed box. Done before any
        # cuts so the edge selection is clean.
        front_face = shell.faces().sort_by(Axis.Z)[0]
        fillet(front_face.edges(), radius=FRONT_EDGE_FILLET)
        back_face = shell.faces().sort_by(Axis.Z)[-1]
        fillet(back_face.edges(), radius=BACK_EDGE_FILLET)

        # Hollow interior open from the back.
        with Locations((0, 0, FRONT_SKIN)):
            Box(
                BODY_W - 2 * WALL,
                BODY_H - 2 * WALL,
                FRONT_DEPTH + 2,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )

        # Large removable bezel recess plus the real active-LCD through-window.
        with Locations((0, SCREEN_Y, -0.35)):
            Box(
                SCREEN_BEZEL_W + 0.6,
                SCREEN_BEZEL_H + 0.6,
                1.25,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )
        with Locations((0, SCREEN_Y, -0.5)):
            Box(
                SCREEN_VISIBLE_W,
                SCREEN_VISIBLE_H,
                FRONT_SKIN + 1.0,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )

        add_display_retention_tabs()
        add_tft_bezel_socket_holes()
        add_side_speaker_honeycomb()
        add_cartridge_slot()

        if not preview:
            add_direct_speaker_mount()
            add_arm_socket_holes()
            add_leg_socket_holes()
            add_body_latch_windows()
            add_front_control_snap_holes()
            add_tactile_switch_mounts()
            add_usbc_port()
            add_side_text_snap_holes()

            # Small interior pads for TTP223 and INMP441 placement.
            with Locations((0, BODY_H / 2 - 18.0, FRONT_SKIN)):
                Box(TOUCH_W + 4.0, TOUCH_H + 4.0, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((0, SCREEN_Y - 32.0, FRONT_SKIN)):
                Box(MIC_W + 3.0, MIC_H + 3.0, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))

    return shell.part


def add_rear_snap_hooks(lip_outer_w: float, lip_outer_h: float):
    """Proud latch hooks that click into the front-shell latch windows."""
    hook_z = LID_T + LID_LIP_H - 3.4
    for x in (-lip_outer_w / 2 - 1.2, lip_outer_w / 2 + 1.2):
        for y in (-BODY_LATCH_SIDE_Y, BODY_LATCH_SIDE_Y):
            with Locations((x, y, hook_z)):
                Box(2.8, 11.5, 5.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x, y, hook_z + 4.4)):
                Box(4.4, 10.0, 1.3, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for y in (-lip_outer_h / 2 - 1.2, lip_outer_h / 2 + 1.2):
        for x in (-27.0, 27.0):
            with Locations((x, y, hook_z)):
                Box(11.5, 2.8, 5.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x, y, hook_z + 4.4)):
                Box(10.0, 4.4, 1.3, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_wire_press_clip(x: float, y: float, orientation: str):
    """Small C-like printed clip: press jumper bundle under the lips."""
    z = LID_T + 1.4
    if orientation == "vertical":
        for px in (x - 4.8, x + 4.8):
            with Locations((px, y, z)):
                Box(1.6, 12.5, 4.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for px in (x - 2.8, x + 2.8):
            with Locations((px, y, z + 3.6)):
                Box(3.8, 12.5, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    else:
        for py in (y - 4.8, y + 4.8):
            with Locations((x, py, z)):
                Box(12.5, 1.6, 4.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for py in (y - 2.8, y + 2.8):
            with Locations((x, py, z + 3.6)):
                Box(12.5, 3.8, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_organ_locator_keys():
    for key, (origin_x, origin_y) in ORGAN_PLACEMENTS.items():
        for local_x, local_y, width, height in ORGAN_KEY_SLOTS[key]:
            with Locations((origin_x + local_x, origin_y + local_y, LID_T + 1.2)):
                Box(width, height, TRAY_KEY_H, align=(Align.CENTER, Align.CENTER, Align.MIN))


def module_saddle(x: float, y: float, w: float, h: float, label_pad: bool = True):
    base_z = LID_T
    with Locations((x, y, base_z)):
        Box(w + 6.0, h + 5.0, 1.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
    rail_t = 2.0
    rail_h = 4.0
    for rx in (x - (w / 2 + 2.2), x + (w / 2 + 2.2)):
        with Locations((rx, y, base_z + 1.4)):
            Box(rail_t, h + 4.0, rail_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    for ry in (y - (h / 2 + 1.8), y + (h / 2 + 1.8)):
        with Locations((x, ry, base_z + 1.4)):
            Box(w * 0.45, 1.6, rail_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    if label_pad:
        with Locations((x, y, base_z + 1.45)):
            Box(w - 4.0, 1.0, 0.5, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_organ_locator_pegs():
    """Peg grid that keys each organ pod into one tray position."""
    peg_z = LID_T + 1.2
    for key, (origin_x, origin_y) in ORGAN_PLACEMENTS.items():
        for local_x, local_y in ORGAN_MOUNT_POINTS[key]:
            with Locations((origin_x + local_x, origin_y + local_y, peg_z)):
                Cylinder(
                    TRAY_LOCATOR_PEG_R,
                    TRAY_LOCATOR_PEG_H,
                    align=(Align.CENTER, Align.CENTER, Align.MIN),
                )


def make_rear_lid():
    """Back lid and electronics tray: module saddles, cable clamp, speaker ring."""
    lip_outer_w = BODY_W - 2 * WALL - LID_CLEARANCE
    lip_outer_h = BODY_H - 2 * WALL - LID_CLEARANCE
    lip_wall = 1.7

    with BuildPart() as lid:
        with BuildSketch():
            RectangleRounded(BODY_W, BODY_H, CORNER_R)
        extrude(amount=LID_T)

        # Soft pillow rounding on the rear outside face, matching the front
        # shell so the closed body reads uniformly rounded like the reference.
        # The lid is only LID_T thick, so cap the radius below that.
        rear_outside = lid.faces().sort_by(Axis.Z)[0]
        fillet(rear_outside.edges(), radius=min(BACK_EDGE_FILLET, LID_T - 1.2))

        with BuildSketch(lid.faces().sort_by(Axis.Z)[-1]):
            RectangleRounded(lip_outer_w, lip_outer_h, max(CORNER_R - WALL, 2.0))
        extrude(amount=LID_LIP_H)
        with Locations((0, 0, LID_T - 0.1)):
            Box(
                lip_outer_w - 2 * lip_wall,
                lip_outer_h - 2 * lip_wall,
                LID_LIP_H + 0.4,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )

        add_rear_snap_hooks(lip_outer_w, lip_outer_h)

        # Rear cable exit and printed press clips for strain relief.
        with Locations((0, -BODY_H / 2 + 8.0, -0.5)):
            Box(28.0, 9.0, LID_T + 1.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        for x in (-8.0, 8.0):
            add_wire_press_clip(x, -BODY_H / 2 + 21.0, "horizontal")

        # Organ tray: only low pads and keyed locator features sit under the
        # pods. Taller wire clips stay off the organ footprints, so each pod can
        # actually drop onto its matching pegs/keys after printing.
        low_z = LID_T + 0.15
        pad_shapes = {
            "esp32_heart": (74.0, 62.0),
            "battery_cell": (42.0, 59.0),
            "charge_kidney": (38.5, 29.5),
            "touch_spark": (33.5, 37.0),
            "boost_gland": (42.5, 29.5),
            "mic_ear": (34.5, 32.0),
            "i2s_lung": (40.0, 33.5),
        }
        for key, (origin_x, origin_y) in ORGAN_PLACEMENTS.items():
            pad_w, pad_h = pad_shapes[key]
            with Locations((origin_x, origin_y, low_z)):
                Box(pad_w, pad_h, 0.55, align=(Align.CENTER, Align.CENTER, Align.MIN))

        # Flat wire gutters point from the heart to each pod but stay below the
        # pod socket depth. Dupont bundles still get a guided route without
        # making the organ cases ride high.
        gutter_z = LID_T + 0.2
        for y in (-35.0, 34.0):
            with Locations((-2.0, y, gutter_z)):
                Box(88.0, 1.2, 0.65, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for x in (-47.0, 16.0, 56.0):
            with Locations((x, 0.0, gutter_z)):
                Box(1.2, 104.0, 0.65, align=(Align.CENTER, Align.CENTER, Align.MIN))

        add_organ_locator_pegs()
        add_organ_locator_keys()

    return lid.part


def make_controls():
    """Combined BMO front controls, placed from the canonical layout."""
    return Compound(
        children=[
            make_dpad().located(Location((*CONTROL_POS["dpad"], 0.0))),
            make_triangle_button().located(Location((*CONTROL_POS["triangle"], 0.0))),
            make_round_button(8.0).located(Location((*CONTROL_POS["red_button"], 0.0))),
            make_round_button(5.3).located(Location((*CONTROL_POS["green_button"], 0.0))),
            make_pill_button().located(Location((*CONTROL_POS["pill_left"], 0.0))),
            make_pill_button().located(Location((*CONTROL_POS["pill_right"], 0.0))),
        ]
    )


def make_screen_panel():
    """Dark display insert for visual previews; replace with the real TFT."""
    return rounded_prism(SCREEN_VISIBLE_W + 7.0, SCREEN_VISIBLE_H + 7.0, 1.5, 4.5)


def make_tft_bezel():
    """Separate mint bezel that keys into the front and masks the red TFT PCB."""
    with BuildPart() as bezel:
        with BuildSketch():
            RectangleRounded(SCREEN_BEZEL_W, SCREEN_BEZEL_H, 5.0)
        extrude(amount=SCREEN_BEZEL_T)
        with Locations((0, 0, -0.2)):
            Box(
                SCREEN_VISIBLE_W,
                SCREEN_VISIBLE_H,
                SCREEN_BEZEL_T + 0.4,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )
        for x in (-SCREEN_BEZEL_PEG_X, SCREEN_BEZEL_PEG_X):
            for y in (-SCREEN_BEZEL_PEG_Y, SCREEN_BEZEL_PEG_Y):
                with Locations((x, y, SCREEN_BEZEL_T - 0.1)):
                    Cylinder(
                        CONTROL_PEG_R,
                        CONTROL_PEG_H,
                        align=(Align.CENTER, Align.CENTER, Align.MIN),
                    )
    return bezel.part


def make_screen_face():
    """Simple BMO face overlay on the display insert."""
    with BuildPart() as face:
        for x in (-13.0, 13.0):
            with Locations((x, 5.0, 0.0)):
                Cylinder(2.8, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0.0, -8.0, 0.0)):
            with BuildSketch():
                RectangleRounded(24.0, 3.6, 1.5)
            extrude(amount=0.8)
    return face.part


def add_control_plug_pegs(points, z: float):
    for x, y in points:
        with Locations((x, y, z)):
            Cylinder(CONTROL_PEG_R, CONTROL_PEG_H, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_control_plunger(points, z: float):
    for x, y in points:
        with Locations((x, y, z)):
            Cylinder(KEYCAP_STEM_R, KEYCAP_STEM_H, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Small round boss under the cap gives a keyboard-cap feel and stops
        # wobble at the face without filling the whole guide hole.
        with Locations((x, y, z - 0.25)):
            Cylinder(KEYCAP_STEM_R + 0.55, 0.5, align=(Align.CENTER, Align.CENTER, Align.MIN))


def make_dpad():
    with BuildPart() as dpad:
        Box(28.0, 8.0, 3.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        Box(8.0, 28.0, 3.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        add_control_plunger(CONTROL_STEMS["dpad"], 2.85)
    return dpad.part


def make_long_slot():
    with BuildPart() as slot:
        with BuildSketch():
            RectangleRounded(38.0, 6.2, 3.0)
        extrude(amount=2.0)
        add_control_plug_pegs([(-12.0, 0.0), (12.0, 0.0)], 1.8)
    return slot.part


def make_small_button():
    with BuildPart() as button:
        Cylinder(3.2, 3.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        add_control_plunger([(0.0, 0.0)], 2.65)
    return button.part


def make_pill_button():
    with BuildPart() as button:
        with BuildSketch():
            RectangleRounded(12.5, 4.0, 1.8)
        extrude(amount=3.0)
        add_control_plunger([(0.0, 0.0)], 2.65)
    return button.part


def make_round_button(radius: float):
    with BuildPart() as button:
        Cylinder(radius, 3.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        add_control_plunger([(0.0, 0.0)], 2.85)
    return button.part


def make_triangle_button():
    with BuildPart() as button:
        with BuildSketch():
            RegularPolygon(6.2, 3, rotation=30)
        extrude(amount=3.1)
        add_control_plunger([(0.0, 0.0)], 2.75)
    return button.part


def _make_side_bmo_text_raw():
    with BuildPart() as text:
        for letter, y in (("B", 22.0), ("M", 0.0), ("O", -22.0)):
            with BuildSketch():
                with Locations((0.0, y)):
                    Text(letter, font_size=22.0)
            extrude(amount=1.8)
        add_control_plug_pegs([(0.0, -20.0), (0.0, 20.0)], 1.65)
    return text.part


def make_side_bmo_text():
    """Raised side lettering matching BMO's vertical side mark."""
    return _make_side_bmo_text_raw().mirror(Plane.YZ)


def make_side_bmo_text_flipped():
    """Mirrored insert for the V7.1 side text direction."""
    return _make_side_bmo_text_raw()


def make_arm(side: str, include_connector: bool = True):
    inward = 1 if side == "left" else -1
    outward = -1 if side == "left" else 1
    R = 4.25  # noodle arm, but not a ball at the hand anymore
    with BuildPart() as arm:
        # Smooth fixed BMO arm: leaves the side socket, sweeps outward, then
        # lifts into the cheerful pose from the references.
        path = [
            (outward * 2.0, 30.0, 4.5),    # root at the shoulder collar
            (outward * 11.0, 48.0, 4.0),   # swing outward from the body
            (outward * 20.0, 74.0, 1.8),   # smooth upward bend
            (outward * 26.0, 104.0, -1.2), # wrist forward of the side wall
        ]
        tube_along(path, R)
        # Round shoulder cap: visible BMO side joint and bearing surface for
        # the movable arm. It hides the pivot bore when assembled.
        with Locations(Location((outward * 1.0, 32.0, 4.4), (0, 90, 0))):
            Cylinder(ARM_PIVOT_COLLAR_R, 3.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        # Flattened BMO mitten hand. The palm/fingers are printed as one soft
        # piece, but the silhouette no longer reads as a plain ball.
        with Locations((outward * 27.4, 106.6, -2.0)):
            add(rounded_box(11.5, 12.5, 5.4, 2.2))
        for fx in (-3.8, 0.0, 3.8):
            with Locations((outward * 27.4 + fx, 113.0, -2.0)):
                add(rounded_box(3.0, 7.2, 4.8, 1.35))
            with Locations(Location((outward * 32.2, 108.2, -2.0), (0, 0, -outward * 24))):
                add(rounded_box(3.2, 8.0, 4.8, 1.35))
        if include_connector:
            # Single shoulder axle: snaps into the round side bore, but stays
            # free to rotate because there is no key block.
            with Locations(Location((inward * 2.0, 32.0, 4.5), (0, inward * 90, 0))):
                add(make_snap_pin(
                    WALL,
                    pin_r=ARM_PIVOT_R,
                    barb=0.78,
                    collar_r=ARM_PIVOT_COLLAR_R,
                    slot_w=1.0,
                ))
    return arm.part


def make_leg_foot(side: str, include_connector: bool = True):
    outward = -1 if side == "left" else 1
    with BuildPart() as leg_foot:
        # Fixed BMO legs: slim round post into a flat rounded boot foot. The
        # bottom has a real flat sole so the assembled body can stand.
        tab_y = 20.2
        Rleg = 4.45
        # Round shin tube: from just under the hip plate straight down, then a
        # forward bend into the foot. -z is toward the face (front).
        shin_path = [
            (0.0, 18.0, 5.8),    # top, overlaps the hip plate/tab
            (0.0, 2.0, 5.8),     # straight shin
            (0.0, -9.0, 4.7),    # ankle starts bending forward
            (outward * 0.8, -16.0, 1.2),   # into the boot
            (outward * 1.4, -19.2, -2.5),  # front sweep into the foot
        ]
        tube_along(shin_path, Rleg)
        with Locations((outward * 1.2, -22.8, 9.4)):
            add(rounded_box(21.0, 9.2, 62.0, 3.4))
        # Subtle flat sole pad keeps the contact plane wide after edge
        # rounding, without changing the one-piece printed limb.
        with Locations((outward * 1.2, -27.6, 9.4)):
            Box(18.0, 1.2, 54.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        if include_connector:
            with Locations((0, tab_y, 7.0)):
                Box(LEG_TAB_W, LEG_TAB_Y, LEG_TAB_Z, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            # Hip plate: a solid root that ties both snap pins to the tab and shin
            # so the leg prints as one piece and the pins have a stiff anchor.
            with Locations((0, tab_y - 1.6, 7.7)):
                Box(LEG_PIN_SPACING + 2 * LEG_SNAP_COLLAR_R, 3.6, 2 * LEG_SNAP_COLLAR_R,
                    align=(Align.CENTER, Align.CENTER, Align.CENTER))
            for x in (-LEG_PIN_SPACING / 2, LEG_PIN_SPACING / 2):
                with Locations(Location((x, tab_y - 0.6, 7.7), (-90, 0, 0))):
                    add(make_snap_pin(WALL, pin_r=LEG_SNAP_R, barb=LEG_SNAP_BARB,
                                      collar_r=LEG_SNAP_COLLAR_R))
    return leg_foot.part


def place_on_plate(shape, center_x: float, center_y: float, rotation_z: float = 0.0):
    """Center a printable part at an A1 plate coordinate and drop it to Z=0."""
    placed = shape.rotate(Axis.Z, rotation_z) if rotation_z else shape
    bbox = placed.bounding_box()
    return placed.translate(
        (
            center_x - (bbox.min.X + bbox.max.X) / 2,
            center_y - (bbox.min.Y + bbox.max.Y) / 2,
            -bbox.min.Z,
        )
    )


def make_static_shell_plate(parts: dict[str, object]):
    """A1-safe batch containing only the two large body halves."""
    return Compound(
        children=[
            place_on_plate(parts["front_shell"], -60.5, 0.0),
            place_on_plate(parts["rear_lid"], 60.5, 0.0),
        ]
    )


def make_static_accessories_plate(parts: dict[str, object]):
    """A1-safe batch for controls, bezel, limbs, and side lettering."""
    return Compound(
        children=[
            place_on_plate(parts["controls"], -72.0, 47.0),
            place_on_plate(parts["tft_bezel"], 29.0, 47.0),
            place_on_plate(parts["left_arm"], -57.0, -27.0, 90.0),
            place_on_plate(parts["right_arm"], 48.0, -27.0, 90.0),
            place_on_plate(parts["left_leg_foot"], -73.0, -78.0, 90.0),
            place_on_plate(parts["right_leg_foot"], -10.0, -78.0, 90.0),
            place_on_plate(parts["side_bmo_text"], 48.0, -83.0),
        ]
    )


def make_print_kit(parts: dict[str, object]):
    """Legacy all-parts layout.

    Prefer the two static A1 batches for real printing; this combined compound
    remains useful for inspection and backward-compatible viewer links.
    """
    items = [
        parts["front_shell"].located(Location((-64.0, 44.0, 0))),
        parts["rear_lid"].located(Location((64.0, 44.0, 0))),
        parts["controls"].located(Location((-78.0, -58.0, 0))),
        parts["left_arm"].located(Location((0.0, -98.0, 0), (0, 0, 90))),
        parts["right_arm"].located(Location((58.0, -98.0, 0), (0, 0, 90))),
        parts["left_leg_foot"].located(Location((104.0, -64.0, 0), (0, 0, 90))),
        parts["right_leg_foot"].located(Location((104.0, -42.0, 0), (0, 0, 90))),
        parts["side_bmo_text"].located(Location((116.0, -98.0, 0))),
        parts["tft_bezel"].located(Location((30.0, -56.0, 0))),
    ]
    return Compound(children=items)


def component_ghosts():
    """Approximate electronics volumes for fit checking."""
    ghosts = []
    ghosts.append(
        rounded_prism(SCREEN_MODULE_W, SCREEN_MODULE_H, SCREEN_MODULE_T, 2.0).located(
            Location((0, SCREEN_Y, FRONT_SKIN + 0.4))
        )
    )
    hub_z = FRONT_DEPTH + LID_T + 3.0
    heart_x, heart_y = ORGAN_PLACEMENTS["esp32_heart"]
    battery_x, battery_y = ORGAN_PLACEMENTS["battery_cell"]
    mic_x, mic_y = ORGAN_PLACEMENTS["mic_ear"]
    amp_x, amp_y = ORGAN_PLACEMENTS["i2s_lung"]
    charge_x, charge_y = ORGAN_PLACEMENTS["charge_kidney"]
    boost_x, boost_y = ORGAN_PLACEMENTS["boost_gland"]
    touch_x, touch_y = ORGAN_PLACEMENTS["touch_spark"]
    ghosts.append(rounded_prism(70.0, 58.0, 29.0, 8.0).located(Location((heart_x, heart_y, hub_z))))
    ghosts.append(Box(BREADBOARD_W, BREADBOARD_H, BREADBOARD_T).located(Location((heart_x - 6.0, heart_y - 1.0, hub_z + 4.0))))
    ghosts.append(Box(ESP32_W, ESP32_H, ESP32_T).located(Location((heart_x + 18.0, heart_y - 1.0, hub_z + 15.0))))
    ghosts.append(
        Box(
            component_specs.BATTERY_103450.width,
            component_specs.BATTERY_103450.height,
            component_specs.BATTERY_103450.depth,
        ).located(Location((battery_x, battery_y, hub_z + 2.0)))
    )
    ghosts.append(Box(MIC_W, MIC_H, MIC_T).located(Location((mic_x, mic_y, hub_z + 2.6))))
    ghosts.append(Box(TOUCH_W, TOUCH_H, TOUCH_T).located(Location((touch_x, touch_y, hub_z + 3.5))))
    ghosts.append(
        Box(SPEAKER_T, SPEAKER_PLATE_W, SPEAKER_PLATE_H).located(
            Location((BODY_W / 2 - WALL - 6.0, 32.0, FRONT_DEPTH * 0.50))
        )
    )
    ghosts.append(Box(AMP_W, AMP_H, AMP_T).located(Location((amp_x, amp_y, hub_z + 5.0))))
    ghosts.append(
        Box(
            component_specs.TP4056_TYPE_C.width,
            component_specs.TP4056_TYPE_C.height,
            component_specs.TP4056_TYPE_C.depth,
        ).located(Location((charge_x, charge_y, hub_z + 4.0)))
    )
    ghosts.append(
        Box(
            component_specs.MT3608.width,
            component_specs.MT3608.height,
            component_specs.MT3608.depth,
        ).located(Location((boost_x, boost_y, hub_z + 5.0)))
    )
    ghosts.append(Box(18.0, 126.0, 7.0).located(Location((8.0, -2.0, hub_z + 2.8))))
    return ghosts


def make_assembly(parts: dict[str, object], fit_check: bool = False):
    arm_z = FRONT_DEPTH * 0.48 - 3.9
    leg_z = FRONT_DEPTH * 0.47 - 7.7
    children = [
        parts["front_shell"],
        parts["rear_lid"].located(Location((0, 0, FRONT_DEPTH + 0.8))),
        parts["tft_bezel"].located(Location((0, SCREEN_Y, -0.05))),
        parts["controls"].located(Location((0, 0, -2.45))),
        parts["side_bmo_text"].located(Location((BODY_W / 2 + 0.8, -4.0, FRONT_DEPTH * 0.64), (0, 90, 0))),
        parts["left_arm"].located(Location((-BODY_W / 2 - 6.5, -55.0, arm_z))),
        parts["right_arm"].located(Location((BODY_W / 2 + 6.5, -55.0, arm_z))),
        parts["left_leg_foot"].located(Location((-26.0, -93.0, leg_z))),
        parts["right_leg_foot"].located(Location((26.0, -93.0, leg_z))),
    ]
    if fit_check:
        children.extend(component_ghosts())
    return Compound(children=children)


def make_parts():
    red_button = make_round_button(8.0)
    blue_button = make_triangle_button()
    bottom_pill = make_pill_button()
    return {
        "front_shell": make_front_shell(),
        "preview_front_shell": make_front_shell(preview=True),
        "rear_lid": make_rear_lid(),
        "tft_bezel": make_tft_bezel(),
        "controls": make_controls(),
        "dpad": make_dpad(),
        "red_button": red_button,
        "blue_button": blue_button,
        "green_button": make_round_button(5.3),
        "bottom_pill": bottom_pill,
        "side_bmo_text": make_side_bmo_text(),
        "side_bmo_text_flipped": make_side_bmo_text_flipped(),
        "left_arm": make_arm("left"),
        "right_arm": make_arm("right"),
        "left_leg_foot": make_leg_foot("left"),
        "right_leg_foot": make_leg_foot("right"),
        "preview_left_arm": make_arm("left", include_connector=False),
        "preview_right_arm": make_arm("right", include_connector=False),
        "preview_left_leg_foot": make_leg_foot("left", include_connector=False),
        "preview_right_leg_foot": make_leg_foot("right", include_connector=False),
    }


def write_basic_3mf(stl_path: Path, out_path: Path):
    """Write a minimal 3MF from an STL mesh for slicer convenience."""
    loaded = trimesh.load_mesh(stl_path, force="mesh")
    if isinstance(loaded, trimesh.Scene):
        mesh = trimesh.util.concatenate(tuple(loaded.geometry.values()))
    else:
        mesh = loaded
    mesh.remove_unreferenced_vertices()

    vertices = "\n".join(
        f'<vertex x="{v[0]:.6f}" y="{v[1]:.6f}" z="{v[2]:.6f}"/>' for v in mesh.vertices
    )
    triangles = "\n".join(
        f'<triangle v1="{int(f[0])}" v2="{int(f[1])}" v3="{int(f[2])}"/>' for f in mesh.faces
    )
    model_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
        "  <resources>\n"
        '    <object id="1" type="model" name="'
        + escape(stl_path.stem)
        + '">\n'
        "      <mesh>\n"
        "        <vertices>\n"
        f"{vertices}\n"
        "        </vertices>\n"
        "        <triangles>\n"
        f"{triangles}\n"
        "        </triangles>\n"
        "      </mesh>\n"
        "    </object>\n"
        "  </resources>\n"
        "  <build>\n"
        '    <item objectid="1"/>\n'
        "  </build>\n"
        "</model>\n"
    )

    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
            '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
            '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
            "</Types>\n",
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '  <Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n'
            "</Relationships>\n",
        )
        archive.writestr("3D/3dmodel.model", model_xml)


def export_shape(name: str, shape, *, make_3mf: bool = True):
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    step_path = EXPORT_DIR / f"{name}.step"
    stl_path = EXPORT_DIR / f"{name}.stl"
    glb_path = EXPORT_DIR / f"{name}.glb"
    export_step(shape, step_path)
    export_stl(shape, stl_path, tolerance=0.08, angular_tolerance=0.15)
    # GLB is a WEB PREVIEW only (the viewer uses it). Default linear_deflection
    # is 0.001 mm = print-grade, which makes multi-MB meshes that load slowly.
    # Coarsen it a lot: still smooth on screen, ~5-10x smaller / faster.
    export_gltf(shape, glb_path, binary=True, linear_deflection=0.1, angular_deflection=0.45)
    if make_3mf:
        write_basic_3mf(stl_path, EXPORT_DIR / f"{name}.3mf")
    return step_path, stl_path, glb_path


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def gen_step():
    """Return the full fit-check assembly for CAD viewers."""
    parts = make_parts()
    return make_assembly(parts, fit_check=True)


def main():
    parts = make_parts()
    assemblies = {
        "bmo_full_assembly": make_assembly(parts, fit_check=False),
        "bmo_fit_check_assembly": make_assembly(parts, fit_check=True),
        "bmo_component_ghosts": Compound(children=component_ghosts()),
        "bmo_print_kit": make_print_kit(parts),
        "bmo_static_shell_plate": make_static_shell_plate(parts),
        "bmo_static_accessories_plate": make_static_accessories_plate(parts),
    }
    exports = {
        "bmo_body_front_shell": parts["front_shell"],
        "bmo_body_rear_lid_tray": parts["rear_lid"],
        "bmo_tft_bezel": parts["tft_bezel"],
        "bmo_front_controls": parts["controls"],
        "bmo_dpad": parts["dpad"],
        "bmo_red_button": parts["red_button"],
        "bmo_blue_button": parts["blue_button"],
        "bmo_green_button": parts["green_button"],
        "bmo_bottom_pill": parts["bottom_pill"],
        "bmo_side_bmo_text": parts["side_bmo_text"],
        "bmo_side_bmo_text_flipped": parts["side_bmo_text_flipped"],
        "bmo_left_arm": parts["left_arm"],
        "bmo_right_arm": parts["right_arm"],
        "bmo_left_leg_foot": parts["left_leg_foot"],
        "bmo_right_leg_foot": parts["right_leg_foot"],
        **assemblies,
    }

    for name, shape in exports.items():
        export_shape(name, shape)
        print(describe_shape(name, shape))

    preview_exports = {
        "bmo_preview_front_shell": parts["preview_front_shell"],
        "bmo_preview_left_arm": parts["preview_left_arm"],
        "bmo_preview_right_arm": parts["preview_right_arm"],
        "bmo_preview_left_leg_foot": parts["preview_left_leg_foot"],
        "bmo_preview_right_leg_foot": parts["preview_right_leg_foot"],
    }
    for name, shape in preview_exports.items():
        export_gltf(shape, EXPORT_DIR / f"{name}.glb", binary=True)
        print(describe_shape(name, shape))

    print(f"Generated CAD artifacts in {EXPORT_DIR}")


if __name__ == "__main__":
    main()
