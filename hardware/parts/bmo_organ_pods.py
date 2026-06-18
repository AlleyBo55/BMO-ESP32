"""Printable snap-fit "organ" wrappers for BMO electronics.

Each electronic module gets a themed two-piece pod:
- base: shallow open box with cable in/out notches and snap pegs
- lid: matching cap with snap sockets

The shapes are intentionally stylized organs, not anatomical models. They are
printable, inspectable, and parametric so exact module dimensions can be tuned
after measuring the real parts.
"""

from __future__ import annotations

from math import cos, radians, sin
from pathlib import Path

from build123d import (
    Align,
    Box,
    BuildPart,
    BuildSketch,
    Compound,
    Cylinder,
    Location,
    Locations,
    Mode,
    Polygon,
    RectangleRounded,
    add,
    export_gltf,
    export_step,
    export_stl,
    extrude,
)

from bmo_body import EXPORT_DIR, ORGAN_KEY_SLOTS, ORGAN_PLACEMENTS, write_basic_3mf
from bmo_component_specs import Envelope
import bmo_component_specs as component_specs


WALL = 1.8
BASE_D = 10.0
LID_D = 2.4
SNAP_R = 1.15
SNAP_H = 1.8
SOCKET_R = 1.35
SNAP_SOCKET_COLLAR_R = 2.45
CABLE_W = 10.5
CABLE_H = 6.0
RIBBON_W = 16.0
KEEPER_LIP_T = 0.9
MOUNT_SOCKET_R = 1.85
MOUNT_SOCKET_D = 3.4
HEART_PLUG_R = 1.55
HEART_SOCKET_R = 1.9
HEART_SOCKET_COLLAR_R = 3.3
HEART_PIN_PROUD = 2.4
HEART_LOCK_POINTS = [(-31.0, 7.0), (31.0, 7.0), (-27.0, -8.0), (27.0, -8.0)]

# Published cavity sizes are part of the fit contract. They describe actual
# empty volume after wall subtraction, not the outside decorative envelope.
ORGAN_CAVITIES = {
    "esp32_heart": Envelope(56.0, 38.5, 27.2),
    "mic_ear": Envelope(28.4, 22.4, 7.7),
    "i2s_lung": Envelope(28.5, 22.0, 12.2),
    "touch_spark": Envelope(27.4, 27.4, 6.2),
    "battery_cell": Envelope(36.4, 53.4, 12.2),
    "charge_kidney": Envelope(32.4, 23.4, 7.2),
    "boost_gland": Envelope(37.4, 22.4, 15.2),
}


ORGAN_MOUNT_POINTS = {
    "esp32_heart": [(-24.0, -12.0), (24.0, -12.0), (-16.0, 20.0), (16.0, 20.0)],
    "mic_ear": [(-8.0, 0.0), (8.0, 0.0)],
    "i2s_lung": [(-10.0, -2.0), (10.0, -2.0)],
    "touch_spark": [(-9.0, 0.0), (9.0, 0.0)],
    "battery_cell": [(-17.0, 0.0), (17.0, 0.0)],
    "charge_kidney": [(-10.0, 0.0), (10.0, 0.0)],
    "boost_gland": [(-11.0, 0.0), (11.0, 0.0)],
}


def rounded_prism(width: float, height: float, depth: float, radius: float):
    with BuildPart() as part:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=depth)
    return part.part


def star_points(outer: float, inner: float, count: int = 5):
    pts = []
    for index in range(count * 2):
        radius = outer if index % 2 == 0 else inner
        angle = radians(90 + index * 180 / count)
        pts.append((cos(angle) * radius, sin(angle) * radius))
    return pts


def honeycomb_points(center_x: float = 0.0, center_y: float = 0.0, spacing: float = 5.8):
    rows = (3, 4, 5, 4, 3)
    for row_index, count in enumerate(rows):
        y = center_y + (row_index - 2) * spacing * 0.88
        for col_index in range(count):
            x = center_x + (col_index - (count - 1) / 2) * spacing
            yield x, y


