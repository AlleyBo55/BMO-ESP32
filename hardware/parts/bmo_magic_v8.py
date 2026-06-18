"""BMO Animatronic V8.0 — show-accurate 4-servo companion, honestly engineered.

V8 evolves the V7.1 clean 4-servo layout toward the Adventure Time reference and
the 4-servo poster the user supplied, with one rule: every motion claim has to
survive real physics on the user's actual hardware (4x SG90 9g, Bambu A1, PLA).

What changed from V7.1
----------------------
- SG90-exact servo pockets (the user owns SG90 9g, not MG90S), with M2 tab bores.
- Slim cylindrical limbs with small round hands and small round feet, matching
  the reference art (the v7 limbs were too thick and the boots oversized).
- A low ballast pod (battery + any spare mass) dropped to the very bottom of the
  torso so the center of mass sits as low as possible. With small show-accurate
  feet, the LOW CoM (not big soles) is what keeps a top-heavy 148 mm body from
  tipping.
- Parametric limb POSES (shoulder + hip swing about the body's X axis) so the
  assembly can render a stand / wave / walk / dance frame from one phase value.
- Shoulder + hip output collars and printable horn adapters carried over.

HONEST capability matrix (4x SG90 9g, body as drawn)
----------------------------------------------------
  stand still ................ YES (low ballast pod keeps the CoM in the feet)
  wave / move hands .......... YES (1 shoulder servo per arm, ~180 deg)
  dance in place ............. YES (choreographed open-loop arm+hip sequences)
  turn in place .............. YES (alternating hip swing + foot stick-slip)
  slow waddle "walk" ......... MAYBE (grippy rubber soles, low CoM, slow steps;
                                it shuffles, it does not stride)
  smooth free walking ........ NO  (needs knees+ankles = 6+ DOF + balance ctrl)
  jump / hop ................. NO  (needs stored spring energy + latch/release,
                                or far higher-power actuators; SG90 cannot)

Upgrade paths (documented, not faked in this file)
--------------------------------------------------
  + 2 servos (ankles) -> static-stable real steps.
  + 6 servos + IMU ... -> dynamic walking with a balance controller.
  + spring-hop module  -> a real hop: wind a torsion spring with a servo, latch,
                          release. That is a separate mechanism, not these 4 servos.

Coordinate convention matches bmo_body:
  X = width, Y = height (up +), Z = depth (face/front at Z=0, internals behind).
The limb local origin sits exactly on its pivot so a single Location with an
X-rotation both swings and places the limb.
"""

from __future__ import annotations

from math import sin, radians

from build123d import (
    Align,
    Axis,
    Box,
    BuildPart,
    Compound,
    Cylinder,
    Location,
    Locations,
    Mode,
    Sphere,
    add,
)

import bmo_body
import bmo_mecha_v2


A1_PLATE = 256.0

# ---------- SG90 9g micro servo (the user's actual hardware) ----------
# Measured-typical SG90 envelope. Body ~22.7 x 11.8 x 22.5 mm; the mounting
# flange spans ~32.2 mm with two M2 tab holes; output shaft is offset ~5.8 mm
# from the body center along the long axis.
SG90_BODY_W = 22.9
SG90_BODY_H = 12.2
SG90_BODY_D = 23.0
SG90_TAB_SPAN = 32.2
SG90_TAB_HOLE_R = 1.1          # M2 self-tapper clearance for the servo screws
SG90_POCKET_W = SG90_BODY_W + 1.4
SG90_POCKET_H = SG90_BODY_H + 1.2
SG90_POCKET_D = SG90_BODY_D + 1.2

# ---------- Servo placement (4 servos: 2 shoulders, 2 hips) ----------
SHOULDER_X = 45.5
SHOULDER_Y = -16.0
SHOULDER_PIVOT_Y = SHOULDER_Y - 8.5
HIP_X = 24.0
HIP_Y = -70.0
HIP_PIVOT_Y = -82.0

SHOULDER_PIVOT_Z = bmo_body.FRONT_DEPTH * 0.48
HIP_PIVOT_Z = bmo_body.FRONT_DEPTH * 0.47

