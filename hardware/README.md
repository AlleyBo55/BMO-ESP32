# BMO Mechanical CAD

Parametric 3D-printable CAD for the BMO body lives in `hardware/parts`.

## Generate

```bash
cd /Users/gilang/ngoding/BMO
./.venv/bin/python hardware/parts/bmo_body.py
./.venv/bin/python hardware/parts/bmo_organ_pods.py
./.venv/bin/python hardware/parts/bmo_rack.py
./.venv/bin/python hardware/parts/bmo_compact_shell.py
```

Primary editable source:

- `hardware/parts/bmo_body.py`
- `hardware/parts/bmo_organ_pods.py`

Generated artifacts:

- `hardware/exports/bmo_full_assembly.step`
- `hardware/exports/bmo_fit_check_assembly.step`
- `hardware/exports/bmo_static_shell_plate.3mf`
- `hardware/exports/bmo_static_accessories_plate.3mf`
- `hardware/exports/bmo_exploded_assembly.step`
- `hardware/exports/bmo_organ_pods_print_kit.step`
- `hardware/exports/bmo_organ_map_assembly.step`
- `hardware/exports/*.stl`
- `hardware/exports/*.3mf`
- `hardware/bmo_viewer.html`

## Soft edges (the pillow look)

The body edges are filleted so it reads like the injection-molded reference,
not a sharp printed box. Two knobs in `bmo_body.py`:

- `FRONT_EDGE_FILLET` (6 mm) rounds the front-face perimeter.
- `BACK_EDGE_FILLET` (3 mm) rounds the rear edges; auto-capped to the lid
  thickness so the fillet always builds.

Raise `FRONT_EDGE_FILLET` for an even softer face; if a fillet ever fails to
build, lower it.

## Functional ports

- **USB-C charge port** (lower-left front). The cutout is pinned to a real
  part, not a guessed size: GCT **USB4085** 16P SMD USB-C receptacle
  (step.parts id `usb_c_receptacle_gct_usb4085`, measured STEP bbox
  8.94 x 9.17 x 5.56 mm). The TP4056 charge board sits behind it. To re-pin a
  different connector, update the `USBC_*` constants in `bmo_body.py`.
- **Cartridge slot**: the dark horizontal slot directly under the screen,
  matching BMO's game-cartridge opening.

## Front control layout

All front controls come from one source of truth (`CONTROL_POS` in
`bmo_body.py`), placed to match the show: yellow D-pad lower-left, cyan
triangle center, big red round button below it, green button to its right,
small blue button upper-right, two blue dashes lower-left.

## Snap-fit, no-glue lock (arms & legs)

The arms and legs assemble like a model kit but hold without glue. Each limb
has hidden **snap pins**: a split arrowhead pin flexes through a bore, the barb
springs out behind the body's inner wall, and an outside shoulder collar clamps
the wall between the barb and collar with a slight preload. Result: a positive
click and a preloaded, zero-play lock.

All fit is parametric at the top of `bmo_body.py`:

