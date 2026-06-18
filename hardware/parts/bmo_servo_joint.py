"""BMO V8 — real bearing-supported servo joint (the part v8 was missing).

The earlier v8 limbs attached to the shell with friction snap pins, which means
the servos could not actually drive them, and any load would have cantilevered
straight onto the SG90's plastic spline. This module fixes that with a proper
actuated joint, the way a real animatronic is built:

    [SG90 body] --horn--> [limb hub] --stub axle--> [623ZZ bearing in wall journal]
        torque only            rigid limb root          carries the radial load

Load path, explicitly:
  * The SG90 HORN transmits TORQUE only (screwed to the inner face of the hub).
  * A 3 mm stub axle on the hub runs through a 623ZZ ball bearing pressed into a
    journal boss on the shell wall. The BEARING carries the limb's weight and
    swing load, so the servo gears never see a cantilever moment. This is the
    single change that makes a printed micro-servo joint survive real use.

Pinned hardware (per the step.parts skill — real parts, not guessed sizes):
  * Bearing: 623ZZ  (step.parts id: bearing_623zz)
      bore 3.0 mm x OD 10.0 mm x width 4.0 mm  (standard 623 dimensions)
      page: https://www.step.parts/parts/bearing_623zz
  * Servo: SG90 9g micro servo (output spline ~4.8 mm, 21T; ships with a
      single-arm horn + M2 self-tapping screws).
  * Screws: M2 self-tappers (servo tabs + horn-to-hub), M3 optional for the
      bearing retainer cap.

All dimensions parametric. FDM tolerances follow the cad-skill defaults:
  * bearing OD seat: slip fit, OD + 0.20 mm, retained by a lip + cap.
  * stub axle in bearing bore: light press, bore - 0.05 mm.
  * snap/press clearances 0.2-0.3 mm.
Coordinate convention: joint axis = +X. Servo inboard (-X), limb outboard (+X),
the shell wall (and bearing) sit between them at X=0.
"""

from __future__ import annotations

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
    add,
)

import bmo_body


# ---------- Pinned hardware dimensions ----------
BEARING_ID = "bearing_623zz"
BEARING_BORE = 3.0
BEARING_OD = 10.0
BEARING_W = 4.0

# SG90 micro servo envelope (measured-typical).
SG90_BODY_W = 22.9      # along the axis-perpendicular long side
SG90_BODY_H = 12.2
SG90_BODY_D = 23.0
SG90_TAB_SPAN = 32.2
SG90_TAB_THK = 2.5
SG90_HORN_THK = 1.6     # single-arm horn thickness
SG90_HORN_SCREW_R = 1.1 # M2 self-tap clearance through the hub into the horn

# ---------- Joint tolerances (FDM, Bambu A1 PLA) ----------
SEAT_SLIP = 0.20        # bearing OD slip fit in the journal
AXLE_PRESS = -0.05      # stub axle into bearing bore (light press)
WALL = bmo_body.WALL    # shell wall thickness the journal grows from

# ---------- Derived ----------
JOURNAL_SEAT_D = BEARING_OD + SEAT_SLIP        # 10.20 bore that holds the bearing
JOURNAL_OUTER_D = BEARING_OD + 6.0             # boss wall around the seat
AXLE_D = BEARING_BORE + AXLE_PRESS             # 2.95 stub axle
RETAIN_LIP = 0.8                               # inner lip the bearing seats against


