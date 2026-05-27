---
inclusion: fileMatch
fileMatchPattern: '**/*.{sdf,world,xacro}'
---

# SDF skill (SDFormat for simulators)

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/sdf/SKILL.md>

> SDFormat/SDF model and world generation, validation, and simulator
> handoff. Use for `.sdf` files, SDFormat XML, Python `gen_sdf()` sources,
> models, worlds, links, joints, poses, frames, inertials,
> visual/collision geometry, mesh URIs, sensors, lights, physics, plugins,
> includes, Gazebo, CAD Explorer static SDF review, or simulator-specific
> metadata.

This skill is for **SDFormat**, not signed-distance-field geometry.

## Core rules

1. Python file defining `gen_sdf()` is the source of truth. Configured
   `.sdf` files are generated artifacts unless the user explicitly asks
   for direct XML editing.
2. Identify the target consumer first: Gazebo/libsdformat version, another
   simulator, visualization-only tooling, model package, or world handoff.
3. Decide document kind: model-level SDF, world-level SDF, or
   model-in-world. Prefer model-level SDF for reusable robot/object
   exports.
4. Use SI units unless the target requires otherwise: meters, kilograms,
   seconds, radians.
5. Prefer `version="1.12"` for new outputs unless the consumer constrains
   the version.
6. Establish the design ledger before writing poses, frames, joint axes,
   mesh scales, inertials, sensors, or plugins.
7. Don't infer spatial transforms from visual impression. Derive poses,
   axes, scale, mass, inertia, and frame names from upstream source data,
   drawings, simulator docs, measured values, or explicit assumptions.
8. Prefer helper functions and named constants over large XML string
   literals. Hidden numbers are a common SDF failure mode.
9. Generate only explicit targets. Don't run directory-wide generation.
10. Regenerate upstream geometry, mesh, robot-description, render,
    topology, or package assets with their owning workflows **before**
    regenerating SDF that references them.
11. After generation: bundled validation, optional `gz sdf --check`,
    simulator load, joint motion, plugin/sensor startup, and `$render`
    handoff.
12. Report assumptions, skipped checks, unresolved resource paths, and
    target-specific compatibility risks.

## Scope

Use for SDFormat outputs and generators. Don't use for signed-distance-
field modeling, raw geometry generation, planning semantics, or to paper
over incorrect upstream robot/source data.

## Workflow

1. Locate the `gen_sdf()` source and intended `.sdf` output.
2. Read or create the design ledger.
3. Read frame semantics before editing any `<pose>`, `<frame>`, joint
   axis, `relative_to`, `expressed_in`, nested scope, sensor frame, or
   plugin frame.
4. Edit the generator source, not generated XML.
5. Use optional builder helpers when they make structure clearer; raw
   ElementTree is still allowed.
6. Regenerate the explicit target.
7. Treat bundled validation as a guardrail, not simulator proof.
8. Run target-consumer smoke tests when available.
9. After creating/modifying `.sdf` output, hand the explicit generated
   path to `$render`. CAD Explorer doesn't execute SDF plugins or read
   file-authored motion metadata.
10. Use stills, not GIFs, for SDF review.
11. Report checks run, checks skipped, and assumptions.

## Commands

```bash
python scripts/sdf path/to/source.py
python scripts/sdf path/to/source.py -o path/to/output.sdf
python scripts/sdf path/to/a.py=out/a.sdf path/to/b.py=out/b.sdf

# optional external check
python scripts/sdf path/to/source.py --gz-check auto
python scripts/sdf path/to/source.py --gz-check required
python scripts/sdf path/to/source.py --gz-check never
```

`gz sdf --check` is optional target-consumer validation. Report it as
skipped when unavailable, unless explicitly required.

## Required report shape

```text
Generated: path/to/model.sdf from path/to/model.py
Checks run:
- bundled SDF validation: passed
- gz sdf --check: skipped, gz not installed
- simulator load: skipped, target simulator unavailable
- visual review: render viewer link returned; snapshot run/skipped
Assumptions:
- Assumed mesh units are meters.
- Assumed lidar frame is coincident with lidar_link.
Risks:
- Camera plugin filename was not verified in target simulator environment.
```

## References (installed bundle)

- Generation command: `references/gen-sdf.md`
- Generator contract: `references/generator-contract.md`
- SDF workflow: `references/sdf-workflow.md`
- Builder helpers: `references/builder-helpers.md`
- LLM guardrails: `references/llm-guardrails.md`
- Design ledger: `references/design-ledger.md`
- Frame semantics: `references/frame-semantics.md`
- Validation scope: `references/validation.md`
- Smoke tests: `references/smoke-tests.md`
- Interoperability: `references/interoperability.md`
- Examples: `references/examples.md`
- Runtime notes: `references/implementation-notes.md`
