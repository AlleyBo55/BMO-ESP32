// Sync only the CAD assets the landing 3D preview (cad-preview.html) needs into
// dashboard/public/exports, so the embedded viewer works in production without
// committing the whole hardware/ export folder.
// Run: node scripts/sync-cad-viewer.mjs   (also wired as `npm run sync-cad`)
import { mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const exportsDir = join(repoRoot, 'hardware', 'exports');
const outExports = join(here, '..', 'public', 'exports');

// EXACTLY the files cad-preview.html loads: per-part GLBs for the three models
// + the two downloadable A1 print kits (.3mf). Nothing heavier (the combined
// kit/assembly GLBs and STL/STEP are intentionally excluded).
const KEEP = [
  /^bmo_compact_(front_shell_preview|bezel|screen_dark|dpad|triangle|green|red|power_dot|pill|side_text|left_arm|right_arm|left_leg|right_leg|rear_lid|cam_lock)\.glb$/,
  /^bmo_okit_.*\.glb$/,
  /^bmo_ikit_.*\.glb$/,
  /^bmo_compact_(outside|inside)_kit\.3mf$/,
];

const wanted = (f) => KEEP.some((re) => re.test(f));

async function main() {
  await mkdir(outExports, { recursive: true });

  // Remove anything in public/exports that is no longer wanted (keeps it lean).
  for (const f of await readdir(outExports)) {
    if (!wanted(f)) await rm(join(outExports, f), { force: true });
  }

  let n = 0;
  for (const f of await readdir(exportsDir)) {
    if (wanted(f)) {
      await copyFile(join(exportsDir, f), join(outExports, f));
      n += 1;
    }
  }
  console.log(`Synced ${n} CAD asset(s) into ${outExports}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
