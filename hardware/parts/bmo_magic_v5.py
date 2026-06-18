"""BMO Living Robot V5 CAD concept.

V5 is intentionally more honest than the earlier "magic" concepts:
- hidden N20 wheels do the real locomotion
- four micro servos drive shoulder and hip output shafts
- a small internal gear/cam train gives the arms and legs a synced doll gait
- external limbs stay clean, with pivot bosses and plug collars instead of
  exposed decorative gears

This is still a printable mechanism layout, not a proven dynamic robot. The
geometry makes the load path and linkage path explicit so the next prototype
can be measured and tuned instead of guessed.
"""

from __future__ import annotations

from math import cos, radians, sin

from build123d import Align, Box, BuildPart, Compound, Cylinder, Location, Locations, Mode, Sphere, add

import bmo_body
import bmo_mecha_v2


A1_PLATE = 256.0

N20_W = 12.0
N20_H = 10.0
N20_L = 26.0
WHEEL_R = 10.5
WHEEL_W = 7.2

CORE_Z = 55.0
CORE_PLATE_W = 102.0
CORE_PLATE_H = 112.0

SHOULDER_X = bmo_body.BODY_W / 2 + 7.0
SHOULDER_Y = -24.0
SHOULDER_Z = 23.0

HIP_X = 32.0
HIP_Y = -75.0
HIP_Z = 20.0

ELBOW_DROP = 25.0
WRIST_DROP = 24.0
KNEE_DROP = 20.5
ANKLE_DROP = 20.0


def flat_children(shape):
    children = getattr(shape, "children", ())
    if not children:
        return [shape]
    flattened = []
    for child in children:
        flattened.extend(flat_children(child))
    return flattened


