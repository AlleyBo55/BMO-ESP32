---
inclusion: fileMatch
fileMatchPattern: '**/*.{step,stp,stl,3mf,dxf,glb,urdf,srdf,sdf,scad}'
---

# CAD Skills — overview & dispatch

Source of these workflows: <https://github.com/earthtojake/text-to-cad>
(MIT licensed, by [@earthtojake](https://x.com/earthtojake))

This workspace adopts the **CAD Skills** suite for any 3D-printable, CAD,
robot-description, or fabrication-vendor task. Each individual skill has its
own steering file with its full contract; this file is the dispatcher that
tells you which one to load.

## Skills installed (one steering file each)

| Steering file | Use when the deliverable is… |
|---|---|
| [`cad-skill.md`](./cad-skill.md) | New parametric parts/assemblies, STEP/STP, build123d Python sources, `@cad[...]` references, geometry inspection, mating, secondary STL/3MF/DXF/GLB exports |
| [`render-skill.md`](./render-skill.md) | Opening or reusing CAD Explorer, returning visual review links, snapshots/PNG/GIF for `.step`, `.stp`, `.glb`, `.stl`, `.3mf`, `.dxf`, `.urdf`, `.srdf`, `.sdf` |
| [`step-parts-skill.md`](./step-parts-skill.md) | Off-the-shelf hardware (screws, nuts, washers, bearings, standoffs, motors, connectors) sourced from <https://step.parts> |
| [`urdf-skill.md`](./urdf-skill.md) | URDF robot description files, `gen_urdf()` Python sources, links/joints/limits, mesh references |
| [`srdf-skill.md`](./srdf-skill.md) | MoveIt2 SRDF semantics, planning groups, end effectors, disabled collisions, group states |
| [`sdf-skill.md`](./sdf-skill.md) | SDFormat/SDF Gazebo/Ignition simulator descriptions, models, worlds, plugins, sensors |
| [`sendcutsend-skill.md`](./sendcutsend-skill.md) | Vendor preflight reports for SendCutSend.com DXF/STEP uploads |
| [`cad-harness.md`](./cad-harness.md) | Repository-level operating rules: source vs. derived artifacts, LFS handling, search scoping, regen discipline |

## How to choose

1. **Is the user asking for a 3D part?** → `cad-skill.md`
2. **Need to source a screw/bearing/standoff?** → `step-parts-skill.md`
3. **Need to view what got generated?** → `render-skill.md`
4. **Is BMO growing arms/wheels?** → `urdf-skill.md` (kinematics) and optionally `srdf-skill.md` (planning) and/or `sdf-skill.md` (sim)
5. **Sending parts to be laser cut?** → `sendcutsend-skill.md`
6. **Editing or organizing CAD project files?** → also load `cad-harness.md`

Multiple skills often combine. A typical BMO mechanical task touches CAD, step.parts, and render.

## Default project layout for this workspace

```
hardware/
  parts/            # build123d sources, .py
    bmo_face_plate.py
    bmo_back_shell.py
  exports/          # generated artifacts
    bmo_face_plate.step
    bmo_face_plate.stl
    bmo_face_plate.3mf
  assembly.py       # imports parts, positions them
  README.md         # parametric overview, materials, print settings
  requirements.txt  # build123d, ocp-vscode
robots/             # if BMO grows actuators, URDF lives here
sim/                # if simulation worlds are needed (SDF)
```

## Tooling installation

The skill bundle is not installed by default. When the user wants live CAD
Explorer reviews and the snapshot CLI, install with:

```bash
npx skills add earthtojake/text-to-cad
```

Python deps for the CAD skill itself (build123d):

```bash
python3.11 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r skills/cad/requirements.txt
```

If the bundle is not installed, you can still author parametric build123d
sources and export STEP/STL/3MF using `python part.py`. The render and
snapshot conveniences require the bundle.

## Rules that apply across all skills

- **STEP is the primary CAD artifact.** STL, 3MF, DXF, GLB are secondary.
- **Edit source first, regenerate explicit targets.** Never hand-edit
  `.step`, `.stl`, `.3mf`, `.dxf`, `.urdf`, `.srdf`, `.sdf`.
- **Hand off generated paths to render** when the render skill is available.
  Prefer the snapshot CLI for visual feedback, not opening the viewer or
  using Playwright.
- **Use stills, not GIFs**, for review feedback. Only CAD STEP-module
  parameter animation may use GIFs.
- **Units default to mm**, X-Y plane, +Z up, unless the target consumer
  requires otherwise.
- **Treat external dependencies (screw sizes, bearing dims, etc.) as
  evidence**, not guesses. Pull them from step.parts when possible.

## When the bundle is unavailable

If `npx skills add` hasn't been run yet, fall back to:

- Author parametric parts in `hardware/parts/<name>.py` using `build123d`.
- Export STEP/STL/3MF via `if __name__ == "__main__":` blocks in each part.
- Skip viewer/snapshot integration; report screenshots manually if needed.
- Mention the install command to the user when richer review would help.
