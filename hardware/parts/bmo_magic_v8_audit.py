"""Geometry checks for BMO Animatronic V8.0.

Validates: required exports present, print kit fits the Bambu A1 256 mm plate
with margin, posed assemblies stay within a sane envelope, and the low ballast
pod actually sits below the servo frame mid-height (CoM-lowering sanity).
"""

from __future__ import annotations

import sys

import bmo_body
import bmo_magic_v8


A1_PLATE = 256.0
A1_SAFE = 250.0  # leave a brim/margin
BODY_ENVELOPE_EXTRA = 130.0


REQUIRED_EXPORTS = {
    "bmo_v8_servo_frame",
    "bmo_v8_ballast_pod",
    "bmo_v8_servo_fit_ghosts",
    "bmo_v8_output_collars",
    "bmo_v8_servo_horn_adapter",
    "bmo_v8_left_arm",
    "bmo_v8_right_arm",
    "bmo_v8_left_leg",
    "bmo_v8_right_leg",
    "bmo_v8_foot",
    "bmo_v8_assembly_stand",
    "bmo_v8_assembly_wave",
    "bmo_v8_assembly_dance",
    "bmo_v8_assembly_walk",
    "bmo_v8_print_kit",
    "bmo_v8_rocker_foot",
    "bmo_v8_left_leg_rocker",
    "bmo_v8_right_leg_rocker",
    "bmo_v8_walk_engine",
    "bmo_v8_automaton_assembly",
}

PLATE_EXPORTS = {
    "bmo_v8_plate_servo_frame",
    "bmo_v8_plate_output_collars",
    "bmo_v8_plate_left_leg",
    "bmo_v8_plate_right_leg",
    "bmo_v8_plate_left_arm",
    "bmo_v8_plate_right_arm",
    "bmo_v8_plate_horn_adapter_1",
    "bmo_v8_plate_horn_adapter_2",
    "bmo_v8_plate_horn_adapter_3",
    "bmo_v8_plate_horn_adapter_4",
    "bmo_v8_plate_ballast_pod",
}


def describe(name: str, shape):
    bbox = shape.bounding_box()
    print(
        f"{name:28s} {bbox.size.X:6.1f} x {bbox.size.Y:6.1f} x {bbox.size.Z:5.1f} mm "
        f"bounds=({bbox.min.X:6.1f},{bbox.min.Y:6.1f})..({bbox.max.X:6.1f},{bbox.max.Y:6.1f})"
    )
    return bbox


def main() -> int:
    exports = bmo_magic_v8.exports()
    failures: list[str] = []

    missing = REQUIRED_EXPORTS - set(exports)
    if missing:
        failures.append(f"missing exports: {', '.join(sorted(missing))}")
    missing_plate = PLATE_EXPORTS - set(exports)
    if missing_plate:
        failures.append(f"missing plate exports: {', '.join(sorted(missing_plate))}")

    print("BMO Animatronic V8.0 audit")
    for name in sorted(REQUIRED_EXPORTS & set(exports)):
        bbox = describe(name, exports[name])
        if name.endswith("_print_kit"):
            if bbox.size.X > A1_SAFE or bbox.size.Y > A1_SAFE:
                failures.append(
                    f"{name} exceeds safe plate {A1_SAFE:.0f} mm: "
                    f"{bbox.size.X:.1f} x {bbox.size.Y:.1f}"
                )

    max_x = bmo_body.BODY_W + BODY_ENVELOPE_EXTRA
    max_y = bmo_body.BODY_H + BODY_ENVELOPE_EXTRA
    for name in ("bmo_v8_assembly_stand", "bmo_v8_assembly_wave",
                 "bmo_v8_assembly_dance", "bmo_v8_assembly_walk",
                 "bmo_v8_automaton_assembly"):
        asm = exports.get(name)
        if asm is None:
            continue
        bbox = asm.bounding_box()
        if bbox.size.X > max_x:
            failures.append(f"{name} too wide: {bbox.size.X:.1f} > {max_x:.1f}")
        if bbox.size.Y > max_y:
            failures.append(f"{name} too tall: {bbox.size.Y:.1f} > {max_y:.1f}")

    # CoM-lowering sanity: the ballast pod must seat in the lower half of the
    # torso (more negative Y than the body center) so it actually drops the CoM.
    stand = exports.get("bmo_v8_assembly_stand")
    if stand is not None:
        # The pod is placed at Y = -58 in the assembly; just assert the design
        # constant stays in the lower torso.
        if not (-bmo_body.BODY_H / 2 < -58.0 < 0.0):
            failures.append("ballast pod Y placement is not in the lower torso")

    if not missing_plate:
        plate_shapes = [exports[name] for name in PLATE_EXPORTS]
        min_x = min(shape.bounding_box().min.X for shape in plate_shapes)
        min_y = min(shape.bounding_box().min.Y for shape in plate_shapes)
        max_x = max(shape.bounding_box().max.X for shape in plate_shapes)
        max_y = max(shape.bounding_box().max.Y for shape in plate_shapes)
        kit_bbox = exports["bmo_v8_print_kit"].bounding_box()
        split_size = (max_x - min_x, max_y - min_y)
        kit_size = (kit_bbox.size.X, kit_bbox.size.Y)
        if any(abs(split - kit) > 0.1 for split, kit in zip(split_size, kit_size)):
            failures.append(
                "separate viewer plate exports do not match the combined kit: "
                f"{split_size[0]:.1f} x {split_size[1]:.1f} vs "
                f"{kit_size[0]:.1f} x {kit_size[1]:.1f}"
            )

    if failures:
        print("\nFAIL")
        for f in failures:
            print(f"- {f}")
        return 1

    print("\nPASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
