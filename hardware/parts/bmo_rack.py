"""BMO Static - consolidated internal rack for the compact shell.

Why this exists
---------------
The old "organ pod" layout spread every board across the FACE plane (X-Y),
which forced a 118 x 148 mm body and made the 1.8" screen look tiny. This rack
instead packs the same components through the body's depth,
mostly empty behind the old organs), so the face footprint shrinks dramatically
and the screen reads much bigger -- WITHOUT changing any component (speaker
stays the 70 mm unit).

It holds, firmly: mini-breadboard + ESP32-C3, the 70 mm speaker, TP4056 charger,
INMP441 mic, TTP223 touch, MAX98357 amp, and the LiPo battery. (The MT3608 boost
is dropped: a static BMO runs ESP32 + amp straight off the LiPo.)

Depth-stack principle (front face = Z 0, +Z into the body):
    screen board  ->  breadboard/ESP32  ->  speaker  ->  back wall
the tall breadboard (26 mm) and the speaker (13.5 mm) sit BEHIND each other in
the same X-Y footprint, so they cost depth, not face area.

Hard limits that set the minimum body (no part changed):
  * Screen board is 58 mm wide  -> body width  >= ~64 mm.
  * Speaker is 70 mm in its long axis -> body width >= ~78 mm when its long
    axis runs across X.
Target body: 80 x 96 x 52 mm.

main() runs an AABB overlap + envelope-containment check so the pack is proven,
not eyeballed.
"""

from __future__ import annotations

from dataclasses import dataclass

from build123d import Align, Box, BuildPart, Compound, Cylinder, Location, Locations, Mode, add

import bmo_body
import bmo_component_specs as cs


# ---------- Target body envelope (matches the compact BMO shell) ----------
RACK_BODY_W = 80.0
RACK_BODY_H = 96.0
RACK_BODY_D = 52.0
WALL = bmo_body.WALL
FRONT_SKIN = bmo_body.FRONT_SKIN
FIT_XY = cs.MIN_TOTAL_XY_CLEARANCE
FIT_Z = cs.MIN_Z_CLEARANCE
REAR_COVER_CLEARANCE = 1.0
BACK_PLATE_T = 2.4
RACK_BACK_Z_MAX = RACK_BODY_D - 4.0
RACK_BACK_Z_MIN = RACK_BACK_Z_MAX - BACK_PLATE_T
COMPONENT_BACK_Z = RACK_BACK_Z_MIN - 0.4
RACK_PLATE_W = 72.0
RACK_PLATE_H = 86.0
SPEAKER_STRAP_X = 12.0

# Battery: confirm against the real 2500 mAh cell. Placeholder = 103450 class.
BATTERY = cs.BATTERY_103450             # 34 x 50 x 10


@dataclass(frozen=True)
class Placed:
    name: str
    size: tuple[float, float, float]    # (w=X, h=Y, d=Z) AFTER orientation
    center: tuple[float, float, float]  # (x, y, z); z from front face (0) into body
    grip: str                           # how the rack holds it


