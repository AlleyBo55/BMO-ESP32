"""Snap-fit test coupon: print this first to dial in the no-glue lock.

Prints in ~5-10 min on an A1. You get:
  - one socket plate with a wall the pin must clamp
  - three loose snap pins at +/-0 and two clearance variants

Push each pin into the socket from the chamfered side. You want a firm shove,
an audible click, and then it should NOT pull back out by hand. If it won't
seat, your printer runs fat: raise SNAP_CLEARANCE in bmo_body.py by 0.04 and
reprint. If it clicks but wobbles, lower SNAP_CLEARANCE by 0.04.

Edit the matching constants in bmo_body.py once you find the winner, then
regenerate the body.
"""
from __future__ import annotations

from pathlib import Path

from build123d import (
    Align, Box, BuildPart, Compound, Cylinder, Location, Locations, Mode,
    export_step, export_stl,
)

import bmo_body as bmo

EXPORT_DIR = Path(__file__).resolve().parents[1] / "exports"
WALL_T = bmo.WALL  # the body wall the snap clamps (2.8 mm)


def socket_plate():
    """A small plate with test bores at the production clearance and +/-."""
    with BuildPart() as plate:
        Box(60.0, 26.0, WALL_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
        # Three arm-size bores; center uses production SNAP_CLEARANCE, sides +/-0.05.
        for x, extra in ((-20.0, 0.05), (0.0, 0.0), (20.0, -0.05)):
            bore_r = bmo.SNAP_PIN_R + bmo.SNAP_CLEARANCE + extra
            with Locations((x, 4.0, WALL_T / 2)):
                Cylinder(bore_r, WALL_T + 2.0,
                         align=(Align.CENTER, Align.CENTER, Align.CENTER),
                         mode=Mode.SUBTRACT)
        # Two leg-size bores at production clearance.
        for x in (-10.0, 10.0):
            bore_r = bmo.LEG_SNAP_R + bmo.SNAP_CLEARANCE
            with Locations((x, -7.0, WALL_T / 2)):
                Cylinder(bore_r, WALL_T + 2.0,
                         align=(Align.CENTER, Align.CENTER, Align.CENTER),
                         mode=Mode.SUBTRACT)
    return plate.part


def pins():
    """Production snap pins: 3 arm-size + 2 leg-size, spaced for handling."""
    items = []
    for x in (-20.0, 0.0, 20.0):
        items.append(bmo.make_snap_pin(WALL_T).located(Location((x, 0, 1.4))))
    for x in (-10.0, 10.0):
        items.append(
            bmo.make_snap_pin(WALL_T, pin_r=bmo.LEG_SNAP_R, barb=bmo.LEG_SNAP_BARB,
                              collar_r=bmo.LEG_SNAP_COLLAR_R).located(Location((x, -14.0, 1.4)))
        )
    return Compound(children=items)


def main():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    coupon = Compound(children=[
        socket_plate().located(Location((0, 18, 0))),
        pins(),
    ])
    step = EXPORT_DIR / "bmo_snap_test_coupon.step"
    stl = EXPORT_DIR / "bmo_snap_test_coupon.stl"
    export_step(coupon, step)
    export_stl(coupon, stl, tolerance=0.05, angular_tolerance=0.1)
    bmo.write_basic_3mf(stl, EXPORT_DIR / "bmo_snap_test_coupon.3mf")
    bbox = coupon.bounding_box()
    print(f"snap test coupon: bbox=({bbox.size.X:.1f} x {bbox.size.Y:.1f} x {bbox.size.Z:.1f}) mm")
    print(f"wrote {stl}")


if __name__ == "__main__":
    main()
