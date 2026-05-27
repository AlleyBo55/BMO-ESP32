---
inclusion: fileMatch
fileMatchPattern: 'hardware/**/*'
---

# CAD repo harness rules

Source: <https://github.com/earthtojake/text-to-cad/blob/main/harness/AGENTS.md>

Repository-level operating rules for script-driven CAD and robot-description
generation. Domain workflows live in the relevant skill steering files.

## Harness context

Project files are repo-relative. The harness doesn't reserve a project-file
directory. Project entries can live at the repo root under folders such as
`STEP/`, `STL/`, `DXF/`, `3MF/`, or in another explicit repo-relative layout
chosen by the project. **In this workspace, mechanical work lives under
`hardware/`**.

Skill tools are file-targeted. They don't depend on a harness layout and
don't prepend a project root.

Project-specific context can live in compact notes such as `PROJECT.md`.
Don't copy reusable skill workflow rules, validation policy, Explorer/link
rules, image-review policy, generator contracts, or full CLI syntax into
project notes — refer to the relevant skill instead.

## Python environment

Prefer the repo-local CAD runtime when it exists:

```bash
./.venv/bin/python
```

If `.venv` is missing or can't import required CAD modules, create or
install the environment from the repo root using the dependency
instructions in the relevant skill (typically `cad-skill.md`).

Other bundled workflows own their own dependency setup. Install those
deps only when using those workflows.

## Source of truth

Generated CAD files, URDF, SDF, SRDF, Explorer sidecars, renders,
topology, meshes, and flat-pattern artifacts are **derived artifacts**.

Don't hand-edit derived artifacts unless explicitly instructed. Edit the
owning source file or imported source file first, then regenerate the
explicit target with the relevant skill tool.

If regenerated output differs from checked-in generated files, the
regenerated output is authoritative.

## Repo policies

- Project files in explicit repo-relative locations.
- Use **explicit generation targets**. Don't run directory-wide generation.
- Generation tools write/overwrite configured outputs. They don't delete
  stale outputs when paths change — clean those up manually.
- Update project-local docs only when project focus, entry roles, inventory,
  dependency notes, durable quirks, or preferred rebuild roots change.
- CAD outputs are often LFS-tracked. Prefer path-limited `git status`
  during CAD work, especially while generated files are changing.

For bookkeeping-only full status without LFS smudge:

```bash
git -c filter.lfs.clean= \
    -c filter.lfs.smudge= \
    -c filter.lfs.process= \
    -c filter.lfs.required=false \
    status --short
```

Never disable LFS filters for `git add`, commits, or other object-writing
operations.

## Execution notes

- Start with the **narrowest source-only search** that can identify
  directly affected files.
- Exclude generated artifacts, binary CAD files, caches, and build outputs
  from default searches unless the task explicitly targets them.
- If the first pass makes scope clear, edit the source first and validate
  after.
- Don't run mutable generation, inspection, and render/review steps in
  parallel against geometry that's still changing in the same edit loop.
  **Rebuild → inspect → review**, in that order.
- In cloud or constrained environments, avoid full-repo hydration when
  affected entries are known. Fetch only the needed inputs, generated
  outputs, and LFS objects for the entries being edited and explicitly
  regenerated.

## This workspace's specifics

- Mechanical sources live in `hardware/parts/*.py`.
- Generated artifacts live in `hardware/exports/*.{step,stl,3mf,glb,dxf}`.
- Robot descriptions, when added, live in `robots/*.urdf|.srdf`.
- Sim worlds, when added, live in `sim/*.sdf`.
- Vendor-specific bundles (e.g. SendCutSend cutlists) live next to their
  DXF/STEP files in `hardware/exports/<vendor>/`.