# ---------- Articulation / joint map (4-servo DOF) ----------
# Adapted from a full humanoid joint diagram, honestly reduced to BMO's FOUR
# servos. A humanoid like the reference has ~30 actuated joints; BMO has 4.
# BMO's 4 active DOF are all PITCH joints (limbs swing fore/aft about the body
# X axis). EVERYTHING else a humanoid actuates -- head pitch/yaw, elbow, wrist,
# waist roll/pitch/yaw, knee, ankle pitch/roll -- is FIXED/rigid on BMO: there
# is no servo there, by design (4 servos only).
#   pos:        joint center in body coords (mm)
#   axis:       rotation axis (all "X" = pitch on BMO)
#   range_deg:  usable servo sweep (SG90 ~180 deg mechanical; we use less)
#   servo:      which of the 4 channels drives it
_BW2 = bmo_body.BODY_W / 2
JOINT_MAP = {
    "shoulder_L": {"pos": (-_BW2, SHOULDER_PIVOT_Y, SHOULDER_PIVOT_Z), "axis": "X",
                   "range_deg": 160, "servo": "S1", "active": True, "label": "Left Shoulder Pitch"},
    "shoulder_R": {"pos": (_BW2, SHOULDER_PIVOT_Y, SHOULDER_PIVOT_Z), "axis": "X",
                   "range_deg": 160, "servo": "S2", "active": True, "label": "Right Shoulder Pitch"},
    "hip_L": {"pos": (-HIP_X, HIP_PIVOT_Y, HIP_PIVOT_Z), "axis": "X",
              "range_deg": 90, "servo": "S3", "active": True, "label": "Left Hip Pitch"},
    "hip_R": {"pos": (HIP_X, HIP_PIVOT_Y, HIP_PIVOT_Z), "axis": "X",
              "range_deg": 90, "servo": "S4", "active": True, "label": "Right Hip Pitch"},
}
# Joints a full humanoid actuates but BMO does NOT (rigid/cosmetic on BMO).
FIXED_JOINTS = (
    "Head pitch/yaw (face is fixed)",
    "Elbow / wrist (arm is one rigid piece)",
    "Waist roll/pitch/yaw (torso is one shell)",
    "Knee (leg is one rigid piece)",
    "Ankle pitch/roll (foot fixed to leg)",
)

# ---------- Stance / show-accurate limbs ----------
# The reference art uses SLIM cylindrical limbs with small round hands and
# small round feet. We match that look. Trade-off: small feet are less stable
# than big boots, so the LOW BALLAST POD does the stability work instead of
# oversized soles (see make_ballast_pod). Stick a small rubber dot under each
# foot for grip when it shuffles/turns.
ARM_R = 3.2            # slim arm tube radius
HAND_R = 5.0           # small round hand
LEG_R = 3.9            # slim leg tube radius
FOOT_W = 18.0          # X: foot width (small, round)
FOOT_THK = 9.0         # Y: foot vertical thickness (flat-ish pad)
# FOOT_L was 24 mm -> stability analysis showed only 0.7 mm fore/aft margin
# (0.4 deg tip angle), i.e. it topples backward. The computed CoM sits at
# Z~=39, so the foot must be longer fore/aft AND shifted back to sit under it.
FOOT_L = 40.0          # Z: foot toe length (front-back), sized from CoM analysis
FOOT_Z_OFFSET = 9.0    # foot center pushed back (+Z) to sit under the CoM
FOOT_R = 4.0           # foot corner rounding
TRACK_HALF = HIP_X     # leg lateral spacing; feet sit under the hips

# Low ballast pod: battery + spare mass, dropped as low as the torso allows.
BALLAST_W = 60.0
BALLAST_H = 22.0
BALLAST_D = 18.0


def make_servo_ghost(label: str):
    """Reuse the V2 servo envelope for fit visualization."""
    return bmo_mecha_v2.make_servo_body(label)


