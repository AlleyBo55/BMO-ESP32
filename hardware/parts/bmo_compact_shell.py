"""BMO Static - compact, BMO-accurate shell (80 x 96 x 52 mm).

Fixes the two things that made the earlier compact body NOT look like BMO:
  1. Aspect ratio. BMO is stocky/square-ish, while the internal depth stack
     keeps the body smaller than the earlier 88 x 112 shell.
  2. The big light SCREEN FACE. BMO's defining feature is the large pale screen
     panel filling the upper face, with the small lit LCD inside it. A bare teal
     box with a tiny window reads as a phone, not BMO. So the pale face panel is
     back (as a separate light-colored insert), with the 35x28 LCD window in it.

Components still pack through body depth via bmo_rack.
Coordinates: X width, Y up, Z depth (face=0).
"""

from __future__ import annotations

from build123d import (
    Align,
    Axis,
    Box,
    BuildPart,
    BuildSketch,
    Compound,
    Cylinder,
    Keep,
    Location,
    Locations,
    Mode,
    Plane,
    RectangleRounded,
    RegularPolygon,
    Sphere,
    Text,
    Torus,
    add,
    extrude,
    fillet,
)

import bmo_body
import bmo_component_specs as cs
import bmo_rack


# ---------- Body envelope (BMO-proportioned) ----------
BODY_W = 80.0
BODY_H = 96.0
FRONT_DEPTH = bmo_rack.RACK_BODY_D
WALL = bmo_body.WALL
FRONT_SKIN = bmo_body.FRONT_SKIN
CORNER_R = 12.0
FRONT_EDGE_FILLET = 3.0                 # front-face pillow round-over. Kept modest (3 mm) so it prints clean face-DOWN: a bigger fillet (6 mm) becomes a near-horizontal downward overhang at the bed and roughens the bottom edge. Raise back toward 6 for a softer look if you print the face up / with support.
LID_PLATE_T = 3.0                       # rear cover outer plate; sits flush at the back (z = FRONT_DEPTH - LID_PLATE_T .. FRONT_DEPTH)
LID_SEAT_Z = bmo_rack.RACK_BODY_D - LID_PLATE_T   # 51: cover plate top is flush with the body back
SHELL_DEPTH = LID_SEAT_Z                # shell stops where the rear-cover plate begins
LIP_DEPTH = 5.0                         # rear-cover sealing lip insertion depth (z = LID_SEAT_Z - LIP_DEPTH .. LID_SEAT_Z)
LIP_BOTTOM_Z = LID_SEAT_Z - LIP_DEPTH   # deepest point the cover lip reaches into the body
# Rear cover bulges outward into a shallow dome so tall internals fit. The dome
# rises REAR_BULGE at the center and flattens to the original back plane at the
# rim; a solid SEAT_BAND-wide perimeter keeps the lip/detents on real material.
REAR_BULGE = 6.0
SEAT_BAND = 6.0

# ---------- BMO face: big pale screen panel + small lit LCD inside ----------
# ---------- BMO face: big ROUNDED light screen (matches the reference) ----------
FACE_W = 48.0                          # smaller screen face (thinner pale surround)
FACE_H = 38.0
FACE_Y = 21.0
R_FACE = 6.0                           # rounder corners (the reference is quite round)
FACE_T = 1.8
SCREEN_VISIBLE_W = cs.TFT_ACTIVE.width + cs.DISPLAY_OPENING_CLEARANCE
SCREEN_VISIBLE_H = cs.TFT_ACTIVE.height + cs.DISPLAY_OPENING_CLEARANCE
FACE_ACTIVE_W = SCREEN_VISIBLE_W
FACE_ACTIVE_H = SCREEN_VISIBLE_H
SCREEN_Y = FACE_Y
BEZEL_T = 1.0
BEZEL_PEG_R = 1.35
BEZEL_PEG_H = 3.8
BEZEL_PEG_CLEARANCE = 0.12              # firm hand-press fit (repo standard); 0.20 was a loose locating fit that fell out
BEZEL_PEG_POS = [(-19.0, -12.0), (-19.0, 12.0), (19.0, -12.0), (19.0, 12.0)]

# ---------- Controls (measured from the BMO render) ----------
# Positions are written for the PRINTED FACE as you hold it (looking at the
# screen): D-pad lower-LEFT, cyan triangle center, small green up-right of it,
# big red below, two blue dashes bottom-left, small blue power dot upper-right.
# (X was mirrored from the old layout, which came out reversed on the print.)
CONTROL_POS = {
    "dpad":         (20.0, -24.0),
    "triangle":     (-5.0, -25.0),
    "green_button": (-21.0, -24.0),
    "red_button":   (-11.0, -37.0),
    "pill_left":    (24.0, -40.0),
    "pill_right":   (15.0, -40.0),
    "power_dot":    (-20.0, -12.0),
}
CTRL_HOLE_R = 1.2
USBC_POS = (0.0, -43.0)
CART_SLOT = (7.0, -6.0, 30.0, 3.0)

