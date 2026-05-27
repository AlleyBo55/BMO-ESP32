---
inclusion: fileMatch
fileMatchPattern: '**/*.{step,stp,stl,3mf,glb,scad,py}'
---

# CAD skill

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/cad/SKILL.md>

> Create, modify, inspect, and validate STEP-first build123d/Python CAD parts
> and assemblies. Use for natural-language CAD specs, STEP/STP generation,
> build123d source, build123d source-level joints, `@cad` references,
> geometry facts, measurements, mating deltas, CAD Explorer handoffs, and
> secondary DXF/STL/3MF outputs.

## Use this skill when

The user asks for: CAD files, STEP/STP files, build123d source, `@cad[...]`
references, mechanical parts, assemblies, enclosures, brackets, fixtures,
holes, counterbores, countersinks, slots, pockets, bosses, standoffs, ribs,
fillets, chamfers, shells, source-level joints, mating, or measurements.

Also use it for DXF, STL, 3MF, or native GLB output from CAD geometry —
these are secondary workflows that branch from the STEP-first process.

Do not use for: render-only concept art, CAM toolpaths, FEA conclusions,
architectural BIM, or freehand illustration.

## Default assumptions

Unless the user specifies otherwise:

- Units: **millimeters**.
- Origin: center of the part / assembly, unless a mating interface or fixed
  root component suggests a better origin.
- Base plane: XY. Up axis: +Z.
- Output: closed, positive-volume solids.
- STEP structure: one valid solid, a compound of solids, or a labeled
  assembly compound.
- Plastic enclosure walls: 2.0–3.0 mm.
- Cosmetic fillets: 1.0–3.0 mm where safe.
- Clearance holes: M3 = 3.4 mm, M4 = 4.5 mm, M5 = 5.5 mm.

Ask one focused clarification question only when missing info makes the
model impossible, fit-critical, safety-critical, or compliance-bound.
Otherwise proceed with explicit assumptions stated up front.

## Required workflow

1. **Classify the task** — new part, new assembly, source mod, direct STEP
   inspection, reference selection, measurement/mating check, render
   review, or secondary output.
2. **Create a natural-language CAD brief** internally — extract dimensions,
   units, coordinate convention, feature intent, output paths, assumptions,
   and validation targets. Do **not** require user-supplied JSON.
3. **Plan before coding** — define parameters, labels, source paths,
   expected bounding boxes, and any mating/positioning datums.
4. **Edit source, not artifacts.** Prefer build123d Python with `gen_step()`.
5. **Generate explicit targets** with `scripts/step` (when the bundle is
   installed). Never run directory-wide generation.
6. **Validate geometrically** with `scripts/inspect refs --facts --planes
   --positioning`, plus targeted `measure`, `mate`, `frame`, or `diff`.
7. **Hand off to `$render`** for live viewer links when supported artifacts
   are created or modified.
8. **Tier visual review** — prefer the snapshot CLI over opening the viewer
   manually or using Playwright. Use stills; only STEP-module parameter
   animations get GIFs.
9. **Repair tightly** — if a check fails, change the smallest responsible
   source section, regenerate, rerun the failed validation.

## Standard part template

```python
"""BMO front face plate: holds the ST7735 TFT.

All dimensions parametric; edit constants only.
"""
from build123d import *

# ---------- Parameters ----------
PLATE_W = 80
PLATE_H = 70
PLATE_T = 2.5
SCREEN_W = 35
SCREEN_H = 28
SCREEN_INSET = 0.6
CORNER_R = 4
SCREW_D = 2.4         # M2 clearance
SCREW_INSET = 4

# ---------- Geometry ----------
def gen_step():
    with BuildPart() as plate:
        with BuildSketch():
            RectangleRounded(PLATE_W, PLATE_H, CORNER_R)
        extrude(amount=PLATE_T)

        # Screen window
        with BuildSketch(plate.faces().sort_by(Axis.Z)[-1]):
            Rectangle(SCREEN_W, SCREEN_H)
        extrude(amount=-PLATE_T, mode=Mode.SUBTRACT)

        # Bezel recess
        with BuildSketch(plate.faces().sort_by(Axis.Z)[-1]):
            Rectangle(SCREEN_W + 4, SCREEN_H + 4)
        extrude(amount=-SCREEN_INSET, mode=Mode.SUBTRACT)

        # Corner screw holes
        for x in (-PLATE_W/2 + SCREW_INSET, PLATE_W/2 - SCREW_INSET):
            for y in (-PLATE_H/2 + SCREW_INSET, PLATE_H/2 - SCREW_INSET):
                with Locations((x, y, 0)):
                    Hole(SCREW_D / 2, depth=PLATE_T)
    return plate.part

if __name__ == "__main__":
    part = gen_step()
    part.export_step("../exports/bmo_face_plate.step")
    part.export_stl("../exports/bmo_face_plate.stl")
    part.export_3mf("../exports/bmo_face_plate.3mf")
```

## Tool launchers (when bundle is installed)

```bash
python scripts/step path/to/source.py
python scripts/step path/to/source.py -o path/to/output.step
python scripts/inspect refs --facts --planes --positioning path/to/output.step
python scripts/dxf path/to/source.py
```

When the bundle is not installed, run the source file directly with
`python hardware/parts/<name>.py` — its `if __name__ == "__main__":` block
exports STEP/STL/3MF beside the source.

## Non-negotiables

- STEP is primary; STL, 3MF, GLB, DXF are derived.
- When a Python generator exists, run `scripts/step` on the **generator**.
  Direct STEP/STP targets are only for files without a generator.
- Use named parameters, closed solids, explicit labels.
- Author assembly positioning in source with build123d joints, part-local
  datums, and explicit `Location` transforms. CLI `inspect mate` is
  read-only validation, not source editing.
- Do not use `git status` / `git diff` / file-size churn as CAD comparison.
  Compare source changes, `scripts/inspect` summaries, or rendered images.
- Hand off to `$render` whenever it's available; report if it isn't.
- Report only checks that actually ran.

## Print-friendliness defaults

- FDM wall thickness: 1.6–2.5 mm (multiples of nozzle diameter).
- Min hole diameter: 2 mm FDM, 1 mm resin.
- Overhang ≤ 45° or add a chamfer.
- M2 heat-set insert hole: 3.2 mm. M3 insert: 4.0 mm.
- Snap-fit clearance: 0.2–0.3 mm on FDM, 0.1 mm on resin.
- Comment in source which face goes on the bed.
