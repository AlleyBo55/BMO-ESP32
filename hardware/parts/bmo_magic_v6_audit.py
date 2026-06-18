"""Geometry checks for BMO True Walker V6."""

from __future__ import annotations

import sys

import bmo_body
import bmo_magic_v6


A1_PLATE = 256.0
BODY_ENVELOPE_EXTRA = 132.0


REQUIRED_EXPORTS = {
    "bmo_v6_hip_servo_cassette",
    "bmo_v6_left_leg_link",
    "bmo_v6_right_leg_link",
    "bmo_v6_left_foot_module",
    "bmo_v6_right_foot_module",
    "bmo_v6_servo_horn_clamp",
    "bmo_v6_servo_fit_ghosts",
    "bmo_v6_weight_shift_linkages",
    "bmo_v6_true_walker_assembly",
    "bmo_v6_true_walker_print_kit",
}


def describe(name: str, shape):
    bbox = shape.bounding_box()
    print(
        f"{name:34s} {bbox.size.X:6.1f} x {bbox.size.Y:6.1f} x {bbox.size.Z:5.1f} mm "
        f"bounds=({bbox.min.X:6.1f},{bbox.min.Y:6.1f})..({bbox.max.X:6.1f},{bbox.max.Y:6.1f})"
    )
    return bbox


def main() -> int:
    exports = bmo_magic_v6.exports()
    failures: list[str] = []

    missing = REQUIRED_EXPORTS - set(exports)
    if missing:
        failures.append(f"missing exports: {', '.join(sorted(missing))}")

    print("BMO True Walker V6 audit")
    for name in sorted(REQUIRED_EXPORTS & set(exports)):
        bbox = describe(name, exports[name])
        if name.endswith("_print_kit"):
            if bbox.size.X > A1_PLATE or bbox.size.Y > A1_PLATE:
                failures.append(f"{name} exceeds {A1_PLATE:.0f} x {A1_PLATE:.0f} mm A1 plate")

    assembly = exports.get("bmo_v6_true_walker_assembly")
    if assembly:
        bbox = assembly.bounding_box()
        max_x = bmo_body.BODY_W + BODY_ENVELOPE_EXTRA
        max_y = bmo_body.BODY_H + BODY_ENVELOPE_EXTRA
        if bbox.size.X > max_x:
            failures.append(f"assembly too wide: {bbox.size.X:.1f} mm > {max_x:.1f} mm")
        if bbox.size.Y > max_y:
            failures.append(f"assembly too tall: {bbox.size.Y:.1f} mm > {max_y:.1f} mm")

    if failures:
        print("\nFAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
