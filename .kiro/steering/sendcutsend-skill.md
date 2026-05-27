---
inclusion: fileMatch
fileMatchPattern: '**/*.{dxf,step,stp}'
---

# SendCutSend skill (vendor preflight)

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/sendcutsend/SKILL.md>

> Review DXF and STEP/STP uploads for SendCutSend.com orders using its
> ordering guide, catalog, and specs. Use only for SendCutSend.com
> preflight reports covering upload readiness, selected
> material/SKU/thickness/service availability, and service-specific
> checks for laser cutting, CNC routing, bending, tapping, countersinking,
> hardware insertion, and finishing.

Treat SendCutSend's ordering guide, catalog JSON, and specs JSON as
**evidence feeds**, not stable APIs. Field names, types, and coverage
may vary. Don't turn missing, unparsable, `N/A`, or conflicting source
data into a pass or fail. Use scripts only to fetch sources or measure
specific file facts; write the final report from explicit comparisons.

## Geometry inspection

Use the active project Python environment for local inspection scripts.
If the `$cad` skill is available, use it first for STEP/STP/DXF inspection
and validation, then add SendCutSend-specific targeted measurements.
Use `build123d.import_step` for STEP/STP and `build123d.ezdxf` for DXF.
Don't use raw text parsing or alternate geometry backends for geometry
facts.

When this workflow creates or updates a DXF/STEP/STP upload candidate,
hand the explicit file path to `$render` for review. Use stills, not
GIFs.

## Source refresh

Before each review, refresh the three SendCutSend source files:

```bash
python scripts/download_sources.py
# force-refresh past 24h cache
python scripts/download_sources.py --skip-cache
```

The downloader writes:

- `references/generated/sendcutsend-ordering-guide.md`
- `references/generated/sendcutsend-catalog.json`
- `references/generated/sendcutsend-specs.json`
- `references/generated/sources-manifest.json`

Cache is fresh for 24 hours. Use the manifest's `fetched_at`,
`cache_expires_at`, `sha256`, and JSON `_meta` values in the source
bibliography. If a source is unfetchable and only stale files exist,
report the limitation and avoid ready verdicts for dependent checks.

## Workflow

1. **Collect order intent.**
   - DXF for laser sheet cutting and 2D sheet profiles.
   - STEP/STP for CNC routing and 3D upload workflows.
   - Record file type, intended process, material/SKU, thickness,
     quantity, services, finish, hardware.
   - If order context is missing or ambiguous, inspect enough source
     data to present concrete options, then ask the user to confirm
     before writing readiness verdicts. Include candidate
     SKUs/materials/thicknesses/services with relevant source links;
     include `photo_url` images and `learn_more_url` links from specs.
2. **Read official sources, run downloader, inspect generated source
   files directly.** Normalize source facts defensively.
3. **Inspect the exact upload file** with `$cad` and targeted
   Python/build123d for missing facts. Don't inspect only the source
   generator, CAD model, or generator console summary.
   - DXF: units, bounds, layers, entity types, open/duplicate geometry,
     unsupported annotations, candidate holes/circles, linework stats,
     bend-line candidates, bend-to-cut distances, bend-adjacent cut
     geometry, local flange depths, degenerate zero-area contours.
   - STEP/STP: parseability, units hints, solid/surface signals,
     bounding box, shell/body signals, validity, sheet thickness,
     cylindrical bend-face radii where bending is in scope.
   - Each inspection script is fact-only. Measurements, parse errors,
     limitations — never pass/fail/readiness statuses.
4. **Select source records by evidence quality.**
   - Exact SKU is the only authoritative catalog/spec join.
   - With only material + thickness, use a selected material only when
     the candidate match is unique and exact enough; otherwise list
     candidates and ask the user.
   - Catalog JSON for orderability: stock, cutting process, available
     services, size limits, hardware, finishes.
   - Specs JSON for engineering: tolerances, holes, bridges, bending,
     tapping, countersinking, hardware insertion, finishing, materials.
   - Ordering guide for plain-language workflow and general file rules.

## Comparison

- Determine whether a check applies.
- Cite the source field path or guide section.
- Cite the measured file fact.
- Compare only when both are available and trustworthy.
- If a needed measurement is missing, write a small targeted
  `build123d` / `ezdxf` inspector for that specific fact.
- Treat every measured upload risk, manufacturability issue, or cited
  requirement violation as an error.
- For DXF units: inspect `$INSUNITS`, header extents, measured bounds,
  and order context together. If `$INSUNITS` is missing, unsupported,
  or not a SendCutSend-expected code (`1` inches or `4` mm), report a
  unit/scale error. Don't silently rescale or use uncertain scale for
  material-specific checks.
- For 2D files with bend lines: check flange length **locally** along
  every bend line, on both sides at every span, including notches,
  slots, gaps, split tabs, and cutouts. Compare minimum local flange
  depth to the SKU's `bending_specs.min_flange_length_before_bend` and
  `min_flange_length_after_bend`. Don't apply flange-length limits to
  ordinary enclosed holes unless a cited rule applies.
- Keep bend findings separate by physical cause. Don't collapse
  bend-adjacent geometry into a generic flange failure.
- For STEP/STP bent parts: extract cylindrical/toroidal bend-face radii
  with `$cad`/`build123d`/OCP, group repeats, compare to the SKU's
  `effective_bend_radius` or `bend_radius`. If the SKU is unknown,
  report the radius set and ask for material/thickness first.

## Status labels

- `✅ pass` — measured fact satisfies cited current requirement.
- `❌ fail` — measured upload risk, manufacturability issue, or direct
  violation of a cited current requirement.
- `❓ need more info` — missing context, missing source evidence,
  unmeasured geometry, source conflicts, or tool limitations.

## Diagnostic images

When findings benefit from visualization, produce a concise diagnostic
diagram **proactively** if image-generation is available. Use `$render`
snapshots first for CAD/DXF geometry; use generated/edited images for
callouts, legends, and before/after explanations. Do this without
waiting for the user when there's a `❌ fail`, spatially ambiguous
issue, or geometry edit needing before/after explanation.

Layout preflight before generating:

- Smallest set of callouts needed to explain the fix.
- Estimate label crowding/overlap. If likely, switch to numbered
  markers + side legend, larger canvas, or separate detail views.
- Long values and rule text in the legend, not over dense geometry.
- Include the measured failing distance, the cited minimum, and the
  proposed movement / clearance target.

After generating, inspect the rendered image. If labels overlap, are
clipped, or obscure geometry, regenerate or revise before reporting.

## Reporting

Include: file path, assumed service, material/order context, source
files checked with access date, inspected geometry facts, findings
ordered by practical impact, specific next edits.

In findings, include a `Rule source` column with Markdown links to the
source URL plus the specific JSON field path or guide section. Rows based
only on direct file inspection: write `Direct file inspection`. Never
leave the source blank.

Don't call a file "SendCutSend ready" unless every required cited check
either passes or is explicitly outside the selected service.
