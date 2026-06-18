# Static BMO Component Fit Design

## Goal

Make the Static BMO body and organ pods printable around the user's photographed
electronics using published common-module dimensions, practical FDM clearance,
and cable/connector space.

## Component Envelopes

- ST7735 red PCB: 58 x 35 x 5 mm; visible LCD opening: 36 x 29 mm.
- ESP32-C3 Super Mini: 22.5 x 18 x 4 mm, installed on a 47 x 36 x 8.5 mm
  mini breadboard.
- Breadboard plus plugged ESP32 and header stack: reserve 27 mm internal height.
- MAX98357 with screw terminal: 24.6 x 19.4 x 8 mm.
- INMP441: 14 x 12 x 4 mm.
- TTP223: 24 x 24 x 4 mm.
- Protected TP4056 Type-C board: 28 x 18 x 5 mm.
- MT3608 including tall inductor/header envelope: 36 x 17 x 14 mm.
- 103450 battery: 34 x 50 x 10 mm.
- Rectangular 8 ohm 3 W speaker: 70 x 30 x 13.5 mm.

## Mechanical Strategy

The body keeps its existing external BMO proportions. The TFT board mount
shrinks to the common red-board envelope and the through-window exposes only
the active LCD, so the PCB cannot fall through the face. The speaker cradle is
rebuilt around the 70 x 30 x 13.5 mm body and remains aligned with the side
honeycomb.

The heart remains the largest organ and gains enough depth for the breadboard,
plugged ESP32, soldered headers, and a modest wire loop. The amplifier lung,
boost gland, and battery cell gain internal clearance. Modules already having
adequate clearance retain their existing exterior size and tray keys.

## Printing

Static printing uses three safe A1 batches:

1. Front shell and rear tray.
2. Controls, lettering, arms, and fixed standing legs.
3. All organ bases and lids.

Every plate must stay within a 250 x 250 mm safe envelope. Individual STL,
STEP, GLB, and 3MF exports remain available for replacement prints.

## Verification

Automated checks compare every cavity with its component envelope, require
clearance for connectors and FDM variation, reject overlapping tray organs,
and reject print plates larger than 250 x 250 mm. Generated meshes are checked
for positive volume and the browser viewer contract is run after export.
