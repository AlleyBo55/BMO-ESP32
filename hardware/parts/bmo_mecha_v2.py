"""BMO Servo/Clockwork V2 CAD concept.

This keeps the verified organ-fit body as V1 and adds a separate V2 layout for
an old-toy-style walking mechanism:
- two arm micro-servos at the shoulders with visible pinion/output gears
- one continuous servo/gearmotor driving a small gear/crank walking engine
- one passive pendulum ballast that gravity-biases the body back upright

The geometry is a printable mechanism layout, not a dynamic simulation. Use the
audit script and a small test coupon before committing to a full robot print.
"""

from __future__ import annotations

from math import atan2, cos, degrees, hypot, radians, sin

from build123d import (
    Align,
    Axis,
    Box,
    BuildPart,
    BuildSketch,
    Compound,
    Cylinder,
    Location,
    Locations,
    Mode,
    RectangleRounded,
    Text,
    add,
    extrude,
    fillet,
)

import bmo_body


EXPORT_DIR = bmo_body.EXPORT_DIR

SERVO_W = 23.5
SERVO_H = 12.5
SERVO_D = 25.0
SERVO_EAR_W = 32.0
SERVO_EAR_H = 4.2
SERVO_HORN_R = 5.2
SHAFT_R = 1.5
LINK_T = 2.2
LINK_W = 4.0
GEAR_T = 3.2
ARM_SERVO_X = 31.0
ARM_OUTPUT_X = 43.5
DRIVE_SERVO_Y = -17.0
PINION_Y = -31.5
GEAR_Y = -44.5
HIP_Y = -61.0
LOWER_OUTPUT_Y = -68.0
DRIVE_PINION_R = 5.5
IDLER_GEAR_R = 7.5
FLYWHEEL_R = 15.5
CRANK_GEAR_R = 12.5
CRANK_PIN_R = 9.0
ARM_PINION_R = 5.2
ARM_OUTPUT_GEAR_R = 8.5


