"""Compact BMO glue-in TFT cradle + light tunnel for the 1.8" ST7735 module.

Why this part exists
--------------------
On the compact front shell the screen area is layered like this (face outer
surface = z 0, +Z runs into the body), all from `bmo_compact_shell`:

    face panel (pale surround)   z -0.4 .. 1.4   (FACE_T thick, sits in window)
    front skin / screen window   z  0   .. 3.2   (FACE_W x FACE_H hole)
    molded retaining lip         z  2.2 .. 5.6   (45 x 35 opening)
    >>> open gap <<<             z  1.4 .. 5.6   (nothing fills this)
    TFT board glass              z  5.6 ..        (board seats behind the lip)

The ST7735 board (58 x 35) is wider than the lip opening, so it can only sit
behind the lip at z >= 5.6. That leaves the LCD ~4 mm behind the face panel
with an empty, unsupported recess between them, and the board itself has
nothing holding it. This part fills that whole space and holds the board:

  1. LIGHT TUNNEL (front): nests through the lip opening and butts the back of
     the face panel, with a bore matching the active LCD so the image shows.
     This FILLS the face-panel-to-board gap.
  2. BOARD POCKET: captures the 58 x 35 PCB, glass forward against the tunnel's
     rear ledge (front stop), with a rear ledge as the back stop.
  3. REAR FILL skirt: extends back to brace the interior.

Insertion: slides in from BEHIND (inside the body). The tunnel (sized just
under the 45 x 35 lip opening) passes through the lip until its tip meets the
face panel; the wider board pocket stays behind the lip.

Everything is derived from `bmo_compact_shell`, so regenerating keeps it in
sync with the shell's face window, skin, lip, and active-area opening.

Print orientation: REAR (skirt rim) DOWN on the bed; the tunnel and pocket
face UP. Continuous upward walls, no supports.

Coordinates (part-local): centered in XY on the screen window. z = 0 is the
back face of the face panel (the tunnel tip / front glue plane). +Z into body.
"""

from __future__ import annotations

from build123d import *
from build123d import export_step, export_stl

import bmo_body
import bmo_compact_shell as shell
import bmo_component_specs as cs

# ---------- Pinned component facts (mm) ----------
TFT_W = cs.TFT_BOARD.width        # 58.0
TFT_H = cs.TFT_BOARD.height       # 35.0
TFT_T = cs.TFT_BOARD.depth        # 5.0
ACT_W = cs.TFT_ACTIVE.width       # 35.0
ACT_H = cs.TFT_ACTIVE.height      # 28.0

# ---------- Derived from the COMPACT front shell ----------
FACE_W = shell.FACE_W             # 48.0
FACE_H = shell.FACE_H             # 38.0
FACE_Y = shell.FACE_Y             # 21.0
R_FACE = shell.R_FACE             # 6.0
FACE_T = shell.FACE_T             # 1.8  face-panel thickness
FRONT_SKIN = shell.FRONT_SKIN     # 3.2

# Active-area light opening (matches the face panel's opening exactly)
BORE_W = shell.SCREEN_VISIBLE_W   # 35.8  (active + DISPLAY_OPENING_CLEARANCE)
BORE_H = shell.SCREEN_VISIBLE_H   # 28.8
BORE_R = 1.8

# Molded retaining lip (mirror of make_front_shell):
#   frame add @ z=FRONT_SKIN-1.0, depth 3.4 ; inner opening FACE_W-3 x FACE_H-3
LIP_FRONT   = FRONT_SKIN - 1.0    # 2.2
LIP_BACK    = LIP_FRONT + 3.4     # 5.6
LIP_INNER_W = FACE_W - 3.0        # 45.0
LIP_INNER_H = FACE_H - 3.0        # 35.0

# Face panel back plane (panel sits proud of the skin front by FACE_PANEL_PROUD)
FACE_PANEL_PROUD = 0.4            # from the assembly: panel located at z=-0.4
FACE_PANEL_BACK  = -FACE_PANEL_PROUD + FACE_T   # 1.4 (skin-front frame)

# Compact cavity (for the fit check)
CAVITY_HALF_W = shell.BODY_W / 2 - shell.WALL   # 37.2
CAVITY_TOP_Y  = shell.BODY_H / 2 - shell.WALL   # 45.2

# ---------- Fit parameters (tune to your printer + measured gap) ----------
BOARD_CLR    = 0.8     # total slip clearance added to pocket W and H
POCKET_DEPTH = TFT_T + 0.4   # board capture depth
WALL_T       = 1.8     # pocket / skirt wall thickness (slim; FDM min ~1.6)
LIP_NEST_CLR = 0.4     # clearance of the tunnel inside the molded lip opening
LEDGE_T      = 1.2     # full-width front-stop ledge behind the lip (joins tunnel
                       # to the pocket walls; the board glass rests on its back)
REAR_LEDGE   = 3.0     # inward back stop the board rests against
REAR_FILL    = 3.0     # <-- gap filler behind the board (slim; set 0 for minimal)

# ---------- Cable exit ----------
CABLE_SLOT   = True
CABLE_SLOT_W = 26.0
CABLE_SLOT_H = 6.0

# ---------- Derived geometry ----------
# Light tunnel: just under the lip opening so it passes through from behind.
TUNNEL_W = LIP_INNER_W - 2 * LIP_NEST_CLR       # 44.2
TUNNEL_H = LIP_INNER_H - 2 * LIP_NEST_CLR        # 34.2
TUNNEL_R = R_FACE - 0.3
TUNNEL_DEPTH = LIP_BACK - FACE_PANEL_BACK        # 4.2 (face panel back -> lip back)

