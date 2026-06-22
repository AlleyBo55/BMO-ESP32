"""BMO Living Robot V4 CAD concept.

V4 keeps the outer BMO silhouette clean and moves like a real robot:
- hidden differential wheels handle reliable locomotion
- a compact cog/cam engine drives the gait rhythm
- arms and legs are split into real articulated segments
- the legs sell the walking illusion while the wheels carry the weight
"""

from __future__ import annotations

from math import cos, radians, sin

from build123d import (
    Align,
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


N20_W = 12.0
N20_H = 10.0
N20_L = 26.0
WHEEL_R = 10.5
WHEEL_W = 7.0
DRIVE_Z = 55.0

SHOULDER_Y = -23.0
SHOULDER_Z = 22.0
SHOULDER_X = bmo_body.BODY_W / 2 + 6.5
HIP_Y = -74.0
HIP_Z = 19.5
HIP_X = 31.0

LINKAGE_Z_OFFSET = 4.2


def flat_children(shape):
    children = getattr(shape, "children", ())
    if not children:
        return [shape]
    flattened = []
    for child in children:
        flattened.extend(flat_children(child))
    return flattened


def make_n20_motor(label: str = ""):
    with BuildPart() as motor:
        add(bmo_body.rounded_box(N20_W, N20_H, N20_L, 1.6))
        with Locations((0, -N20_H / 2 - 1.1, 0)):
            Box(N20_W + 4.8, 2.0, N20_L - 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, N20_L / 2 + 2.2)):
            Cylinder(1.1, 4.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    return motor.part


def make_drive_wheel(side: str = "left"):
    with BuildPart() as wheel:
        Cylinder(WHEEL_R, WHEEL_W, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, 0)):
            Cylinder(WHEEL_R * 0.36, WHEEL_W + 0.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for angle in range(0, 360, 45):
            x = cos(radians(angle)) * WHEEL_R * 0.73
            y = sin(radians(angle)) * WHEEL_R * 0.73
            with Locations((x, y, -WHEEL_W / 2 - 0.2)):
                Box(2.1, 4.8, WHEEL_W + 0.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, -WHEEL_W / 2 - 0.7)):
            Cylinder(WHEEL_R + 1.3, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, WHEEL_W / 2 - 0.5)):
            Cylinder(WHEEL_R + 0.8, 0.9, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return wheel.part


def make_drive_chassis():
    """Lower internal chassis: motors, wheel shafts, cam bearings, and wire gutters."""
    with BuildPart() as chassis:
        with Locations((0, -47.0, 2.0)):
            add(bmo_body.rounded_box(96.0, 62.0, 3.2, 1.4))
        for x in (-44.0, 44.0):
            with Locations((x, -47.0, 6.2)):
                Box(3.2, 58.0, 6.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        for y in (-20.0, -47.0, -75.0):
            with Locations((0, y, 6.4)):
                Box(84.0, 3.0, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # Motor saddles with through-slots for removable printed straps.
        for x in (-34.0, 34.0):
            with Locations((x, -54.0, 8.0)):
                add(bmo_body.rounded_box(21.0, 19.0, 8.5, 2.2))
            with Locations((x, -54.0, 8.2)):
                Box(13.6, 11.6, 9.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for y in (-63.0, -45.0):
                with Locations((x, y, 5.5)):
                    Cylinder(1.25, 3.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Camshaft bearing towers. These make the physical linkage path obvious.
        for x, y in ((-22.0, -37.0), (0.0, -37.0), (22.0, -37.0), (-18.0, -67.0), (18.0, -67.0)):
            with Locations((x, y, 10.5)):
                Cylinder(4.0, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, y, 10.5)):
                Cylinder(1.55, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Cable comb down the center so wires do not fight the moving rods.
        for x in (-12.0, 0.0, 12.0):
            with Locations((x, -6.0, 7.8)):
                Box(2.0, 38.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 15.0, 8.4)):
            Box(56.0, 4.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    return chassis.part


def make_motor_pack():
    children = []
    for x in (-34.0, 34.0):
        children.append(make_n20_motor().located(Location((x, -54.0, 17.0))))
        children.append(bmo_body.rounded_box(26.0, 5.0, 4.5, 1.2).located(Location((x, -44.0, 23.0))))
        children.append(bmo_body.rounded_box(26.0, 5.0, 4.5, 1.2).located(Location((x, -64.0, 23.0))))
    return Compound(children=children)


def make_cog_cam_engine():
    """Compact mechanical take-off: gears and cams that pull arms/legs in rhythm."""
    children = [
        bmo_mecha_v2.make_spur_gear(8.0, 12, 3.0, bore_r=1.3).located(Location((-22.0, -37.0, 16.0))),
        bmo_mecha_v2.make_spur_gear(13.5, 20, 3.0, bore_r=1.3).located(Location((0.0, -37.0, 16.0))),
        bmo_mecha_v2.make_spur_gear(8.0, 12, 3.0, bore_r=1.3).located(Location((22.0, -37.0, 16.0))),
        bmo_mecha_v2.make_crank_disk(radius=10.0, pin_offset=7.5, pin_angle=35).located(Location((-18.0, -67.0, 16.0))),
        bmo_mecha_v2.make_crank_disk(radius=10.0, pin_offset=7.5, pin_angle=215).located(Location((18.0, -67.0, 16.0))),
        Cylinder(1.45, 48.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((0.0, -67.0, 18.1), (0, 90, 0))),
        bmo_mecha_v2.make_link_rod((-18.0, -67.0), (-26.0, -78.0), width=3.4).located(Location((0, 0, 21.0))),
        bmo_mecha_v2.make_link_rod((18.0, -67.0), (26.0, -78.0), width=3.4).located(Location((0, 0, 21.0))),
        bmo_mecha_v2.make_link_rod((-22.0, -37.0), (-48.0, -23.0), width=3.0).located(Location((0, 0, 22.5))),
        bmo_mecha_v2.make_link_rod((22.0, -37.0), (48.0, -23.0), width=3.0).located(Location((0, 0, 22.5))),
    ]
    return Compound(children=children)


def make_shoulder_servo_pods():
    children = []
    for side, x, rot in (("L", -39.0, 0), ("R", 39.0, 180)):
        children.append(bmo_mecha_v2.make_servo_body(side).located(Location((x, -15.0, 8.0), (0, 0, 90))))
        children.append(bmo_mecha_v2.make_spur_gear(7.0, 12, 3.0, bore_r=1.3).located(Location((x, -23.0, 34.0))))
        children.append(
            bmo_body.rounded_box(15.0, 6.0, 5.0, 2.0).located(Location((x + (-8.0 if side == "L" else 8.0), -23.0, 34.0), (0, 0, rot)))
        )
    return Compound(children=children)


def make_external_servo_mounts():
    """Visible joint actuator pods for the clean V4 robot guide."""
    children = [
        bmo_body.rounded_box(78.0, 10.0, 9.0, 2.6).located(Location((0.0, HIP_Y + 1.0, HIP_Z + 0.4))),
    ]
    for side in ("left", "right"):
        outward = -1 if side == "left" else 1
        shoulder_x = outward * SHOULDER_X
        hip_x = outward * HIP_X

        children.extend(
            [
                bmo_body.rounded_box(18.0, 16.0, 12.0, 3.0).located(
                    Location((shoulder_x - outward * 2.2, SHOULDER_Y, SHOULDER_Z + 0.6))
                ),
                Cylinder(9.2, 7.2, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(
                    Location((shoulder_x, SHOULDER_Y, SHOULDER_Z + LINKAGE_Z_OFFSET))
                ),
                bmo_body.rounded_box(18.0, 16.0, 12.0, 3.0).located(
                    Location((hip_x, HIP_Y, HIP_Z + 0.6))
                ),
                Cylinder(8.8, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(
                    Location((hip_x, HIP_Y, HIP_Z + LINKAGE_Z_OFFSET))
                ),
            ]
        )
    return Compound(children=children)


def make_external_cog_linkages():
    """Clean visible gears, pulleys, and rods that explain limb articulation."""
    children = []
    for side in ("left", "right"):
        outward = -1 if side == "left" else 1
        shoulder = (outward * SHOULDER_X, SHOULDER_Y)
        elbow = (outward * (SHOULDER_X + 6.0), SHOULDER_Y - 25.0)
        wrist = (elbow[0] + outward * 5.2, elbow[1] - 22.5)
        hip = (outward * HIP_X, HIP_Y)
        knee = (hip[0] + outward * 2.5, HIP_Y - 20.0)
        ankle = (knee[0] + outward * 2.5, knee[1] - 19.0)

        children.extend(
            [
                bmo_mecha_v2.make_spur_gear(6.4, 12, 2.4, bore_r=1.25).located(
                    Location((shoulder[0], shoulder[1], SHOULDER_Z + LINKAGE_Z_OFFSET))
                ),
                bmo_mecha_v2.make_spur_gear(4.5, 10, 2.2, bore_r=1.1).located(
                    Location((elbow[0], elbow[1], SHOULDER_Z + LINKAGE_Z_OFFSET - 0.4))
                ),
                bmo_mecha_v2.make_link_rod(shoulder, elbow, width=2.8).located(
                    Location((0, 0, SHOULDER_Z + LINKAGE_Z_OFFSET + 1.8))
                ),
                bmo_mecha_v2.make_link_rod(elbow, wrist, width=2.3).located(
                    Location((0, 0, SHOULDER_Z + LINKAGE_Z_OFFSET + 1.0))
                ),
                bmo_mecha_v2.make_spur_gear(6.6, 12, 2.4, bore_r=1.25).located(
                    Location((hip[0], hip[1], HIP_Z + LINKAGE_Z_OFFSET))
                ),
                bmo_mecha_v2.make_spur_gear(4.8, 10, 2.2, bore_r=1.1).located(
                    Location((knee[0], knee[1], HIP_Z + LINKAGE_Z_OFFSET - 0.3))
                ),
                bmo_mecha_v2.make_crank_disk(radius=5.6, pin_offset=3.9, pin_angle=40 if side == "left" else 220).located(
                    Location((ankle[0], ankle[1], HIP_Z + LINKAGE_Z_OFFSET - 0.7))
                ),
                bmo_mecha_v2.make_link_rod(hip, knee, width=2.8).located(
                    Location((0, 0, HIP_Z + LINKAGE_Z_OFFSET + 1.6))
                ),
                bmo_mecha_v2.make_link_rod(knee, ankle, width=2.4).located(
                    Location((0, 0, HIP_Z + LINKAGE_Z_OFFSET + 0.8))
                ),
            ]
        )
    return Compound(children=children)


def make_balance_caster():
    return Compound(
        children=[
            bmo_body.rounded_box(38.0, 13.0, 12.0, 3.0).located(Location((0, -82.0, 12.0))),
            Sphere(5.0).located(Location((0, -88.0, 4.0))),
            bmo_body.rounded_box(42.0, 16.0, 8.0, 2.0).located(Location((0, -66.0, 9.0))),
        ]
    )


def make_electronics_deck():
    return Compound(
        children=[
            bmo_body.rounded_box(90.0, 43.0, 5.0, 2.4).located(Location((0, 25.0, 8.0))),
            bmo_body.rounded_box(48.0, 32.0, 4.0, 1.8).located(Location((-22.0, 25.0, 13.0))),
            bmo_body.rounded_box(30.0, 19.0, 4.0, 1.8).located(Location((29.0, 33.0, 13.0))),
            bmo_body.rounded_box(34.0, 12.0, 4.0, 1.8).located(Location((28.0, 12.0, 13.0))),
            bmo_body.rounded_box(72.0, 4.0, 5.0, 1.2).located(Location((0, 50.0, 13.0))),
        ]
    )


def make_upper_arm(side: str):
    outward = -1 if side == "left" else 1
    elbow = (outward * 6.0, -25.0, -0.5)
    with BuildPart() as part:
        with Locations((0.0, 0.0, 0.0)):
            Cylinder(9.5, 7.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.1, 7.6, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0.0, 0.0, -3.2)):
            Cylinder(8.0, 2.8, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((outward * 3.0, -2.0, 0.0)):
            add(bmo_body.rounded_box(13.5, 12.0, 7.4, 2.6))
        bmo_body.tube_along([(0, 0, 0), (outward * 3.0, -11.0, 0.2), elbow], 6.7)
        with Locations(elbow):
            Sphere(7.0)
            Cylinder(1.25, 8.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((elbow[0], elbow[1], -3.5)):
            Cylinder(6.0, 2.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((outward * 8.5, -18.0, -0.4)):
            Cylinder(2.5, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.0, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_forearm_hand(side: str):
    outward = -1 if side == "left" else 1
    wrist = (outward * 5.2, -22.5, -1.0)
    with BuildPart() as part:
        with Locations((0.0, 0.0, 0.0)):
            Sphere(6.9)
            Cylinder(1.25, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0.0, 0.0, -3.1)):
            Cylinder(6.0, 2.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        bmo_body.tube_along([(0, 0, 0), (outward * 2.6, -10.0, -0.6), wrist], 6.0)
        with Locations(wrist):
            Sphere(5.8)
        with Locations((wrist[0], wrist[1], -3.1)):
            Cylinder(4.4, 2.1, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((outward * 6.6, -29.0, -1.5)):
            add(bmo_body.rounded_box(17.5, 15.0, 7.6, 3.0))
        for fx in (-3.5, 0.0, 3.5):
            with Locations((outward * 6.6 + fx, -35.2, -1.5)):
                add(bmo_body.rounded_box(4.0, 8.6, 5.8, 1.5))
    return part.part


def make_thigh(side: str):
    outward = -1 if side == "left" else 1
    knee = (outward * 2.5, -20.0, -1.0)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Cylinder(9.4, 7.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.35, 7.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, 0, -3.2)):
            Cylinder(7.6, 2.8, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0.0, -3.0, 0.0)):
            add(bmo_body.rounded_box(14.5, 12.6, 7.6, 2.6))
        bmo_body.tube_along([(0, 0, 0), (outward * 1.0, -10.0, -0.4), knee], 7.0)
        with Locations(knee):
            Sphere(7.5)
            Cylinder(1.25, 8.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((knee[0], knee[1], -3.2)):
            Cylinder(6.2, 2.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((outward * 8.0, -8.0, 0.0)):
            Cylinder(2.7, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_shin_foot(side: str):
    outward = -1 if side == "left" else 1
    ankle = (outward * 2.5, -19.0, -3.0)
    foot_center = (outward * 4.2, -31.0, 7.0)
    with BuildPart() as part:
        with Locations((0, 0, 0)):
            Sphere(7.4)
            Cylinder(1.25, 8.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, 0, -3.2)):
            Cylinder(6.2, 2.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        bmo_body.tube_along([(0, 0, 0), (outward * 1.5, -9.0, -1.5), ankle], 6.6)
        with Locations(ankle):
            Sphere(6.4)
            Cylinder(1.15, 7.6, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((ankle[0], ankle[1], -3.3)):
            Cylinder(5.6, 2.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations(foot_center):
            add(bmo_body.rounded_box(40.0, 23.0, 56.0, 5.4))
        with Locations((foot_center[0], foot_center[1] - 6.0, foot_center[2])):
            Box(34.0, 2.0, 46.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((foot_center[0], foot_center[1] - 1.0, foot_center[2] - 23.5)):
            add(bmo_body.rounded_box(37.0, 18.0, 5.6, 2.4))
        with Locations((outward * 9.0, -10.0, -1.4)):
            Cylinder(2.6, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return part.part


def make_living_robot_assembly():
    shoulder_left = (-SHOULDER_X, SHOULDER_Y, SHOULDER_Z)
    shoulder_right = (SHOULDER_X, SHOULDER_Y, SHOULDER_Z)
    left_elbow = (shoulder_left[0] - 6.0, shoulder_left[1] - 25.0, shoulder_left[2] - 0.5)
    right_elbow = (shoulder_right[0] + 6.0, shoulder_right[1] - 25.0, shoulder_right[2] - 0.5)
    left_hip = (-HIP_X, HIP_Y, HIP_Z)
    right_hip = (HIP_X, HIP_Y, HIP_Z)
    left_knee = (left_hip[0] - 2.5, left_hip[1] - 20.0, left_hip[2] - 1.0)
    right_knee = (right_hip[0] + 2.5, right_hip[1] - 20.0, right_hip[2] - 1.0)

    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            make_drive_chassis().located(Location((0, 0, DRIVE_Z))),
            make_motor_pack().located(Location((0, 0, DRIVE_Z))),
            make_drive_wheel("left").located(Location((-34.0, -80.0, DRIVE_Z + 17.0), (0, 90, 0))),
            make_drive_wheel("right").located(Location((34.0, -80.0, DRIVE_Z + 17.0), (0, 90, 0))),
            make_cog_cam_engine().located(Location((0, 0, DRIVE_Z))),
            make_shoulder_servo_pods().located(Location((0, 0, DRIVE_Z))),
            make_external_servo_mounts(),
            make_balance_caster().located(Location((0, 0, DRIVE_Z))),
            make_electronics_deck().located(Location((0, 0, DRIVE_Z))),
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
        ("drive_chassis", make_drive_chassis().located(Location((-68.0, 72.0, 0)))),
        ("motor_pack", make_motor_pack().located(Location((56.0, 76.0, 0)))),
        ("left_drive_wheel", make_drive_wheel("left").located(Location((92.0, 30.0, 0), (0, 90, 0)))),
        ("right_drive_wheel", make_drive_wheel("right").located(Location((116.0, 30.0, 0), (0, 90, 0)))),
        ("cog_cam_engine", make_cog_cam_engine().located(Location((-72.0, -10.0, 0)))),
        ("shoulder_servo_pods", make_shoulder_servo_pods().located(Location((40.0, -12.0, 0)))),
        ("balance_caster", make_balance_caster().located(Location((-76.0, -55.0, 0)))),
        ("electronics_deck", make_electronics_deck().located(Location((50.0, -92.0, 0)))),
    ]


def make_core_print_kit():
    return Compound(children=[shape for _, shape in core_print_kit_parts()])


def limb_print_kit_parts():
    return [
        ("left_upper_arm", make_upper_arm("left").located(Location((-98.0, 72.0, 0), (0, 0, -90)))),
        ("left_forearm_hand", make_forearm_hand("left").located(Location((-62.0, 72.0, 0), (0, 0, -90)))),
        ("right_upper_arm", make_upper_arm("right").located(Location((-22.0, 72.0, 0), (0, 0, 90)))),
        ("right_forearm_hand", make_forearm_hand("right").located(Location((14.0, 72.0, 0), (0, 0, 90)))),
        ("left_thigh", make_thigh("left").located(Location((-92.0, 6.0, 0)))),
        ("left_shin_foot", make_shin_foot("left").located(Location((-54.0, 6.0, 0)))),
        ("right_thigh", make_thigh("right").located(Location((4.0, 6.0, 0)))),
        ("right_shin_foot", make_shin_foot("right").located(Location((42.0, 6.0, 0)))),
    ]


def make_limb_print_kit():
    return Compound(children=[shape for _, shape in limb_print_kit_parts()])


def exports():
    return {
        "bmo_v4_drive_chassis": make_drive_chassis(),
        "bmo_v4_motor_pack": make_motor_pack(),
        "bmo_v4_left_drive_wheel": make_drive_wheel("left"),
        "bmo_v4_right_drive_wheel": make_drive_wheel("right"),
        "bmo_v4_cog_cam_engine": make_cog_cam_engine(),
        "bmo_v4_shoulder_servo_pods": make_shoulder_servo_pods(),
        "bmo_v4_external_servo_mounts": make_external_servo_mounts(),
        "bmo_v4_external_cog_linkages": make_external_cog_linkages(),
        "bmo_v4_balance_caster": make_balance_caster(),
        "bmo_v4_electronics_deck": make_electronics_deck(),
        "bmo_v4_left_upper_arm": make_upper_arm("left"),
        "bmo_v4_left_forearm_hand": make_forearm_hand("left"),
        "bmo_v4_right_upper_arm": make_upper_arm("right"),
        "bmo_v4_right_forearm_hand": make_forearm_hand("right"),
        "bmo_v4_left_thigh": make_thigh("left"),
        "bmo_v4_left_shin_foot": make_shin_foot("left"),
        "bmo_v4_right_thigh": make_thigh("right"),
        "bmo_v4_right_shin_foot": make_shin_foot("right"),
        "bmo_v4_living_robot_assembly": make_living_robot_assembly(),
        "bmo_v4_core_print_kit": make_core_print_kit(),
        "bmo_v4_limb_print_kit": make_limb_print_kit(),
    }


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def main():
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape)
        print(describe_shape(name, shape))
    print(f"Generated BMO Living Robot V4 artifacts in {bmo_body.EXPORT_DIR}")


if __name__ == "__main__":
    main()
