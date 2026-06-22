import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const viewerPath = new URL("../bmo_viewer.html", import.meta.url);
const html = await readFile(viewerPath, "utf8");

assert.match(
  html,
  /id="showBody"[^>]*>Static BMO</,
  "The non-moving body view should be named Static BMO."
);

assert.match(html, /id="poseStand"/, "The V8 viewer should expose a Stand pose button.");
assert.match(html, /id="poseSit"/, "The V8 viewer should expose a Sit pose button.");
assert.match(
  html,
  /localStorage\.(?:getItem|setItem)\("bmo-viewer-menu-collapsed"/,
  "The collapsed menu state should be remembered."
);
assert.match(
  html,
  /savedMenuState === null \? true/,
  "The viewer menu should start collapsed on a fresh browser."
);
assert.match(
  html,
  /const v8PrintAssets = \[/,
  "The V8 A1 plate should load separate selectable print assets."
);
assert.match(
  html,
  /bmo_v8_plate_servo_frame\.glb/,
  "The V8 print view should use the exact CAD-positioned plate exports."
);
assert.match(
  html,
  /\.\.\.\[1, 2, 3, 4\]\.map\(\(index\) => \(\{/,
  "The V8 print view should expose four separate horn adapters."
);
assert.match(
  html,
  /bmo_v8_plate_horn_adapter_\$\{index\}\.glb/,
  "Each horn adapter should load its own CAD-positioned GLB."
);
assert.match(
  html,
  /dataset\.printPartCount = String\(v8PrintAssets\.length\)/,
  "The rendered print view should expose its separate printable-object count."
);
assert.match(
  html,
  /id="showV8Prints"[^>]*>V8 A1 Print Parts</,
  "The V8 print-parts button should clearly name the A1 plate view."
);
assert.match(
  html,
  /href="\.\/exports\/bmo_static_shell_plate\.3mf"[^>]*>Static Shell Plate</,
  "The viewer should link the safe A1 plate containing both body halves."
);
assert.match(
  html,
  /href="\.\/exports\/bmo_static_accessories_plate\.3mf"[^>]*>Static Parts Plate</,
  "The viewer should link the safe A1 plate containing the static accessories."
);
assert.match(
  html,
  /bmo_tft_bezel\.glb/,
  "The Static BMO view should show the separate TFT masking bezel."
);
assert.match(
  html,
  /58 x 35 mm module/,
  "The assembly guide should describe the corrected TFT board envelope."
);
assert.match(
  html,
  /queryParams\.get\("v"\) \|\| queryParams\.get\("cb"\)/,
  "The viewer should use the cb query parameter to refresh regenerated CAD assets."
);
assert.match(
  html,
  /Compact BMO shell \(80 x 96 x 52 mm/,
  "The compact viewer should describe the approved body envelope."
);
for (const position of [
  "[-24, -35, 52.0]",
  "[24, -35, 52.0]",
  "[-24, 35, 52.0]",
  "[24, 35, 52.0]",
]) {
  assert.ok(
    html.includes(`position: ${position}`),
    `The compact viewer should place a cam lock at ${position}.`
  );
}

console.log("BMO viewer UI contract: PASS");
