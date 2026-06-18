"""BMO Clean 4-Servo Animatronic V7 CAD concept.

V7 matches the clean reference layout:
- Servo 1/2 drive the left/right shoulders.
- Servo 3/4 drive the left/right hips.
- Feet stay slim and BMO-like. No bulky servos live inside the feet.

Physics note:
This is a 4-servo animatronic/shuffle walker layout. It can look alive and can
attempt slow weight-shift steps on a grippy surface, but true reliable running
needs either more leg degrees of freedom, hidden drive wheels, or a much more
advanced balance controller.
"""

from __future__ import annotations

from build123d import Align, Box, BuildPart, Compound, Cylinder, Location, Locations, Mode, Sphere, add

import bmo_body
import bmo_mecha_v2


A1_PLATE = 256.0

SHOULDER_X = 45.5
SHOULDER_Y = -18.0
SHOULDER_Z = 22.0
HIP_X = 27.0
HIP_Y = -72.5
HIP_Z = 20.0

SERVO_POCKET_W = 25.4
SERVO_POCKET_H = 14.2
SERVO_POCKET_D = 25.8
V71_ORGAN_Z = bmo_body.FRONT_DEPTH + 27.0

V71_ORGAN_LAYOUT = {
    "heart": (-23.0, 8.0),
    "battery": (35.0, 0.0),
    "charge": (-38.0, 52.0),
    "touch": (0.0, 52.0),
    "boost": (36.0, 52.0),
    "mic": (-42.0, -52.0),
    "amp": (40.0, -52.0),
}


def make_servo_ghost(label: str):
    return bmo_mecha_v2.make_servo_body(label)


