---
inclusion: fileMatch
fileMatchPattern: '**/*.{srdf,urdf}'
---

# SRDF skill

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/srdf/SKILL.md>

> MoveIt2 SRDF generation, validation, and planning-semantics workflow.
> Use when creating, editing, regenerating, inspecting, or validating
> `.srdf` files, `gen_srdf()` sources, MoveIt planning groups, virtual
> joints, passive joints, end effectors, group states, disabled
> collisions, URDF-linked planning semantics, or SRDF handoff to CAD
> Explorer review.

SRDF correctness is a **planning semantics** problem. The common failure
isn't invalid XML — it's a plausible-looking SRDF that gives MoveIt the
wrong planning group, wrong tool link, wrong default state, unsafe
disabled-collision matrix, or wrong joint units.

LLMs are weak at spatial and kinematic reasoning. Derive planning groups,
end effectors, group states, and disabled collisions from URDF topology,
MoveIt Setup Assistant output, sampled collision analysis, or explicit
user data. Do not infer them from visual appearance alone.

## Format boundary

- **URDF** owns physical structure: links, joints, geometry, inertials,
  limits, mimic joints, transmissions, robot-state publishing.
- **SRDF** owns MoveIt semantics: virtual joints, passive joints,
  planning groups, group states, end effectors, disabled collision pairs.
- **SDF** owns simulator/world semantics: physics, sensors, lights,
  plugins, worlds, sim-specific metadata.

Don't put geometry, inertials, joint origins, link poses, mesh references,
physical joint limits, transmissions, or `ros2_control` interfaces in SRDF.

After creating or modifying generated `.srdf` files, hand the explicit
output path to `$render`. If the user needs interactive IK or path
planning, make that part of the `$render` handoff — `$render` owns the
local `moveit2_server` setup and runtime.

## Required workflow

1. **Start from a valid URDF.** Generate or fix the URDF first. The SRDF
   generator validates against the source-relative `.urdf` path supplied
   by `gen_srdf()`.
2. **Identify the planning task** — arm IK, gripper control, mobile-base
   planning, dual-arm, tool use, or local smoke testing.
3. **Create or update the planning ledger** before writing XML.
4. **Define virtual and passive joints deliberately.** Use them when the
   robot model needs them.
5. **Define planning groups from URDF topology.** Prefer chain groups for
   serial manipulators when base/tip form a real path. Use joint/link/
   subgroup definitions only when intentional.
6. **Define end effectors after group membership is known.** Avoid overlap
   between an EE group and its parent group. Record the actual target/TCP
   link.
7. **Define group states in URDF-native units.** Revolute and continuous
   in radians; prismatic in meters. **Never** store degrees in SRDF.
8. **Generate disabled collisions from evidence.** Use adjacency, MoveIt
   Setup Assistant sampling, or explicit user-provided collision matrices.
   Don't invent broad disable lists.
9. **Regenerate only explicit SRDF targets.** Generation validates the
   generated SRDF against the linked URDF before writing.
10. **Run MoveIt smoke tests when available.** Use Setup Assistant or a
    project MoveIt launch directly. For Explorer-based IK/planning, hand
    SRDF to `$render`; it owns `moveit2_server` startup and URL wiring.
11. **Hand off generated artifacts** to `$render` for live viewer links.
12. **Use stills, not GIFs**, for SRDF review.
13. **Report assumptions and skipped checks**: incomplete validation,
    missing MoveIt environment, skipped `$render` handoff/viewer checks,
    manually reasoned collision disables, inferred target links.

## Commands

```bash
python scripts/srdf path/to/source.py
python scripts/srdf path/to/source.py -o path/to/robot.srdf
python scripts/srdf path/to/a.py=out/a.srdf path/to/b.py=out/b.srdf
```

Relative source targets and CLI output overrides resolve from the current
working directory. Prefix the launcher path when running from outside the
skill directory.

For GUI/rendering review, do **not** start Explorer from this skill. Hand
generated/modified `.srdf` files to `$render` with explicit paths.
`$render` owns viewer liveness checks and links. Request optional MoveIt2
controls only when the user needs IK or path-planning review.

## Hard rules

- SRDF must reference an existing valid URDF.
- The SRDF robot name must match the URDF robot name.
- Group states use URDF-native units: radians for revolute/continuous,
  meters for prismatic.
- Disabled collision pairs require truthful reasons and provenance.
- End-effector groups should not share links with their parent planning
  group.
- `$render` owns CAD Explorer links and the local `moveit2_server`. SRDF
  hands off explicit generated/modified `.srdf` paths rather than
  starting GUI services itself.
- Visual rendering review is useful but **cannot prove planning correctness**.

## References (installed bundle)

- Generation command: `references/gen-srdf.md`
- Generator contract: `references/generator-contract.md`
- SRDF workflow: `references/srdf-workflow.md`
- Planning ledger: `references/planning-ledger.md`
- Validation scope: `references/validation.md`
- End effectors: `references/end-effectors.md`
- Disabled collisions: `references/disabled-collisions.md`