POCKET_INNER_W = TFT_W + BOARD_CLR               # 58.8
POCKET_INNER_H = TFT_H + BOARD_CLR               # 35.8
OUTER_W = POCKET_INNER_W + 2 * WALL_T            # 63.2
OUTER_H = POCKET_INNER_H + 2 * WALL_T            # 40.2
OUTER_R = 4.0
POCKET_R = 3.0

# Z stations (z = 0 = face panel back, +Z into body)
Z_LEDGE_FRONT = TUNNEL_DEPTH                     # 4.2  tunnel back / ledge front
Z_BOARD_FRONT = Z_LEDGE_FRONT + LEDGE_T          # 5.4  board glass seats here
Z_BOARD_BACK  = Z_BOARD_FRONT + POCKET_DEPTH     # 11.0
Z_TOTAL       = Z_BOARD_BACK + REAR_FILL         # 17.0

# Install reference: tunnel tip (local z=0) sits at shell z=FACE_PANEL_BACK.
INSTALL_FRONT_SHELL_Z = FACE_PANEL_BACK          # 1.4


def gen_step():
    with BuildPart() as cradle:
        # --- Light tunnel (front): fills face panel -> lip -> ledge ---
        add(bmo_body.rounded_prism(TUNNEL_W, TUNNEL_H, TUNNEL_DEPTH, TUNNEL_R))

        # --- Ledge + board pocket + rear fill skirt: one solid block behind the
        # lip. Its front face (z = Z_LEDGE_FRONT) is full width and fully
        # contains the tunnel footprint, so the union is a single solid. ---
        add(
            bmo_body.rounded_prism(OUTER_W, OUTER_H, Z_TOTAL - Z_LEDGE_FRONT, OUTER_R)
            .located(Location((0, 0, Z_LEDGE_FRONT)))
        )

        # --- Active-area bore: light path from the face panel through the
        # tunnel AND the ledge, down to the board. ---
        add(
            bmo_body.rounded_prism(BORE_W, BORE_H, Z_BOARD_FRONT + 0.02, BORE_R)
            .located(Location((0, 0, -0.01))),
            mode=Mode.SUBTRACT,
        )

        # --- Board pocket; the ledge ring (bore..pocket) is the glass front stop ---
        add(
            bmo_body.rounded_prism(POCKET_INNER_W, POCKET_INNER_H,
                                   POCKET_DEPTH + 0.02, POCKET_R)
            .located(Location((0, 0, Z_BOARD_FRONT))),
            mode=Mode.SUBTRACT,
        )

        # --- Rear opening: leaves a back-stop ledge ring + hollow skirt ---
        add(
            bmo_body.rounded_prism(POCKET_INNER_W - 2 * REAR_LEDGE,
                                   POCKET_INNER_H - 2 * REAR_LEDGE,
                                   REAR_FILL + 1.0, POCKET_R)
            .located(Location((0, 0, Z_BOARD_BACK))),
            mode=Mode.SUBTRACT,
        )

        # --- Cable exit slot in the bottom skirt wall ---
        if CABLE_SLOT:
            with Locations((0, -OUTER_H / 2, Z_TOTAL - CABLE_SLOT_H / 2 + 0.5)):
                Box(CABLE_SLOT_W, WALL_T * 3, CABLE_SLOT_H + 1.0,
                    align=(Align.CENTER, Align.CENTER, Align.CENTER),
                    mode=Mode.SUBTRACT)

    return cradle.part


def fit_check():
    """Verify the installed cradle clears the compact body cavity + report fill."""
    half_w = OUTER_W / 2
    top = FACE_Y + OUTER_H / 2
    ok_w = half_w <= CAVITY_HALF_W
    ok_top = top <= CAVITY_TOP_Y
    ok_tunnel = (TUNNEL_W < LIP_INNER_W) and (TUNNEL_H < LIP_INNER_H)
    ok_bore = (BORE_W > ACT_W) and (BORE_H > ACT_H)
    print("---- compact fit check ----")
    print(f"  width   : half {half_w:.1f} <= {CAVITY_HALF_W:.1f}  -> {'PASS' if ok_w else 'FAIL'}")
    print(f"  top edge: {top:.1f} <= {CAVITY_TOP_Y:.1f}  -> {'PASS' if ok_top else 'FAIL'}")
    print(f"  tunnel passes lip opening ({TUNNEL_W:.1f}x{TUNNEL_H:.1f} < "
          f"{LIP_INNER_W:.0f}x{LIP_INNER_H:.0f}) -> {'PASS' if ok_tunnel else 'FAIL'}")
    print(f"  active LCD clears bore ({ACT_W:.0f}x{ACT_H:.0f} < "
          f"{BORE_W:.1f}x{BORE_H:.1f}) -> {'PASS' if ok_bore else 'FAIL'}")
    print(f"  fills shell z {INSTALL_FRONT_SHELL_Z:.1f} (face panel back) -> "
          f"{INSTALL_FRONT_SHELL_Z + Z_TOTAL:.1f} (into body)")
    print(f"  board glass sits at shell z {INSTALL_FRONT_SHELL_Z + Z_BOARD_FRONT:.1f}")
    return ok_w and ok_top and ok_tunnel and ok_bore


if __name__ == "__main__":
    part = gen_step()
    bb = part.bounding_box()
    print(f"solids: {len(part.solids())}")
    print(f"bbox mm: {bb.size.X:.1f} x {bb.size.Y:.1f} x {bb.size.Z:.1f}")
    fit_check()
    export_step(part, "../exports/bmo_compact_tft_cradle.step")
    export_stl(part, "../exports/bmo_compact_tft_cradle.stl",
               tolerance=0.08, angular_tolerance=0.15)
    print("exported bmo_compact_tft_cradle .step/.stl")
