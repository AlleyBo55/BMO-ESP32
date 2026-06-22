"""BMO V8 static + tip stability analysis.

Turns the hand-wavy claim "the low ballast keeps it upright" into actual
numbers: computes the loaded center of mass (CoM), the foot support polygon,
the static stability margin, the CoM excursion when the arms swing, and the
sideways/fore-aft tipping angle.

Method
------
Mass = printed-PLA mass (part volume x PLA density x effective fill factor)
     + lumped component masses (servos, bearings, battery, boards) placed at
       their real mounting coordinates.
CoM  = mass-weighted average of every part/component centroid (CenterOf.MASS,
       in world/body coordinates).
Support polygon = the convex footprint of the two feet on the ground plane
       (X = width, Z = depth). Static stability requires the CoM's (X, Z)
       projection to fall inside it; the margin is the distance to the nearest
       edge. Tip angle = atan(margin_to_edge / CoM_height).

Coordinate convention matches bmo_body: X width, Y up, Z depth.
All masses in grams, lengths in mm.
"""

from __future__ import annotations

from math import atan2, degrees, hypot

from build123d import CenterOf, Location

import bmo_body
import bmo_magic_v8 as v8


# ---------- Material / print ----------
PLA_DENSITY = 1.24e-3      # g/mm^3 (solid PLA)
EFFECTIVE_FILL = 0.45      # printed parts: walls + sparse infill ~= 45% of solid

# ---------- Component masses (grams, datasheet/measured-typical) ----------
M_SG90 = 9.0               # SG90 9g micro servo
M_623ZZ = 1.4              # 623ZZ ball bearing
M_BATTERY = 48.0           # 804066 ~3000 mAh LiPo
M_ESP32 = 4.0              # ESP32-C3 super mini + wiring
M_SCREEN = 11.0            # 1.8" ST7735 module
M_SPEAKER = 10.0           # 8 ohm speaker + MAX98357 amp
M_MISC = 6.0               # mic, touch, dupont wiring, screws


def _placed_mass(part, loc: Location):
    """Return (mass_g, centroid_xyz) for a printed PLA part at a world location."""
    p = part.located(loc)
    vol = p.volume
    mass = vol * PLA_DENSITY * EFFECTIVE_FILL
    c = p.center(CenterOf.MASS)
    return mass, (c.X, c.Y, c.Z)


def printed_parts():
    """Every printed PLA part in the standing assembly with its world location.

    Placements mirror v8.make_v8_assembly('stand'); kept here so the analysis
    is explicit and survives if the assembly preview changes cosmetically.
    """
    fd = bmo_body.FRONT_DEPTH
    return [
        ("front_shell", bmo_body.make_front_shell(preview=True), Location((0, 0, 0))),
        ("rear_lid", bmo_body.make_rear_lid(), Location((0, 0, fd + 0.8))),
        ("servo_frame", v8.make_servo_frame(), Location((0, 0, fd + 1.0))),
        ("ballast_pod", v8.make_ballast_pod(), Location((0, -58.0, fd + 8.0))),
        ("output_collars", v8.make_output_collars(), Location((0, 0, 0))),
        ("left_arm", v8.make_arm("left"), v8._arm_location("left", 0.0)),
        ("right_arm", v8.make_arm("right"), v8._arm_location("right", 0.0)),
        ("left_leg", v8.make_leg("left"), v8._leg_location("left", 0.0)),
        ("right_leg", v8.make_leg("right"), v8._leg_location("right", 0.0)),
    ]


def lumped_components():
    """(label, mass_g, centroid_xyz) for non-printed components at their mounts."""
    sx, sy, sz = v8.SHOULDER_X, v8.SHOULDER_Y, v8.SHOULDER_PIVOT_Z
    hx, hy, hz = v8.HIP_X, v8.HIP_Y, v8.HIP_PIVOT_Z
    fd = bmo_body.FRONT_DEPTH
    return [
        ("servo_arm_L", M_SG90, (-sx, sy, sz)),
        ("servo_arm_R", M_SG90, (sx, sy, sz)),
        ("servo_hip_L", M_SG90, (-hx, hy, hz)),
        ("servo_hip_R", M_SG90, (hx, hy, hz)),
        ("bearing_sh_L", M_623ZZ, (-bmo_body.BODY_W / 2, v8.SHOULDER_PIVOT_Y, sz)),
        ("bearing_sh_R", M_623ZZ, (bmo_body.BODY_W / 2, v8.SHOULDER_PIVOT_Y, sz)),
        ("bearing_hip_L", M_623ZZ, (-hx, v8.HIP_PIVOT_Y, hz)),
        ("bearing_hip_R", M_623ZZ, (hx, v8.HIP_PIVOT_Y, hz)),
        ("battery", M_BATTERY, (0, -58.0, fd + 8.0)),
        ("esp32", M_ESP32, (0, 0.0, fd * 0.7)),
        ("screen", M_SCREEN, (0, bmo_body.SCREEN_Y, 5.0)),
        ("speaker_amp", M_SPEAKER, (bmo_body.BODY_W / 2 - 10.0, 32.0, fd * 0.5)),
        ("misc", M_MISC, (0, 10.0, fd * 0.5)),
    ]


