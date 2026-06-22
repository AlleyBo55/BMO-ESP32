# Static BMO Component Fit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resize the Static BMO body mounts and organ pods to researched component envelopes and export safe Bambu Lab A1 print batches.

**Architecture:** Keep physical component envelopes in one Python module, consume them from body and organ CAD, and validate generated cavities and plate bounds in the existing fit audit. Preserve the external body dimensions and existing snap/key system.

**Tech Stack:** Python 3, build123d, trimesh, STEP/STL/GLB/3MF exports, Node viewer contract test.

---

### Task 1: Component fit contract

**Files:**
- Create: `hardware/parts/bmo_component_specs.py`
- Create: `hardware/tests/test_component_fit.py`

- [ ] Write assertions for TFT, speaker, breadboard stack, amplifier, microphone,
  touch, battery, charger, and boost clearances.
- [ ] Run the test and confirm it fails because the shared specifications and
  cavity metadata do not exist yet.
- [ ] Add the researched component envelopes and fit-clearance constants.
- [ ] Run the test and keep the remaining CAD mismatch failures visible.

### Task 2: Body mounts and static plates

**Files:**
- Modify: `hardware/parts/bmo_body.py`

- [ ] Drive TFT, speaker, and component ghosts from the shared specifications.
- [ ] Resize the TFT board retention and active-area opening.
- [ ] Rebuild the rectangular speaker cradle for its real depth.
- [ ] Add separate static shell and accessory A1 plate exports.
- [ ] Run the component fit test and body generation.

### Task 3: Organ cavities

**Files:**
- Modify: `hardware/parts/bmo_organ_pods.py`
- Modify: `hardware/parts/bmo_fit_audit.py`

- [ ] Publish exact internal cavity dimensions from the pod generator.
- [ ] Increase heart stack depth, amplifier lung clearance, battery tolerance,
  and MT3608 height.
- [ ] Repack the organ plate if required.
- [ ] Extend the audit to enforce cavity and 250 mm safe-plate constraints.
- [ ] Run the fit test and audit.

### Task 4: Exports and instructions

**Files:**
- Modify: `hardware/bmo_viewer.html`
- Modify: `hardware/tests/bmo_viewer_ui_test.mjs`
- Modify: `hardware/README.md`
- Regenerate: `hardware/exports/*`

- [ ] Add direct links for the two Static BMO body batches and organ batch.
- [ ] Document the print order and the remaining requirement to test snap
  clearance before the long prints.
- [ ] Regenerate body and organ exports.
- [ ] Run Python fit checks, V8 regression audit, viewer UI contract, and inspect
  the Static BMO and organ views in the browser.
