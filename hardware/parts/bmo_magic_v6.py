"""BMO True Walker V6 CAD concept.

V6 targets the user's real constraint: 4 servos + 3D printed parts.

Architecture:
- Servo 1/2: left/right body-roll / weight-shift servos, mounted inside the
  lower body. They move short link rods to lean the body over the stance foot.
- Servo 3/4: left/right hip pitch. These swing the unweighted leg forward.
- No hidden wheels as the primary locomotion.

This is a quasi-static biped walker, not a runner. It needs wide feet, low
battery placement, grippy soles, slow gait timing, and ideally an IMU.
"""

from __future__ import annotations

from build123d import Align, Box, BuildPart, Compound, Cylinder, Location, Locations, Mode, Sphere, add

import bmo_body
import bmo_mecha_v2


A1_PLATE = 256.0

HIP_X = 29.0
HIP_Y = -74.0
HIP_Z = 23.0
ANKLE_Y = -119.0
ANKLE_Z = 16.0
LEG_LEN = 45.0

FOOT_W = 32.0
FOOT_L = 25.0
FOOT_H = 42.0
SOLE_T = 4.0

SERVO_POCKET_W = 24.8
SERVO_POCKET_H = 14.0
SERVO_POCKET_D = 25.5


def flat_children(shape):
    children = getattr(shape, "children", ())
    if not children:
        return [shape]
    flattened = []
    for child in children:
        flattened.extend(flat_children(child))
    return flattened


def make_servo_ghost(label: str):
    return bmo_mecha_v2.make_servo_body(label)