def make_n20_fit_motor():
    """N20 gearmotor fit ghost, not a printable part."""
    with BuildPart() as motor:
        add(bmo_body.rounded_box(N20_W, N20_H, N20_L, 1.6))
        with Locations((0, -N20_H / 2 - 1.1, 0)):
            Box(N20_W + 4.8, 2.0, N20_L - 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, N20_L / 2 + 2.2)):
            Cylinder(1.1, 4.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    return motor.part


def make_drive_wheel():
    """Small rubber-tire-like wheel printable test part."""
    with BuildPart() as wheel:
        Cylinder(WHEEL_R, WHEEL_W, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, 0)):
            Cylinder(WHEEL_R * 0.33, WHEEL_W + 0.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for angle in range(0, 360, 45):
            x = cos(radians(angle)) * WHEEL_R * 0.73
            y = sin(radians(angle)) * WHEEL_R * 0.73
            with Locations((x, y, 0)):
                Box(2.0, 5.2, WHEEL_W + 0.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, -WHEEL_W / 2 - 0.6)):
            Cylinder(WHEEL_R + 1.2, 1.1, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return wheel.part


def make_motion_backbone():
    """One-piece internal frame: motor saddles, servo pockets, shafts, and cable lanes."""
    with BuildPart() as frame:
        with Locations((0, -29.0, 2.0)):
            add(bmo_body.rounded_box(CORE_PLATE_W, CORE_PLATE_H, 3.6, 1.1))

        # Perimeter and cross ribs keep the frame from flexing when the wheels
        # push against the body.
        for x in (-49.0, 49.0):
            with Locations((x, -29.0, 7.2)):
                Box(3.2, 104.0, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        for y in (15.0, -23.0, -58.0, -83.0):
            with Locations((0, y, 7.2)):
                Box(93.0, 3.2, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # N20 motor pockets and strap screw holes.
        for x in (-34.0, 34.0):
            with Locations((x, -64.0, 9.2)):
                add(bmo_body.rounded_box(23.0, 20.0, 10.0, 2.0))
            with Locations((x, -64.0, 9.4)):
                Box(14.2, 12.2, 10.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for y in (-73.5, -54.5):
                with Locations((x, y, 6.2)):
                    Cylinder(1.25, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Four real servo pockets. These are print features; the black servo
        # ghosts are separate fit objects in the viewer.
        for x, y in ((-36.0, -14.0), (36.0, -14.0), (-29.0, -70.0), (29.0, -70.0)):
            with Locations((x, y, 10.4)):
                add(bmo_body.rounded_box(31.5, 18.0, 9.0, 2.2))
            with Locations((x, y, 10.7)):
                Box(24.4, 13.4, 9.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for sx in (-11.8, 11.8):
                with Locations((x + sx, y, 6.2)):
                    Cylinder(1.15, 4.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Bearing bosses for the synchronized crankshaft and idler gears.
        for x, y in ((-24.0, -43.0), (0.0, -43.0), (24.0, -43.0), (-24.0, -56.0), (24.0, -56.0)):
            with Locations((x, y, 13.0)):
                Cylinder(4.5, 10.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, y, 13.0)):
                Cylinder(1.55, 11.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Output-shaft support towers aligned to the external shoulders/hips.
        for x, y in ((-43.0, -24.0), (43.0, -24.0), (-32.0, -75.0), (32.0, -75.0)):
            with Locations((x, y, 20.0)):
                add(bmo_body.rounded_box(12.0, 14.0, 18.0, 2.4))
            with Locations((x, y, 20.0)):
                Cylinder(2.0, 19.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Cable-safe center tunnel: all wires rise behind this comb so rods do
        # not rub jumper wires loose.
        with Locations((0, 31.0, 8.0)):
            add(bmo_body.rounded_box(78.0, 20.0, 7.0, 2.0))
        with Locations((0, 31.0, 8.1)):
            Box(64.0, 10.0, 7.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for x in (-16.0, -8.0, 0.0, 8.0, 16.0):
            with Locations((x, 3.0, 9.0)):
                Box(2.0, 46.0, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # Front and rear locator tabs that can screw or snap into the rear tray.
        for x, y in ((-42.0, 25.0), (42.0, 25.0), (-42.0, -86.0), (42.0, -86.0)):
            with Locations((x, y, 6.0)):
                Cylinder(3.2, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, y, 6.0)):
                Cylinder(1.2, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

    return frame.part


def make_servo_fit_ghosts():
    """Fit ghosts for SG90/MG90S servos and N20 motors."""
    children = []
    for x, y, label in (
        (-36.0, -14.0, "S1"),
        (36.0, -14.0, "S2"),
        (-29.0, -70.0, "S3"),
        (29.0, -70.0, "S4"),
    ):
        children.append(bmo_mecha_v2.make_servo_body(label).located(Location((x, y, 6.2), (0, 0, 90))))
    for x in (-34.0, 34.0):
        children.append(make_n20_fit_motor().located(Location((x, -64.0, 16.5))))
    return Compound(children=children)


def make_hidden_drive():
    children = []
    for x in (-34.0, 34.0):
        children.append(make_drive_wheel().located(Location((x, -88.5, 17.0), (0, 90, 0))))
        children.append(bmo_body.rounded_box(27.0, 5.0, 4.5, 1.2).located(Location((x, -54.0, 23.0))))
        children.append(bmo_body.rounded_box(27.0, 5.0, 4.5, 1.2).located(Location((x, -74.0, 23.0))))
    children.append(bmo_body.rounded_box(36.0, 14.0, 10.0, 3.0).located(Location((0, -88.0, 11.0))))
    children.append(Sphere(4.8).located(Location((0, -94.5, 4.2))))
    return Compound(children=children)


def make_v5_gear_train():
    """Internal gear/cam set: gear reduction plus opposed crank disks."""
    children = [
        bmo_mecha_v2.make_spur_gear(7.0, 12, 3.0, bore_r=1.3).located(Location((0.0, -31.5, 19.0))),
        bmo_mecha_v2.make_spur_gear(14.0, 22, 3.2, bore_r=1.35).located(Location((0.0, -43.0, 19.0))),
        bmo_mecha_v2.make_crank_disk(radius=10.5, pin_offset=7.8, pin_angle=35).located(Location((-24.0, -43.0, 22.6))),
        bmo_mecha_v2.make_crank_disk(radius=10.5, pin_offset=7.8, pin_angle=215).located(Location((24.0, -43.0, 22.6))),
        bmo_mecha_v2.make_crank_disk(radius=7.0, pin_offset=4.8, pin_angle=105).located(Location((-24.0, -56.0, 26.2))),
        bmo_mecha_v2.make_crank_disk(radius=7.0, pin_offset=4.8, pin_angle=285).located(Location((24.0, -56.0, 26.2))),
        Cylinder(1.7, 56.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((0.0, -43.0, 25.0), (0, 90, 0))),
        Cylinder(1.45, 55.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((0.0, -56.0, 28.2), (0, 90, 0))),
    ]
    for x, y in ((-43.0, -24.0), (43.0, -24.0), (-32.0, -75.0), (32.0, -75.0)):
        children.append(bmo_mecha_v2.make_spur_gear(6.2, 12, 2.8, bore_r=1.4).located(Location((x, y, 31.5))))
    return Compound(children=children)


def make_v5_linkage_rods():
    """All the visible/printable rods that explain the real pivot path."""
    left_crank = (-24.0 + cos(radians(35)) * 7.8, -43.0 + sin(radians(35)) * 7.8)
    right_crank = (24.0 + cos(radians(215)) * 7.8, -43.0 + sin(radians(215)) * 7.8)
    left_knee_cam = (-24.0 + cos(radians(105)) * 4.8, -56.0 + sin(radians(105)) * 4.8)
    right_knee_cam = (24.0 + cos(radians(285)) * 4.8, -56.0 + sin(radians(285)) * 4.8)

    children = [
        bmo_mecha_v2.make_link_rod(left_crank, (-32.0, -75.0), width=4.0).located(Location((0, 0, 27.0))),
        bmo_mecha_v2.make_link_rod(right_crank, (32.0, -75.0), width=4.0).located(Location((0, 0, 27.0))),
        bmo_mecha_v2.make_link_rod(left_knee_cam, (-35.0, -94.0), width=3.4).located(Location((0, 0, 30.0))),
        bmo_mecha_v2.make_link_rod(right_knee_cam, (35.0, -94.0), width=3.4).located(Location((0, 0, 30.0))),
        bmo_mecha_v2.make_link_rod((-36.0, -14.0), (-43.0, -24.0), width=3.6).located(Location((0, 0, 32.0))),
        bmo_mecha_v2.make_link_rod((36.0, -14.0), (43.0, -24.0), width=3.6).located(Location((0, 0, 32.0))),
        bmo_mecha_v2.make_link_rod((-43.0, -24.0), (-58.0, -24.0), width=4.2).located(Location((0, 0, 34.5))),
        bmo_mecha_v2.make_link_rod((43.0, -24.0), (58.0, -24.0), width=4.2).located(Location((0, 0, 34.5))),
        bmo_mecha_v2.make_link_rod((-32.0, -75.0), (-32.0, -94.0), width=4.2).located(Location((0, 0, 34.0))),
        bmo_mecha_v2.make_link_rod((32.0, -75.0), (32.0, -94.0), width=4.2).located(Location((0, 0, 34.0))),
    ]
    return Compound(children=children)


def make_output_collars():
    """Smooth external collars; gear load stays inside, limbs plug outside."""
    children = []
    for side in ("left", "right"):
        sign = -1 if side == "left" else 1
        for x, y, z, r, label_depth in (
            (sign * SHOULDER_X, SHOULDER_Y, SHOULDER_Z, 9.8, 7.0),
            (sign * HIP_X, HIP_Y, HIP_Z, 8.8, 7.0),
        ):
            children.append(Cylinder(r, label_depth, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((x, y, z + 4.2))))
            children.append(Cylinder(2.2, label_depth + 1.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((x, y, z + 4.2))))
        # Small side cover bridge hides the shoulder shaft.
        children.append(bmo_body.rounded_box(16.0, 18.0, 10.0, 3.0).located(Location((sign * (SHOULDER_X - 2.0 * sign), SHOULDER_Y, SHOULDER_Z + 0.8))))
    children.append(bmo_body.rounded_box(78.0, 10.0, 8.5, 2.4).located(Location((0, HIP_Y, HIP_Z + 1.2))))
    return Compound(children=children)


def make_v5_motion_core():
    children = []
    for shape in (
        make_motion_backbone(),
        make_hidden_drive(),
        make_servo_fit_ghosts(),
        make_v5_gear_train(),
        make_v5_linkage_rods(),
    ):
        children.extend(flat_children(shape))
    return Compound(children=children)


def make_electronics_shelf():
    return Compound(
        children=[
            bmo_body.rounded_box(88.0, 36.0, 5.0, 2.4).located(Location((0, 31.0, 42.0))),
            bmo_body.rounded_box(48.0, 31.0, 4.0, 1.8).located(Location((-23.0, 31.0, 47.0))),
            bmo_body.rounded_box(32.0, 20.0, 4.0, 1.8).located(Location((29.0, 39.0, 47.0))),
            bmo_body.rounded_box(35.0, 13.0, 4.0, 1.8).located(Location((29.0, 17.0, 47.0))),
        ]
    )


def make_upper_arm(side: str):
    sign = -1 if side == "left" else 1
    elbow = (sign * 5.5, -24.5, -0.8)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Cylinder(9.5, 7.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.25, 8.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        bmo_body.tube_along([(0, 0, 0), (sign * 2.5, -11.5, -0.2), elbow], 6.7)
        with Locations(elbow):
            Sphere(7.2)
            Cylinder(1.4, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((sign * 7.8, -16.0, -1.0)):
            Cylinder(2.4, 4.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.05, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_forearm_hand(side: str):
    sign = -1 if side == "left" else 1
    wrist = (sign * 5.0, -22.5, -1.5)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Sphere(7.0)
            Cylinder(1.4, 8.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        bmo_body.tube_along([(0, 0, 0), (sign * 2.8, -10.5, -0.8), wrist], 6.0)
        with Locations(wrist):
            Sphere(5.8)
        with Locations((sign * 7.0, -29.5, -1.4)):
            add(bmo_body.rounded_box(17.0, 14.0, 7.5, 3.0))
        for fx in (-3.6, 0.0, 3.6):
            with Locations((sign * 7.0 + fx, -35.4, -1.4)):
                add(bmo_body.rounded_box(4.0, 8.4, 5.6, 1.5))
    return part.part


def make_thigh(side: str):
    sign = -1 if side == "left" else 1
    knee = (sign * 2.8, -KNEE_DROP, -1.0)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Cylinder(9.5, 7.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.1, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        bmo_body.tube_along([(0, 0, 0), (sign * 1.5, -10.0, -0.5), knee], 7.2)
        with Locations(knee):
            Sphere(7.6)
            Cylinder(1.4, 8.6, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((sign * 7.0, -9.0, -0.8)):
            Cylinder(2.6, 4.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.1, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_shin_foot(side: str):
    sign = -1 if side == "left" else 1
    ankle = (sign * 2.5, -ANKLE_DROP, -2.6)
    foot = (sign * 4.2, -32.5, 5.2)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Sphere(7.4)
            Cylinder(1.4, 8.6, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        bmo_body.tube_along([(0, 0, 0), (sign * 1.5, -9.5, -1.3), ankle], 6.8)
        with Locations(ankle):
            Sphere(6.5)
            Cylinder(1.25, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Wide rounded boot: printable, stable, and visually BMO-ish.
        with Locations(foot):
            add(bmo_body.rounded_box(36.0, 22.0, 30.0, 5.0))
        with Locations((foot[0], foot[1] - 6.2, foot[2] - 12.0)):
            add(bmo_body.rounded_box(34.0, 7.0, 6.0, 2.2))
        with Locations((sign * 7.4, -10.5, -1.5)):
            Cylinder(2.5, 4.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.05, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_v5_living_robot_assembly():
    shoulder_left = (-SHOULDER_X, SHOULDER_Y, SHOULDER_Z)
    shoulder_right = (SHOULDER_X, SHOULDER_Y, SHOULDER_Z)
    left_elbow = (shoulder_left[0] - 5.5, shoulder_left[1] - ELBOW_DROP, shoulder_left[2] - 0.8)
    right_elbow = (shoulder_right[0] + 5.5, shoulder_right[1] - ELBOW_DROP, shoulder_right[2] - 0.8)
    left_hip = (-HIP_X, HIP_Y, HIP_Z)
    right_hip = (HIP_X, HIP_Y, HIP_Z)
    left_knee = (left_hip[0] - 2.8, left_hip[1] - KNEE_DROP, left_hip[2] - 1.0)
    right_knee = (right_hip[0] + 2.8, right_hip[1] - KNEE_DROP, right_hip[2] - 1.0)

    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            make_v5_motion_core().located(Location((0, 0, CORE_Z))),
            make_output_collars(),
            make_electronics_shelf().located(Location((0, 0, CORE_Z))),
            make_upper_arm("left").located(Location(shoulder_left)),
            make_forearm_hand("left").located(Location(left_elbow)),
            make_upper_arm("right").located(Location(shoulder_right)),
            make_forearm_hand("right").located(Location(right_elbow)),
            make_thigh("left").located(Location(left_hip)),
            make_shin_foot("left").located(Location(left_knee)),
            make_thigh("right").located(Location(right_hip)),
            make_shin_foot("right").located(Location(right_knee)),
        ]
    )


def core_print_kit_parts():
    return [
        ("motion_backbone", make_motion_backbone().located(Location((-70.0, 48.0, 0)))),
        ("hidden_drive", make_hidden_drive().located(Location((58.0, 80.0, 0)))),
        ("output_collars", make_output_collars().located(Location((54.0, -38.0, 0)))),
        ("electronics_shelf", make_electronics_shelf().located(Location((-74.0, -108.0, 0)))),
    ]


def make_core_print_kit():
    return Compound(children=[shape for _, shape in core_print_kit_parts()])


def linkage_print_kit_parts():
    return [
        ("gear_train", make_v5_gear_train().located(Location((-60.0, 35.0, 0)))),
        ("linkage_rods", make_v5_linkage_rods().located(Location((55.0, 35.0, 0)))),
    ]


def make_linkage_print_kit():
    return Compound(children=[shape for _, shape in linkage_print_kit_parts()])


def limb_print_kit_parts():
    return [
        ("left_upper_arm", make_upper_arm("left").located(Location((-96.0, 70.0, 0), (0, 0, -90)))),
        ("left_forearm_hand", make_forearm_hand("left").located(Location((-58.0, 70.0, 0), (0, 0, -90)))),
        ("right_upper_arm", make_upper_arm("right").located(Location((-18.0, 70.0, 0), (0, 0, 90)))),
        ("right_forearm_hand", make_forearm_hand("right").located(Location((20.0, 70.0, 0), (0, 0, 90)))),
        ("left_thigh", make_thigh("left").located(Location((-94.0, 6.0, 0)))),
        ("left_shin_foot", make_shin_foot("left").located(Location((-54.0, 8.0, 0)))),
        ("right_thigh", make_thigh("right").located(Location((2.0, 6.0, 0)))),
        ("right_shin_foot", make_shin_foot("right").located(Location((42.0, 8.0, 0)))),
    ]


def make_limb_print_kit():
    return Compound(children=[shape for _, shape in limb_print_kit_parts()])


def exports():
    return {
        "bmo_v5_motion_backbone": make_motion_backbone(),
        "bmo_v5_servo_fit_ghosts": make_servo_fit_ghosts(),
        "bmo_v5_hidden_drive": make_hidden_drive(),
        "bmo_v5_gear_train": make_v5_gear_train(),
        "bmo_v5_linkage_rods": make_v5_linkage_rods(),
        "bmo_v5_output_collars": make_output_collars(),
        "bmo_v5_electronics_shelf": make_electronics_shelf(),
        "bmo_v5_left_upper_arm": make_upper_arm("left"),
        "bmo_v5_left_forearm_hand": make_forearm_hand("left"),
        "bmo_v5_right_upper_arm": make_upper_arm("right"),
        "bmo_v5_right_forearm_hand": make_forearm_hand("right"),
        "bmo_v5_left_thigh": make_thigh("left"),
        "bmo_v5_left_shin_foot": make_shin_foot("left"),
        "bmo_v5_right_thigh": make_thigh("right"),
        "bmo_v5_right_shin_foot": make_shin_foot("right"),
        "bmo_v5_motion_core": make_v5_motion_core(),
        "bmo_v5_living_robot_assembly": make_v5_living_robot_assembly(),
        "bmo_v5_core_print_kit": make_core_print_kit(),
        "bmo_v5_linkage_print_kit": make_linkage_print_kit(),
        "bmo_v5_limb_print_kit": make_limb_print_kit(),
    }


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def main():
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name != "bmo_v5_servo_fit_ghosts")
        print(describe_shape(name, shape))
    print(f"Generated BMO Living Robot V5 artifacts in {bmo_body.EXPORT_DIR}")


if __name__ == "__main__":
    main()
