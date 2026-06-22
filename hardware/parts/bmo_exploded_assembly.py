"""Exploded CAD assembly showing how the BMO print kit stacks together."""

from __future__ import annotations

from build123d import Compound, Location

import bmo_body
import bmo_organ_pods


EXPORT_DIR = bmo_body.EXPORT_DIR


def make_exploded_assembly():
    body_parts = bmo_body.make_parts()
    organs = bmo_organ_pods.make_organs()

    children = [
        # Front shell and face parts pulled forward.
        body_parts["front_shell"].located(Location((0, 0, -48))),
        body_parts["tft_bezel"].located(Location((0, bmo_body.SCREEN_Y, -70))),
        body_parts["controls"].located(Location((0, 0, -70))),
        body_parts["side_bmo_text"].located(
            Location((bmo_body.BODY_W / 2 + 0.8, -4.0, bmo_body.FRONT_DEPTH * 0.64 - 48), (0, 90, 0))
        ),
        body_parts["left_arm"].located(Location((-bmo_body.BODY_W / 2 - 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.40 - 16))),
        body_parts["right_arm"].located(Location((bmo_body.BODY_W / 2 + 6.5, -55.0, bmo_body.FRONT_DEPTH * 0.40 - 16))),
        body_parts["left_leg_foot"].located(Location((-26.0, -114.0, -8))),
        body_parts["right_leg_foot"].located(Location((26.0, -114.0, -8))),
        # Rear tray remains behind the front shell.
        body_parts["rear_lid"].located(Location((0, 0, bmo_body.FRONT_DEPTH + 12))),
    ]

    # Organ bases above keyed locator pegs, lids above bases. Exact XY matches tray pegs.
    for key, (x, y) in bmo_body.ORGAN_PLACEMENTS.items():
        children.append(organs[f"{key}_base"].located(Location((x, y, bmo_body.FRONT_DEPTH + 54))))
        children.append(organs[f"{key}_lid"].located(Location((x, y, bmo_body.FRONT_DEPTH + 78))))

    return Compound(children=children)


def main():
    exploded = make_exploded_assembly()
    bmo_body.export_shape("bmo_exploded_assembly", exploded)
    print(bmo_body.describe_shape("bmo_exploded_assembly", exploded))
    print(f"Generated exploded assembly CAD in {EXPORT_DIR}")


if __name__ == "__main__":
    main()