def make_servo_frame():
    """One-piece internal cradle for four micro servos and low power mass."""
    with BuildPart() as frame:
        # Two rails make the frame easy to print and leave wire space open.
        with Locations((0, -45.0, 5.5)):
            add(bmo_body.rounded_box(96.0, 82.0, 6.0, 2.0))
        with Locations((0, -45.0, 6.0)):
            Box(74.0, 56.0, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Servo trays: shoulder pair high/wide, hip pair low/center.
        servo_sites = [
            (-SHOULDER_X, SHOULDER_Y, "S1 arm L"),
            (SHOULDER_X, SHOULDER_Y, "S2 arm R"),
            (-HIP_X, HIP_Y, "S3 hip L"),
            (HIP_X, HIP_Y, "S4 hip R"),
        ]
        for x, y, _ in servo_sites:
            with Locations((x, y, 8.0)):
                add(bmo_body.rounded_box(35.0, 19.5, 12.0, 1.8))
            with Locations((x, y, 8.0)):
                Box(SERVO_POCKET_W, SERVO_POCKET_H, 13.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for sx in (-12.0, 12.0):
                with Locations((x + sx, y, 4.2)):
                    Cylinder(1.15, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Side shoulder bearing towers align to the outside arms.
        for x in (-SHOULDER_X, SHOULDER_X):
            with Locations((x, SHOULDER_Y - 8.5, 17.5)):
                Cylinder(6.4, 13.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, SHOULDER_Y - 8.5, 17.5)):
                Cylinder(2.0, 14.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Hip bearing towers line up with the slim legs.
        for x in (-HIP_X, HIP_X):
            with Locations((x, HIP_Y - 2.0, 16.0)):
                Cylinder(6.0, 13.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, HIP_Y - 2.0, 16.0)):
                Cylinder(2.0, 14.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Low battery/ballast shelf; low mass is the difference between cute
        # shuffling and instant faceplant.
        with Locations((0, -5.0, 7.0)):
            add(bmo_body.rounded_box(60.0, 18.0, 8.0, 2.0))
        with Locations((0, -5.0, 7.2)):
            Box(52.0, 10.0, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Cable combs above the servos.
        for x in (-34.0, -17.0, 0.0, 17.0, 34.0):
            with Locations((x, 22.0, 8.0)):
                add(bmo_body.rounded_box(3.0, 18.0, 7.0, 1.2))
        with Locations((0, 34.0, 7.8)):
            add(bmo_body.rounded_box(82.0, 4.0, 5.5, 1.0))

        # Mounting pegs for fixing this frame to the rear tray.
        for x in (-44.0, 44.0):
            for y in (-82.0, 30.0):
                with Locations((x, y, 4.0)):
                    Cylinder(2.8, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
                with Locations((x, y, 4.0)):
                    Cylinder(1.15, 6.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return frame.part


def make_open_tray(width: float, height: float, depth: float, cavity_w: float, cavity_h: float, radius: float = 3.0):
    """Shallow organ tray with real internal clearance."""
    safe_radius = min(radius, width / 2 - 1.0, height / 2 - 1.0, depth / 2 - 0.8)
    with BuildPart() as tray:
        with Locations((0, 0, depth / 2)):
            add(bmo_body.rounded_box(width, height, depth, max(0.8, safe_radius)))
        with Locations((0, 0, bmo_organ_bottom() + depth / 2)):
            Box(cavity_w, cavity_h, depth + 0.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        # Two keyed plug sockets on the underside/top read clearly in the viewer
        # and give the printed cover a non-ambiguous orientation.
        for x in (-width * 0.28, width * 0.28):
            with Locations((x, -height / 2 + 4.0, depth - 1.2)):
                Cylinder(1.35, 2.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return tray.part


def bmo_organ_bottom() -> float:
    return 1.6


def make_v71_heart_hub():
    """Shallow heart shelf that still holds ESP32-C3 plugged into a mini breadboard."""
    with BuildPart() as heart:
        with Locations((-14.0, 10.0, 5.0)):
            Cylinder(16.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((14.0, 10.0, 5.0)):
            Cylinder(16.0, 10.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        # Lower point of the heart, simplified into a printable cradle.
        with Locations((0, -7.0, 5.0)):
            add(bmo_body.rounded_box(62.0, 35.0, 10.0, 3.0))
        with Locations((0, 3.0, 5.6)):
            Box(56.0, 38.5, 9.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for x in (-26.0, 26.0):
            for y in (-16.0, 19.0):
                with Locations((x, y, 2.0)):
                    add(bmo_body.rounded_box(5.5, 2.0, 2.4, 0.8))
        for x in (-20.0, 0.0, 20.0):
            with Locations((x, -27.0, 5.0)):
                Box(8.5, 3.4, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return heart.part


def make_v71_battery_cell():
    return make_open_tray(42.0, 58.0, 10.0, 36.0, 52.0, 5.0)


def make_v71_charge_kidney():
    return make_open_tray(36.0, 24.0, 7.0, 30.0, 18.0, 4.0)


def make_v71_boost_gland():
    return make_open_tray(38.0, 24.0, 8.0, 34.0, 18.0, 4.0)


def make_v71_touch_spark():
    with BuildPart() as spark:
        with Locations((0, 0, 3.0)):
            add(bmo_body.rounded_box(30.0, 30.0, 6.0, 1.8))
        with Locations((0, 0, 3.4)):
            Box(24.5, 24.5, 6.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, 0, 6.1)):
            add(bmo_body.rounded_box(22.0, 22.0, 1.0, 0.35))
    return spark.part


def make_v71_mic_ear():
    return make_open_tray(26.0, 24.0, 6.0, 19.0, 16.0, 3.8)


def make_v71_amp_lung():
    return make_open_tray(30.0, 24.0, 7.0, 23.0, 18.5, 4.0)


def make_v71_component_fit_ghosts():
    """Real component envelopes packed in the V7.1 upper organ layer."""
    children = []
    hx, hy = V71_ORGAN_LAYOUT["heart"]
    bx, by = V71_ORGAN_LAYOUT["battery"]
    cx, cy = V71_ORGAN_LAYOUT["charge"]
    tx, ty = V71_ORGAN_LAYOUT["touch"]
    gx, gy = V71_ORGAN_LAYOUT["boost"]
    mx, my = V71_ORGAN_LAYOUT["mic"]
    ax, ay = V71_ORGAN_LAYOUT["amp"]
    z = V71_ORGAN_Z + 6.0
    children.extend([
        Box(bmo_body.BREADBOARD_W, bmo_body.BREADBOARD_H, bmo_body.BREADBOARD_T).located(Location((hx - 5.0, hy + 2.0, z))),
        Box(bmo_body.ESP32_W, bmo_body.ESP32_H, bmo_body.ESP32_T).located(Location((hx + 15.0, hy + 2.0, z + 4.5))),
        Box(34.0, 50.0, 10.0).located(Location((bx, by, z))),
        Box(30.0, 18.0, 5.0).located(Location((cx, cy, z))),
        Box(24.0, 24.0, 4.0).located(Location((tx, ty, z))),
        Box(36.0, 19.0, 7.0).located(Location((gx, gy, z))),
        Box(18.0, 15.0, 4.0).located(Location((mx, my, z))),
        Box(21.0, 18.0, 5.0).located(Location((ax, ay, z))),
    ])
    return Compound(children=children)


def make_v71_plug_guides():
    """Readable plug/lock guide: frame pins, keyed organ sockets, and cable combs."""
    children = []
    # Frame-to-tray plug points.
    for x in (-44.0, 44.0):
        for y in (-82.0, 30.0):
            children.append(Cylinder(2.2, 7.0, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((x, y, V71_ORGAN_Z - 1.0))))
    # Organ keyed rails.
    for x, y in V71_ORGAN_LAYOUT.values():
        children.append(bmo_body.rounded_box(17.0, 3.0, 3.0, 0.8).located(Location((x, y - 16.0, V71_ORGAN_Z - 1.2))))
        children.append(bmo_body.rounded_box(3.0, 12.0, 3.0, 0.8).located(Location((x + 15.0, y + 8.0, V71_ORGAN_Z - 1.2))))
    # Twin side cable combs for jumper wires.
    for x in (-55.0, 55.0):
        for y in (-46.0, -30.0, -14.0, 2.0, 18.0, 34.0):
            children.append(bmo_body.rounded_box(2.6, 10.0, 5.0, 0.9).located(Location((x, y, V71_ORGAN_Z + 5.0))))
    return Compound(children=children)


def make_v71_organ_layer():
    return Compound(children=[
        make_v71_heart_hub().located(Location((*V71_ORGAN_LAYOUT["heart"], V71_ORGAN_Z))),
        make_v71_battery_cell().located(Location((*V71_ORGAN_LAYOUT["battery"], V71_ORGAN_Z))),
        make_v71_charge_kidney().located(Location((*V71_ORGAN_LAYOUT["charge"], V71_ORGAN_Z))),
        make_v71_touch_spark().located(Location((*V71_ORGAN_LAYOUT["touch"], V71_ORGAN_Z))),
        make_v71_boost_gland().located(Location((*V71_ORGAN_LAYOUT["boost"], V71_ORGAN_Z))),
        make_v71_mic_ear().located(Location((*V71_ORGAN_LAYOUT["mic"], V71_ORGAN_Z))),
        make_v71_amp_lung().located(Location((*V71_ORGAN_LAYOUT["amp"], V71_ORGAN_Z))),
    ])


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


def make_output_collars():
    """Visible round collars that hide servo horns and receive the limbs."""
    children = []
    for x in (-bmo_body.BODY_W / 2 - 1.8, bmo_body.BODY_W / 2 + 1.8):
        children.append(Cylinder(8.0, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((x, SHOULDER_Y - 8.5, bmo_body.FRONT_DEPTH * 0.48), (0, 90, 0))))
    for x in (-HIP_X, HIP_X):
        children.append(Cylinder(6.4, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER)).located(Location((x, -82.0, bmo_body.FRONT_DEPTH * 0.47), (90, 0, 0))))
    return Compound(children=children)


def make_arm(side: str):
    """Slim one-servo arm with rounded hand, like the clean reference."""
    outward = -1 if side == "left" else 1
    inward = -outward
    with BuildPart() as arm:
        with Locations(Location((inward * 2.0, 0.0, 0.0), (0, inward * 90, 0))):
            add(bmo_body.make_snap_pin(
                bmo_body.WALL,
                pin_r=3.0,
                barb=0.65,
                collar_r=7.5,
                slot_w=1.0,
            ))
        with Locations(Location((outward * 1.0, 0.0, 0.0), (0, 90, 0))):
            Cylinder(7.6, 3.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        bmo_body.tube_along(
            [
                (outward * 3.0, -1.0, 0.0),
                (outward * 9.0, -16.0, 0.8),
                (outward * 11.0, -32.0, 1.3),
                (outward * 8.0, -44.0, 1.6),
            ],
            4.2,
        )
        with Locations((outward * 8.0, -49.5, 1.7)):
            Sphere(6.0)
        for dx in (-3.0, 0.0, 3.0):
            with Locations((outward * 8.0 + dx, -55.0, 1.7)):
                add(bmo_body.rounded_box(2.7, 6.5, 4.2, 1.2))
    return arm.part


def make_leg(side: str):
    """Slim hip-driven leg with passive-looking BMO boot foot."""
    outward = -1 if side == "left" else 1
    with BuildPart() as leg:
        with Locations(Location((0, 0.0, 0.0), (90, 0, 0))):
            Cylinder(6.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.0, 6.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        bmo_body.tube_along(
            [
                (0.0, -2.0, 0.0),
                (outward * 1.0, -19.0, 0.8),
                (outward * 1.5, -36.0, 1.8),
                (outward * 2.5, -48.0, -0.3),
            ],
            4.5,
        )

        # Printed knee/ankle bumps are passive pivots visually; with 4 servos
        # they do not add active degrees of freedom.
        with Locations((outward * 1.0, -23.0, 0.9)):
            Sphere(5.3)
        with Locations((outward * 2.5, -43.5, 0.1)):
            Sphere(4.8)

        with Locations((outward * 2.5, -54.0, 5.0)):
            add(bmo_body.rounded_box(25.0, 12.0, 34.0, 3.6))
        with Locations((outward * 2.5, -61.0, 5.0)):
            Box(20.0, 1.4, 28.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        # Tiny heel nub helps the pose stand while still looking slim.
        with Locations((outward * 2.5, -57.0, 18.5)):
            add(bmo_body.rounded_box(15.0, 6.0, 7.0, 2.0))
    return leg.part


def make_servo_horn_adapter():
    with BuildPart() as adapter:
        Cylinder(6.6, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        Box(20.0, 4.0, 3.6, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, 0)):
            Cylinder(2.05, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        for x in (-6.0, 6.0):
            with Locations((x, 0, 0)):
                Cylinder(0.95, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return adapter.part


def make_v7_assembly():
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            bmo_body.make_controls().located(Location((0, 0, -2.45))),
            bmo_body.make_side_bmo_text().located(Location((bmo_body.BODY_W / 2 + 0.8, -4.0, bmo_body.FRONT_DEPTH * 0.64), (0, 90, 0))),
            make_servo_frame().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_servo_fit_ghosts().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_output_collars(),
            make_arm("left").located(Location((-bmo_body.BODY_W / 2 - 8.0, SHOULDER_Y - 8.5, bmo_body.FRONT_DEPTH * 0.48))),
            make_arm("right").located(Location((bmo_body.BODY_W / 2 + 8.0, SHOULDER_Y - 8.5, bmo_body.FRONT_DEPTH * 0.48))),
            make_leg("left").located(Location((-HIP_X, -82.0, bmo_body.FRONT_DEPTH * 0.47))),
            make_leg("right").located(Location((HIP_X, -82.0, bmo_body.FRONT_DEPTH * 0.47))),
        ]
    )


def make_v71_assembly():
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            bmo_body.make_controls().located(Location((0, 0, -2.45))),
            bmo_body.make_side_bmo_text_flipped().located(Location((bmo_body.BODY_W / 2 + 0.8, -4.0, bmo_body.FRONT_DEPTH * 0.64), (0, 90, 0))),
            make_servo_frame().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_servo_fit_ghosts().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_output_collars(),
            make_v71_organ_layer(),
            make_v71_component_fit_ghosts(),
            make_v71_plug_guides(),
            make_arm("left").located(Location((-bmo_body.BODY_W / 2 - 8.0, SHOULDER_Y - 8.5, bmo_body.FRONT_DEPTH * 0.48))),
            make_arm("right").located(Location((bmo_body.BODY_W / 2 + 8.0, SHOULDER_Y - 8.5, bmo_body.FRONT_DEPTH * 0.48))),
            make_leg("left").located(Location((-HIP_X, -82.0, bmo_body.FRONT_DEPTH * 0.47))),
            make_leg("right").located(Location((HIP_X, -82.0, bmo_body.FRONT_DEPTH * 0.47))),
        ]
    )


def print_kit_parts():
    return [
        ("servo_frame", make_servo_frame().located(Location((-70.0, 48.0, 0)))),
        ("left_arm", make_arm("left").located(Location((18.0, 78.0, 0), (0, 0, 74)))),
        ("right_arm", make_arm("right").located(Location((58.0, 78.0, 0), (0, 0, -74)))),
        ("left_leg", make_leg("left").located(Location((22.0, -20.0, 0), (0, 0, 92)))),
        ("right_leg", make_leg("right").located(Location((82.0, -20.0, 0), (0, 0, -92)))),
        ("output_collars", make_output_collars().located(Location((-82.0, -78.0, -16.0)))),
        ("horn_adapters", Compound(children=[
            make_servo_horn_adapter().located(Location((-12.0 + i * 18.0, -82.0, 0)))
            for i in range(4)
        ])),
    ]


def v71_print_kit_parts():
    return [
        ("servo_frame", make_servo_frame().located(Location((-70.0, 48.0, 0)))),
        ("organ_layer", make_v71_organ_layer().located(Location((0.0, 0.0, -V71_ORGAN_Z)))),
        ("plug_guides", make_v71_plug_guides().located(Location((0.0, 0.0, -V71_ORGAN_Z + 13.0)))),
        ("left_arm", make_arm("left").located(Location((18.0, 78.0, 0), (0, 0, 74)))),
        ("right_arm", make_arm("right").located(Location((58.0, 78.0, 0), (0, 0, -74)))),
        ("left_leg", make_leg("left").located(Location((22.0, -20.0, 0), (0, 0, 92)))),
        ("right_leg", make_leg("right").located(Location((82.0, -20.0, 0), (0, 0, -92)))),
        ("output_collars", make_output_collars().located(Location((-82.0, -78.0, -16.0)))),
        ("horn_adapters", Compound(children=[
            make_servo_horn_adapter().located(Location((-12.0 + i * 18.0, -82.0, 0)))
            for i in range(4)
        ])),
    ]


def make_print_kit():
    return Compound(children=[shape for _, shape in print_kit_parts()])


def make_v71_print_kit():
    return Compound(children=[shape for _, shape in v71_print_kit_parts()])


def exports():
    return {
        "bmo_v7_servo_frame": make_servo_frame(),
        "bmo_v7_servo_fit_ghosts": make_servo_fit_ghosts(),
        "bmo_v7_output_collars": make_output_collars(),
        "bmo_v7_left_arm": make_arm("left"),
        "bmo_v7_right_arm": make_arm("right"),
        "bmo_v7_left_leg": make_leg("left"),
        "bmo_v7_right_leg": make_leg("right"),
        "bmo_v7_servo_horn_adapter": make_servo_horn_adapter(),
        "bmo_v7_clean_robot_assembly": make_v7_assembly(),
        "bmo_v7_clean_robot_print_kit": make_print_kit(),
        "bmo_v71_heart_hub": make_v71_heart_hub(),
        "bmo_v71_battery_cell": make_v71_battery_cell(),
        "bmo_v71_charge_kidney": make_v71_charge_kidney(),
        "bmo_v71_touch_spark": make_v71_touch_spark(),
        "bmo_v71_boost_gland": make_v71_boost_gland(),
        "bmo_v71_mic_ear": make_v71_mic_ear(),
        "bmo_v71_amp_lung": make_v71_amp_lung(),
        "bmo_v71_organ_layer": make_v71_organ_layer(),
        "bmo_v71_component_fit_ghosts": make_v71_component_fit_ghosts(),
        "bmo_v71_plug_guides": make_v71_plug_guides(),
        "bmo_v71_packed_robot_assembly": make_v71_assembly(),
        "bmo_v71_packed_robot_print_kit": make_v71_print_kit(),
    }


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def main():
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name not in {"bmo_v7_servo_fit_ghosts", "bmo_v71_component_fit_ghosts"})
        print(describe_shape(name, shape))
    print(f"Generated BMO Clean Animatronic V7 artifacts in {bmo_body.EXPORT_DIR}")


if __name__ == "__main__":
    main()
