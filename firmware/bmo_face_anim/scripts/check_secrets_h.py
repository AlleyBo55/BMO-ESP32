"""
PlatformIO pre-build hook.

Source of truth for secrets is the gitignored `.env` file. This hook renders
include/secrets.h from include/secrets.h.in by substituting each @KEY@ marker
with the matching VALUE from .env, then verifies no placeholders remain.

If .env is absent, it falls back to requiring a hand-written include/secrets.h
(legacy flow) and just validates it.

Wired up in platformio.ini via:

    extra_scripts = pre:scripts/check_secrets_h.py

Both .env and include/secrets.h are gitignored — see .gitignore.
"""

import os
import re

import SCons.Errors

# PlatformIO injects `env` into globals when running an extra_script.
# pylint: disable=undefined-variable
Import("env")  # type: ignore[name-defined]

PROJECT_DIR = env["PROJECT_DIR"]  # type: ignore[name-defined]
SECRETS_H = os.path.join(PROJECT_DIR, "include", "secrets.h")
TEMPLATE = os.path.join(PROJECT_DIR, "include", "secrets.h.in")
ENV_FILE = os.path.join(PROJECT_DIR, ".env")

# Matches @WIFI_SSID@, @FINGERPRINT@, etc. — anything left from the template.
PLACEHOLDER_RE = re.compile(r"@[A-Z0-9_]+@")


def _fail(message: str) -> None:
    """Raise a UserError so PlatformIO prints the message and stops the build."""
    raise SCons.Errors.UserError("\n" + message)


def _load_env(path: str) -> dict:
    """Parse a simple KEY=VALUE .env file. Ignores blanks and # comments.

    Surrounding single/double quotes on values are stripped so both
    `WIFI_PASS=hunter2` and `WIFI_PASS="my home wifi"` work.
    """
    values = {}
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            values[key] = val
    return values


def _render_secrets_h_from_env() -> None:
    """Render include/secrets.h from the template + .env substitutions."""
    if not os.path.isfile(TEMPLATE):
        _fail(
            "================================================================\n"
            "  BMO firmware build halted: include/secrets.h.in is missing.\n"
            "----------------------------------------------------------------\n"
            "  The template is required to render include/secrets.h from\n"
            "  .env. Restore include/secrets.h.in and re-run the build.\n"
            "================================================================"
        )

    env_values = _load_env(ENV_FILE)

    with open(TEMPLATE, "r", encoding="utf-8") as fh:
        template = fh.read()

    # Substitute every @KEY@ that has a matching .env entry.
    def _sub(match: "re.Match") -> str:
        key = match.group(0)[1:-1]  # strip the surrounding @ @
        return env_values.get(key, match.group(0))

    rendered = PLACEHOLDER_RE.sub(_sub, template)

    leftover = sorted(set(PLACEHOLDER_RE.findall(rendered)))
    if leftover:
        _fail(
            "================================================================\n"
            "  BMO firmware build halted: .env is missing required keys.\n"
            "----------------------------------------------------------------\n"
            "  These template placeholders had no matching value in .env:\n"
            "    " + ", ".join(leftover) + "\n"
            "\n"
            "  Add the matching KEY=VALUE lines to .env (see .env.example),\n"
            "  then re-run the build. .env is gitignored — never commit it.\n"
            "================================================================"
        )

    header = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Rendered from include/secrets.h.in + .env by\n"
        "// scripts/check_secrets_h.py at build time. Edit .env instead.\n\n"
    )
    new_content = header + rendered

    # Only rewrite when content changed, so we don't churn mtimes (and thus
    # force needless recompiles) on every build.
    existing = ""
    if os.path.isfile(SECRETS_H):
        try:
            with open(SECRETS_H, "r", encoding="utf-8") as fh:
                existing = fh.read()
        except OSError:
            existing = ""
    if existing != new_content:
        with open(SECRETS_H, "w", encoding="utf-8") as fh:
            fh.write(new_content)
        print("[check_secrets_h] rendered include/secrets.h from .env")
    else:
        print("[check_secrets_h] include/secrets.h already up to date")


def check_secrets_h(*_args, **_kwargs) -> None:
    # Preferred flow: .env is the source of truth, render secrets.h from it.
    if os.path.isfile(ENV_FILE):
        _render_secrets_h_from_env()
        return

    # Legacy fallback: no .env, require a hand-written secrets.h.
    if not os.path.isfile(SECRETS_H):
        _fail(
            "================================================================\n"
            "  BMO firmware build halted: no .env and no include/secrets.h.\n"
            "----------------------------------------------------------------\n"
            "  Secrets now live in a gitignored .env file. To fix:\n"
            "    1. cp .env.example .env\n"
            "    2. Edit .env and fill in every value:\n"
            "       - WIFI_SSID / WIFI_PASS: your 2.4 GHz WiFi\n"
            "       - WIFI_SSID2 / WIFI_PASS2: optional fallback network\n"
            "       - DASHBOARD_URL: the deployed dashboard origin\n"
            "       - FINGERPRINT: from the dashboard onboarding/rotate UI\n"
            "    3. Re-run the build — include/secrets.h is generated for you.\n"
            "\n"
            "  See docs/DEPLOY.md (in the dashboard repo) for the end-to-end\n"
            "  flow that produces the fingerprint value.\n"
            "================================================================"
        )

    try:
        with open(SECRETS_H, "r", encoding="utf-8") as fh:
            content = fh.read()
    except OSError as exc:
        _fail(
            "================================================================\n"
            "  BMO firmware build halted: include/secrets.h is unreadable.\n"
            "----------------------------------------------------------------\n"
            "  Underlying error: " + str(exc) + "\n"
            "  Check file permissions and re-run the build.\n"
            "================================================================"
        )
        return  # unreachable; satisfies linters

    leftover = PLACEHOLDER_RE.findall(content)
    if leftover:
        unique = sorted(set(leftover))
        _fail(
            "================================================================\n"
            "  BMO firmware build halted: include/secrets.h contains\n"
            "  unfilled placeholders from the template.\n"
            "----------------------------------------------------------------\n"
            "  Placeholders still present: " + ", ".join(unique) + "\n"
            "\n"
            "  Either fill them in, or switch to the .env flow:\n"
            "    cp .env.example .env  (then edit .env)\n"
            "================================================================"
        )

    print("[check_secrets_h] include/secrets.h ok")


# Register so PlatformIO runs the check before any compilation step.
# Targeting `buildprog` runs once per build, before sources are compiled.
env.AddPreAction("buildprog", check_secrets_h)  # type: ignore[name-defined]

# Also run it eagerly at script-load time so a stale build cache cannot mask
# a missing/placeholder secrets.h. UserError raised here aborts immediately.
check_secrets_h()