def layout():
    """Depth-stacked component placement inside the RACK_BODY envelope.

    Coordinates: body center at (0,0); +Y up, +Z into the body from the face.
    """
    fd = RACK_BODY_D
    return [
        # Screen board on the front face, top of the head.
        Placed("screen_board", (cs.TFT_BOARD.width, cs.TFT_BOARD.height, cs.TFT_BOARD.depth),
               (0.0, 21.0, FRONT_SKIN + cs.TFT_BOARD.depth / 2), "front retention tabs"),
        # Breadboard + ESP32 directly behind the screen (uses depth, not face).
        Placed("breadboard_esp32",
               (cs.BREADBOARD_ESP32_STACK.width, cs.BREADBOARD_ESP32_STACK.height, cs.BREADBOARD_ESP32_STACK.depth),
               (0.0, 24.0, FRONT_SKIN + 5.6 + cs.BREADBOARD_ESP32_STACK.depth / 2), "side rails + hold-down strap"),
        # Speaker: long axis runs across X and presses against the rear plate.
        Placed("speaker", (cs.SPEAKER.width, cs.SPEAKER.height, cs.SPEAKER.depth),
               (0.0, -24.0, COMPONENT_BACK_Z - cs.SPEAKER.depth / 2), "side cradle + hold-down strap"),
        # Battery LANDSCAPE (50 wide x 34 tall) low and forward (drops CoM,
        # fits under the breadboard within the shorter body).
        Placed("battery", (BATTERY.height, BATTERY.width, BATTERY.depth),  # 50(X) x 34(Y) x 10(Z)
               (0.0, -28.0, FRONT_SKIN + 6.0 + BATTERY.depth / 2), "drawer pocket"),
        # TP4056 charger behind the battery (depth stack), near the USB-C edge.
        Placed("tp4056", (cs.TP4056_TYPE_C.width, cs.TP4056_TYPE_C.height, cs.TP4056_TYPE_C.depth),
               (0.0, -28.0, FRONT_SKIN + 6.0 + BATTERY.depth + 1.5 + cs.TP4056_TYPE_C.depth / 2), "clip shelf"),
        # MAX98357 amp above the speaker at the back.
        Placed("amp", (cs.MAX98357_TERMINAL.width, cs.MAX98357_TERMINAL.height, cs.MAX98357_TERMINAL.depth),
               (0.0, 33.5, COMPONENT_BACK_Z - cs.MAX98357_TERMINAL.depth / 2), "clip shelf"),
        # INMP441 mic on the left flank near the front (good sound pickup).
        Placed("mic", (cs.INMP441.width, cs.INMP441.height, cs.INMP441.depth),
               (-27.5, -3.0, FRONT_SKIN + 4.0), "clip shelf"),
        # TTP223 touch on the front face just under the screen / on the chin.
        Placed("touch", (cs.TTP223.width, cs.TTP223.height, cs.TTP223.depth),
               (0.0, -9.0, FRONT_SKIN + cs.TTP223.depth / 2), "front pad"),
    ]


def _aabb(p: Placed):
    (w, h, d), (x, y, z) = p.size, p.center
    return (x - w / 2, x + w / 2, y - h / 2, y + h / 2, z - d / 2, z + d / 2)


def _overlap(a, b, slack=0.0):
    ax0, ax1, ay0, ay1, az0, az1 = a
    bx0, bx1, by0, by1, bz0, bz1 = b
    return (ax0 < bx1 - slack and bx0 < ax1 - slack and
            ay0 < by1 - slack and by0 < ay1 - slack and
            az0 < bz1 - slack and bz0 < az1 - slack)


def check_pack():
    """Return (ok, messages): envelope containment + pairwise overlap report."""
    msgs = []
    ok = True
    items = layout()
    halfw, halfh = RACK_BODY_W / 2 - WALL, RACK_BODY_H / 2 - WALL
    for p in items:
        x0, x1, y0, y1, z0, z1 = _aabb(p)
        if x0 < -halfw or x1 > halfw:
            ok = False; msgs.append(f"  {p.name}: exceeds width envelope (x {x0:.1f}..{x1:.1f}, max +/-{halfw:.1f})")
        if y0 < -halfh or y1 > halfh:
            ok = False; msgs.append(f"  {p.name}: exceeds height envelope (y {y0:.1f}..{y1:.1f}, max +/-{halfh:.1f})")
        if z1 > RACK_BODY_D - 0.5:
            ok = False; msgs.append(f"  {p.name}: too deep (z max {z1:.1f} > {RACK_BODY_D-0.5:.1f})")
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if _overlap(_aabb(items[i]), _aabb(items[j]), slack=0.3):
                ok = False
                msgs.append(f"  OVERLAP: {items[i].name} <-> {items[j].name}")
    return ok, msgs


def make_component_ghosts():
    """Transparent component envelopes in their rack positions (preview)."""
    children = []
    for p in layout():
        children.append(Box(*p.size).located(Location(p.center)))
    return Compound(children=children)