def cut_top_honeycomb(depth: float, radius: float = 2.2, center_x: float = 0.0, center_y: float = 0.0):
    for x, y in honeycomb_points(center_x, center_y, spacing=5.7):
        with Locations((x, y, -0.2)):
            Cylinder(radius, depth + 0.6, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def star_prism(outer: float, inner: float, depth: float):
    with BuildPart() as star:
        with BuildSketch():
            Polygon(*star_points(outer, inner))
        extrude(amount=depth)
    return star.part


def add_snap_pegs(width: float, height: float, z: float):
    for x in (-width / 2 + 5.0, width / 2 - 5.0):
        for y in (-height / 2 + 5.0, height / 2 - 5.0):
            with Locations((x, y, z)):
                Cylinder(SNAP_R, SNAP_H, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cut_snap_sockets(width: float, height: float, depth: float):
    for x in (-width / 2 + 5.0, width / 2 - 5.0):
        for y in (-height / 2 + 5.0, height / 2 - 5.0):
            with Locations((x, y, -0.25)):
                Cylinder(SOCKET_R, depth + 0.5, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)


def add_snap_socket_collars(width: float, height: float, depth: float):
    for x in (-width / 2 + 5.0, width / 2 - 5.0):
        for y in (-height / 2 + 5.0, height / 2 - 5.0):
            with Locations((x, y, depth)):
                Cylinder(SNAP_SOCKET_COLLAR_R, 0.45, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cut_mount_sockets(points):
    """Underside sockets that drop onto rear-tray locator pegs."""
    for x, y in points:
        with Locations((x, y, -0.2)):
            Cylinder(
                MOUNT_SOCKET_R,
                MOUNT_SOCKET_D,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )


def cut_key_sockets(key: str):
    """Underside keyed slots so each organ only fits its matching tray rails."""
    for x, y, width, height in ORGAN_KEY_SLOTS[key]:
        with Locations((x, y, -0.2)):
            Box(
                width + 0.55,
                height + 0.55,
                MOUNT_SOCKET_D,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )


def add_heart_plug_posts(depth: float):
    """Tall visible male pins that plug the heart lid to the heart base."""
    for x, y in HEART_LOCK_POINTS:
        with Locations((x, y, 0.0)):
            Cylinder(HEART_PLUG_R, depth + HEART_PIN_PROUD, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((x, y, depth + HEART_PIN_PROUD - 0.55)):
            Cylinder(HEART_PLUG_R + 0.35, 0.55, align=(Align.CENTER, Align.CENTER, Align.MIN))


def add_heart_socket_collars(depth: float):
    """Raised rings make the matching heart lid socket holes readable on the print plate."""
    for x, y in HEART_LOCK_POINTS:
        with Locations((x, y, depth)):
            Cylinder(HEART_SOCKET_COLLAR_R, 0.75, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cut_heart_socket_holes(depth: float):
    for x, y in HEART_LOCK_POINTS:
        with Locations((x, y, -0.25)):
            Cylinder(
                HEART_SOCKET_R,
                depth + 1.4,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )


def cut_cable_port(
    width: float,
    height: float,
    depth: float,
    side: str,
    *,
    offset: float = 0.0,
    slot_w: float = CABLE_W,
    slot_h: float = CABLE_H,
):
    """Cut a side slot big enough for Dupont housings and wire bundles."""
    if side == "left":
        with Locations((-width / 2, offset, depth * 0.55)):
            Box(slot_h, slot_w, slot_h, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    elif side == "right":
        with Locations((width / 2, offset, depth * 0.55)):
            Box(slot_h, slot_w, slot_h, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    elif side == "top":
        with Locations((offset, height / 2, depth * 0.55)):
            Box(slot_w, slot_h, slot_h, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    elif side == "bottom":
        with Locations((offset, -height / 2, depth * 0.55)):
            Box(slot_w, slot_h, slot_h, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)


def add_cable_guide(width: float, height: float, side: str, *, offset: float = 0.0, span: float = 16.0):
    """Raised press rails near each port so wire bundles clip into place."""
    z = WALL
    if side == "left":
        for x in (-width / 2 + 6.5, -width / 2 + 12.0):
            with Locations((x, offset, z)):
                Box(1.4, span, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x + 0.8, offset, z + 2.0)):
                Box(3.2, span, KEEPER_LIP_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    elif side == "right":
        for x in (width / 2 - 6.5, width / 2 - 12.0):
            with Locations((x, offset, z)):
                Box(1.4, span, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((x - 0.8, offset, z + 2.0)):
                Box(3.2, span, KEEPER_LIP_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    elif side == "top":
        for y in (height / 2 - 6.5, height / 2 - 12.0):
            with Locations((offset, y, z)):
                Box(span, 1.4, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((offset, y - 0.8, z + 2.0)):
                Box(span, 3.2, KEEPER_LIP_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    elif side == "bottom":
        for y in (-height / 2 + 6.5, -height / 2 + 12.0):
            with Locations((offset, y, z)):
                Box(span, 1.4, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
            with Locations((offset, y + 0.8, z + 2.0)):
                Box(span, 3.2, KEEPER_LIP_T, align=(Align.CENTER, Align.CENTER, Align.MIN))


def cut_cable_notches(width: float, height: float, depth: float, sides=("left", "right")):
    for side in sides:
        cut_cable_port(width, height, depth, side)


def add_cable_guides(width: float, height: float, sides=("left", "right")):
    for side in sides:
        add_cable_guide(width, height, side)


def add_lid_pull_tab(width: float, height: float):
    with Locations((0, -height / 2 - 2.5, 0.0)):
        Box(min(width * 0.46, 18.0), 3.0, 1.4, align=(Align.CENTER, Align.CENTER, Align.MIN))


def make_rounded_case(
    width: float,
    height: float,
    depth: float,
    radius: float,
    sides=("left", "right"),
    mount_points=None,
    key: str | None = None,
):
    """Generic rounded base and lid with snap details."""
    with BuildPart() as base:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=depth)
        with Locations((0, 0, WALL)):
            Box(width - 2 * WALL, height - 2 * WALL, depth, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        cut_cable_notches(width, height, depth, sides)
        add_cable_guides(width, height, sides)
        cut_mount_sockets(mount_points or [(-width * 0.25, 0.0), (width * 0.25, 0.0)])
        if key:
            cut_key_sockets(key)
        add_snap_pegs(width, height, depth - 0.15)
        # Small inside ledges keep the module from sliding during shakes.
        for y in (-height * 0.22, height * 0.22):
            with Locations((0, y, WALL)):
                Box(width * 0.45, 1.2, 1.8, align=(Align.CENTER, Align.CENTER, Align.MIN))

    with BuildPart() as lid:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=LID_D)
        add_snap_socket_collars(width, height, LID_D)
        cut_snap_sockets(width, height, LID_D)
        cut_cable_notches(width, height, LID_D, sides)
        add_lid_pull_tab(width, height)

    return base.part, lid.part


def make_heart_case():
    """Core heart pod for ESP32 plus breadboard/extension board.

    The heart is intentionally the biggest organ. It has cable ports on every
    side so mic, amp, touch, display, speaker, battery, charge, and boost
    wires can route in and out without pinching.
    """
    width, height = 70.0, 58.0
    cavity = ORGAN_CAVITIES["esp32_heart"]
    depth = cavity.depth + WALL
    hub_ports = (
        ("top", -22.0, CABLE_W),
        ("top", 0.0, RIBBON_W),
        ("top", 22.0, CABLE_W),
        ("bottom", -18.0, CABLE_W),
        ("bottom", 18.0, CABLE_W),
        ("left", -18.0, CABLE_W),
        ("left", 14.0, CABLE_W),
        ("right", -18.0, CABLE_W),
        ("right", 14.0, CABLE_W),
    )
    with BuildPart() as base:
        with Locations((-15.5, 12.0, 0.0)):
            Cylinder(17.5, depth, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((15.5, 12.0, 0.0)):
            Cylinder(17.5, depth, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with BuildSketch():
            Polygon((-35, 11), (35, 11), (28, -13), (0, -30), (-28, -13))
        extrude(amount=depth)
        # Main electronics bay for a mini breadboard with the ESP32-C3 Super
        # Mini already plugged into it as one removable block.
        with Locations((0, -1.0, WALL)):
            Box(
                cavity.width,
                cavity.height,
                depth,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )
        # Four low corner clips keep the breadboard from sliding without
        # blocking the jumper area in the center.
        for x in (-25.0, 25.0):
            for y in (-18.0, 15.0):
                with Locations((x, y, WALL)):
                    Box(7.0, 1.5, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
                with Locations((x, y, WALL)):
                    Box(1.5, 7.0, 2.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
        for side, offset, slot_w in hub_ports:
            cut_cable_port(width, height, depth, side, offset=offset, slot_w=slot_w)
            add_cable_guide(width, height, side, offset=offset, span=slot_w + 4.0)
        cut_mount_sockets(ORGAN_MOUNT_POINTS["esp32_heart"])
        cut_key_sockets("esp32_heart")
        add_heart_plug_posts(depth)

    with BuildPart() as lid:
        with Locations((-15.5, 12.0, 0.0)):
            Cylinder(17.5, LID_D, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((15.5, 12.0, 0.0)):
            Cylinder(17.5, LID_D, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with BuildSketch():
            Polygon((-35, 11), (35, 11), (28, -13), (0, -30), (-28, -13))
        extrude(amount=LID_D)
        add_heart_socket_collars(LID_D)
        cut_heart_socket_holes(LID_D)
        for side, offset, slot_w in hub_ports:
            cut_cable_port(width, height, LID_D, side, offset=offset, slot_w=slot_w)
        # Small raised pulse line: decorative and gives fingers something to
        # press while popping the lid off.
        with Locations((0, 2.0, LID_D)):
            Box(30.0, 1.8, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((-10.0, 6.0, LID_D)):
            Box(1.8, 8.0, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((10.0, -3.0, LID_D)):
            Box(1.8, 8.0, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN))
        add_lid_pull_tab(width, height)

    return base.part, lid.part


def make_ear_case():
    base, lid = make_rounded_case(
        32.0,
        26.0,
        9.5,
        11.0,
        ("bottom", "right"),
        ORGAN_MOUNT_POINTS["mic_ear"],
        "mic_ear",
    )
    with BuildPart() as ear_ridge:
        with Locations((-5.0, 0.0, 0.0)):
            Cylinder(5.2, 1.1, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((3.5, -1.5, 0.0)):
            Cylinder(2.4, 1.1, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return base, Compound(children=[lid, ear_ridge.part.located(Location((0, 0, LID_D)))])


def make_lung_case():
    """MAX98357 I2S amplifier / voice lung pod with heart and speaker ports."""
    width, height = 38.0, 31.0
    cavity = ORGAN_CAVITIES["i2s_lung"]
    depth = cavity.depth + WALL
    with BuildPart() as base:
        with BuildSketch():
            RectangleRounded(width, height, 10.0)
        extrude(amount=depth)
        with Locations((0, 0, WALL)):
            Box(
                cavity.width,
                cavity.height,
                depth,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )
        # Left routes I2S/power from the heart; right routes amp output to the side speaker.
        cut_cable_notches(width, height, depth, ("left", "right", "top"))
        add_cable_guides(width, height, ("left", "right", "top"))
        cut_mount_sockets(ORGAN_MOUNT_POINTS["i2s_lung"])
        cut_key_sockets("i2s_lung")
        add_snap_pegs(34.0, 25.0, depth - 0.15)
        with Locations((0, 0, WALL)):
            Box(24.6, 19.4, 1.0, align=(Align.CENTER, Align.CENTER, Align.MIN))

    with BuildPart() as lid:
        with BuildSketch():
            RectangleRounded(width, height, 10.0)
        extrude(amount=LID_D)
        add_snap_socket_collars(34.0, 25.0, LID_D)
        cut_snap_sockets(34.0, 25.0, LID_D)
        cut_cable_notches(width, height, LID_D, ("left", "right", "top"))
        add_lid_pull_tab(width, height)
        # A shallow center seam keeps the wrapper readable as paired lungs
        # without weakening the rectangular component cavity below.
        with Locations((0, 0, LID_D)):
            Box(1.4, height - 7.0, 0.7, align=(Align.CENTER, Align.CENTER, Align.MIN))

    return base.part, lid.part


def make_star_case():
    """Touch sensor spark/star pod."""
    width, height, depth, radius = 31.0, 31.0, 8.0, 7.0
    with BuildPart() as base:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=depth)
        with Locations((0, 0, WALL)):
            Box(width - 2 * WALL, height - 2 * WALL, depth, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        cut_cable_notches(width, height, depth, ("bottom", "top"))
        add_cable_guides(width, height, ("bottom", "top"))
        cut_mount_sockets(ORGAN_MOUNT_POINTS["touch_spark"])
        cut_key_sockets("touch_spark")
        add_snap_pegs(width, height, depth - 0.15)
        # The sensor board should sit directly under the thin lid window.
        with Locations((0, 0, WALL)):
            Box(24.0, 24.0, 1.0, align=(Align.CENTER, Align.CENTER, Align.MIN))

    with BuildPart() as lid:
        with BuildSketch():
            RectangleRounded(width, height, radius)
        extrude(amount=LID_D)
        # Recess the underside and leave about 0.8 mm of plastic as the
        # capacitive touch surface. Keep the TTP223 pad pressed close to this.
        with Locations((0, 0, -0.2)):
            Box(23.0, 23.0, LID_D - 0.6, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        add_snap_socket_collars(width, height, LID_D)
        cut_snap_sockets(width, height, LID_D)
        cut_cable_notches(width, height, LID_D, ("bottom", "top"))
        add_lid_pull_tab(width, height)

    spark = star_prism(12.5, 5.4, 0.35).located(Location((0, 0, LID_D)))
    return base.part, Compound(children=[lid.part, spark])


def make_energy_cell_case():
    """Battery energy-cell pod."""
    cavity = ORGAN_CAVITIES["battery_cell"]
    base, lid = make_rounded_case(
        cavity.width + 2 * WALL,
        cavity.height + 2 * WALL,
        cavity.depth + WALL,
        8.0,
        ("bottom", "top", "left"),
        ORGAN_MOUNT_POINTS["battery_cell"],
        "battery_cell",
    )
    terminal = rounded_prism(13.0, 9.0, 1.6, 2.0).located(
        Location((0, (cavity.height + 2 * WALL) / 2 + 1.0, LID_D))
    )
    return base, Compound(children=[lid, terminal])


def make_charge_kidney_case():
    """TP4056 Type-C charger/protection kidney pod."""
    width, height, depth = 36.0, 27.0, 9.0
    base, lid = make_rounded_case(
        width,
        height,
        depth,
        7.0,
        ("left", "right", "bottom"),
        ORGAN_MOUNT_POINTS["charge_kidney"],
        "charge_kidney",
    )
    # Raised Type-C end marker: the module should face this side if the USB
    # port needs to align with the rear/body charging cable route.
    port = rounded_prism(12.0, 4.8, 1.0, 1.5).located(Location((0, -height / 2 + 2.0, LID_D)))
    led_a = Cylinder(1.25, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(
        Location((-8.0, 6.0, LID_D))
    )
    led_b = Cylinder(1.25, 0.8, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(
        Location((-3.0, 6.0, LID_D))
    )
    return base, Compound(children=[lid, port, led_a, led_b])


def make_boost_gland_case():
    """MT3608 2A DC-DC boost converter pod."""
    cavity = ORGAN_CAVITIES["boost_gland"]
    width, height, depth = cavity.width + 2 * WALL, cavity.height + 2 * WALL, cavity.depth + WALL
    base, lid = make_rounded_case(
        width,
        height,
        depth,
        7.0,
        ("left", "right", "top"),
        ORGAN_MOUNT_POINTS["boost_gland"],
        "boost_gland",
    )
    coil = Cylinder(5.6, 1.2, align=(Align.CENTER, Align.CENTER, Align.MIN)).located(
        Location((-9.0, 0.0, LID_D))
    )
    trim_pot = rounded_prism(7.0, 7.0, 1.0, 1.5).located(Location((8.0, 2.0, LID_D)))
    output_mark = rounded_prism(12.0, 2.0, 0.8, 0.8).located(Location((0, height / 2 - 3.0, LID_D)))
    return base, Compound(children=[lid, coil, trim_pot, output_mark])


ORGAN_SPECS = {
    "esp32_heart": ("ESP32 + breadboard heart", make_heart_case, 0xf4a7c6),
    "mic_ear": ("INMP441 ear", make_ear_case, 0x8bd3ff),
    "i2s_lung": ("MAX98357 voice lung", make_lung_case, 0xf48fb1),
    "touch_spark": ("TTP223 touch spark", make_star_case, 0xffd23f),
    "battery_cell": ("battery energy cell", make_energy_cell_case, 0xffb45e),
    "charge_kidney": ("TP4056 charge kidney", make_charge_kidney_case, 0xcaa8ff),
    "boost_gland": ("MT3608 boost gland", make_boost_gland_case, 0xa6e36d),
}


def make_organs():
    items = {}
    for key, (label, maker, color) in ORGAN_SPECS.items():
        base, lid = maker()
        items[f"{key}_base"] = base
        items[f"{key}_lid"] = lid
    return items


def make_print_kit(items: dict[str, object]):
    placements = {
        "esp32_heart_base": (-74.0, 72.0, 0.0),
        "esp32_heart_lid": (12.0, 72.0, 0.0),
        "battery_cell_lid": (94.0, 72.0, 0.0),
        "battery_cell_base": (-92.0, -10.0, 0.0),
        "i2s_lung_base": (-35.0, -10.0, 0.0),
        "i2s_lung_lid": (0.0, -10.0, 0.0),
        "mic_ear_base": (36.0, -10.0, 0.0),
        "mic_ear_lid": (76.0, -10.0, 0.0),
        "touch_spark_base": (-26.0, -65.0, 0.0),
        "touch_spark_lid": (22.0, -65.0, 0.0),
        "boost_gland_base": (-78.0, -118.0, 0.0),
        "boost_gland_lid": (-30.0, -118.0, 0.0),
        "charge_kidney_base": (24.0, -118.0, 0.0),
        "charge_kidney_lid": (70.0, -118.0, 0.0),
    }
    placed = [items[key].located(Location(position)) for key, position in placements.items()]
    return Compound(children=placed)


def make_closed_organ_map(items: dict[str, object]):
    """Pods arranged as an internal organ map for the open BMO body."""
    base_z = 4.4
    children = []
    for key, (x, y) in ORGAN_PLACEMENTS.items():
        position = (x, y, base_z)
        children.append(items[f"{key}_base"].located(Location(position)))
        base_height = items[f"{key}_base"].bounding_box().size.Z
        children.append(items[f"{key}_lid"].located(Location((position[0], position[1], position[2] + base_height + 1.0))))
    return Compound(children=children)


def export_shape(name: str, shape):
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    step_path = EXPORT_DIR / f"{name}.step"
    stl_path = EXPORT_DIR / f"{name}.stl"
    glb_path = EXPORT_DIR / f"{name}.glb"
    export_step(shape, step_path)
    export_stl(shape, stl_path, tolerance=0.08, angular_tolerance=0.15)
    export_gltf(shape, glb_path, binary=True)
    write_basic_3mf(stl_path, EXPORT_DIR / f"{name}.3mf")
    return step_path, stl_path, glb_path


def describe_shape(name: str, shape):
    bbox = shape.bounding_box()
    return (
        f"{name}: volume={shape.volume:.1f} mm^3, "
        f"bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm"
    )


def gen_step():
    items = make_organs()
    return make_print_kit(items)


def main():
    items = make_organs()
    exports = {
        **{f"bmo_organ_{key}": value for key, value in items.items()},
        "bmo_organ_pods_print_kit": make_print_kit(items),
        "bmo_organ_map_assembly": make_closed_organ_map(items),
    }
    for name, shape in exports.items():
        export_shape(name, shape)
        print(describe_shape(name, shape))
    print(f"Generated organ pod CAD artifacts in {EXPORT_DIR}")


if __name__ == "__main__":
    main()