def foot_support_polygon():
    """Axis-aligned support footprint (X, Z) from the two feet on the ground.

    Foot is FOOT_W (X) x FOOT_L (Z), centered under each hip (x = +/-HIP_X) at
    the leg's foot z. Returns (xmin, xmax, zmin, zmax) of the combined hull.
    """
    half_w = v8.FOOT_W / 2
    half_l = v8.FOOT_L / 2
    foot_cx = v8.HIP_X + 1.2          # leg tube drifts outward ~1.2 mm
    foot_cz = v8.HIP_PIVOT_Z + getattr(v8, "FOOT_Z_OFFSET", 2.0)
    xmin, xmax = -(foot_cx + half_w), (foot_cx + half_w)
    zmin, zmax = foot_cz - half_l, foot_cz + half_l
    return xmin, xmax, zmin, zmax


def compute_com_from_items(items, extra=None):
    """Total mass (g) and CoM (x,y,z) from a prebuilt item list (+ optional extra)."""
    allitems = items if not extra else items + extra
    total = sum(m for _, m, _ in allitems)
    cx = sum(m * c[0] for _, m, c in allitems) / total
    cy = sum(m * c[1] for _, m, c in allitems) / total
    cz = sum(m * c[2] for _, m, c in allitems) / total
    return total, (cx, cy, cz)


def gather_items():
    """Build every printed part ONCE and combine with lumped components.

    Returns (items, printed_mass) where items = [(name, mass_g, centroid)].
    """
    printed = []
    printed_mass = 0.0
    for name, part, loc in printed_parts():
        m, c = _placed_mass(part, loc)
        printed_mass += m
        printed.append((name, m, c))
    return printed + lumped_components(), printed_mass, dict((n, (m, c)) for n, m, c in printed)


def _margin_to_polygon(px, pz, poly):
    xmin, xmax, zmin, zmax = poly
    inside = xmin <= px <= xmax and zmin <= pz <= zmax
    dx = min(px - xmin, xmax - px)
    dz = min(pz - zmin, zmax - pz)
    margin = min(dx, dz)
    return inside, margin


def main():
    poly = foot_support_polygon()
    xmin, xmax, zmin, zmax = poly
    items, printed_mass, printed_lookup = gather_items()
    total, (cx, cy, cz) = compute_com_from_items(items)

    # CoM height above the ground (lowest foot point).
    ground_y = v8.HIP_PIVOT_Y - 44.0 - v8.FOOT_THK / 2
    com_height = cy - ground_y

    print("=== BMO V8 stability analysis ===")
    print(f"effective fill {EFFECTIVE_FILL:.2f}, PLA {PLA_DENSITY*1000:.2f} g/cm^3")
    print(f"total mass:        {total:.1f} g")
    print(f"  printed PLA:     {printed_mass:.1f} g")
    print(f"  components:      {total - printed_mass:.1f} g")
    print(f"CoM (x,y,z):       ({cx:.1f}, {cy:.1f}, {cz:.1f}) mm")
    print(f"support polygon X: [{xmin:.1f}, {xmax:.1f}]  (width {xmax-xmin:.1f} mm)")
    print(f"support polygon Z: [{zmin:.1f}, {zmax:.1f}]  (depth {zmax-zmin:.1f} mm)")

    inside, margin = _margin_to_polygon(cx, cz, poly)
    print(f"\nstatic stand:      CoM projects {'INSIDE' if inside else 'OUTSIDE'} the polygon")
    print(f"stability margin:  {margin:.1f} mm to nearest tip edge")
    print(f"CoM height:        {com_height:.1f} mm above the soles")
    if com_height > 0:
        tip_lat = degrees(atan2(min(cx - xmin, xmax - cx), com_height))
        tip_fb = degrees(atan2(min(cz - zmin, zmax - cz), com_height))
        print(f"tip angle (lateral, roll):   {tip_lat:.1f} deg before toppling")
        print(f"tip angle (fore/aft, pitch): {tip_fb:.1f} deg before toppling")

    # Dynamic worst case: both arms swung fully forward (+Z) at once. No rebuild;
    # reuse the already-built arm masses, just relocate their centroids forward.
    arm_reach_z = 50.0
    extra = []
    base = []
    for side, name in (("left", "left_arm"), ("right", "right_arm")):
        m, c = printed_lookup[name]
        sx = -v8.SHOULDER_X if side == "left" else v8.SHOULDER_X
        base.append((name, -m, c))  # subtract the resting arm
        extra.append((f"{name}_fwd", m, (sx, v8.SHOULDER_PIVOT_Y, v8.SHOULDER_PIVOT_Z + arm_reach_z)))
    total2, (cx2, cy2, cz2) = compute_com_from_items(items + base, extra=extra)
    inside2, margin2 = _margin_to_polygon(cx2, cz2, poly)
    print(f"\narms-forward worst case: CoM Z {cz:.1f} -> {cz2:.1f} mm "
          f"({'INSIDE' if inside2 else 'OUTSIDE'}, margin {margin2:.1f} mm)")

    verdict = "STANDS (static)" if inside else "TIPS — needs more ballast / wider feet"
    print(f"\nVERDICT: {verdict}")
    if inside and margin < 8.0:
        print("  margin is thin (<8 mm): fine standing still, twitchy during motion.")
        print(f"  firm it up: add low/central ballast or widen feet by ~{(8.0-margin)*2:.0f} mm.")


if __name__ == "__main__":
    main()