- `SNAP_PIN_R`, `SNAP_BARB`, `SNAP_CLEARANCE`, `SNAP_PRELOAD` — arm pins
- `LEG_SNAP_R`, `LEG_SNAP_BARB` — leg pins
- Bigger `SNAP_BARB` / `SNAP_PRELOAD` = stickier. Bigger `SNAP_CLEARANCE` =
  looser (raise it if a fat printer won't let parts seat).

### Print the test coupon first

Snap fit depends on your printer's tolerances. Print this ~10 min coupon and
dial it in before committing the whole body:

```bash
./.venv/bin/python hardware/parts/bmo_snap_test.py
# then slice hardware/exports/bmo_snap_test_coupon.3mf
```

Push each pin into the plate from the chamfered side. You want a firm shove, an
audible click, and no pull-out by hand. If pins won't seat, raise
`SNAP_CLEARANCE` by 0.04 and reprint. If they click but wobble, lower it by
0.04. Copy the winning value into `bmo_body.py`, then regenerate the body.

## Batch printing on the A1

Use these three pre-arranged batches for the Static BMO:

1. `bmo_static_shell_plate.3mf`: front shell and rear electronics tray,
   approximately 239.4 x 148.8 mm.
2. `bmo_static_accessories_plate.3mf`: TFT masking bezel, buttons, arms, fixed
   standing legs, and side BMO letters, approximately 207.0 x 188.5 mm.
3. `bmo_organ_pods_print_kit.3mf`: all organ bases and lids, approximately
   226.0 x 241.5 mm.

The legacy combined `bmo_print_kit` is kept for inspection but is too close to
the full 256 mm plate boundary for a comfortable brim. Use the three batches
above for actual printing.

## Compact BMO A1 printing

Use the split compact batches, not the legacy combined compact kit:

1. `bmo_compact_outside_kit.3mf`: front shell, rear cover, screen surround,
   plug-in bezel, buttons, arms, shoe-foot legs, and side letters,
   approximately 234.1 x 161.0 mm.
2. `bmo_compact_inside_kit.3mf`: one connected internal rack plus speaker,
   battery, and breadboard hold-down straps, approximately 212.4 x 124.1 mm.

The compact rear cover keeps a continuous inner sealing lip around all corners
and is a solid, keyhole-free panel. It is held shut by snap detent bumps on the
lip that click into dimples in the front shell (press to close, pull firmly to
pop off) -- the quarter-turn cam locks were removed as redundant. The screen
surround exposes the active TFT area, the teal bezel plugs into four hidden
shell sockets with a firm 0.12 mm press fit, limbs use tight bayonet cam locks,
and the rack has side cable combs plus a lower cable exit for cleaner harness
routing.

## Design Notes

- Units are millimeters.
- The fitted component envelopes are: common red ST7735 PCB 58 x 35 x 5 mm,
  active LCD opening 35.8 x 28.8 mm, ESP32-C3 Super Mini 22.5 x 18 mm,
  mini breadboard 47 x 36 x 8.5 mm, MAX98357 with terminal 24.6 x 19.4 x
  8 mm, INMP441 14 x 12 x 4 mm, TTP223 24 x 24 x 4 mm, MT3608 36 x 17 x
  14 mm, protected TP4056 Type-C 28 x 18 x 5 mm, 103450 battery 34 x 50 x
  10 mm, and rectangular speaker 70 x 30 x 13.5 mm.
- Every fit-critical number is a named parameter near the top of
  `bmo_body.py`; tune those values after measuring your exact modules.
- The redesigned body is a closer BMO-style shell: about 118 x 150 mm at the
  front with a 54 mm deep cuboid body, tighter rounded corners, right-side
  speaker honeycomb, side BMO lettering, fixed curved blue tube arms with
  hidden dual pins, small BMO-style hands, mirrored plug-in legs with hidden
  dual pins, and short rounded boot feet.
- The design uses a front shell plus rear electronics tray/lid. The shell
  carries the screen window, clip-in TFT lips, mic hole, touch opening, side
  arm sockets, keyed leg slots with pin holes, latch windows, speaker
  honeycomb, and peg holes for the BMO front controls.
  The lid carries snap hooks, an organ tray, a central heart cradle, fan-out
  wire rails, printed press-clips for cable bundles, a rear cable exit, keyed
  organ rails, and locator pegs for the organ pods.
- The browser viewer loads separate GLB parts with colors so the model reads
  like BMO, including a pale mint screen panel with dark face details and blue
  limbs. The STEP/STL/3MF files remain normal CAD/slicer artifacts.
- The TFT does not use an organ. Its red PCB clips behind the face and a
  separate mint bezel masks the PCB while leaving only the active LCD open.
  The speaker clips directly behind the right-side honeycomb in a cradle sized
  for the 70 x 30 x 13.5 mm frame.
- Organ wrappers are separate snap-fit pods with cable slots sized for Dupont
  jumper bundles: ESP32-C3 plugged into a mini breadboard in the large pink
  heart, INMP441 ear, MAX98357 voice lung, TTP223 spark with a thin capacitive
  touch window, MT3608 boost gland, TP4056 charge kidney, and a battery energy
  cell sized around a 103450 34 x 50 x 10 mm 3.7 V pack. The TFT/display does
  not use an organ pod; it slides under printed lips behind the face window.
  The rectangular speaker also does not use an organ pod; it clips into the
  right-side internal cradle behind the honeycomb outlet. Every pod has at
  least one heart-facing wire port, and the heart has multiple hub ports plus
  printed wire combs.
- The printed wire combs and keeper lips provide strain relief so movement is
  taken by the plastic clips instead of the pin connection. They do not turn
  loose single Dupont/breadboard contacts into locking connectors. For the most
  shake-safe build, make each organ a grouped harness, such as one keyed JST or
  grouped Dupont housing per organ, then plug those harnesses into the heart
  hub.
- Organ bases now have underside sockets that drop onto matching rear-tray pegs
  and keyed rail slots so each pod has an obvious home. Organ lids use rim snap
  pegs/sockets, the arms use hidden dual pins plus a key block into side
  sockets, the legs use keyed tabs plus hidden dual pins into bottom slots, and
  the body front/rear clicks together with latch hooks/windows.
- `bmo_exploded_assembly.*` shows the real CAD parts separated in assembly
  order: front shell, rear tray, front controls, limbs, organ bases, and organ
  lids.
- The audited Static BMO batches are below a 250 x 250 mm safe A1 envelope:
  shell plate about 239.4 x 148.8 mm, accessories about 207.0 x 188.5 mm,
  and organ plate about 226.0 x 241.5 mm.
