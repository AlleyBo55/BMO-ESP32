"""BMO Magic Locomotion V3 CAD concept.

V2 tried to make tiny exposed clockwork legs do the whole job. This V3 uses a
more reliable illusion: hidden differential drive wheels move the body, while
small cams/servos make the arms and leg shells twitch like a haunted toy.
"""

from __future__ import annotations

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
CHASSIS_W = 96.0
CHASSIS_H = 60.0
CHASSIS_T = 3.2


def make_n20_motor(label: str):
    """Approximate N20 micro gearmotor envelope, shaft points toward wheel."""
    with BuildPart() as motor:
        add(bmo_body.rounded_box(N20_W, N20_H, N20_L, 1.8))
        with Locations((0, -N20_H / 2 - 1.0, 0)):
            Box(N20_W + 5.0, 2.0, N20_L - 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, N20_L / 2 + 2.2)):
            Cylinder(1.1, 4.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
    return motor.part


def make_drive_wheel():
    with BuildPart() as wheel:
        Cylinder(WHEEL_R, WHEEL_W, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, 0)):
            Cylinder(WHEEL_R * 0.52, WHEEL_W + 0.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, 0, -WHEEL_W / 2 - 0.3)):
            Cylinder(WHEEL_R * 0.62, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, WHEEL_W / 2 - 0.5)):
            Cylinder(WHEEL_R * 0.62, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return wheel.part


def make_magic_chassis():
    """Internal bottom chassis that carries motors, caster, balance, and wires."""
    with BuildPart() as chassis:
        with Locations((0, -48.0, 2.0)):
            add(bmo_body.rounded_box(CHASSIS_W, CHASSIS_H, CHASSIS_T, 1.2))

        # Motor saddles and removable strap tabs.
        for x in (-34.0, 34.0):
            with Locations((x, -48.0, 6.0)):
                add(bmo_body.rounded_box(18.0, 16.0, 5.0, 2.0))
            with Locations((x, -48.0, 6.2)):
                Box(13.4, 11.4, 6.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for y in (-56.0, -40.0):
                with Locations((x, y, 5.6)):
                    Cylinder(1.25, 3.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Front/back wire gutters. Keep this open: the body still needs the
        # screen, speaker, heart/electronics, and charging harness.
        with Locations((0, -21.0, 5.0)):
            Box(72.0, 4.0, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, -73.0, 5.0)):
            Box(72.0, 4.0, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # Caster socket at rear center.
        with Locations((0, -73.0, 5.8)):
            Cylinder(6.0, 4.8, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, -73.0, 5.8)):
            Cylinder(3.4, 6.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

    return chassis.part


def make_hidden_drive():
    """Two N20 motors plus wheel envelopes, hidden behind BMO's feet/skirt."""
    children = []
    for side, x in (("L", -34.0), ("R", 34.0)):
        children.append(make_n20_motor(side).located(Location((x, -48.0, 14.0))))
        children.append(
            make_drive_wheel().located(Location((x, -77.0, 18.0), (0, 90, 0)))
        )
        # Faux foot skirt. The wheel does the moving; this sells the BMO look.
        children.append(
            bmo_body.rounded_box(25.0, 11.0, 18.0, 3.0).located(Location((x, -82.0, 18.0)))
        )
    return Compound(children=children)


def make_leg_illusion_crank():
    """Small cam bar for shuffling the leg shells while wheels move the body."""
    children = [
        bmo_mecha_v2.make_servo_body("LEG CAM").located(Location((0, -55.0, 9.0), (0, 0, 90))),
        bmo_mecha_v2.make_spur_gear(9.0, 12, 3.0, bore_r=1.3).located(Location((0, -64.0, 35.0))),
    ]
    for x in (-22.0, 22.0):
        children.append(
            bmo_mecha_v2.make_link_rod((0, -64.0), (x, -77.0), width=3.6).located(Location((0, 0, 36.0)))
        )
        children.append(Cylinder(2.4, 4.0, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(Location((x, -77.0, 35.0))))
    return Compound(children=children)


def make_balance_caster():
    """Low rear caster plus removable ballast pocket for stable roaming."""
    children = [
        Sphere(5.2).located(Location((0, -81.0, 34.0))),
        bmo_body.rounded_box(42.0, 10.0, 14.0, 3.0).located(Location((0, -69.0, 28.0))),
        bmo_mecha_v2.make_gravity_balancer().located(Location((0, 0, 4.0))),
    ]
    return Compound(children=children)


def make_electronics_deck():
    """Upper shelf for ESP32/breadboard, motor driver, and power organs."""
    children = [
        bmo_body.rounded_box(88.0, 48.0, 7.0, 3.0).located(Location((0, 24.0, 8.0))),
        bmo_body.rounded_box(34.0, 20.0, 5.0, 2.0).located(Location((-27.0, 30.0, 14.0))),
        bmo_body.rounded_box(32.0, 18.0, 5.0, 2.0).located(Location((27.0, 30.0, 14.0))),
        bmo_body.rounded_box(44.0, 12.0, 5.0, 2.0).located(Location((0, 55.0, 14.0))),
    ]
    return Compound(children=children)


def make_haunted_arm(side: str):
    """Segmented arm shell that can read as shoulder/elbow/wrist motion."""
    outward = -1 if side == "left" else 1
    with BuildPart() as arm:
        # Shoulder, elbow, wrist balls make the possible motion obvious. The
        # real mechanism can be a servo shoulder plus a loose elbow/spring link.
        with Locations((0.0, 0.0, 0.0)):
            Cylinder(6.4, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((outward * 8.0, 22.0, 1.0)):
            Sphere(4.6)
        with Locations((outward * 15.0, 43.0, -1.5)):
            Sphere(4.0)

        bmo_body.tube_along(
            [
                (0.0, 0.0, 0.0),
                (outward * 4.0, 10.0, 0.5),
                (outward * 8.0, 22.0, 1.0),
            ],
            3.5,
        )
        bmo_body.tube_along(
            [
                (outward * 8.0, 22.0, 1.0),
                (outward * 12.0, 33.0, 0.0),
                (outward * 15.0, 43.0, -1.5),
            ],
            3.2,
        )
        with Locations((outward * 17.0, 49.0, -2.0)):
            add(bmo_body.rounded_box(11.0, 10.0, 5.0, 2.0))
        for offset in (-3.4, 0.0, 3.4):
            with Locations((outward * 17.0 + offset, 54.0, -2.0)):
                add(bmo_body.rounded_box(2.8, 6.0, 4.2, 1.2))
        # Small rear coupler tab for a horn, spring, or fishing-line pull.
        with Locations((outward * 1.0, -5.0, 0.0)):
            add(bmo_body.rounded_box(8.0, 5.0, 4.0, 1.5))
    return arm.part


def make_haunted_leg(side: str):
    """Segmented leg shell with hip/knee/ankle cues and a rocker foot."""
    outward = -1 if side == "left" else 1
    with BuildPart() as leg:
        hip = (0.0, 16.0, 5.0)
        knee = (outward * 2.5, -1.0, 4.0)
        ankle = (outward * 5.5, -17.5, 1.0)
        foot = (outward * 7.0, -26.0, 8.0)

        for point, radius in ((hip, 4.8), (knee, 4.2), (ankle, 3.8)):
            with Locations(point):
                Sphere(radius)

        bmo_body.tube_along([hip, (outward * 1.0, 7.0, 4.8), knee], 3.7)
        bmo_body.tube_along([knee, (outward * 4.0, -10.0, 2.5), ankle], 3.4)

        # Rocker foot: rounded on top, flatter underneath, long enough to show
        # fore/aft roll while the hidden wheel carries the real load.
        with Locations(foot):
            add(bmo_body.rounded_box(25.0, 11.0, 34.0, 3.0))
        with Locations((foot[0], foot[1] - 6.0, foot[2])):
            Box(20.0, 1.4, 28.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))

        # Cam pull eyelet; this is what makes the leg shape look capable of
        # forward/back shuffle instead of only vertical bobbing.
        with Locations((outward * 9.5, 4.0, 4.5)):
            Cylinder(2.8, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.2, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return leg.part


def make_magic_assembly():
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            make_magic_chassis().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_hidden_drive().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_leg_illusion_crank().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_balance_caster().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_electronics_deck().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_haunted_arm("left").located(Location((-bmo_body.BODY_W / 2 - 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.48 - 3.9))),
            make_haunted_arm("right").located(Location((bmo_body.BODY_W / 2 + 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.48 - 3.9))),
            make_haunted_leg("left").located(Location((-26.0, -93.0, bmo_body.FRONT_DEPTH * 0.47 - 5.0))),
            make_haunted_leg("right").located(Location((26.0, -93.0, bmo_body.FRONT_DEPTH * 0.47 - 5.0))),
        ]
    )


def make_print_kit():
    return Compound(
        children=[
            make_magic_chassis().located(Location((-72.0, 72.0, 0))),
            make_hidden_drive().located(Location((58.0, 72.0, 0))),
            make_leg_illusion_crank().located(Location((-78.0, -8.0, 0))),
            make_balance_caster().located(Location((48.0, -16.0, 0))),
            make_electronics_deck().located(Location((-56.0, -100.0, 0))),
            make_haunted_arm("left").located(Location((90.0, -16.0, 0), (0, 0, -90))),
            make_haunted_arm("right").located(Location((110.0, -16.0, 0), (0, 0, 90))),
            make_haunted_leg("left").located(Location((88.0, -88.0, 0))),
            make_haunted_leg("right").located(Location((118.0, -88.0, 0))),
        ]
    )


def exports():
    return {
        "bmo_v3_magic_chassis": make_magic_chassis(),
        "bmo_v3_hidden_drive": make_hidden_drive(),
        "bmo_v3_leg_illusion_crank": make_leg_illusion_crank(),
        "bmo_v3_balance_caster": make_balance_caster(),
        "bmo_v3_electronics_deck": make_electronics_deck(),
        "bmo_v3_left_haunted_arm": make_haunted_arm("left"),
        "bmo_v3_right_haunted_arm": make_haunted_arm("right"),
        "bmo_v3_left_haunted_leg": make_haunted_leg("left"),
        "bmo_v3_right_haunted_leg": make_haunted_leg("right"),
        "bmo_v3_magic_assembly": make_magic_assembly(),
        "bmo_v3_print_kit": make_print_kit(),
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
    print(f"Generated BMO Magic Locomotion V3 artifacts in {bmo_body.EXPORT_DIR}")


if __name__ == "__main__":
    main()
