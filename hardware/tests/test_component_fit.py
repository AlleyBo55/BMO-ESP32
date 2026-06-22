"""Dimensional contract for the user's Static BMO electronics."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


PARTS = Path(__file__).resolve().parents[1] / "parts"
sys.path.insert(0, str(PARTS))

import bmo_body
import bmo_component_specs as specs
import bmo_organ_pods


class ComponentFitTest(unittest.TestCase):
    def assert_cavity_fits(self, key: str, component: specs.Envelope) -> None:
        cavity = bmo_organ_pods.ORGAN_CAVITIES[key]
        self.assertGreaterEqual(
            cavity.width,
            component.width + specs.MIN_TOTAL_XY_CLEARANCE,
            f"{key} cavity is too narrow",
        )
        self.assertGreaterEqual(
            cavity.height,
            component.height + specs.MIN_TOTAL_XY_CLEARANCE,
            f"{key} cavity is too short",
        )
        self.assertGreaterEqual(
            cavity.depth,
            component.depth + specs.MIN_Z_CLEARANCE,
            f"{key} cavity is too shallow",
        )

    def test_tft_mount_matches_common_red_st7735_board(self) -> None:
        self.assertEqual(bmo_body.SCREEN_MODULE_W, specs.TFT_BOARD.width)
        self.assertEqual(bmo_body.SCREEN_MODULE_H, specs.TFT_BOARD.height)
        self.assertGreaterEqual(
            bmo_body.SCREEN_VISIBLE_W,
            specs.TFT_ACTIVE.width + specs.DISPLAY_OPENING_CLEARANCE,
        )
        self.assertGreaterEqual(
            bmo_body.SCREEN_VISIBLE_H,
            specs.TFT_ACTIVE.height + specs.DISPLAY_OPENING_CLEARANCE,
        )
        self.assertLessEqual(bmo_body.SCREEN_VISIBLE_W, specs.TFT_ACTIVE.width + 2.0)
        self.assertLessEqual(bmo_body.SCREEN_VISIBLE_H, specs.TFT_ACTIVE.height + 2.0)

    def test_direct_speaker_mount_uses_researched_envelope(self) -> None:
        self.assertEqual(bmo_body.SPEAKER_PLATE_W, specs.SPEAKER.width)
        self.assertEqual(bmo_body.SPEAKER_PLATE_H, specs.SPEAKER.height)
        self.assertEqual(bmo_body.SPEAKER_T, specs.SPEAKER.depth)

    def test_heart_fits_breadboard_esp32_stack(self) -> None:
        self.assert_cavity_fits("esp32_heart", specs.BREADBOARD_ESP32_STACK)

    def test_individual_organs_fit_modules(self) -> None:
        for key, component in {
            "mic_ear": specs.INMP441,
            "i2s_lung": specs.MAX98357_TERMINAL,
            "touch_spark": specs.TTP223,
            "battery_cell": specs.BATTERY_103450,
            "charge_kidney": specs.TP4056_TYPE_C,
            "boost_gland": specs.MT3608,
        }.items():
            with self.subTest(key=key):
                self.assert_cavity_fits(key, component)

    def test_exported_organ_bases_are_larger_than_published_cavities(self) -> None:
        organs = bmo_organ_pods.make_organs()
        for key, cavity in bmo_organ_pods.ORGAN_CAVITIES.items():
            with self.subTest(key=key):
                bbox = organs[f"{key}_base"].bounding_box()
                self.assertGreaterEqual(bbox.size.X, cavity.width + 2 * bmo_organ_pods.WALL)
                self.assertGreaterEqual(bbox.size.Y, cavity.height + 2 * bmo_organ_pods.WALL)


if __name__ == "__main__":
    unittest.main()