# ---------- Rear cover closure ----------
# The rear cover is held shut by snap DETENT bumps on its lip that click into
# dimples in the front shell (press to close, pull firmly to pop off). The
# quarter-turn cam lock was removed: it was redundant with the detents and its
# catch towers complicated the print, so the cover is now a clean, solid,
# fully light-tight panel with no keyholes.
SIDE_DETENT_Y = 27.0
TOP_DETENT_X = 18.0
# Rear-cover snap detents (cover lip bump -> wall socket). Tuned so the bump
# rides the wall with only ~0.25 mm interference and pops into the socket (real
# click), instead of the old 1.1 mm jam that wouldn't seat.
DETENT_BUMP_R = 1.6        # lip bump sphere radius
DETENT_PROTRUDE = 0.45     # how far the bump apex sticks past the lip outer face
DETENT_DIMPLE_R = 2.0      # spherical socket in the wall (symmetric: no cut-direction bug)
ARM_SOCKET_Y = 8.0

A1_SAFE = 250.0


def make_front_shell(preview: bool = False):
    """Compact BMO front shell: stocky body, big recessed screen face."""
    with BuildPart() as shell:
        with BuildSketch():
            RectangleRounded(BODY_W, BODY_H, CORNER_R)
        extrude(amount=SHELL_DEPTH)

        front_face = shell.faces().sort_by(Axis.Z)[0]
        fillet(front_face.edges(), radius=FRONT_EDGE_FILLET)

        # Hollow from the back (for the rack). ROUNDED inner corners, concentric
        # with the body (r = CORNER_R - WALL), so the cavity stays INSIDE the rear
        # lid's rounded corners. A sharp square cavity pokes ~1 mm past the rounded
        # lid at each vertical corner, leaving an open notch ("corner not enclosed").
        add(bmo_body.rounded_prism(BODY_W - 2 * WALL, BODY_H - 2 * WALL,
                                   FRONT_DEPTH + 2, CORNER_R - WALL)
            .located(Location((0, 0, FRONT_SKIN))), mode=Mode.SUBTRACT)

        # Rounded-corner screen window (THE BMO screen), cut through the skin.
        # Covered by the TFT/face from behind, so it isn't an open "leak".
        add(bmo_body.rounded_prism(FACE_W, FACE_H, FRONT_SKIN + 1.0, R_FACE)
            .located(Location((0, FACE_Y, -0.5))), mode=Mode.SUBTRACT)
        # TFT retaining FRAME: ONE connected lip behind the window that merges
        # into the skin (no floating tabs). The screen board seats against its
        # back face from inside and can't push out the front.
        add(bmo_body.rounded_prism(FACE_W + 5.0, FACE_H + 5.0, 3.4, R_FACE + 1.0)
            .located(Location((0, FACE_Y, FRONT_SKIN - 1.0))))
        add(bmo_body.rounded_prism(FACE_W - 3.0, FACE_H - 3.0, 6.0, R_FACE)
            .located(Location((0, FACE_Y, FRONT_SKIN - 1.5))), mode=Mode.SUBTRACT)
        # Hidden sockets for the removable bezel. The pegs are covered by the
        # bezel itself, so these holes cannot leak light around the TFT.
        for px, py in BEZEL_PEG_POS:
            with Locations((px, FACE_Y + py, -0.5)):
                Cylinder(
                    BEZEL_PEG_R + BEZEL_PEG_CLEARANCE,
                    FRONT_SKIN + 1.4,
                    align=(Align.CENTER, Align.CENTER, Align.MIN),
                    mode=Mode.SUBTRACT,
                )

        # Cartridge / diskette slot — THROUGH opening (pierces the front skin).
        cx, cyy, cwid, chei = CART_SLOT
        with Locations((cx, cyy, -0.5)):
            Box(cwid, chei, FRONT_SKIN + 1.0,
                align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

        # Honeycomb speaker grille — the ONLY open vent (speaker needs to breathe).
        _cut_side_honeycomb(shell)

        # USB-C charge port — snug around the Type-C plug shell (GCT USB4085
        # receptacle; plug metal ~8.34 x 2.56 mm + insertion clearance). Smaller
        # than before so the opening reads tight, not gappy.
        ux, uy = USBC_POS
        with Locations((ux, uy, -0.5)):
            Box(8.6, 2.9, FRONT_SKIN + 1.0,
                align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

        if not preview:
            # Limb BAYONET twist-lock sockets. +Z of each frame points INTO the
            # body so the locking relief sits on the interior side.
            with Locations(Location((-BODY_W / 2, ARM_SOCKET_Y, FRONT_DEPTH * 0.5), (0, 90, 0))):
                cut_bayonet_socket()
            with Locations(Location((BODY_W / 2, ARM_SOCKET_Y, FRONT_DEPTH * 0.5), (0, -90, 0))):
                cut_bayonet_socket()
            for hx in (-LEG_SPACING / 2, LEG_SPACING / 2):
                with Locations(Location((hx, -BODY_H / 2, FRONT_DEPTH * 0.5), (-90, 0, 0))):
                    cut_bayonet_socket()
            # Plug sockets for the control caps (covered by each cap = no visible leak).
            for ox, oy in CONTROL_POS.values():
                with Locations((ox, oy, -0.5)):
                    Cylinder(1.55, FRONT_SKIN + 1.6, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

            # Snap SOCKETS in the interior walls — receive the rear cover's lip
            # detent bumps so the cover CLICKS shut. Spherical sockets centered on
            # each inner wall face: symmetric, so there's no cut-direction bug and
            # every one of the 8 detents actually seats.
            lip_detent_z = LID_SEAT_Z - 4.0
            for wx in (-(BODY_W / 2 - WALL), BODY_W / 2 - WALL):
                for wy in (-SIDE_DETENT_Y, SIDE_DETENT_Y):
                    with Locations((wx, wy, lip_detent_z)):
                        Sphere(DETENT_DIMPLE_R, mode=Mode.SUBTRACT)
            for wy in (-(BODY_H / 2 - WALL), BODY_H / 2 - WALL):
                for wx in (-TOP_DETENT_X, TOP_DETENT_X):
                    with Locations((wx, wy, lip_detent_z)):
                        Sphere(DETENT_DIMPLE_R, mode=Mode.SUBTRACT)
    return shell.part


def _cut_side_honeycomb(shell):
    """BMO-style honeycomb grille on BOTH side walls, set ABOVE the arm line
    (just over the shoulder bayonets at y=+8) so the comb sits above the hands.
    """
    cx_y, cz = 22.0, FRONT_DEPTH * 0.5
    for wall_x in (BODY_W / 2 - 0.2, -BODY_W / 2 + 0.2):
        for pa, pb in bmo_body.honeycomb_points(cx_y, cz, spacing=5.4):
            with Locations(Location((wall_x, pa, pb), (0, 90, 0))):
                Cylinder(2.0, WALL + 3.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)


def make_front_shell_half(which: str = "bottom"):
    """Front shell cut in two at mid-height (Y=0) so each half prints in ~half
    the time (the full shell is the 6h+ part). The cut faces carry alignment
    pins (bottom half) / holes (top half) so the two glue back together square
    and light-tight. Glue with CA/super glue along the seam.
    """
    base = make_front_shell()
    with BuildPart() as out:
        add(base)
        # Cut away the OTHER half at the Y=0 plane.
        y_align = Align.MIN if which == "bottom" else Align.MAX
        with Locations((0, 0, FRONT_DEPTH / 2)):
            Box(BODY_W + 40, BODY_H + 40, FRONT_DEPTH + 40,
                align=(Align.CENTER, y_align, Align.CENTER), mode=Mode.SUBTRACT)
        # Alignment pins (bottom half) / holes (top half) on the two side walls.
        sx = BODY_W / 2 - WALL / 2 - 0.2
        for px in (-sx, sx):
            for pz in (SHELL_DEPTH * 0.28, SHELL_DEPTH * 0.74):
                with Locations(Location((px, 0.0, pz), (-90, 0, 0))):
                    if which == "bottom":
                        Cylinder(1.5, 5.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
                    else:
                        Cylinder(1.7, 5.4, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return out.part


def make_face_panel():
    """Light BMO screen surround with a real opening for the active TFT."""
    with BuildPart() as panel:
        add(bmo_body.rounded_prism(FACE_W - 0.6, FACE_H - 0.6, FACE_T, R_FACE - 0.3))
        add(
            bmo_body.rounded_prism(FACE_ACTIVE_W, FACE_ACTIVE_H, FACE_T + 1.0, 1.8)
            .located(Location((0, 0, -0.5))),
            mode=Mode.SUBTRACT,
        )
    return panel.part


def make_screen_dark():
    """Optional dark LCD insert (the lit ST7735 area) for the real build."""
    return bmo_body.rounded_box(SCREEN_VISIBLE_W + 1.0, SCREEN_VISIBLE_H + 1.0, 1.0, 0.4)


def make_side_text():
    """Vertical 'BMO' lettering (each letter stacked along Y) for the side wall."""
    with BuildPart() as t:
        for i, ch in enumerate("BMO"):
            with Locations((0, 11.0 - i * 11.0, 0)):
                with BuildSketch():
                    Text(ch, font_size=8.5)
                extrude(amount=1.2)
    return t.part


# ---------- Control caps ----------
def make_dpad_cap():
    with BuildPart() as cap:
        add(bmo_body.rounded_box(13.0, 4.4, 2.8, 1.0))
        add(bmo_body.rounded_box(4.4, 13.0, 2.8, 1.0))
        with Locations((0, 0, -3.6)):
            Cylinder(1.3, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN))   # plug peg
    return cap.part


def make_triangle_cap():
    with BuildPart() as cap:
        with BuildSketch():
            RegularPolygon(5.0, 3)
        extrude(amount=2.6)
        with Locations((0, 0, -3.6)):
            Cylinder(1.3, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return cap.part


def make_round_cap(radius: float = 4.6):
    peg_r = min(1.3, radius - 0.8)
    with BuildPart() as cap:
        Cylinder(radius, 2.6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, -3.6)):
            Cylinder(peg_r, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return cap.part


def make_red_button():
    """Large red round button (the biggest control)."""
    return make_round_cap(5.2)


def make_green_button():
    """Small green round button."""
    return make_round_cap(3.0)


def make_power_dot():
    """Tiny blue power dot near the cartridge slot."""
    return make_round_cap(2.0)


def make_pill_cap():
    with BuildPart() as cap:
        add(bmo_body.rounded_box(8.0, 3.0, 2.6, 1.0))
        with Locations((0, 0, -3.6)):
            Cylinder(1.0, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return cap.part


def make_controls_runner():
    """Gundam-style sprue: every front-control cap joined to one central runner
    bar by thin gates. Prints as ONE stable piece (caps face-DOWN so the visible
    tops are smooth on the bed, plungers pointing up). Snip each cap off the gate
    with a sprue/flush cutter, then plug it into the shell.

    Tiny caps fail when printed loose; on a runner they share a big, stable base.
    """
    caps = [
        ("dpad", make_dpad_cap()),
        ("triangle", make_triangle_cap()),
        ("red", make_red_button()),
        ("green", make_green_button()),
        ("pill_left", make_pill_cap()),
        ("pill_right", make_pill_cap()),
        ("power_dot", make_power_dot()),
    ]
    GATE_W = 1.2          # gate width (thin = easy snip, clean nub)
    GATE_H = 1.4          # gate height (sits at the bed)
    SPINE_W = 3.2         # runner bar width
    SPINE_H = 2.4         # runner bar height
    PITCH = 17.0          # spacing between caps (> widest cap)
    NEAR_Y = SPINE_W / 2 + 2.6   # cap near-edge line -> short, uniform gates
    n = len(caps)
    spine_len = (n - 1) * PITCH + 18.0
    with BuildPart() as runner:
        # Central runner bar along X at y=0.
        add(bmo_body.rounded_box(spine_len, SPINE_W, SPINE_H, 0.6)
            .translate((0, 0, SPINE_H / 2)))
        for i, (_, cap) in enumerate(caps):
            x = -spine_len / 2 + 9.0 + i * PITCH
            flipped = cap.rotate(Axis.X, 180)   # cap face down, plunger up
            bb = flipped.bounding_box()
            placed = flipped.translate((
                x - (bb.min.X + bb.max.X) / 2,    # center on this slot
                NEAR_Y - bb.min.Y,                # near edge on the gate line
                -bb.min.Z,                        # rest on the bed
            ))
            add(placed)
            # Thin gate bridging the runner bar to the cap. Runs from the spine
            # well into the cap so even the triangle's narrow tip fuses solidly.
            gate_len = NEAR_Y + 2.6
            with Locations((x, gate_len / 2, GATE_H / 2)):
                Box(GATE_W, gate_len, GATE_H)
    return runner.part


def make_bezel_ring():
    """Raised teal bezel with four hidden press pegs into the front shell."""
    with BuildPart() as ring:
        add(bmo_body.rounded_prism(FACE_W + 3.0, FACE_H + 3.0, BEZEL_T, R_FACE + 1.5))
        add(bmo_body.rounded_prism(FACE_W + 0.4, FACE_H + 0.4, 2.4, R_FACE)
            .located(Location((0, 0, -0.4))), mode=Mode.SUBTRACT)
        for px, py in BEZEL_PEG_POS:
            with Locations((px, py, BEZEL_T - 0.2)):
                Cylinder(
                    BEZEL_PEG_R,
                    BEZEL_PEG_H + 0.2,
                    align=(Align.CENTER, Align.CENTER, Align.MIN),
                )
    return ring.part


# ---------- Gundam-style bayonet twist-lock joint ----------
# Insert the pin (lugs aligned to the keyway), push in, ROTATE 90 deg -> the
# lugs sit behind the inner wall face and lock (no rattle, no glue). Rotate back
# 90 deg -> lugs realign with the keyway -> pull out. Clearances are parametric
# because the exact fit must be dialed on a test print.
BAY_SHANK_R = 3.0
BAY_LUG = 1.8           # how far each lug sticks past the shank
BAY_LUG_T = 4.0         # lug bar thickness (the narrow axis, = keyway width)
BAY_LUG_H = 2.4         # lug bar height (sits behind the wall)
BAY_CLR = 0.20          # Bambu A1 PLA running clearance (socket side — DO NOT change without re-cutting the shell hole)
# ---- Pin-only firmness tuning (the shell socket is NOT changed by any of these) ----
BAY_AXIAL_CLEARANCE = 0.06   # was 0.20: lug now seats ~flush on the pocket floor -> kills in/out wobble
PIN_SHANK_FIT = 0.12         # oversize the pin shank only (3.0 -> 3.12) so it's snug in the 3.2 bore (0.08 gap, was 0.20) -> no tilt, holds rotation by friction
PIN_SNAP_INTERF = 0.10       # retention bead radial interference past the bore mouth -> positive CLICK on insert + resists pull-out
PIN_SNAP_MINOR = 0.5         # bead cross-section radius (rounded so it cams through by hand)

HAND_FINGER_COUNT = 4
FOOT_W = 18.0
FOOT_D = 30.0
FOOT_H = 9.0
LEG_SPACING = 32.0


def make_bayonet_pin(collar_r: float = 6.0):
    """Bayonet pin built along +Z: collar -> shank through wall -> locking lugs.

    Pin-only firmness (the matching shell socket is unchanged):
      * shank is oversized (PIN_SHANK_FIT) for a snug, no-tilt fit in the bore,
      * a rounded snap bead just past the inner wall face clicks into the socket's
        relief pocket and resists pull-out,
      * tighter axial clearance seats the lug almost flush on the pocket floor.
    """
    shank_r = BAY_SHANK_R + PIN_SHANK_FIT
    with BuildPart() as pin:
        # Outer collar/shoulder that seats flat on the outside wall face.
        with Locations((0, 0, -1.6)):
            Cylinder(collar_r, 1.6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Shank through the wall (snug in the bore).
        shank_len = WALL + BAY_AXIAL_CLEARANCE
        Cylinder(shank_r, shank_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Snap-retention bead: rounded ring just past the inner wall face. It pops
        # into the socket's relief pocket on insertion (audible/tactile click) and
        # must be forced back through the bore to pull the limb off.
        bead_outer = BAY_SHANK_R + BAY_CLR + PIN_SNAP_INTERF
        with Locations((0, 0, WALL + PIN_SNAP_MINOR)):
            add(Torus(max(bead_outer - PIN_SNAP_MINOR, 0.1), PIN_SNAP_MINOR))
        # Locking lug bar beyond the inner wall face (wide in X, thin in Y).
        with Locations((0, 0, shank_len)):
            add(bmo_body.rounded_box(2 * (BAY_SHANK_R + BAY_LUG), BAY_LUG_T, BAY_LUG_H, 0.8)
                .translate((0, 0, BAY_LUG_H / 2)))
    return pin.part


def cut_bayonet_socket():
    """Subtract a bayonet socket in the active Locations frame (+Z = INTO body).

    Bore for the shank + a keyway slot (lets the lug bar pass) + an inner relief
    disc (lets the lugs rotate behind the wall to lock).
    """
    # Shank bore (through the wall).
    with Locations((0, 0, -2.0)):
        Cylinder(BAY_SHANK_R + BAY_CLR, WALL + 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    # Keyway slot for the lug bar to pass straight through (X-wide).
    with Locations((0, 0, -2.0)):
        Box(2 * (BAY_SHANK_R + BAY_LUG) + 2 * BAY_CLR, BAY_LUG_T + 2 * BAY_CLR, WALL + 4.0,
            align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    # Inner relief disc so the lugs can rotate behind the wall and lock.
    with Locations((0, 0, WALL)):
        Cylinder(BAY_SHANK_R + BAY_LUG + BAY_CLR + 0.5, BAY_LUG_H + 1.0,
                 align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def make_arm(side: str):
    """Thin BMO arm with a fused palm and four readable rounded digits.

    Insert with the hand pointing outward (lugs aligned to the keyway), push in,
    then rotate the arm down ~90 deg to lock. Rotate back up to release + pull.
    """
    out = -1 if side == "left" else 1
    inward = -out
    with BuildPart() as arm:
        with Locations(Location((inward * 1.0, 0.0, 0.0), (0, inward * 90, 0))):
            add(make_bayonet_pin(collar_r=5.5))
        bmo_body.tube_along(
            [
                (out * 2.0, -1.0, 0.0),
                (out * 5.0, -14.0, 2.0),
                (out * 5.0, -30.0, 3.0),
                (out * 3.0, -42.0, 2.0),
            ],
            3.0,
        )
        palm_x = out * 3.0
        with Locations((palm_x, -44.5, 2.0)):
            add(bmo_body.rounded_box(8.8, 7.0, 4.8, 2.0))
        for offset, length, spread in ((-1.8, 5.2, -0.5), (0.0, 6.0, 0.0), (1.8, 5.4, 0.5)):
            bmo_body.tube_along(
                [
                    (palm_x + out * offset, -46.5, 2.0),
                    (palm_x + out * (offset + spread), -46.5 - length, 2.0),
                ],
                1.2,
            )
        bmo_body.tube_along(
            [
                (palm_x - out * 3.2, -44.8, 2.0),
                (palm_x - out * 5.2, -48.4, 2.0),
            ],
            1.25,
        )
    return arm.part


def make_leg(side: str):
    """Short BMO leg with a wide, flat-soled shoe and bayonet cam lock.

    Insert with the foot pointing sideways (lugs aligned to the keyway), push up,
    rotate the leg forward ~90 deg to lock. Rotate back to release + pull down.
    """
    with BuildPart() as leg:
        out = -1 if side == "left" else 1
        with Locations(Location((0.0, 1.0, 0.0), (-90, 0, 0))):
            add(make_bayonet_pin(collar_r=6.0))
        bmo_body.tube_along(
            [
                (0.0, -1.0, 0.0),
                (out * 1.0, -14.0, 0.0),
                (out * 2.0, -26.0, 1.0),
            ],
            3.6,
        )
        # A broad sole and slightly smaller upper read as a shoe while keeping
        # both feet coplanar and the support polygon centered under the body.
        with Locations((out * 2.0, -31.0, -1.0)):
            add(bmo_body.rounded_box(FOOT_W, 4.0, FOOT_D, 1.5))
        with Locations((out * 2.0, -28.5, -2.0)):
            add(bmo_body.rounded_box(FOOT_W - 2.0, FOOT_H - 3.0, FOOT_D - 5.0, 2.0))
    return leg.part


def make_tft_ghost():
    """ST7735 module envelope, to drop behind the screen hole and check fit."""
    return bmo_body.rounded_box(cs.TFT_BOARD.width, cs.TFT_BOARD.height, cs.TFT_BOARD.depth, 1.0)


def add_limb_sockets(shell_part=None):
    """(Documentation) the printable shell drills snap sockets for the limbs:
    two side-wall bores at the shoulders and two floor bores at the hips, sized
    to make_snap_pin so each limb clicks on and pulls off. Wired in make_front_shell."""
    return None


def make_rear_lid():
    """Domed rear cover. The outer face bulges out into a shallow dome (rise
    REAR_BULGE at center, flush at the rim) so tall internals fit; the underside
    is hollowed to a ~LID_PLATE_T shell, gaining that depth inside. A solid
    SEAT_BAND perimeter carries the light-tight lip and the snap detents.
    """
    lip_w = BODY_W - 2 * WALL - 0.4
    lip_h = BODY_H - 2 * WALL - 0.4
    lip_wall = 1.6
    bulge = REAR_BULGE
    # Sphere radius that lifts `bulge` at the center over the footprint corners.
    a = ((BODY_W / 2) ** 2 + (BODY_H / 2) ** 2) ** 0.5
    dome_r = (a * a + bulge * bulge) / (2 * bulge)
    with BuildPart() as lid:
        # Tall full-footprint block, then carve the OUTER dome with a big sphere
        # (rises `bulge` at center, flush with the back plane at the rim).
        with BuildSketch():
            RectangleRounded(BODY_W, BODY_H, CORNER_R)
        extrude(amount=LID_PLATE_T + bulge)
        with Locations((0, 0, (LID_PLATE_T + bulge) - dome_r)):
            Sphere(dome_r, mode=Mode.INTERSECT)
        # Hollow only the INTERIOR (inset by SEAT_BAND) under a parallel inner
        # dome, leaving a solid rim ring for the lip + detents.
        with BuildPart(mode=Mode.PRIVATE) as cavity:
            with BuildSketch():
                RectangleRounded(BODY_W - 2 * SEAT_BAND, BODY_H - 2 * SEAT_BAND,
                                  max(CORNER_R - SEAT_BAND, 2.0))
            extrude(amount=LID_PLATE_T + bulge + 2.0)
            with Locations((0, 0, bulge - dome_r)):
                Sphere(dome_r, mode=Mode.INTERSECT)
        add(cavity.part, mode=Mode.SUBTRACT)
        # Sealing lip extruded the OTHER way (-Z) so it slides into the body.
        with BuildSketch():
            RectangleRounded(lip_w, lip_h, max(CORNER_R - WALL, 2.0))
        extrude(amount=-LIP_DEPTH)
        # Hollow the lip into a thin wall (don't touch the base plate).
        with Locations((0, 0, -LIP_DEPTH)):
            Box(lip_w - 2 * lip_wall, lip_h - 2 * lip_wall, LIP_DEPTH,
                align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        # (No rear cable exit / lip relief: the compact build is fully self-
        # contained and charges via the FRONT USB-C, so the rear cover stays a
        # solid, continuous, light-tight panel.)
        # Snap DETENT bumps on the lip — click into the front shell's wall
        # sockets so the cover locks shut (press to close, pull firmly to pop
        # off). Recessed so each bump apex stands ~0.45 mm proud of the lip face
        # (~0.25 mm interference past the wall = a real snap, not a jam).
        recess = DETENT_BUMP_R - DETENT_PROTRUDE
        for sx in (-(lip_w / 2 - recess), lip_w / 2 - recess):
            for sy in (-SIDE_DETENT_Y, SIDE_DETENT_Y):
                with Locations((sx, sy, -4.0)):
                    Sphere(DETENT_BUMP_R)
        for sx in (-TOP_DETENT_X, TOP_DETENT_X):
            for sy in (-(lip_h / 2 - recess), lip_h / 2 - recess):
                with Locations((sx, sy, -4.0)):
                    Sphere(DETENT_BUMP_R)
    return lid.part


def make_compact_assembly():
    return Compound(children=[
        make_front_shell(preview=True),
        make_face_panel().located(Location((0, FACE_Y, -0.4))),
        make_screen_dark().located(Location((0, SCREEN_Y, 0.3))),
        # Lid seats flush: plate top face is flush with the body back (z=FRONT_DEPTH).
        make_rear_lid().located(Location((0, 0, LID_SEAT_Z))),
    ])


def _place(shape, cx: float, cy: float, rot_z: float = 0.0):
    """Rotate flat, center the footprint at (cx, cy), drop to z=0 (plate layout)."""
    from build123d import Axis
    s = shape.rotate(Axis.Z, rot_z) if rot_z else shape
    bb = s.bounding_box()
    return s.translate((cx - (bb.min.X + bb.max.X) / 2, cy - (bb.min.Y + bb.max.Y) / 2, -bb.min.Z))


def _shelf_pack(specs, plate: float = 248.0, gap: float = 9.0, y_top: float = 122.0):
    """Lay parts flat on an A1 plate with ZERO overlap (shelf/row packing).

    specs: list of (name, shape). Each part keeps its native X-Y footprint (so
    the viewer, which loads the raw per-part GLBs, lines up with this layout).
    Parts are sorted tallest-first, packed left->right, wrapping to a new row
    when the plate width is exceeded, marching downward from y_top. A constant
    `gap` between every footprint guarantees no two parts touch.

    Returns: list of (name, placed_shape, (cx, cy, w, h)).
    """
    laid = []
    for name, shp in specs:
        bb = shp.bounding_box()
        flat = shp.translate((0, 0, -bb.min.Z))   # rest on the bed (min z = 0)
        laid.append((name, flat, bb.size.X, bb.size.Y))
    laid.sort(key=lambda t: t[3], reverse=True)    # tallest first => tight rows

    out = []
    x_cursor = -plate / 2
    y_cursor = y_top
    row_h = 0.0
    for name, flat, w, h in laid:
        if x_cursor + w > plate / 2 and row_h > 0.0:   # wrap to next row
            x_cursor = -plate / 2
            y_cursor -= row_h + gap
            row_h = 0.0
        cx = x_cursor + w / 2
        cy = y_cursor - h / 2
        bb = flat.bounding_box()
        placed = flat.translate((cx - (bb.min.X + bb.max.X) / 2,
                                 cy - (bb.min.Y + bb.max.Y) / 2, 0))
        out.append((name, placed, (round(cx, 1), round(cy, 1), round(w, 1), round(h, 1))))
        x_cursor += w + gap
        row_h = max(row_h, h)

    # Center the whole layout on the plate (X-Y), so the kit imports centered on
    # the bed instead of sitting off to one side/top.
    xs0 = min(cx - w / 2 for _, _, (cx, cy, w, h) in out)
    xs1 = max(cx + w / 2 for _, _, (cx, cy, w, h) in out)
    ys0 = min(cy - h / 2 for _, _, (cx, cy, w, h) in out)
    ys1 = max(cy + h / 2 for _, _, (cx, cy, w, h) in out)
    dx, dy = -(xs0 + xs1) / 2, -(ys0 + ys1) / 2
    centered = []
    for name, placed, (cx, cy, w, h) in out:
        centered.append((name, placed.translate((dx, dy, 0)),
                         (round(cx + dx, 1), round(cy + dy, 1), round(w, 1), round(h, 1))))
    return centered


def _pack_overlap_report(packed, gap: float = 9.0):
    """Assert no two packed footprints overlap (slack = gap/3)."""
    msgs = []
    slack = gap / 3.0
    boxes = [(n, cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2) for n, _, (cx, cy, w, h) in packed]
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            ni, ax0, ax1, ay0, ay1 = boxes[i]
            nj, bx0, bx1, by0, by1 = boxes[j]
            if ax0 < bx1 - slack and bx0 < ax1 - slack and ay0 < by1 - slack and by0 < ay1 - slack:
                msgs.append(f"  OVERLAP: {ni} <-> {nj}")
    return msgs


def compact_print_kit_parts():
    """Every printable part of the compact BMO, shelf-packed on the A1 plate."""
    import bmo_rack
    specs = [
        ("front_shell", make_front_shell()),
        ("rear_lid", make_rear_lid()),
        ("rack", bmo_rack.make_rack().rotate(Axis.X, 180)),
        ("face_panel", make_face_panel()),
        ("bezel", make_bezel_ring()),
        ("left_arm", make_arm("left")),
        ("right_arm", make_arm("right")),
        ("left_leg", make_leg("left")),
        ("right_leg", make_leg("right")),
        ("speaker_strap", bmo_rack.make_holddown_strap("speaker")),
        ("battery_strap", bmo_rack.make_holddown_strap("battery")),
        ("breadboard_strap", bmo_rack.make_holddown_strap("breadboard_esp32")),
        ("side_text", make_side_text()),
        ("dpad", make_dpad_cap()),
        ("triangle", make_triangle_cap()),
        ("red", make_red_button()),
        ("green", make_green_button()),
        ("power_dot", make_power_dot()),
        ("pill_left", make_pill_cap()),
        ("pill_right", make_pill_cap()),
    ]
    return [(n, s) for n, s, _ in _shelf_pack(specs)]


def make_compact_print_kit():
    return Compound(children=[shape for _, shape in compact_print_kit_parts()])


def outside_print_kit_parts():
    """OUTSIDE kit (print #2): the visible body + cosmetics + limbs."""
    specs = [
        ("front_shell", make_front_shell()),
        ("face_panel", make_face_panel()),
        ("bezel", make_bezel_ring()),
        ("left_arm", make_arm("left")),
        ("right_arm", make_arm("right")),
        ("left_leg", make_leg("left")),
        ("right_leg", make_leg("right")),
        ("side_text", make_side_text()),
        ("dpad", make_dpad_cap()),
        ("triangle", make_triangle_cap()),
        ("red", make_red_button()),
        ("green", make_green_button()),
        ("power_dot", make_power_dot()),
        ("pill_left", make_pill_cap()),
        ("pill_right", make_pill_cap()),
        # Rear cover prints DOME-UP (lip down): the visible outer dome is a clean
        # gentle top surface; the shallow interior overhang takes support inside
        # where it's hidden. (Old flat-back-down flip would put the convex dome
        # on the bed = tiny contact.)
        ("rear_lid", make_rear_lid()),
    ]
    return [(n, s) for n, s, _ in _shelf_pack(specs)]


def inside_print_kit_parts():
    """INSIDE kit (print #1): the structural rack + hold-down straps."""
    import bmo_rack
    specs = [
        # Rack flipped so its big flat back-plate prints on the bed (~7400 mm2
        # contact) and the cradle pockets open upward (no internal supports).
        ("rack", bmo_rack.make_rack().rotate(Axis.X, 180)),
        ("speaker_strap", bmo_rack.make_holddown_strap("speaker")),
        ("battery_strap", bmo_rack.make_holddown_strap("battery")),
        ("breadboard_strap", bmo_rack.make_holddown_strap("breadboard_esp32")),
    ]
    return [(n, s) for n, s, _ in _shelf_pack(specs)]


def make_outside_print_kit():
    return Compound(children=[shape for _, shape in outside_print_kit_parts()])


def make_inside_print_kit():
    return Compound(children=[shape for _, shape in inside_print_kit_parts()])


def exports():
    return {
        "bmo_compact_front_shell": make_front_shell(),
        "bmo_compact_front_shell_top": make_front_shell_half("top"),
        "bmo_compact_front_shell_bottom": make_front_shell_half("bottom"),
        "bmo_compact_front_shell_preview": make_front_shell(preview=True),
        "bmo_compact_face_panel": make_face_panel(),
        "bmo_compact_tft_ghost": make_tft_ghost(),
        "bmo_compact_bezel": make_bezel_ring(),
        "bmo_compact_screen_dark": make_screen_dark(),
        "bmo_compact_side_text": make_side_text(),
        "bmo_compact_rear_lid": make_rear_lid(),
        "bmo_compact_controls_runner": make_controls_runner(),
        "bmo_compact_left_arm": make_arm("left"),
        "bmo_compact_right_arm": make_arm("right"),
        "bmo_compact_left_leg": make_leg("left"),
        "bmo_compact_right_leg": make_leg("right"),
        "bmo_compact_dpad": make_dpad_cap(),
        "bmo_compact_triangle": make_triangle_cap(),
        "bmo_compact_red": make_red_button(),
        "bmo_compact_green": make_green_button(),
        "bmo_compact_power_dot": make_power_dot(),
        "bmo_compact_pill": make_pill_cap(),
        "bmo_compact_print_kit": make_compact_print_kit(),
        "bmo_compact_outside_kit": make_outside_print_kit(),
        "bmo_compact_inside_kit": make_inside_print_kit(),
        "bmo_compact_assembly": make_compact_assembly(),
    }


def main():
    skip_3mf = {"bmo_compact_assembly", "bmo_compact_front_shell_preview"}
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name not in skip_3mf)
        bb = shape.bounding_box()
        print(f"{name}: bbox=({bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f})")

    # Per-part kit GLBs, PRE-PLACED on the plate (laid flat at min z=0, packed
    # with zero overlap). The viewer loads these at the origin so what you see is
    # exactly the print plate — no viewer-side positioning, no float, no overlap.
    # Also write a CENTERED, single-part print file (bmo_compact_print_<name>.3mf/.stl)
    # for each so you can print ONE part at a time and see results fast.
    for prefix, parts in (("bmo_okit", outside_print_kit_parts()),
                          ("bmo_ikit", inside_print_kit_parts())):
        for name, placed in parts:
            bmo_body.export_shape(f"{prefix}_{name}", placed, make_3mf=False)
            b = placed.bounding_box()
            centered = placed.translate((-(b.min.X + b.max.X) / 2,
                                         -(b.min.Y + b.max.Y) / 2, 0))
            bmo_body.export_shape(f"bmo_compact_print_{name}", centered, make_3mf=True)

    print(f"\ncompact body {BODY_W:.0f} x {BODY_H:.0f} mm (ratio {BODY_W/BODY_H:.2f}); "
          f"screen face {FACE_W:.0f}x{FACE_H:.0f}, lit LCD ~{cs.TFT_ACTIVE.width/BODY_W*100:.0f}% of face")
    # Layout sanity: report any packing overlaps (should be none).
    for label, parts in (("OUTSIDE", outside_print_kit_parts()), ("INSIDE", inside_print_kit_parts())):
        packed = _shelf_pack([(n, s) for n, s in parts])  # re-pack reports coords
        msgs = _pack_overlap_report(packed)
        print(f"{label} kit overlaps: {len(msgs)}")
        for mm in msgs:
            print(mm)


if __name__ == "__main__":
    main()