def make_wall_journal():
    """Boss on the shell wall that seats the 623ZZ and supports the limb.

    Built around X = 0 (the wall plane). The boss grows INWARD (-X) into the
    body; the bearing drops in from outside (+X) against an inner retaining lip.
    Bed face: print the flat outer face (+X) down, or with the boss axis
    vertical and a brim.
    """
    boss_len = BEARING_W + RETAIN_LIP + 1.2
    with BuildPart() as journal:
        # Boss body (a short tube growing inward from the wall).
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(JOURNAL_OUTER_D / 2, boss_len,
                     align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Bearing seat (open to +X / outside), depth = bearing width.
        with Locations(Location((BEARING_W / 2, 0, 0), (0, 90, 0))):
            Cylinder(JOURNAL_SEAT_D / 2, BEARING_W + 0.1,
                     align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Through clearance for the stub axle past the retaining lip.
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(BEARING_BORE / 2 + 0.6, boss_len + 2.0,
                     align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Lead-in chamfer at the outer mouth so the bearing starts square.
        with Locations(Location((boss_len - BEARING_W / 2, 0, 0), (0, 90, 0))):
            Cylinder(JOURNAL_SEAT_D / 2 + 0.6, 0.6,
                     align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return journal.part


def make_limb_hub():
    """Limb root: horn-capture face (torque in) + stub axle (load out).

    Built around X = 0. The inner face (-X) captures the SG90 single-arm horn
    (recess + 2 screw holes); the stub axle (+ side, toward -X through the
    bearing) carries the radial load; the outer face (+X) is where the printed
    limb tube attaches. Bed face: print the outer disc face down.
    """
    hub_d = 16.0
    hub_thk = 4.5
    axle_len = BEARING_W + RETAIN_LIP + 2.5
    with BuildPart() as hub:
        # Hub disc (the limb bolts/merges to its +X face).
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(hub_d / 2, hub_thk, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Stub axle reaching inward (-X) through the bearing bore.
        with Locations(Location((-axle_len, 0, 0), (0, 90, 0))):
            Cylinder(AXLE_D / 2, axle_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Horn-capture recess on the inner face: a slot for the single-arm horn.
        with Locations((-0.1, 0, 0)):
            with Locations(Location((0, 0, 0), (0, 90, 0))):
                Box(SG90_HORN_THK + 0.4, 6.0, 22.0,
                    align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        # Two M2 horn screw holes straddling the spline, into the hub face.
        for z in (-7.5, 7.5):
            with Locations(Location((0, 0, z), (0, 90, 0))):
                Cylinder(SG90_HORN_SCREW_R, hub_thk + 1.0,
                         align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return hub.part


def make_retainer_cap():
    """Thin printed ring that traps the 623ZZ outer race in the journal.

    Its center hole (7 mm) clears the rotating stub axle/neck but is smaller
    than the 10 mm bearing OD, so the ring overlaps the outer race and stops it
    walking out. Seats on the journal rim. Bed face: flat side down.
    """
    cap_center_d = 7.0  # < BEARING_OD so the ring overlaps the outer race
    with BuildPart() as cap:
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(JOURNAL_OUTER_D / 2, 1.6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Center clearance for the rotating stub axle / hub neck.
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(cap_center_d / 2, 3.0,
                     align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return cap.part


def make_servo_cradle():
    """SG90 cradle with M2 tab bosses, output axis on the joint axis (X=0).

    The servo sits inboard (-X) so its horn lands at the wall plane. Bed face:
    print open-pocket-up.
    """
    inset = SG90_BODY_D + 3.0
    with BuildPart() as cradle:
        # Cradle shell around the servo body, behind the wall.
        with Locations((-inset / 2 - 2.0, 0, 0)):
            add(bmo_body.rounded_box(SG90_BODY_D + 6.0, SG90_BODY_H + 6.0, SG90_BODY_W + 6.0, 2.0))
        # Servo body pocket.
        with Locations((-inset / 2 - 2.0, 0, 0)):
            Box(SG90_BODY_D + 1.2, SG90_BODY_H + 1.2, SG90_BODY_W + 1.4,
                align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # M2 mounting tab bosses (the SG90 flange screws to these).
        for z in (-SG90_TAB_SPAN / 2, SG90_TAB_SPAN / 2):
            with Locations(Location((-3.0, 0, z), (0, 90, 0))):
                Cylinder(1.1, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return cradle.part


# ---------- Ghosts for the exploded demo ----------

def make_bearing_ghost():
    """623ZZ stand-in (NOT printed; this is the bought bearing)."""
    with BuildPart() as brg:
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(BEARING_OD / 2, BEARING_W, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations(Location((0, 0, 0), (0, 90, 0))):
            Cylinder(BEARING_BORE / 2, BEARING_W + 0.4,
                     align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return brg.part


def make_joint_demo():
    """Exploded view of the whole joint along the axis, to read the load path."""
    return Compound(children=[
        make_servo_cradle().located(Location((-22.0, 0, 0))),
        make_limb_hub().located(Location((-10.0, 0, 0))),
        make_bearing_ghost().located(Location((0.0, 0, 0))),
        make_wall_journal().located(Location((6.0, 0, 0))),
    ])


# ---------- Joint placement on the V8 body (integration layer) ----------
# Reads the 4-servo joint map from bmo_magic_v8 and places a real bearing joint
# at each shoulder/hip: where the snap pins used to be, a journal+bearing+hub
# now sits. Left-side joints are mirrored (servo inboard). Subtract
# shell_journal_bores() from the front shell to host them.
def _joint_sites():
    import bmo_magic_v8 as v8
    return v8.JOINT_MAP


def shell_journal_bores():
    """The 4 negative cylinders to cut into the shell at each joint axis.

    Each is an axle clearance bore (axis = body X) at a joint center. Subtract
    from bmo_body.make_front_shell to host the wall journals.
    """
    children = []
    bore_r = JOURNAL_OUTER_D / 2 + 0.3
    for key, j in _joint_sites().items():
        x, y, z = j["pos"]
        children.append(
            Cylinder(bore_r, WALL + 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            .located(Location((x, y, z), (0, 90, 0)))
        )
    return Compound(children=children)


def make_integration_preview():
    """All 4 bearing joints placed at their body coordinates (preview)."""
    children = []
    for key, j in _joint_sites().items():
        x, y, z = j["pos"]
        rot = (0, 180, 0) if x < 0 else (0, 0, 0)
        stack = Compound(children=[
            make_wall_journal(),
            make_bearing_ghost().located(Location((1.0, 0, 0))),
            make_limb_hub().located(Location((6.0, 0, 0))),
        ])
        children.append(stack.located(Location((x, y, z), rot)))
    return Compound(children=children)


def exports():
    return {
        "bmo_joint_wall_journal": make_wall_journal(),
        "bmo_joint_limb_hub": make_limb_hub(),
        "bmo_joint_retainer_cap": make_retainer_cap(),
        "bmo_joint_servo_cradle": make_servo_cradle(),
        "bmo_joint_bearing_ghost": make_bearing_ghost(),
        "bmo_joint_demo": make_joint_demo(),
        "bmo_joint_integration_preview": make_integration_preview(),
        "bmo_joint_shell_bores": shell_journal_bores(),
    }


def describe_shape(name, shape):
    bb = shape.bounding_box()
    return f"{name}: vol={shape.volume:.1f} mm^3, bbox=({bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f})"


def main():
    skip_3mf = {"bmo_joint_bearing_ghost", "bmo_joint_demo"}
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name not in skip_3mf)
        print(describe_shape(name, shape))
    print(f"Pinned bearing: {BEARING_ID} ({BEARING_BORE}x{BEARING_OD}x{BEARING_W} mm)")
    print(f"Journal seat bore {JOURNAL_SEAT_D:.2f} mm, stub axle {AXLE_D:.2f} mm")


if __name__ == "__main__":
    main()
