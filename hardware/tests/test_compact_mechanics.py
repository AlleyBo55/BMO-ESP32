"""Regression checks for the compact BMO printable assembly."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

from build123d import Vector


PARTS = Path(__file__).resolve().parents[1] / "parts"
sys.path.insert(0, str(PARTS))

import bmo_compact_shell as compact
import bmo_rack


class CompactMechanicsTest(unittest.TestCase):
    def test_body_uses_approved_80_by_96_by_52_envelope(self) -> None:
        self.assertEqual((compact.BODY_W, compact.BODY_H, compact.FRONT_DEPTH), (80.0, 96.0, 52.0))
        self.assertEqual(
            (bmo_rack.RACK_BODY_W, bmo_rack.RACK_BODY_H, bmo_rack.RACK_BODY_D),
            (80.0, 96.0, 52.0),
        )

    def test_repacked_components_fit_without_overlap(self) -> None:
        speaker = {item.name: item for item in bmo_rack.layout()}["speaker"]
        self.assertEqual(speaker.size, (70.0, 30.0, 13.5))
        ok, messages = bmo_rack.check_pack()
        self.assertTrue(ok, "\n".join(messages))

    def test_internal_rack_is_one_connected_printable_part(self) -> None:
        rack = bmo_rack.make_rack()
        self.assertEqual(len(rack.solids()), 1)
        bbox = rack.bounding_box()
        inner_half_width = compact.BODY_W / 2 - compact.WALL
        inner_half_height = compact.BODY_H / 2 - compact.WALL
        self.assertGreaterEqual(bbox.min.X, -inner_half_width)
        self.assertLessEqual(bbox.max.X, inner_half_width)
        self.assertGreaterEqual(bbox.min.Y, -inner_half_height)
        self.assertLessEqual(bbox.max.Y, inner_half_height)

    def test_internal_parts_clear_the_rear_cover(self) -> None:
        rear_limit = compact.LID_SEAT_Z - bmo_rack.REAR_COVER_CLEARANCE
        for item in bmo_rack.layout():
            with self.subTest(item=item.name):
                self.assertLessEqual(bmo_rack._aabb(item)[5], rear_limit)
        self.assertLessEqual(bmo_rack.RACK_BACK_Z_MAX, rear_limit)

    def test_rear_cover_has_a_continuous_corner_sealing_lip(self) -> None:
        lid = compact.make_rear_lid()
        half_w = compact.BODY_W / 2
        half_h = compact.BODY_H / 2
        for point in (
            (half_w - 11.0, -half_h + 4.0, -4.0),
            (half_w - 4.0, -half_h + 11.0, -4.0),
            (-half_w + 11.0, -half_h + 4.0, -4.0),
            (-half_w + 4.0, -half_h + 11.0, -4.0),
        ):
            with self.subTest(point=point):
                self.assertTrue(lid.is_inside(Vector(*point)))

    def test_front_shell_stops_at_the_rear_cover_seat(self) -> None:
        shell = compact.make_front_shell(preview=True)
        self.assertAlmostEqual(shell.bounding_box().max.Z, compact.LID_SEAT_Z, places=4)
        for y in (-(compact.BODY_H / 2 - 0.5), compact.BODY_H / 2 - 0.5):
            with self.subTest(y=y):
                self.assertTrue(shell.is_inside(Vector(0.0, y, compact.LID_SEAT_Z - 0.1)))
                self.assertFalse(shell.is_inside(Vector(0.0, y, compact.LID_SEAT_Z + 0.1)))

    def test_screen_face_exposes_the_active_tft_area(self) -> None:
        face = compact.make_face_panel()
        self.assertFalse(face.is_inside(Vector(0.0, 0.0, compact.FACE_T / 2)))
        self.assertGreaterEqual(
            compact.FACE_ACTIVE_W,
            compact.SCREEN_VISIBLE_W,
        )
        self.assertGreaterEqual(
            compact.FACE_ACTIVE_H,
            compact.SCREEN_VISIBLE_H,
        )

    def test_screen_bezel_has_matching_shell_mounts(self) -> None:
        bezel = compact.make_bezel_ring()
        self.assertEqual(len(compact.BEZEL_PEG_POS), 4)
        self.assertGreaterEqual(
            bezel.bounding_box().size.Z,
            compact.BEZEL_T + compact.BEZEL_PEG_H,
        )
        shell = compact.make_front_shell()
        for x, y in compact.BEZEL_PEG_POS:
            with self.subTest(x=x, y=y):
                self.assertFalse(
                    shell.is_inside(Vector(x, compact.FACE_Y + y, compact.FRONT_SKIN / 2))
                )

    def test_rear_cover_is_solid_with_no_cam_lock(self) -> None:
        # The quarter-turn cam lock was removed (redundant with the snap
        # detents). The cover must now be a solid, keyhole-free panel and no
        # cam_lock parts should remain in any kit.
        for kit in (compact.outside_print_kit_parts(), compact.compact_print_kit_parts()):
            cam_names = [name for name, _ in kit if "cam_lock" in name]
            self.assertEqual(cam_names, [])
        # No cam keyholes: the domed cover skin is continuous over the old
        # cam-lock corners (probe across the shell band -> material present).
        lid = compact.make_rear_lid()
        for x, y in [(-24.0, -35.0), (24.0, -35.0), (-24.0, 35.0), (24.0, 35.0)]:
            with self.subTest(x=x, y=y):
                self.assertTrue(
                    any(lid.is_inside(Vector(x, y, z)) for z in (3.5, 4.0, 4.5, 5.0, 5.5))
                )

    def test_inside_kit_includes_every_hold_down_strap(self) -> None:
        names = {name for name, _ in compact.inside_print_kit_parts()}
        self.assertTrue(
            {"speaker_strap", "battery_strap", "breadboard_strap"}.issubset(names)
        )

    def test_limb_bayonets_have_firm_axial_preload(self) -> None:
        self.assertLessEqual(compact.BAY_AXIAL_CLEARANCE, 0.25)
        self.assertLessEqual(compact.BAY_CLR, 0.25)

    def test_shoe_feet_provide_a_stable_support_polygon(self) -> None:
        self.assertGreaterEqual(compact.FOOT_W, 18.0)
        self.assertGreaterEqual(compact.FOOT_D, 30.0)
        self.assertGreaterEqual(compact.LEG_SPACING, 30.0)
        for side in ("left", "right"):
            with self.subTest(side=side):
                foot = compact.make_leg(side)
                self.assertGreaterEqual(foot.bounding_box().size.X, compact.FOOT_W)
                self.assertGreaterEqual(foot.bounding_box().size.Z, compact.FOOT_D)

    def test_compact_a1_plates_are_separated_and_inside_safe_area(self) -> None:
        for label, parts in (
            ("outside", compact.outside_print_kit_parts()),
            ("inside", compact.inside_print_kit_parts()),
        ):
            boxes = []
            for name, shape in parts:
                bbox = shape.bounding_box()
                boxes.append(
                    (
                        name,
                        bbox.min.X,
                        bbox.max.X,
                        bbox.min.Y,
                        bbox.max.Y,
                    )
                )
                self.assertGreaterEqual(bbox.min.X, -compact.A1_SAFE / 2, label)
                self.assertLessEqual(bbox.max.X, compact.A1_SAFE / 2, label)
                self.assertGreaterEqual(bbox.min.Y, -compact.A1_SAFE / 2, label)
                self.assertLessEqual(bbox.max.Y, compact.A1_SAFE / 2, label)

            for index, left in enumerate(boxes):
                for right in boxes[index + 1 :]:
                    x_overlap = min(left[2], right[2]) - max(left[1], right[1])
                    y_overlap = min(left[4], right[4]) - max(left[3], right[3])
                    self.assertFalse(
                        x_overlap > 0 and y_overlap > 0,
                        f"{label}: {left[0]} overlaps {right[0]}",
                    )


if __name__ == "__main__":
    unittest.main()