def make_rack():
    """Printable holding rack: back plate + per-component cradles, with cable
    routing notches and hold-down screw bosses for the heavy parts.

    Bed face: the back plate (max +Z face) prints down.
    """
    items = {p.name: p for p in layout()}
    with BuildPart() as rack:
        # Rear plate remains fully inside the lid seat. The lower central notch
        # aligns with the cover cable exit.
        with Locations((0, 0, (RACK_BACK_Z_MIN + RACK_BACK_Z_MAX) / 2)):
            add(
                bmo_body.rounded_box(
                    RACK_PLATE_W,
                    RACK_PLATE_H,
                    BACK_PLATE_T,
                    1.0,
                )
            )
        with Locations((0, -RACK_BODY_H / 2 + WALL + 5.0, RACK_BACK_Z_MIN - 0.4)):
            Box(
                20.0,
                10.0,
                BACK_PLATE_T + 1.0,
                align=(Align.CENTER, Align.CENTER, Align.MIN),
                mode=Mode.SUBTRACT,
            )

        # U-shaped component cradles. Side rails grip the part while rearward
        # ribs tie every holder to the single back plate.
        for name in ("speaker", "breadboard_esp32", "battery"):
            p = items[name]
            w, h, d = p.size
            x, y, z = p.center
            # The horizontal speaker uses slim 3-perimeter rails so its 70 mm
            # frame still clears the 74.4 mm internal shell width.
            rail_t = 1.2 if name == "speaker" else 2.4
            rail_r = min(0.8, rail_t * 0.35)
            side_x = w / 2 + FIT_XY / 2 + rail_t / 2
            for sx in (-side_x, side_x):
                with Locations((x + sx, y, z)):
                    add(bmo_body.rounded_box(rail_t, h, d, rail_r))
            # A shallow end stop overlaps the side rails so the cradle is one
            # printable solid. The speaker uses its upper edge because its
            # lower edge already reaches the body floor.
            if name in ("speaker", "battery"):
                stop_y = y + h / 2 + rail_t / 2 - 0.3
            else:
                stop_y = y - h / 2 - rail_t / 2 + 0.3
            with Locations((x, stop_y, z)):
                add(bmo_body.rounded_box(w + 2 * rail_t, rail_t, d, rail_r))

            support_start = z + d / 2 - 0.5
            support_depth = RACK_BACK_Z_MIN - support_start + 0.5
            for sx in (-side_x, side_x):
                with Locations((x + sx, y, support_start)):
                    Box(
                        rail_t,
                        6.0,
                        support_depth,
                        align=(Align.CENTER, Align.CENTER, Align.MIN),
                    )

        # M2 hold-down bosses for the speaker, battery, and breadboard straps.
        for name in ("speaker", "battery", "breadboard_esp32"):
            p = items[name]
            w, h, d = p.size
            x, y, z = p.center
            if name == "speaker":
                speaker_boss_offset = h / 2 + 2.7
                boss_x = x + SPEAKER_STRAP_X
                boss_positions = ((boss_x, y - speaker_boss_offset), (boss_x, y + speaker_boss_offset))
            else:
                boss_positions = ((x - (w / 2 + 4.0), y), (x + (w / 2 + 4.0), y))
            for boss_x, boss_y in boss_positions:
                with Locations((boss_x, boss_y, z + d / 2 - 3.0)):
                    Cylinder(2.8, 6.0, align=(Align.CENTER, Align.CENTER, Align.MIN))
                with Locations((boss_x, boss_y, z + d / 2 - 3.0)):
                    Cylinder(0.9, 7.0, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

        # Clip shelves for the small boards, each connected to the rear plate by
        # two narrow rails outside the board envelope.
        for name in ("tp4056", "amp", "mic", "touch"):
            p = items[name]
            w, h, d = p.size
            x, y, z = p.center
            shelf_z = z + d / 2 + 0.8
            with Locations((x, y, shelf_z)):
                add(bmo_body.rounded_box(w + 4.0, h + 4.0, 1.6, 0.6))
            for sx in (-(w / 2 + 1.0), (w / 2 + 1.0)):
                with Locations((x + sx, y, z)):
                    add(bmo_body.rounded_box(1.8, h * 0.65, d, 0.6))
                support_start = shelf_z
                support_depth = RACK_BACK_Z_MIN - support_start + 0.5
                if support_depth > 0:
                    with Locations((x + sx, y, support_start)):
                        Box(
                            1.8,
                            4.0,
                            support_depth,
                            align=(Align.CENTER, Align.CENTER, Align.MIN),
                        )
            with Locations((x, y + (h + 4.0) / 2, shelf_z)):
                Box(6.0, 3.0, 2.4, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)

        # Push-in wire combs on both sides of the rear plate. Bundles run along
        # Y and exit through the lower center without crossing component bays.
        for clip_x in (-29.0, 29.0):
            for clip_y in (-27.0, 0.0, 27.0):
                clip_z = RACK_BACK_Z_MIN - 1.5
                with Locations((clip_x, clip_y, clip_z)):
                    add(bmo_body.rounded_box(12.0, 4.0, 4.0, 0.8))
                with Locations((clip_x, clip_y, clip_z - 0.8)):
                    Box(
                        8.0,
                        6.0,
                        2.6,
                        align=(Align.CENTER, Align.CENTER, Align.CENTER),
                        mode=Mode.SUBTRACT,
                    )
    return rack.part


def make_holddown_strap(name: str = "speaker"):
    """Flat printed strap that screws across a heavy part's bosses to lock it."""
    p = {q.name: q for q in layout()}[name]
    w, h, _ = p.size
    with BuildPart() as strap:
        if name == "speaker":
            span = h + 12.0
            add(bmo_body.rounded_box(9.0, span, 3.0, 1.4))
            for sy in (-(h / 2 + 2.7), h / 2 + 2.7):
                with Locations((0, sy, 0)):
                    Cylinder(1.6, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
        else:
            span = w + 16.0
            add(bmo_body.rounded_box(span, 9.0, 3.0, 1.4))
            for sx in (-(w / 2 + 4.0), w / 2 + 4.0):
                with Locations((sx, 0, 0)):
                    Cylinder(1.6, 5.0, align=(Align.CENTER, Align.CENTER, Align.CENTER), mode=Mode.SUBTRACT)
    return strap.part


def make_rack_assembly():
    return Compound(children=[make_rack(), make_component_ghosts()])


def exports():
    return {
        "bmo_compact_rack": make_rack(),
        "bmo_compact_rack_speaker_strap": make_holddown_strap("speaker"),
        "bmo_compact_rack_battery_strap": make_holddown_strap("battery"),
        "bmo_compact_rack_breadboard_strap": make_holddown_strap("breadboard_esp32"),
        "bmo_compact_rack_component_ghosts": make_component_ghosts(),
        "bmo_compact_rack_assembly": make_rack_assembly(),
    }


def main():
    skip_3mf = {"bmo_compact_rack_component_ghosts", "bmo_compact_rack_assembly"}
    for name, shape in exports().items():
        bmo_body.export_shape(name, shape, make_3mf=name not in skip_3mf)
        bb = shape.bounding_box()
        print(f"{name}: bbox=({bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f})")

    print("\n--- pack check ---")
    ok, msgs = check_pack()
    for m in msgs:
        print(m)
    old_w, old_h = 118.0, 148.0
    ratio_old = cs.TFT_ACTIVE.width / old_w * 100
    ratio_new = cs.TFT_ACTIVE.width / RACK_BODY_W * 100
    print(f"\nbody: {old_w:.0f} x {old_h:.0f}  ->  {RACK_BODY_W:.0f} x {RACK_BODY_H:.0f} mm")
    print(f"screen-to-face width ratio: {ratio_old:.0f}%  ->  {ratio_new:.0f}%")
    print("PACK OK" if ok else "PACK FAIL (see overlaps/envelope above)")


if __name__ == "__main__":
    main()