def make_servo_body(label: str = ""):
    """Approximate SG90/MG90S envelope with mounting ears and output horn."""
    with BuildPart() as servo:
        with Locations((0, 0, 0)):
            Box(SERVO_W, SERVO_H, SERVO_D, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for y in (-(SERVO_H / 2 + SERVO_EAR_H / 2), SERVO_H / 2 + SERVO_EAR_H / 2):
            with Locations((0, y, SERVO_D * 0.32)):
                Box(SERVO_EAR_W, SERVO_EAR_H, 2.2, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            for x in (-SERVO_EAR_W / 2 + 4.5, SERVO_EAR_W / 2 - 4.5):
                with Locations((x, y, SERVO_D * 0.32 - 1.3)):
                    Cylinder(1.15, 3.2, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        with Locations((0, 0, SERVO_D)):
            Cylinder(SERVO_HORN_R, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, SERVO_D + 2.0)):
            Box(20.0, 3.0, 1.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
            Box(3.0, 20.0, 1.4, align=(Align.CENTER, Align.CENTER, Align.MIN))
        if label:
            with Locations((-SERVO_W / 2 + 2.0, -SERVO_H / 2 + 2.0, SERVO_D + 3.4)):
                with BuildSketch():
                    Text(label, font_size=3.8)
                extrude(amount=0.35)
    return servo.part


def make_spur_gear(radius: float, teeth: int, depth: float, bore_r: float = SHAFT_R):
    """Simple printable visual spur gear with rectangular teeth and shaft bore."""
    tooth_outer = radius + 2.0
    tooth_w = max(2.2, radius * 0.28)
    with BuildPart() as gear:
        Cylinder(radius, depth, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for index in range(teeth):
            angle = 360.0 * index / teeth
            x = cos(radians(angle)) * tooth_outer
            y = sin(radians(angle)) * tooth_outer
            with Locations(Location((x, y, depth / 2), (0, 0, angle))):
                Box(3.1, tooth_w, depth, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, -0.2)):
            Cylinder(bore_r, depth + 0.4, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return gear.part


def make_crank_disk(radius: float = 10.0, pin_offset: float = 7.0, pin_angle: float = 0.0):
    with BuildPart() as crank:
        add(make_spur_gear(radius, 14, GEAR_T, bore_r=SHAFT_R))
        px = cos(radians(pin_angle)) * pin_offset
        py = sin(radians(pin_angle)) * pin_offset
        with Locations((px, py, GEAR_T)):
            Cylinder(1.45, 3.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((px, py, GEAR_T + 2.7)):
            Cylinder(2.05, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return crank.part


def make_link_rod(start: tuple[float, float], end: tuple[float, float], width: float = LINK_W):
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length = hypot(dx, dy)
    angle = degrees(atan2(dy, dx))
    midpoint = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
    with BuildPart() as rod:
        with Locations(Location((midpoint[0], midpoint[1], 0.0), (0, 0, angle))):
            Box(length, width, LINK_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for x, y in (start, end):
            with Locations((x, y, 0.0)):
                Cylinder(width * 0.78, LINK_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x, y, -0.2)):
                Cylinder(1.25, LINK_T + 0.4, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return rod.part


def flat_children(shape):
    """Flatten nested build123d compounds before exporting combined modules."""
    children = getattr(shape, "children", ())
    if not children:
        return [shape]
    flattened = []
    for child in children:
        flattened.extend(flat_children(child))
    return flattened


def make_mecha_tray():
    """Rear body tray redesigned as a mechanism chassis."""
    lip_outer_w = bmo_body.ORGAN_LIP_W
    lip_outer_h = bmo_body.ORGAN_LIP_H
    lip_wall = 1.7

    with BuildPart() as tray:
        with BuildSketch():
            RectangleRounded(bmo_body.BODY_W, bmo_body.BODY_H, bmo_body.CORNER_R)
        extrude(amount=bmo_body.LID_T)
        rear_outside = tray.faces().sort_by(Axis.Z)[0]
        fillet(rear_outside.edges(), radius=min(bmo_body.BACK_EDGE_FILLET, bmo_body.LID_T - 1.2))

        with BuildSketch(tray.faces().sort_by(Axis.Z)[-1]):
            RectangleRounded(lip_outer_w, lip_outer_h, max(bmo_body.CORNER_R - bmo_body.WALL, 2.0))
        extrude(amount=bmo_body.LID_LIP_H)
        with Locations((0, 0, bmo_body.LID_T - 0.1)):
            Box(
                lip_outer_w - 2 * lip_wall,
                lip_outer_h - 2 * lip_wall,
                bmo_body.LID_LIP_H + 0.4,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )

        bmo_body.add_rear_snap_hooks(lip_outer_w, lip_outer_h)

        # Shoulder servo shelves.
        for x in (-ARM_SERVO_X, ARM_SERVO_X):
            with Locations((x, -22.0, bmo_body.LID_T + 0.6)):
                Box(35.0, 18.0, 2.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
            for px in (x - 12.0, x + 12.0):
                with Locations((px, -22.0, bmo_body.LID_T + 2.8)):
                    Cylinder(1.25, 3.0, align=(Align.CENTER, Align.CENTER, Align.MIN))

        # Center walking engine plate and four gear bearing bosses.
        with Locations((0, GEAR_Y, bmo_body.LID_T + 0.4)):
            Box(82.0, 52.0, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for x, y in ((0.0, PINION_Y), (0.0, GEAR_Y), (-18.0, GEAR_Y), (18.0, GEAR_Y)):
            with Locations((x, y, bmo_body.LID_T + 2.4)):
                Cylinder(4.0, 4.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x, y, bmo_body.LID_T + 2.2)):
                Cylinder(SHAFT_R + 0.35, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

        # Hip rocker posts and lower leg slots.
        for x in (-26.0, 26.0):
            with Locations((x, HIP_Y, bmo_body.LID_T + 1.0)):
                Cylinder(4.2, 8.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x, HIP_Y, bmo_body.LID_T + 0.8)):
                Cylinder(1.55, 9.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
            with Locations((x, LOWER_OUTPUT_Y, bmo_body.LID_T - 0.4)):
                Box(11.0, 8.0, 3.4, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

        # Electronics shelf above the mechanism: ESP32/breadboard and power
        # boards move high so the walking cam has clean swing room.
        with Locations((0, 30.0, bmo_body.LID_T + 0.5)):
            Box(88.0, 34.0, 1.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for y in (14.0, 46.0):
            with Locations((0, y, bmo_body.LID_T + 2.3)):
                Box(82.0, 1.8, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 60.5, bmo_body.LID_T + 0.4)):
            Box(46.0, 14.0, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))

        # Cable tunnel between electronics shelf and walking engine.
        with Locations((0, -8.0, bmo_body.LID_T + 0.5)):
            Box(18.0, 70.0, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))

        # Passive balance pivot and low ballast guide. This does not magically
        # balance the robot; it gives a real pendulum/weight module somewhere to
        # swing so gravity biases the body back upright like an old toy.
        with Locations((0, 2.0, bmo_body.LID_T + 2.0)):
            Cylinder(5.0, 5.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 2.0, bmo_body.LID_T + 1.8)):
            Cylinder(1.7, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        with Locations((0, -68.0, bmo_body.LID_T + 0.6)):
            Box(34.0, 9.0, 1.6, align=(Align.CENTER, Align.CENTER, Align.MIN))

    return tray.part


def make_drive_motor():
    """Continuous servo/gearmotor that feeds the leg gearbox."""
    return make_servo_body("DRIVE").located(Location((0, DRIVE_SERVO_Y, 2.0), (0, 0, 90)))


def make_leg_gear_train():
    """Visible toy-walker gearbox: motor pinion -> flywheel -> opposed crank disks."""
    children = [
        make_spur_gear(DRIVE_PINION_R, 10, GEAR_T, bore_r=SHAFT_R).located(Location((0, PINION_Y, 12.0))),
        make_spur_gear(FLYWHEEL_R, 24, GEAR_T, bore_r=SHAFT_R).located(Location((0, GEAR_Y, 12.0))),
        make_crank_disk(radius=CRANK_GEAR_R, pin_offset=CRANK_PIN_R, pin_angle=35).located(Location((-24.0, GEAR_Y, 15.6))),
        make_crank_disk(radius=CRANK_GEAR_R, pin_offset=CRANK_PIN_R, pin_angle=215).located(Location((24.0, GEAR_Y, 15.6))),
    ]
    # Cross-shaft ties both crank disks together. This is the piece that makes
    # left/right legs stay 180 degrees out of phase like a mechanical toy.
    children.append(Cylinder(1.9, 55.0, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((-27.5, GEAR_Y, 17.3), (0, 90, 0))))
    for x, y in ((0.0, PINION_Y), (0.0, GEAR_Y), (-24.0, GEAR_Y), (24.0, GEAR_Y)):
        children.append(Cylinder(2.2, 6.5, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((x, y, 15.0))))
    return Compound(children=children)


def make_leg_linkages():
    """Crank rods, hip rockers, knee pulls, and ankle pulls for toy gait."""
    left_pin = (-24.0 + cos(radians(35)) * CRANK_PIN_R, GEAR_Y + sin(radians(35)) * CRANK_PIN_R)
    right_pin = (24.0 + cos(radians(215)) * CRANK_PIN_R, GEAR_Y + sin(radians(215)) * CRANK_PIN_R)
    children = [
        make_link_rod(left_pin, (-26.0, HIP_Y)).located(Location((0, 0, 16.2))),
        make_link_rod(right_pin, (26.0, HIP_Y)).located(Location((0, 0, 16.2))),
    ]
    for x in (-26.0, 26.0):
        children.append(Cylinder(5.0, 3.0, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((x, HIP_Y, 15.2))))
        children.append(make_link_rod((x - 8.0, HIP_Y), (x + 8.0, HIP_Y), width=5.2).located(Location((0, 0, 18.0))))
        lower = (x + (3.0 if x > 0 else -3.0), LOWER_OUTPUT_Y)
        children.append(make_link_rod((x, HIP_Y), lower, width=5.0).located(Location((0, 0, 14.0))))
        children.append(make_link_rod(lower, (x + (7.0 if x > 0 else -7.0), LOWER_OUTPUT_Y - 0.2), width=4.2).located(Location((0, 0, 12.0))))
    return Compound(children=children)


def make_walk_engine():
    """Combined printable walking engine module."""
    children = []
    for shape in (make_drive_motor(), make_leg_gear_train(), make_leg_linkages()):
        children.extend(flat_children(shape))
    return Compound(children=children)


def make_arm_servo_bodies():
    children = []
    for x, label in ((-ARM_SERVO_X, "L ARM"), (ARM_SERVO_X, "R ARM")):
        children.append(make_servo_body(label).located(Location((x, -22.0, 4.2), (0, 0, 90))))
    return Compound(children=children)


def make_arm_gear_links():
    """Shoulder gear reduction and coupler rods for both arms."""
    children = []
    for x in (-ARM_SERVO_X, ARM_SERVO_X):
        output_x = -ARM_OUTPUT_X if x < 0 else ARM_OUTPUT_X
        direction = -1 if x < 0 else 1
        children.append(make_spur_gear(ARM_PINION_R, 9, GEAR_T, bore_r=SHAFT_R).located(Location((x, -22.0, 31.0))))
        children.append(make_spur_gear(ARM_OUTPUT_GEAR_R, 13, GEAR_T, bore_r=SHAFT_R).located(Location((output_x, -23.0, 31.0))))
        children.append(make_link_rod((x, -22.0), (output_x, -23.0), width=3.4).located(Location((0, 0, 31.0))))
        children.append(make_link_rod((output_x, -23.0), (direction * 53.0, -23.0), width=4.2).located(Location((0, 0, 35.0))))
        children.append(Cylinder(2.8, 5.0, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((direction * 53.0, -23.0, 34.2))))
    return Compound(children=children)


def make_arm_servo_pack():
    children = []
    for shape in (make_arm_servo_bodies(), make_arm_gear_links()):
        children.extend(flat_children(shape))
    return Compound(children=children)


def make_gravity_balancer():
    """Passive pendulum ballast: gravity-biased, not active stabilization."""
    with BuildPart() as balancer:
        with Locations((0, 2.0, 25.5)):
            Cylinder(2.8, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        add(make_link_rod((0.0, 2.0), (0.0, -56.0), width=4.2).located(Location((0, 0, 24.8))))
        with Locations((0.0, -62.5, 24.0)):
            add(bmo_body.rounded_box(32.0, 11.0, 10.0, 3.0))
        with Locations((0.0, -62.5, 29.8)):
            Box(25.0, 1.4, 1.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    return balancer.part


def make_electronics_bay():
    """Simplified upper electronics placement for V2."""
    parts = [
        bmo_body.rounded_prism(54.0, 30.0, 8.0, 2.0).located(Location((-17.0, 30.0, 6.0))),
        bmo_body.rounded_prism(32.0, 20.0, 6.0, 2.0).located(Location((28.0, 32.0, 6.0))),
        bmo_body.rounded_prism(40.0, 13.0, 7.0, 2.0).located(Location((0.0, 60.5, 5.5))),
    ]
    return Compound(children=parts)


def make_v2_leg(side: str, pose: float = 0.0):
    outward = -1 if side == "left" else 1
    hip_x = -26.0 if side == "left" else 26.0
    swing = sin(radians(pose))
    lift = max(0.0, sin(radians(pose + 18.0)))
    knee = (hip_x + outward * (2.5 + 4.0 * swing), -85.5 + 4.0 * lift)
    ankle = (hip_x + outward * (4.0 + 7.0 * swing), -103.0 + 8.0 * lift)
    foot = (hip_x + outward * (7.0 + 9.0 * swing), -113.0 + 3.0 * lift)
    hip = (hip_x, -68.0)

    children = [
        make_link_rod(hip, knee, width=7.0).located(Location((0, 0, 4.0))),
        make_link_rod(knee, ankle, width=7.0).located(Location((0, 0, 4.0))),
        bmo_body.rounded_box(24.0, 12.0, 34.0, 3.4).located(Location((foot[0], foot[1], 0.0))),
    ]
    for point in (hip, knee, ankle):
        children.append(Cylinder(4.4, 5.5, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((point[0], point[1], 2.8))))
    children.append(make_link_rod(ankle, (foot[0] + outward * 8.0, foot[1]), width=4.8).located(Location((0, 0, 7.2))))
    return Compound(children=children)


def make_v2_mecha_assembly(fit_check: bool = False):
    front = bmo_body.make_front_shell(preview=True if not fit_check else False)
    children = [
        front,
        make_mecha_tray().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
        make_walk_engine().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
        make_arm_servo_pack().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
        make_gravity_balancer().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
        make_electronics_bay().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
        bmo_body.make_arm("left", include_connector=False).located(Location((-bmo_body.BODY_W / 2 - 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.48 - 3.9))),
        bmo_body.make_arm("right", include_connector=False).located(Location((bmo_body.BODY_W / 2 + 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.48 - 3.9))),
        make_v2_leg("left", pose=18).located(Location((0, -6.0, bmo_body.FRONT_DEPTH * 0.47 - 5.0))),
        make_v2_leg("right", pose=-18).located(Location((0, -6.0, bmo_body.FRONT_DEPTH * 0.47 - 5.0))),
    ]
    if fit_check:
        children.append(make_servo_body("SWAY").located(Location((0, 12.0, bmo_body.FRONT_DEPTH + 5.2))))
    return Compound(children=children)


def v2_print_kit_parts():
    """Named V2 build-plate layout, kept audit-able for overlap checks."""
    return [
        ("mecha_tray", make_mecha_tray().located(Location((-62.0, 42.0, 0)))),
        ("drive_motor", make_drive_motor().located(Location((30.0, 100.0, 0)))),
        ("leg_gear_train", make_leg_gear_train().located(Location((82.0, 96.0, 0)))),
        ("leg_linkages", make_leg_linkages().located(Location((78.0, 67.0, 0)))),
        ("arm_servo_bodies", make_arm_servo_bodies().located(Location((73.0, -10.0, 0)))),
        ("arm_gear_links", make_arm_gear_links().located(Location((66.0, -45.0, 0)))),
        ("gravity_balancer", make_gravity_balancer().located(Location((-90.0, -120.0, 0), (0, 0, 90)))),
        ("electronics_bay", make_electronics_bay().located(Location((-74.0, -112.0, 0)))),
        ("left_leg", make_v2_leg("left", pose=0).located(Location((86.0, -20.0, 0)))),
        ("right_leg", make_v2_leg("right", pose=0).located(Location((87.0, -20.0, 0)))),
    ]


def make_v2_print_kit():
    children = [shape for _, shape in v2_print_kit_parts()]
    return Compound(children=children)


def exports():
    return {
        "bmo_v2_mecha_tray": make_mecha_tray(),
        "bmo_v2_drive_motor": make_drive_motor(),
        "bmo_v2_leg_gear_train": make_leg_gear_train(),
        "bmo_v2_leg_linkages": make_leg_linkages(),
        "bmo_v2_walk_engine": make_walk_engine(),
        "bmo_v2_arm_servo_bodies": make_arm_servo_bodies(),
        "bmo_v2_arm_gear_links": make_arm_gear_links(),
        "bmo_v2_arm_servo_pack": make_arm_servo_pack(),
        "bmo_v2_gravity_balancer": make_gravity_balancer(),
        "bmo_v2_electronics_bay": make_electronics_bay(),
        "bmo_v2_left_leg": make_v2_leg("left", pose=18),
        "bmo_v2_right_leg": make_v2_leg("right", pose=-18),
        "bmo_v2_mecha_assembly": make_v2_mecha_assembly(fit_check=False),
        "bmo_v2_mecha_fit_check": make_v2_mecha_assembly(fit_check=True),
        "bmo_v2_print_kit": make_v2_print_kit(),
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
    print(f"Generated BMO mecha V2 CAD artifacts in {EXPORT_DIR}")


if __name__ == "__main__":
    main()
