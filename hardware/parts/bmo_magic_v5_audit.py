"""Geometry checks for BMO Living Robot V5."""

from __future__ import annotations

import sys

import bmo_body
import bmo_magic_v5


A1_PLATE = 256.0
BODY_ENVELOPE_EXTRA = 118.0


REQUIRED_EXPORTS = {
    "bmo_v5_motion_backbone",
    "bmo_v5_servo_fit_ghosts",
    "bmo_v5_hidden_drive",
    "bmo_v5_gear_train",
    "bmo_v5_linkage_rods",
    "bmo_v5_output_collars",
    "bmo_v5_electronics_shelf",
    "bmo_v5_left_upper_arm",
    "bmo_v5_left_forearm_hand",
    "bmo_v5_right_upper_arm",
    "bmo_v5_right_forearm_hand",
    "bmo_v5_left_thigh",
    "bmo_v5_left_shin_foot",
    "bmo_v5_right_thigh",
    "bmo_v5_right_shin_foot",
    "bmo_v5_motion_core",
    "bmo_v5_living_robot_assembly",
    "bmo_v5_core_print_kit",
    "bmo_v5_linkage_print_kit",
    "bmo_v5_limb_print_kit",
}


def describe(name: str, shape):
    bbox = shape.bounding_box()
    print(
        f"{name:32s} {bbox.size.X:6.1f} x {bbox.size.Y:6.1f} x {bbox.size.Z:5.1f} mm "
        f"bounds=({bbox.min.X:6.1f},{bbox.min.Y:6.1f})..({bbox.max.X:6.1f},{bbox.max.Y:6.1f})"
    )
    return bbox


def main() -> int:
    exports = bmo_magic_v5.exports()
    failures: list[str] = []

    missing = REQUIRED_EXPORTS - set(exports)
    if missing:
        failures.append(f"missing exports: {', '.join(sorted(missing))}")

    print("BMO Living Robot V5 audit")
    for name in sorted(REQUIRED_EXPORTS & set(exports)):
        bbox = describe(name, exports[name])
        if name.endswith("_print_kit"):
            if bbox.size.X > A1_PLATE or bbox.size.Y > A1_PLATE:
                failures.append(f"{name} exceeds {A1_PLATE:.0f} x {A1_PLATE:.0f} mm A1 plate")

    assembly = exports.get("bmo_v5_living_robot_assembly")
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
