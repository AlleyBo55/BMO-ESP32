"""Geometry checks for the BMO Servo/Clockwork V2 concept."""

from __future__ import annotations

import bmo_body
import bmo_mecha_v2


A1_PLATE = 256.0
LIP_CLEARANCE = 1.0
PLATE_LAYOUT_CLEARANCE = 1.5


def describe(name: str, shape):
    bbox = shape.bounding_box()
    print(
        f"{name:22s} {bbox.size.X:6.1f} x {bbox.size.Y:6.1f} x {bbox.size.Z:5.1f} mm "
        f"bounds=({bbox.min.X:6.1f},{bbox.min.Y:6.1f})..({bbox.max.X:6.1f},{bbox.max.Y:6.1f})"
    )
    return bbox


def main():
    failures: list[str] = []
    exports = bmo_mecha_v2.exports()

    print("BMO Servo/Clockwork V2 audit")
    tray_bbox = describe("mecha tray", exports["bmo_v2_mecha_tray"])
    walk_bbox = describe("walk engine", exports["bmo_v2_walk_engine"])
    arms_bbox = describe("arm servo pack", exports["bmo_v2_arm_servo_pack"])
    balance_bbox = describe("gravity balancer", exports["bmo_v2_gravity_balancer"])
    elec_bbox = describe("electronics bay", exports["bmo_v2_electronics_bay"])
    kit_bbox = describe("v2 print kit", exports["bmo_v2_print_kit"])
    assembly_bbox = describe("v2 assembly", exports["bmo_v2_mecha_assembly"])
    print_parts = [(name, shape.bounding_box()) for name, shape in bmo_mecha_v2.v2_print_kit_parts()]

    if kit_bbox.size.X > A1_PLATE or kit_bbox.size.Y > A1_PLATE:
        failures.append(f"V2 print kit exceeds {A1_PLATE:.0f} x {A1_PLATE:.0f} mm A1 plate")

    for index, (left_name, left_bbox) in enumerate(print_parts):
        for right_name, right_bbox in print_parts[index + 1 :]:
            x_overlap = (
                left_bbox.min.X < right_bbox.max.X + PLATE_LAYOUT_CLEARANCE
                and left_bbox.max.X + PLATE_LAYOUT_CLEARANCE > right_bbox.min.X
            )
            y_overlap = (
                left_bbox.min.Y < right_bbox.max.Y + PLATE_LAYOUT_CLEARANCE
                and left_bbox.max.Y + PLATE_LAYOUT_CLEARANCE > right_bbox.min.Y
            )
            if x_overlap and y_overlap:
                failures.append(f"V2 print kit layout overlap: {left_name} touches {right_name}")

    if tray_bbox.size.X > bmo_body.BODY_W + 2.0 or tray_bbox.size.Y > bmo_body.BODY_H + 2.0:
        failures.append("V2 tray outline drifted beyond body shell dimensions")

    if max(walk_bbox.size.X, arms_bbox.size.X, elec_bbox.size.X) > bmo_body.BODY_W + 4.0:
        failures.append("A V2 internal module is wider than the BMO body envelope")

    lip_x = bmo_body.ORGAN_LIP_W / 2
    lip_y = bmo_body.ORGAN_LIP_H / 2
    for name, bbox in (
        ("walk engine", walk_bbox),
        ("arm servo pack", arms_bbox),
        ("gravity balancer", balance_bbox),
        ("electronics bay", elec_bbox),
    ):
        if bbox.min.X < -lip_x - LIP_CLEARANCE or bbox.max.X > lip_x + LIP_CLEARANCE:
            failures.append(f"{name} extends outside rear tray lip in X")
        if bbox.min.Y < -lip_y - LIP_CLEARANCE or bbox.max.Y > lip_y + LIP_CLEARANCE:
            failures.append(f"{name} extends outside rear tray lip in Y")

    if assembly_bbox.size.Z > bmo_body.FRONT_DEPTH + bmo_body.LID_T + bmo_body.LID_LIP_H + bmo_mecha_v2.SERVO_D + 12.0:
        failures.append("V2 assembly depth is larger than expected; check servo placement")

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"- {failure}")
        raise SystemExit(1)

    print("PASS")


if __name__ == "__main__":
    main()