def make_servo_frame():
    """One-piece internal cradle for four SG90 servos + a low ballast shelf.

    Bed face: the flat -Z underside of the base plate prints on the plate.
    """
    with BuildPart() as frame:
        # Base plate spanning the lower torso, kept thin to save mass.
        with Locations((0, -45.0, 5.5)):
            add(bmo_body.rounded_box(96.0, 84.0, 6.0, 2.0))
        with Locations((0, -45.0, 6.0)):
            Box(74.0, 58.0, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        servo_sites = [
            (-SHOULDER_X, SHOULDER_Y, "S1 arm L"),
            (SHOULDER_X, SHOULDER_Y, "S2 arm R"),
            (-HIP_X, HIP_Y, "S3 hip L"),
            (HIP_X, HIP_Y, "S4 hip R"),
        ]
        for x, y, _ in servo_sites:
            # Cradle walls around each servo.
            with Locations((x, y, 8.0)):
                add(bmo_body.rounded_box(SG90_POCKET_W + 8.0, SG90_POCKET_H + 6.0, 12.0, 1.8))
            # Servo body pocket.
            with Locations((x, y, 8.0)):
                Box(SG90_POCKET_W, SG90_POCKET_H, 13.0,
                    align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            # M2 tab screw bores (servo mounting flange).
            for sx in (-SG90_TAB_SPAN / 2, SG90_TAB_SPAN / 2):
                with Locations((x + sx, y, 4.2)):
                    Cylinder(SG90_TAB_HOLE_R, 6.0,
                             align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Shoulder bearing towers (outboard pivot for each arm).
        for x in (-SHOULDER_X, SHOULDER_X):
            with Locations((x, SHOULDER_PIVOT_Y, 17.5)):
                Cylinder(6.4, 13.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, SHOULDER_PIVOT_Y, 17.5)):
                Cylinder(2.0, 14.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Hip bearing towers.
        for x in (-HIP_X, HIP_X):
            with Locations((x, HIP_PIVOT_Y + 12.0, 16.0)):
                Cylinder(6.0, 13.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, HIP_PIVOT_Y + 12.0, 16.0)):
                Cylinder(2.0, 14.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Low ballast shelf: keep the heavy battery as low as the torso allows.
        with Locations((0, -58.0, 6.5)):
            add(bmo_body.rounded_box(BALLAST_W + 6.0, BALLAST_H + 6.0, 9.0, 2.0))
        with Locations((0, -58.0, 7.0)):
            Box(BALLAST_W, BALLAST_H, 10.0,
                align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Cable comb above the servos.
        for x in (-34.0, -17.0, 0.0, 17.0, 34.0):
            with Locations((x, 24.0, 8.0)):
                add(bmo_body.rounded_box(3.0, 16.0, 7.0, 1.2))

        # Mounting pegs to fix the frame to the rear tray.
        for x in (-44.0, 44.0):
            for y in (-82.0, 30.0):
                with Locations((x, y, 4.0)):
                    Cylinder(2.8, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
                with Locations((x, y, 4.0)):
                    Cylinder(1.15, 6.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return frame.part


def make_ballast_pod():
    """Printable battery/ballast box that drops the center of mass to the floor.

    Print this, load it with the LiPo (and washers/coins if you need more mass),
    and seat it on the frame's low ballast shelf. Bed face: -Z underside.
    """
    with BuildPart() as pod:
        with Locations((0, 0, BALLAST_D / 2)):
            add(bmo_body.rounded_box(BALLAST_W, BALLAST_H, BALLAST_D, 3.0))
        with Locations((0, 0, BALLAST_D / 2 + 1.0)):
            Box(BALLAST_W - 4.0, BALLAST_H - 4.0, BALLAST_D,
                align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Lead-out notch for the battery JST cable.
        with Locations((0, BALLAST_H / 2, BALLAST_D - 4.0)):
            Box(8.0, 6.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return pod.part


def make_output_collars():
    """Round collars that hide the servo horns and receive the limbs."""
    children = []
    for x in (-bmo_body.BODY_W / 2 - 1.8, bmo_body.BODY_W / 2 + 1.8):
        children.append(
            Cylinder(8.0, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            .located(Location((x, SHOULDER_PIVOT_Y, SHOULDER_PIVOT_Z), (0, 90, 0)))
        )
    for x in (-HIP_X, HIP_X):
        children.append(
            Cylinder(6.4, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            .located(Location((x, HIP_PIVOT_Y, HIP_PIVOT_Z), (90, 0, 0)))
        )
    return Compound(children=children)


def make_servo_horn_adapter():
    """Bridges the SG90 spline horn to a printed limb root (M2 + spline bores)."""
    with BuildPart() as adapter:
        Cylinder(6.6, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        Box(20.0, 4.0, 3.6, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        Cylinder(2.05, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for x in (-6.0, 6.0):
            with Locations((x, 0, 0)):
                Cylinder(0.95, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return adapter.part


def make_arm(side: str):
    """Slim one-servo BMO arm with a small round hand. Local origin = shoulder
    pivot, so a single X-rotation Location both swings and places the arm.

    Matches the reference: a slim cylinder hanging down and slightly outward,
    ending in a smooth round ball hand (no fingers). Bed face: lay flat on side.
    """
    outward = -1 if side == "left" else 1
    inward = -outward
    with BuildPart() as arm:
        # Snap axle into the body side wall (pivot at local origin).
        with Locations(Location((inward * 2.0, 0.0, 0.0), (0, inward * 90, 0))):
            add(bmo_body.make_snap_pin(
                bmo_body.WALL,
                pin_r=3.0,
                barb=0.65,
                collar_r=6.5,
                slot_w=1.0,
            ))
        with Locations(Location((outward * 1.0, 0.0, 0.0), (0, 90, 0))):
            Cylinder(6.5, 3.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # Slim cylindrical arm: down and slightly out, like the poster.
        bmo_body.tube_along(
            [
                (outward * 2.0, -2.0, 0.0),
                (outward * 4.0, -16.0, 0.0),
                (outward * 4.5, -30.0, 0.0),
                (outward * 4.0, -40.0, 0.0),
            ],
            ARM_R,
        )
        # Small round ball hand (no finger nubs — matches the reference).
        with Locations((outward * 4.0, -44.0, 0.0)):
            Sphere(HAND_R)
    return arm.part


def make_foot(side: str):
    """Small round BMO foot: a flat-ish rounded pad, toe pointing forward.

    Bed face: the flat -Y/underside prints on the plate. Stick a rubber dot on
    the bottom for grip. Toe length runs along Z (toward the face).
    """
    with BuildPart() as foot:
        add(bmo_body.rounded_box(FOOT_W, FOOT_THK, FOOT_L, FOOT_R))
        # Shallow ankle socket on top to receive the leg tube end.
        with Locations((0, FOOT_THK / 2 - 2.0, 0.0)):
            Cylinder(LEG_R + 0.3, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER),
                     mode=Mode.SUBTRACT)
    return foot.part


def make_leg(side: str):
    """Slim hip-driven leg ending in a small round BMO foot.

    Local origin = hip pivot, so a single X-rotation Location swings + places it.
    Bed face: lay the leg on its side. Matches the reference slim-cylinder look.
    """
    outward = -1 if side == "left" else 1
    with BuildPart() as leg:
        # Hip pivot bearing at local origin.
        with Locations(Location((0, 0.0, 0.0), (90, 0, 0))):
            Cylinder(6.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Slim cylindrical shin down to the ankle.
        bmo_body.tube_along(
            [
                (0.0, -2.0, 0.0),
                (outward * 0.6, -16.0, 0.0),
                (outward * 1.0, -30.0, 0.0),
                (outward * 1.2, -40.0, 0.0),
            ],
            LEG_R,
        )
        # Foot sized/placed from the CoM stability analysis (longer fore/aft,
        # pushed back so the support polygon sits under the center of mass).
        with Locations((outward * 1.2, -44.0, FOOT_Z_OFFSET)):
            add(bmo_body.rounded_box(FOOT_W, FOOT_THK, FOOT_L, FOOT_R))
    return leg.part


# ---------- Clockwork walking engine (the "magic doll" automaton drive) ----------
# How old wind-up tin walkers actually move, applied honestly to BMO:
#   1 drive servo  ->  reduction gear train (cog torque multiplication)
#                  ->  flywheel + twin crank disks on a cross-shaft
#                      (legs forced 180 deg out of phase, like a steam walker)
#                  ->  link rods swing each leg fore/aft.
#   ROCKER feet (rounded "log" soles) let the body rock side-to-side, so the
#   swinging leg lifts clear instead of scuffing -- that lateral rock is the
#   ingredient a plain hip-only walker is missing, and it's why this advances
#   instead of tipping. The gear train also multiplies the weak SG90 torque so
#   it can actually shove the body's mass through each step.
#   The two arm servos stay for expressive motion; the low ballast keeps the CoM
#   down so each rock returns to center instead of toppling.
# This reuses the validated bmo_mecha_v2 walking engine. It is a fit/printability
# layout, NOT a gait sim -- print the test coupon (engine + one rocker leg) and
# tune crank throw + rocker radius before a full body print.

ROCKER_FOOT_R = 8.5       # rounded rocker sole radius (reads round, rolls L-R)
ROCKER_FOOT_L = 22.0      # toe length along Z
ENGINE_Z = bmo_body.FRONT_DEPTH + 1.0


def make_rocker_foot(side: str):
    """Rounded 'log' foot that rolls side-to-side (lateral rocker).

    A cylinder lying along Z reads as a round BMO foot from the front, but its
    curved underside lets the body rock so the opposite foot can lift and swing.
    The top is flattened to seat the leg. Bed face: print toe-up with a brim, or
    on the flat top face.
    """
    with BuildPart() as foot:
        # Round log body (axis along Z = toe direction); round from the front.
        Cylinder(ROCKER_FOOT_R, ROCKER_FOOT_L, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        # Flatten the top third so the leg seats and it doesn't read as a full log.
        with Locations((0, ROCKER_FOOT_R * 0.75, 0)):
            Box(2 * ROCKER_FOOT_R + 2, ROCKER_FOOT_R, ROCKER_FOOT_L + 2,
                align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Ankle socket bored down from the flat top (axis along Y).
        with Locations(Location((0, ROCKER_FOOT_R * 0.2, 0), (90, 0, 0))):
            Cylinder(LEG_R + 0.3, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER),
                     mode=Mode.SUBTRACT)
    return foot.part


def make_leg_rocker(side: str):
    """Slim hip-driven leg ending in a rounded ROCKER foot for the automaton.

    Local origin = hip pivot. Same slim look as make_leg, but the foot rolls
    side-to-side so the cam/crank gait can lift and swing it.
    """
    outward = -1 if side == "left" else 1
    with BuildPart() as leg:
        with Locations(Location((0, 0.0, 0.0), (90, 0, 0))):
            Cylinder(6.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        bmo_body.tube_along(
            [
                (0.0, -2.0, 0.0),
                (outward * 0.6, -16.0, 0.0),
                (outward * 1.0, -30.0, 0.0),
                (outward * 1.2, -40.0, 0.0),
            ],
            LEG_R,
        )
        # Rounded rocker foot at the bottom.
        with Locations((outward * 1.2, -44.0 - ROCKER_FOOT_R * 0.2, 0.0)):
            add(make_rocker_foot(side))
    return leg.part


def make_walk_engine():
    """Cog/crank walking engine: reuses the validated bmo_mecha_v2 mechanism.

    Drive servo -> reduction pinion + flywheel -> twin opposed crank disks tied
    by a cross-shaft -> link rods to the hips. This is the clockwork that forces
    the legs 180 deg out of phase. Mounted low in the torso behind the body.
    """
    return bmo_mecha_v2.make_walk_engine()


def make_v8_automaton_assembly():
    """Full automaton preview: show-accurate BMO body + clockwork walking engine
    + rocker-foot legs + servo arms + low ballast pod.
    """
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            bmo_body.make_controls().located(Location((0, 0, -2.45))),
            bmo_body.make_side_bmo_text().located(
                Location((bmo_body.BODY_W / 2 + 0.8, -4.0, bmo_body.FRONT_DEPTH * 0.64), (0, 90, 0))
            ),
            make_servo_frame().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_walk_engine().located(Location((0, 0, ENGINE_Z))),
            make_ballast_pod().located(Location((0, -58.0, bmo_body.FRONT_DEPTH + 8.0))),
            make_output_collars(),
            make_arm("left").located(_arm_location("left", 18.0)),
            make_arm("right").located(_arm_location("right", -18.0)),
            make_leg_rocker("left").located(_leg_location("left", 10.0)),
            make_leg_rocker("right").located(_leg_location("right", -10.0)),
        ]
    )


# ---------- Pose system (preview only) ----------
# A single phase 0..1 maps to shoulder + hip swing angles about the body X axis.
# These angles are illustrative poses for the rendered assembly, NOT a tuned
# gait. Real motion comes from the firmware servo choreography.

def _swing(phase: float, amp_deg: float, lead: float = 0.0) -> float:
    return amp_deg * sin(radians(360.0 * phase + lead))


def gait_pose(phase: float, mode: str = "stand"):
    """Return (armL, armR, hipL, hipR) swing angles in degrees for a phase."""
    if mode == "stand":
        return (0.0, 0.0, 0.0, 0.0)
    if mode == "wave":
        return (_swing(phase, 35.0, 90.0) + 40.0, 0.0, 0.0, 0.0)
    if mode == "dance":
        a = _swing(phase, 45.0)
        return (a + 25.0, -a + 25.0, _swing(phase, 12.0, 90.0), _swing(phase, 12.0, -90.0))
    if mode == "walk":
        # Arms counter-swing to the legs; small hip swing (a shuffle, not a stride).
        return (_swing(phase, 18.0, 180.0), _swing(phase, 18.0, 0.0),
                _swing(phase, 14.0, 0.0), _swing(phase, 14.0, 180.0))
    return (0.0, 0.0, 0.0, 0.0)


def _arm_location(side: str, swing_deg: float) -> Location:
    x = -bmo_body.BODY_W / 2 - 8.0 if side == "left" else bmo_body.BODY_W / 2 + 8.0
    return Location((x, SHOULDER_PIVOT_Y, SHOULDER_PIVOT_Z), (swing_deg, 0, 0))


def _leg_location(side: str, swing_deg: float) -> Location:
    x = -HIP_X if side == "left" else HIP_X
    return Location((x, HIP_PIVOT_Y, HIP_PIVOT_Z), (swing_deg, 0, 0))


def make_servo_fit_ghosts():
    children = []
    for x, y, label in (
        (-SHOULDER_X, SHOULDER_Y, "S1 ARM L"),
        (SHOULDER_X, SHOULDER_Y, "S2 ARM R"),
        (-HIP_X, HIP_Y, "S3 HIP L"),
        (HIP_X, HIP_Y, "S4 HIP R"),
    ):
        children.append(make_servo_ghost(label).located(Location((x, y, 8.0), (0, 0, 90))))
    return Compound(children=children)


def make_v8_assembly(mode: str = "stand", phase: float = 0.0):
    """Full posed preview. mode in {stand, wave, dance, walk}."""
    armL, armR, hipL, hipR = gait_pose(phase, mode)
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            bmo_body.make_controls().located(Location((0, 0, -2.45))),
            bmo_body.make_side_bmo_text().located(
                Location((bmo_body.BODY_W / 2 + 0.8, -4.0, bmo_body.FRONT_DEPTH * 0.64), (0, 90, 0))
            ),
            make_servo_frame().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_servo_fit_ghosts().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_ballast_pod().located(Location((0, -58.0, bmo_body.FRONT_DEPTH + 8.0))),
            make_output_collars(),
            make_arm("left").located(_arm_location("left", armL)),
            make_arm("right").located(_arm_location("right", armR)),
            make_leg("left").located(_leg_location("left", hipL)),
            make_leg("right").located(_leg_location("right", hipR)),
        ]
    )


def _place(shape, cx: float, cy: float, rot_z: float = 0.0):
    """Rotate a part flat on the plate, then center its footprint at (cx, cy)
    and drop its lowest point to z=0. Deterministic, no double-offset surprises.
    """
    s = shape.rotate(Axis.Z, rot_z) if rot_z else shape
    bb = s.bounding_box()
    dx = cx - (bb.min.X + bb.max.X) / 2
    dy = cy - (bb.min.Y + bb.max.Y) / 2
    dz = -bb.min.Z
    return s.translate((dx, dy, dz))


def print_kit_parts():
    """Build-plate layout for the printable kit (Bambu A1, 256 x 256 mm).

    Two wide parts (servo frame, output collars) own the left column; the slim
    limbs, ballast pod and horn adapters stack down the right column. Centers
    chosen so the whole kit stays inside ~+/-118 mm with brim margin.
    """
    return [
        ("servo_frame", _place(make_servo_frame(), -52.0, 52.0)),
        ("output_collars", _place(make_output_collars(), -52.0, -84.0)),
        ("left_leg", _place(make_leg("left"), 60.0, 95.0, rot_z=90.0)),
        ("right_leg", _place(make_leg("right"), 60.0, 60.0, rot_z=-90.0)),
        ("left_arm", _place(make_arm("left"), 62.0, 22.0, rot_z=74.0)),
        ("right_arm", _place(make_arm("right"), 62.0, -22.0, rot_z=-74.0)),
        ("horn_adapters", _place(Compound(children=[
            make_servo_horn_adapter().located(Location((-27.0 + i * 18.0, 0.0, 0.0)))
            for i in range(4)
        ]), 60.0, -55.0)),
        ("ballast_pod", _place(make_ballast_pod(), 60.0, -100.0)),
    ]


def make_print_kit():
    return Compound(children=[shape for _, shape in print_kit_parts()])


def plate_part_exports():
    """Individual GLBs in the same transforms used by the audited A1 kit.

    Keeping these separate makes every printable object selectable in the
    viewer without approximating its plate placement in JavaScript.
    """
    horn_centers = (33.0, 51.0, 69.0, 87.0)
    return {
        "bmo_v8_plate_servo_frame": _place(make_servo_frame(), -52.0, 52.0),
        "bmo_v8_plate_output_collars": _place(make_output_collars(), -52.0, -84.0),
        "bmo_v8_plate_left_leg": _place(make_leg("left"), 60.0, 95.0, rot_z=90.0),
        "bmo_v8_plate_right_leg": _place(make_leg("right"), 60.0, 60.0, rot_z=-90.0),
        "bmo_v8_plate_left_arm": _place(make_arm("left"), 62.0, 22.0, rot_z=74.0),
        "bmo_v8_plate_right_arm": _place(make_arm("right"), 62.0, -22.0, rot_z=-74.0),
        **{
            f"bmo_v8_plate_horn_adapter_{index}": _place(
                make_servo_horn_adapter(), center_x, -55.0
            )
            for index, center_x in enumerate(horn_centers, start=1)
        },
        "bmo_v8_plate_ballast_pod": _place(make_ballast_pod(), 60.0, -100.0),
    }


def exports():
    return {
        "bmo_v8_servo_frame": make_servo_frame(),
        "bmo_v8_ballast_pod": make_ballast_pod(),
        "bmo_v8_servo_fit_ghosts": make_servo_fit_ghosts(),
        "bmo_v8_output_collars": make_output_collars(),
        "bmo_v8_servo_horn_adapter": make_servo_horn_adapter(),
        "bmo_v8_left_arm": make_arm("left"),
        "bmo_v8_right_arm": make_arm("right"),
        "bmo_v8_left_leg": make_leg("left"),
        "bmo_v8_right_leg": make_leg("right"),
        "bmo_v8_foot": make_foot("left"),
        "bmo_v8_assembly_stand": make_v8_assembly("stand"),
        "bmo_v8_assembly_wave": make_v8_assembly("wave", phase=0.25),
        "bmo_v8_assembly_dance": make_v8_assembly("dance", phase=0.2),
        "bmo_v8_assembly_walk": make_v8_assembly("walk", phase=0.25),
        "bmo_v8_print_kit": make_print_kit(),
        # Clockwork "magic doll" automaton: cog/crank walking engine + rocker feet.
        "bmo_v8_rocker_foot": make_rocker_foot("left"),
        "bmo_v8_left_leg_rocker": make_leg_rocker("left"),
        "bmo_v8_right_leg_rocker": make_leg_rocker("right"),
        "bmo_v8_walk_engine": make_walk_engine(),
        "bmo_v8_automaton_assembly": make_v8_automaton_assembly(),
        **plate_part_exports(),
    }


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def describe_joint_map() -> str:
    """Human-readable 4-servo joint map (the BMO adaptation of the humanoid map)."""
    lines = ["BMO V8 joint map (4 servos = 4 active DOF, all pitch):"]
    for key, j in JOINT_MAP.items():
        x, y, z = j["pos"]
        lines.append(
            f"  {j['servo']}  {j['label']:<22} axis={j['axis']}  +/-{j['range_deg'] // 2} deg  "
            f"@({x:.0f},{y:.0f},{z:.0f})"
        )
    lines.append("Fixed on BMO (no servo):")
    for f in FIXED_JOINTS:
        lines.append(f"  - {f}")
    return "\n".join(lines)


def main():
    skip_3mf = {"bmo_v8_servo_fit_ghosts", "bmo_v8_walk_engine", "bmo_v8_automaton_assembly"}
    for name, shape in exports().items():
        make_3mf = name not in skip_3mf and not name.startswith("bmo_v8_plate_")
        bmo_body.export_shape(name, shape, make_3mf=make_3mf)
        print(describe_shape(name, shape))
    print(f"Generated BMO Animatronic V8 artifacts in {bmo_body.EXPORT_DIR}")
    print()
    print(describe_joint_map())


if __name__ == "__main__":
    main()
