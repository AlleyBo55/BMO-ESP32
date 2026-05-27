---
inclusion: fileMatch
fileMatchPattern: '**/*.{step,stp,scad,py}'
---

# step.parts skill

Source: <https://github.com/earthtojake/text-to-cad/blob/main/skills/step-parts/SKILL.md>

> Find, evaluate, and download low-level common standard CAD parts from
> step.parts: screws, bolts, nuts, washers, bearings, standoffs, electronics
> parts, motors, connectors, and other off-the-shelf components.

## Endpoints

- API origin: `https://api.step.parts`
- Site / static assets: `https://www.step.parts`

If neither resolves, report the hosted service is not reachable. Don't fall
back to repo-specific assumptions.

## Quick workflow

1. **Interpret the request** into search terms and optional facets.
   - `q` for fuzzy tokens: standards, aliases, dimensions, source/product
     URLs, attribute names/values.
   - `category`, `family`, `standard`, `tag` for exact facets.
2. **Search** `/v1/parts` and inspect `items`, `total`, and `facets`.
3. **If ambiguous**, present a few options with `id`, `name`, `standard`,
   key attributes — don't download yet.
4. **If clear**, return the selected record details. Don't download unless
   the user asked for a local STEP file.
5. **When downloading**, fetch `stepUrl` and verify with the record's
   `sha256` if present.
6. **Report** the local path, selected part id, and page/API URLs so the
   user can trace provenance.

## Bundled downloader

```bash
# fuzzy search + download
python skills/step-parts/scripts/download_step_part.py "M3 socket head 12" \
  --download --out-dir /tmp/step-parts

# by exact id
python skills/step-parts/scripts/download_step_part.py \
  --id iso4762_socket_head_cap_screw_m3x12 \
  --download --out-dir /tmp/step-parts

# search only
python skills/step-parts/scripts/download_step_part.py "bearing 608zz" --limit 5
```

Useful options:

- `--origin` — override the default API origin.
- `--tag`, `--category`, `--family`, `--standard` — repeatable facet filters.
- `--out-dir` — directory for downloaded STEP files. Default `/tmp/step-parts`.
- `--all` — with `--download`, download every result on the page.
- `--overwrite` — replace an existing output file.

The script prints JSON to stdout. Searches print matched records;
downloads print saved file paths, checksums, and source URLs.

## Search guidance

- Query tokens are AND-ed by the API. Start specific but not over-constrained
  (e.g. `M3 SHCS 12` before adding exact family + standard filters).
- Values within one facet are OR-ed; selected `tag`, `category`, `family`,
  `standard` are AND-ed. Use exact facets to narrow within known categories,
  then rank by name and attributes.
- Standards accept `ISO 4762`, `ISO4762`, or the exact `standard.designation`.
- The `attributes` object holds family-specific facts: `thread`, `lengthMm`,
  `bore1Mm`, `material`, `profileSeries`, `slotSizeMm`, dimensions in mm.
- Part, GLB, and PNG URL patterns are predictable on `www.step.parts`.
  STEP URLs are environment-aware and may resolve to GitHub LFS in
  production. Use catalog/API `stepUrl` for downloads.

## API reference

Prefer:

- `/v1/parts` — filtered search with absolute asset URLs.
- `/v1/parts/{id}` — one enriched record.
- Returned `stepUrl` — STEP downloads.
- `/v1/catalog/parts.index.json` — compact discovery index.
- `/v1/catalog/schema` — field and family attribute meanings.
- `/v1/openapi.json` — for generating a client.

Read `references/step-parts-api.md` (in the installed skill) for endpoint
details, field meanings, and query semantics.

## When the bundle is not installed

The downloader script lives inside the installed skill bundle. If the
bundle isn't present, you can still:

- Hit the public API directly with `curl` and parse JSON.
- Browse <https://www.step.parts> manually and copy the part `id`.
- Document the chosen part `id`, `standard`, and key attributes inline in
  the build123d source (e.g. as a comment near the corresponding hole).

A pin-and-document approach matters more than tool choice: every external
hardware mate must reference a specific part id, not a guessed dimension.
