"""Geometry checks for BMO Clean 4-Servo Animatronic V7."""

from __future__ import annotations

import sys

from build123d import Location

import bmo_body
import bmo_magic_v7


A1_PLATE = 256.0
BODY_ENVELOPE_EXTRA = 126.0


REQUIRED_EXPORTS = {
    "bmo_v7_servo_frame",
    "bmo_v7_servo_fit_ghosts",
    "bmo_v7_output_collars",
    "bmo_v7_left_arm",
    "bmo_v7_right_arm",
    "bmo_v7_left_leg",
    "bmo_v7_right_leg",
    "bmo_v7_servo_horn_adapter",
    "bmo_v7_clean_robot_assembly",
    "bmo_v7_clean_robot_print_kit",
    "bmo_v71_heart_hub",
    "bmo_v71_battery_cell",
    "bmo_v71_charge_kidney",
    "bmo_v71_touch_spark",
    "bmo_v71_boost_gland",
    "bmo_v71_mic_ear",
    "bmo_v71_amp_lung",
    "bmo_v71_organ_layer",
    "bmo_v71_component_fit_ghosts",
    "bmo_v71_plug_guides",
    "bmo_v71_packed_robot_assembly",
    "bmo_v71_packed_robot_print_kit",
}


def describe(name: str, shape):
    bbox = shape.bounding_box()
    print(
        f"{name:34s} {bbox.size.X:6.1f} x {bbox.size.Y:6.1f} x {bbox.size.Z:5.1f} mm "
        f"bounds=({bbox.min.X:6.1f},{bbox.min.Y:6.1f})..({bbox.max.X:6.1f},{bbox.max.Y:6.1f})"
    )
    return bbox


def main() -> int:
    exports = bmo_magic_v7.exports()
    failures: list[str] = []

    missing = REQUIRED_EXPORTS - set(exports)
    if missing:
        failures.append(f"missing exports: {', '.join(sorted(missing))}")

    print("BMO Clean Animatronic V7 audit")
    for name in sorted(REQUIRED_EXPORTS & set(exports)):
        bbox = describe(name, exports[name])
        if name.endswith("_print_kit"):
            if bbox.size.X > A1_PLATE or bbox.size.Y > A1_PLATE:
                failures.append(f"{name} exceeds {A1_PLATE:.0f} x {A1_PLATE:.0f} mm A1 plate")

    assembly = exports.get("bmo_v7_clean_robot_assembly")
    if assembly:
        bbox = assembly.bounding_box()
        max_x = bmo_body.BODY_W + BODY_ENVELOPE_EXTRA
        max_y = bmo_body.BODY_H + BODY_ENVELOPE_EXTRA
        if bbox.size.X > max_x:
            failures.append(f"assembly too wide: {bbox.size.X:.1f} mm > {max_x:.1f} mm")
        if bbox.size.Y > max_y:
            failures.append(f"assembly too tall: {bbox.size.Y:.1f} mm > {max_y:.1f} mm")

    v71 = exports.get("bmo_v71_packed_robot_assembly")
    if v71:
        packed_bbox = v71.bounding_box()
        if packed_bbox.size.X > max_x:
            failures.append(f"V7.1 assembly too wide: {packed_bbox.size.X:.1f} mm > {max_x:.1f} mm")
        if packed_bbox.size.Y > max_y:
            failures.append(f"V7.1 assembly too tall: {packed_bbox.size.Y:.1f} mm > {max_y:.1f} mm")

    # The V7.1 upper organ layer intentionally stacks above the servo frame.
    # If these z ranges touch, the printer preview may look fine but the parts
    # would fight for the same real volume.
    frame = exports.get("bmo_v7_servo_frame")
    organs = exports.get("bmo_v71_organ_layer")
    if frame and organs:
        frame_z = frame.located(Location((0, 0, bmo_body.FRONT_DEPTH + 1.0))).bounding_box()
        organ_z = organs.bounding_box()
        if frame_z.max.Z > organ_z.min.Z:
            failures.append(
                f"V7.1 organ layer overlaps servo frame in Z: frame max {frame_z.max.Z:.1f} > organ min {organ_z.min.Z:.1f}"
            )

    if failures:
        print("\nFAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
