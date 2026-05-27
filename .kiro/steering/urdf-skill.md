---
inclusion: fileMatch
fileMatchPattern: '**/*.{urdf,srdf,sdf,xacro}'
---

# URDF skill

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/urdf/SKILL.md>

> URDF robot description generation and default generation-time validation.
> Use when creating, editing, regenerating, inspecting, or debugging
> `.urdf` files, Python `gen_urdf()` sources, robot links, joints, limits,
> inertials, visual/collision geometry, mesh references, frame conventions,
> or generated robot-description artifacts.

URDF correctness is **constrained kinematic modeling**, not just XML
writing. The main risks: frame placement, joint-axis semantics, unit
consistency, mesh scale, inertial data, and generated-artifact drift.

## Core rules

1. Treat the Python source defining `gen_urdf()` as the source of truth.
   Treat configured `.urdf` files as generated artifacts.
2. Generate only explicit URDF targets. Don't regenerate unrelated CAD,
   mesh, render, SRDF, SDF, or simulator artifacts from this skill.
3. The `scripts/urdf` generator validates generated URDFs by default. Don't
   document or use a separate `validate` command.
4. Before writing or changing URDF XML, establish the robot's frame, joint,
   geometry, unit, and assumption ledger. See `references/design-ledger.md`.
5. URDF frame semantics are exact. Joint origins, link frames, joint axes,
   and visual/collision/inertial origins use **different** reference frames.
6. Don't infer spatial transforms, mesh units, handedness, axes, or joint
   signs from vague prose. Use CAD transforms, dimensioned drawings,
   measured values, existing source data, or explicit assumptions.
7. Prefer simple, auditable generator code over clever XML construction.
   Name constants by physical meaning, not arbitrary numbers.
8. For physical links, model `inertial`, `visual`, and `collision`
   separately when the consumer needs them. Frame-only links may
   intentionally omit mass and geometry.

## Workflow

1. Identify `gen_urdf()` source and target `.urdf` output.
2. Identify target consumers: RViz, robot_state_publisher, Gazebo/Ignition,
   MoveIt, a real robot driver, or another simulator.
3. Read or create the design ledger before editing frames, origins, axes,
   mesh scale, limits, or inertials.
4. Edit the **generator source**, not generated URDF XML.
5. Regenerate only explicit targets with `scripts/urdf`.
6. Let generation-time validation fail fast on XML, graph, joint, geometry,
   mesh-reference, and inertial problems.
7. When geometry/mesh references depend on changed CAD, regenerate those
   explicit artifacts with the owning workflow first, then regenerate URDF.
8. After creating/modifying a `.urdf`, hand the explicit generated path to
   `$render`. It checks/reuses a live viewer and returns a link.
9. For visual feedback, prefer `$render` snapshots over opening the viewer
   or using Playwright. Stills only — URDF review should not generate GIFs.
10. When available, run a consumer smoke test: RViz display,
    robot_state_publisher tree, Gazebo/Ignition loading, or MoveIt model
    loading.
11. Report remaining assumptions, unchecked spatial data, skipped
    `$render` handoff/viewer checks, and validation/smoke-test gaps.

## Commands

The URDF generator and lightweight validator use only the Python standard
library. Downstream consumers (RViz, Gazebo, MoveIt) need their own
runtime packages.

From the URDF skill directory (when the bundle is installed):

```bash
python scripts/urdf path/to/source.py
python scripts/urdf path/to/source.py -o path/to/robot.urdf
python scripts/urdf path/to/a.py=out/a.urdf path/to/b.py=out/b.urdf
```

- Plain Python targets write a sibling `.urdf` next to the source.
- `-o` / `--output` is valid only with one plain target.
- `SOURCE.py=OUTPUT.urdf` pairs handle multi-target custom destinations.
- Relative source targets and CLI output overrides resolve from the
  current working directory. When running from outside the skill
  directory, prefix the launcher path so target files still resolve from
  the intended workspace.
- The launcher executes only `gen_urdf()` and validates the generated
  output. There is **no** separate validation-only command.

## References (installed bundle)

- Design ledger: `references/design-ledger.md`
- Frame semantics: `references/frame-semantics.md`
- URDF generator contract: `references/generator-contract.md`
- URDF generation command: `references/gen-urdf.md`
- URDF edit workflow: `references/urdf-workflow.md`
- Generation-time validation expectations: `references/validation.md`
