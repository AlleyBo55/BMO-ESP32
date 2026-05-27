---
inclusion: fileMatch
fileMatchPattern: '**/*.{step,stp,stl,3mf,dxf,glb,urdf,srdf,sdf}'
---

# Render skill

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/render/SKILL.md>

> Start or reuse the CAD Explorer viewer, return review links, and create
> saved snapshots for explicit CAD and robot-description files. Use when
> rendering or visually reviewing `.step`, `.stp`, `.glb`, `.stl`, `.3mf`,
> `.dxf`, `.urdf`, `.srdf`, or `.sdf` files, especially when handed off
> from CAD, URDF, SRDF, or SDF generation skills.

## Handoff contract

- Accept explicit file paths from CAD, URDF, SRDF, SDF, SendCutSend, or
  standard-part workflows.
- Start or reuse CAD Explorer with `dev:ensure`. Do **not** assume a fixed
  port. Treat `dev:ensure` as the viewer-liveness check for returned links.
- Treat port reuse as mandatory: if `dev:ensure` reports `EPERM`/`EACCES`,
  rerun with the needed local-binding permission, **don't** pick a new port.
- Do not use `npm run dev -- --port ...`, raw `vite dev`, or raw
  `vite preview` for normal handoffs. Those bypass the reuse policy and
  leave duplicate Explorer servers running.
- Return the printed Explorer URL for each file.
- For generation review, prefer the snapshot CLI over opening the viewer
  manually or using Playwright. Viewer links still get returned.
- GIFs only for CAD STEP-module parameter animation review. Otherwise
  stills.
- If startup fails, report the failure and let the owning skill continue
  with non-GUI validation.

## Commands

From the `skills/render` directory (when the bundle is installed):

```bash
# start or reuse Explorer for a file
npm --prefix scripts/viewer run dev:ensure -- --file path/to/model.step

# headless snapshot
python3 scripts/snapshot --job path/to/render-job.json
python3 scripts/snapshot --job -

# common still snapshot
python3 scripts/snapshot \
  --input path/to/model.step \
  --output /tmp/model.png \
  --mode view \
  --theme technical \
  --camera iso \
  --view-labels

# STEP module sidecar parameters (still or animated GIF)
python3 scripts/snapshot \
  --input path/to/model.step \
  --output /tmp/model.png \
  --params '{"drive":180,"ringVisible":false}'

python3 scripts/snapshot \
  --input path/to/model.step \
  --output /tmp/model.gif \
  --params '{"values":{"ringVisible":true},"animate":{"drive":{"from":0,"to":1260}},"durationSeconds":6,"fps":18,"loop":true}'

# explicit workspace root
npm --prefix scripts/viewer run dev:ensure -- \
  --workspace-root /path/to/workspace \
  --file path/to/model.step

# manual Vite foreground (for Explorer dev only)
npm --prefix scripts/viewer run dev
```

## Snapshot defaults

The snapshot CLI defaults to `--theme technical`, a flat high-contrast
theme intended for diagnosis, not presentation. Picks default dimensions
by request context when width/height are omitted:

- Diagnostic stills: 1600×1200
- Simple unlabeled parts: 1200×900
- Sections / labeled / dimensioned views: at least 1600×1200
- Complex assemblies: 1800×1200 or 1920×1440 via `render.sizeProfile`
- Presentation renders: 2400×1600 or 2800×1800 via `render.sizeProfile`
- STEP module parameter GIFs: 960×640
- Contact sheets: at least 2400 px wide

Keep transparent snapshots presentation-only unless transparency answers a
specific overlap, collision, or internal-relationship question.

`--theme` accepts a built-in name, an inline JSON theme object, or a path
to a JSON theme file. Set `theme.display.mode` to `solid` or `wireframe`
for surface/wire output.

`--params` targets Explorer `.step.js` STEP module sidecar parameters,
**not** Python/build123d regeneration parameters.

Supported render modes: `view`, `orbit`, `section`, `list`.
Supported inputs: `.step`, `.stp`, `.glb`, `.stl`, `.3mf`, `.dxf`,
`.urdf`, `.srdf`, `.sdf`.

## MoveIt2 controls (SRDF reviews only)

```bash
scripts/moveit2_server/setup.sh
scripts/moveit2_server/check-moveit2-server.sh
scripts/moveit2_server/run-moveit2-server.sh
```

Default WS URL: `ws://127.0.0.1:8765/ws`. CAD Explorer connects there in
local dev unless `EXPLORER_MOVEIT2_WS_URL` or `?moveit2Ws=` is set.

Plain SRDF generation and Explorer links do not require the server. Start
it only when the user needs interactive IK or path-planning controls.

## Useful Explorer environment variables

```text
EXPLORER_PORT
EXPLORER_PORT_END
EXPLORER_ROOT_DIR
EXPLORER_DEFAULT_FILE
EXPLORER_WORKSPACE_ROOT
EXPLORER_GITHUB_URL
EXPLORER_MOVEIT2_WS_URL
EXPLORER_ALLOWED_HOSTS
EXPLORER_SERVER_REGISTRY
```

When exposing Explorer through Tailscale Serve, set
`EXPLORER_ALLOWED_HOSTS` before starting `dev:ensure`:

```bash
EXPLORER_ALLOWED_HOSTS=macbook-pro-108.tail3c8ded.ts.net \
  npm --prefix scripts/viewer run dev:ensure -- \
    --workspace-root /path/to/workspace \
    --root-dir models \
    --file path/to/model.urdf
```

If a remote phone shows a blank page through the Vite dev server, fall back
to a production preview build:

```bash
EXPLORER_WORKSPACE_ROOT=/path/to/workspace \
EXPLORER_ROOT_DIR=models \
EXPLORER_DEFAULT_FILE=robots/elrobot/elrobot-follower.urdf \
  npm --prefix scripts/viewer run build

cd scripts/viewer
EXPLORER_WORKSPACE_ROOT=/path/to/workspace \
EXPLORER_ROOT_DIR=models \
EXPLORER_DEFAULT_FILE=robots/elrobot/elrobot-follower.urdf \
EXPLORER_ALLOWED_HOSTS=macbook-pro-108.tail3c8ded.ts.net \
EXPLORER_PORT=4202 \
  npm exec vite preview -- --host 127.0.0.1 --port 4202 --strictPort
```

## Lightweight discipline

Start the server only when a link or review is needed. Prefer `dev:ensure`
for agent workflows. Don't stop an existing Explorer server unless the
user asks.