def make_hip_servo_cassette():
    """Internal lower-body cassette for four servos and low battery/ballast."""
    with BuildPart() as cassette:
        with Locations((0, -56.0, 8.0)):
            add(bmo_body.rounded_box(94.0, 58.0, 10.0, 2.0))

        # Rear row: hip-pitch servos swing each leg forward/back.
        for x in (-HIP_X, HIP_X):
            with Locations((x, -69.0, 9.0)):
                add(bmo_body.rounded_box(33.0, 18.0, 10.0, 1.8))
            with Locations((x, -69.0, 9.0)):
                Box(SERVO_POCKET_W, SERVO_POCKET_H, 11.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for sx in (-12.0, 12.0):
                with Locations((x + sx, -69.0, 6.0)):
                    Cylinder(1.15, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

            # Output shaft tower aligned with the printed leg hub.
            with Locations((x, -76.0, 17.0)):
                Cylinder(6.2, 16.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, -76.0, 17.0)):
                Cylinder(2.0, 17.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Front row: weight-shift servos. Keeping these inside the body avoids
        # the giant shoe look from the first V6 pass.
        for x in (-22.0, 22.0):
            with Locations((x, -43.0, 9.0)):
                add(bmo_body.rounded_box(33.0, 18.0, 10.0, 1.8))
            with Locations((x, -43.0, 9.0)):
                Box(SERVO_POCKET_W, SERVO_POCKET_H, 11.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            for sx in (-12.0, 12.0):
                with Locations((x + sx, -43.0, 6.0)):
                    Cylinder(1.15, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            with Locations((x, -32.5, 16.0)):
                Cylinder(5.4, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((x, -32.5, 16.0)):
                Cylinder(1.8, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Low battery/ballast shelf. This matters more than it looks.
        with Locations((0, -22.0, 9.0)):
            add(bmo_body.rounded_box(62.0, 17.0, 8.0, 2.0))
        with Locations((0, -22.0, 9.2)):
            Box(54.0, 9.0, 8.8, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        for x in (-39.0, 39.0):
            for y in (-80.0, -21.0):
                with Locations((x, y, 5.5)):
                    Cylinder(2.8, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
                with Locations((x, y, 5.5)):
                    Cylinder(1.15, 6.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return cassette.part


def make_leg_link(side: str):
    """Rigid printable leg link; hip pitch is active, knee is omitted for 4-servo simplicity."""
    sign = -1 if side == "left" else 1
    with BuildPart() as leg:
        with Locations((0, 0, 0)):
            Cylinder(8.8, 8.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(2.1, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, -10.0, 0)):
            add(bmo_body.rounded_box(13.0, 22.0, 8.0, 2.4))
        bmo_body.tube_along([(0, 0, 0), (sign * 1.5, -20.0, -0.8), (sign * 2.5, -LEG_LEN, -1.4)], 6.6)
        with Locations((sign * 2.5, -LEG_LEN, -1.4)):
            Sphere(7.4)
            Cylinder(1.6, 9.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((sign * 8.5, -18.0, -0.5)):
            Cylinder(2.5, 4.5, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(1.05, 5.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return leg.part


def make_foot_module(side: str):
    """Slim passive rocker foot shaped closer to BMO."""
    sign = -1 if side == "left" else 1
    with BuildPart() as foot:
        with Locations((0, 0, 0)):
            add(bmo_body.rounded_box(FOOT_W, FOOT_L, FOOT_H, 5.2))
        # Flat TPU/rubber pad lanes on the underside.
        for y in (-6.5, 6.5):
            with Locations((0, y, -FOOT_H / 2 + SOLE_T / 2)):
                Box(FOOT_W - 7.0, 4.6, SOLE_T + 0.5, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Top ankle yoke and roll-axis bore. The servo is inside the body; this
        # foot only needs a passive pin and a linkage pickup.
        for x in (-9.0, 9.0):
            with Locations((x, 0.0, FOOT_H / 2 + 5.0)):
                add(bmo_body.rounded_box(4.8, 15.0, 10.0, 1.5))
        with Locations(Location((0, 0.0, FOOT_H / 2 + 5.0), (90, 0, 0))):
            Cylinder(1.7, 26.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Link pickup for the body-roll rod.
        with Locations((sign * 9.5, 2.5, FOOT_H / 2 + 6.5)):
            Cylinder(2.4, 4.6, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            Cylinder(0.95, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Toe and heel pads give a BMO boot silhouette without giant shoes.
        for y, label_z in ((FOOT_L / 2 - 3.8, -FOOT_H / 2 + 2.0), (-FOOT_L / 2 + 4.8, -FOOT_H / 2 + 2.0)):
            with Locations((sign * 1.6, y, label_z)):
                add(bmo_body.rounded_box(FOOT_W - 7.0, 6.5, 4.5, 2.0))
    return foot.part


def make_weight_shift_linkages():
    """Visible link rods from internal roll servos to passive ankle rocker feet."""
    with BuildPart() as links:
        for sign in (-1, 1):
            x = sign * HIP_X
            servo_x = sign * 22.0
            # Servo crank disk.
            with Locations((servo_x, -32.5, 16.0)):
                Cylinder(4.8, 2.4, align=(Align.CENTER, Align.CENTER, Align.CENTER))
            with Locations((servo_x, -32.5, 16.0)):
                Cylinder(1.0, 3.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
            bmo_body.tube_along(
                [
                    (servo_x, -35.5, 16.0),
                    (x, -70.0, 18.0),
                    (x + sign * 9.5, -119.0, FOOT_H / 2 + ANKLE_Z + 5.0),
                ],
                1.55,
                end_ball=True,
            )
            with Locations((x + sign * 9.5, -119.0, FOOT_H / 2 + ANKLE_Z + 5.0)):
                Cylinder(0.95, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return links.part


def make_servo_horn_clamp():
    """Small printable clamp/coupler for standard micro-servo horns."""
    with BuildPart() as clamp:
        Cylinder(7.0, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        with Locations((0, 0, 0)):
            Cylinder(2.1, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        with Locations((0, 0, 0)):
            Box(18.0, 4.0, 4.0, align=(Align.CENTER, Align.CENTER, Align.CENTER))
        for x in (-6.0, 6.0):
            with Locations((x, 0, 0)):
                Cylinder(1.0, 5.2, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return clamp.part


def make_servo_fit_ghosts():
    children = []
    for x, y, label in ((-HIP_X, -69.0, "HIP L"), (HIP_X, -69.0, "HIP R")):
        children.append(make_servo_ghost(label).located(Location((x, y, 8.5), (0, 0, 90))))
    for x, label in ((-22.0, "ROLL L"), (22.0, "ROLL R")):
        children.append(make_servo_ghost(label).located(Location((x, -43.0, 8.5), (0, 0, 90))))
    return Compound(children=children)


def make_v6_walker_assembly():
    return Compound(
        children=[
            bmo_body.make_front_shell(preview=True),
            bmo_body.make_rear_lid().located(Location((0, 0, bmo_body.FRONT_DEPTH + 0.8))),
            make_hip_servo_cassette().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_servo_fit_ghosts().located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))),
            make_weight_shift_linkages(),
            make_leg_link("left").located(Location((-HIP_X, HIP_Y, HIP_Z))),
            make_leg_link("right").located(Location((HIP_X, HIP_Y, HIP_Z))),
            make_foot_module("left").located(Location((-HIP_X, ANKLE_Y, ANKLE_Z))),
            make_foot_module("right").located(Location((HIP_X, ANKLE_Y, ANKLE_Z))),
        ]
    )


def print_kit_parts():
    return [
        ("hip_servo_cassette", make_hip_servo_cassette().located(Location((-70.0, 66.0, 0)))),
        ("left_leg_link", make_leg_link("left").located(Location((36.0, 88.0, 0), (0, 0, -90)))),
        ("right_leg_link", make_leg_link("right").located(Location((76.0, 88.0, 0), (0, 0, 90)))),
        ("left_foot_module", make_foot_module("left").located(Location((-62.0, -50.0, 0)))),
        ("right_foot_module", make_foot_module("right").located(Location((12.0, -50.0, 0)))),
        ("weight_shift_linkages", make_weight_shift_linkages().located(Location((-4.0, -12.0, -10.0), (0, 0, 90)))),
        ("horn_clamps", Compound(children=[
            make_servo_horn_clamp().located(Location((72.0 + i * 18.0, -42.0, 0)))
            for i in range(4)
        ])),
    ]


def make_print_kit():
    return Compound(children=[shape for _, shape in print_kit_parts()])


def exports():
    return {
        "bmo_v6_hip_servo_cassette": make_hip_servo_cassette(),
        "bmo_v6_left_leg_link": make_leg_link("left"),
        "bmo_v6_right_leg_link": make_leg_link("right"),
        "bmo_v6_left_foot_module": make_foot_module("left"),
        "bmo_v6_right_foot_module": make_foot_module("right"),
        "bmo_v6_servo_horn_clamp": make_servo_horn_clamp(),
        "bmo_v6_servo_fit_ghosts": make_servo_fit_ghosts(),
        "bmo_v6_weight_shift_linkages": make_weight_shift_linkages(),
        "bmo_v6_true_walker_assembly": make_v6_walker_assembly(),
        "bmo_v6_true_walker_print_kit": make_print_kit(),
    }


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def main():
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name != "bmo_v6_servo_fit_ghosts")
        print(describe_shape(name, shape))
    print(f"Generated BMO True Walker V6 artifacts in {bmo_body.EXPORT_DIR}")


if __name__ == "__main__":
    main()
