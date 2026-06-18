"""Geometry checks for the BMO body, organ pods, and A1 print plates."""

from __future__ import annotations

from itertools import combinations

import bmo_body
import bmo_component_specs as component_specs
import bmo_organ_pods


A1_PLATE = 256.0
A1_SAFE = 250.0
ORGAN_BASE_Z = 4.4
MIN_BBOX_GAP = 0.25


def bbox_xy(shape):
    bbox = shape.bounding_box()
    return bbox.min.X, bbox.max.X, bbox.min.Y, bbox.max.Y


def placed_organ_bounds(key: str, items: dict[str, object]):
    origin_x, origin_y = bmo_body.ORGAN_PLACEMENTS[key]
    base = items[f"{key}_base"]
    lid = items[f"{key}_lid"]
    base_bbox = base.bounding_box()
    lid_bbox = lid.bounding_box()
    return (
        origin_x + min(base_bbox.min.X, lid_bbox.min.X),
        origin_x + max(base_bbox.max.X, lid_bbox.max.X),
        origin_y + min(base_bbox.min.Y, lid_bbox.min.Y),
        origin_y + max(base_bbox.max.Y, lid_bbox.max.Y),
    )


def overlap_amount(a, b):
    x_overlap = min(a[1], b[1]) - max(a[0], b[0])
    y_overlap = min(a[3], b[3]) - max(a[2], b[2])
    return x_overlap, y_overlap


def plate_size(name: str, shape):
    bbox = shape.bounding_box()
    return name, bbox.size.X, bbox.size.Y, bbox.size.Z


def main():
    failures: list[str] = []
    items = bmo_organ_pods.make_organs()

    half_w = bmo_body.ORGAN_LIP_W / 2
    half_h = bmo_body.ORGAN_LIP_H / 2
    print(f"rear tray organ lip: {bmo_body.ORGAN_LIP_W:.1f} x {bmo_body.ORGAN_LIP_H:.1f} mm")

    bounds = {}
    for key in bmo_body.ORGAN_PLACEMENTS:
        placed = placed_organ_bounds(key, items)
        bounds[key] = placed
        left = placed[0] + half_w
        right = half_w - placed[1]
        bottom = placed[2] + half_h
        top = half_h - placed[3]
        print(
            f"{key:14s} x={placed[0]:6.1f}..{placed[1]:5.1f} "
            f"y={placed[2]:6.1f}..{placed[3]:5.1f} "
            f"margins L/R/B/T={left:4.1f}/{right:4.1f}/{bottom:4.1f}/{top:4.1f}"
        )
        if min(left, right, bottom, top) < MIN_BBOX_GAP:
            failures.append(f"{key} has less than {MIN_BBOX_GAP:.2f} mm lip clearance")

    for left_key, right_key in combinations(bounds, 2):
        x_overlap, y_overlap = overlap_amount(bounds[left_key], bounds[right_key])
        if x_overlap > 0 and y_overlap > 0:
            failures.append(
                f"{left_key} overlaps {right_key} by {x_overlap:.1f} x {y_overlap:.1f} mm"
            )

    organ_map = bmo_organ_pods.make_closed_organ_map(items)
    print(
        "organ map bbox: "
        f"{organ_map.bounding_box().size.X:.1f} x "
        f"{organ_map.bounding_box().size.Y:.1f} x "
        f"{organ_map.bounding_box().size.Z:.1f} mm"
    )

    organ_kit = bmo_organ_pods.make_print_kit(items)
    body_parts = bmo_body.make_parts()
    body_kit = bmo_body.make_print_kit(body_parts)
    shell_plate = bmo_body.make_static_shell_plate(body_parts)
    accessories_plate = bmo_body.make_static_accessories_plate(body_parts)
    for name, x_size, y_size, z_size in (
        plate_size("organ print kit", organ_kit),
        plate_size("body print kit", body_kit),
        plate_size("static shell plate", shell_plate),
        plate_size("static accessories plate", accessories_plate),
    ):
        print(f"{name}: {x_size:.1f} x {y_size:.1f} x {z_size:.1f} mm")
        limit = A1_PLATE if name == "body print kit" else A1_SAFE
        if x_size > limit or y_size > limit:
            failures.append(f"{name} exceeds {limit:.0f} x {limit:.0f} mm plate envelope")

    component_map = {
        "esp32_heart": component_specs.BREADBOARD_ESP32_STACK,
        "mic_ear": component_specs.INMP441,
        "i2s_lung": component_specs.MAX98357_TERMINAL,
        "touch_spark": component_specs.TTP223,
        "battery_cell": component_specs.BATTERY_103450,
        "charge_kidney": component_specs.TP4056_TYPE_C,
        "boost_gland": component_specs.MT3608,
    }
    for key, component in component_map.items():
        cavity = bmo_organ_pods.ORGAN_CAVITIES[key]
        if cavity.width < component.width + component_specs.MIN_TOTAL_XY_CLEARANCE:
            failures.append(f"{key} cavity is too narrow for its component")
        if cavity.height < component.height + component_specs.MIN_TOTAL_XY_CLEARANCE:
            failures.append(f"{key} cavity is too short for its component")
        if cavity.depth < component.depth + component_specs.MIN_Z_CLEARANCE:
            failures.append(f"{key} cavity is too shallow for its component")

    available_internal_depth = bmo_body.FRONT_DEPTH - bmo_body.FRONT_SKIN - bmo_body.LID_LIP_H
    tallest_closed_pod = max(
        items[f"{key}_base"].bounding_box().size.Z
        + items[f"{key}_lid"].bounding_box().size.Z
        for key in bmo_body.ORGAN_PLACEMENTS
    )
    print(
        f"tallest closed organ: {tallest_closed_pod:.1f} mm "
        f"inside {available_internal_depth:.1f} mm body allowance"
    )
    if tallest_closed_pod > available_internal_depth:
        failures.append("closed organ depth exceeds the body internal allowance")

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"- {failure}")
        raise SystemExit(1)

    print("PASS")


if __name__ == "__main__":
    main()
