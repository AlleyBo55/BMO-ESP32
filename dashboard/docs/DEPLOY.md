# Deploying the BMO Dashboard

This guide walks a fresh deploy from zero: spin up Supabase, spin up Vercel, complete the in-browser onboarding wizard, paste the generated fingerprint into the firmware, then verify the firmware can talk to the dashboard.

The dashboard is a Next.js 15 App Router app. The only required infra is one Supabase project and one Vercel project. No other moving parts.

---

## 0. Prerequisites

- A Supabase account (free tier is enough)
- A Vercel account connected to the GitHub repo containing this dashboard
- An OpenRouter account with an API key and at least a small credit balance
- The BMO firmware repo checked out locally with PlatformIO installed

You will collect five env values along the way. Keep a scratch buffer open.

---

## 1. Create the Supabase project and apply the schema

1. Go to https://supabase.com/dashboard, click **New project**.
2. Pick a region close to your Vercel deploy region (e.g. both in `us-east-1`).
3. Set a strong DB password — you will not need it again unless you SSH into the DB.
4. Wait for the project to provision (about 2 minutes).
5. Open the **SQL Editor** for the new project.
6. Paste the entire contents of `dashboard/supabase/schema.sql`, run it.
7. Paste the entire contents of `dashboard/supabase/seed.sql`, run it.

Verify in the **Table Editor**: you should see `admin` (empty), `config` (empty), `activity_log` (empty), and `auth_attempts` (empty). RLS should be enabled on all four.

---

## 2. Capture the three Supabase values

In the Supabase dashboard, go to **Project Settings → API Keys**.

Copy these three values to your scratch buffer:

| Label                     | Lives where                              | Goes into                              |
| ------------------------- | ---------------------------------------- | -------------------------------------- |
| Project URL               | Settings → API → Project URL             | `NEXT_PUBLIC_SUPABASE_URL`             |
| Publishable key           | Settings → API Keys → Publishable        | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| Secret key                | Settings → API Keys → Secret keys        | `SUPABASE_SECRET_KEY`                  |

> Supabase renamed its keys in late 2024. If your project still shows the
> old names, the legacy variants `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
> `SUPABASE_SERVICE_ROLE_KEY` are still accepted — `lib/env.ts` reads
> whichever pair you set.

The secret key bypasses RLS. Never paste it into a public file, a frontend bundle, or a client-side env. It is server-only.

---

## 3. Create the Vercel project and link the dashboard subdirectory

1. Go to https://vercel.com/new, import the GitHub repo.
2. **Root Directory**: set to `dashboard`. (The repo contains both firmware and dashboard; this isolates the build to the dashboard folder.)
3. Framework preset: Next.js (auto-detected).
4. Build command: leave default (`next build`).
5. Output directory: leave default (`.next`).
6. Do **not** click Deploy yet. Open the project settings to add env vars first (next step).

---

## 4. Set the five env vars in Vercel

In the Vercel project, go to **Settings → Environment Variables** and add the following. Apply each to the **Production**, **Preview**, and **Development** environments. Mark the four server-only ones as **Sensitive** so Vercel hides them from logs and the UI.

| Name                                   | Value source                            | Sensitive? |
| -------------------------------------- | --------------------------------------- | ---------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Step 2 — Project URL                    | no         |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Step 2 — Publishable key                | no         |
| `SUPABASE_SECRET_KEY`                  | Step 2 — Secret key                     | **yes**    |
| `OPENROUTER_API_KEY`                   | OpenRouter dashboard → API Keys         | **yes**    |
| `AUTH_SESSION_SECRET`                  | `openssl rand -hex 32`                  | **yes**    |

Sanity check: any var prefixed `NEXT_PUBLIC_` is bundled to the client by Next.js and is therefore safe-to-expose by definition. Anything else is server-only and must be marked sensitive. The CI step `check-bundle-secrets` will fail the build if a server-only value ever leaks into the client bundle.

---

## 5. Deploy main on push

1. Back on the project's **Deployments** page, click **Deploy** for the initial deploy.
2. Verify GitHub integration is on (Settings → Git): every push to `main` deploys to Production; every PR gets a Preview URL.
3. Wait for the first deploy to go green. Note the production URL (e.g. `https://bmo-dashboard.vercel.app`).

If the build fails, the most common cause is a missing env var — Vercel's build logs will point to the exact variable.

---

## 6. Complete the onboarding wizard

1. Visit the production URL in a browser.
2. Middleware will redirect you to `/onboarding`. (If you instead see the login page, an admin row already exists — see `docs/RECOVERY.md`.)
3. Fill in the form:
   - **Username**: any short string you'll remember
   - **Password**: at least 12 characters
   - **Fingerprint**: leave blank to auto-generate (recommended), or paste your own ≥32-byte hex/base64 string
4. Submit the form.
5. The page renders the **plaintext fingerprint exactly once** — copy it now to your scratch buffer. You will not be able to retrieve it again. The dashboard only stores the argon2id hash.
6. Click through to the login page and verify you can sign in with the credentials you just chose.

After this point, `/onboarding` returns 404 forever.

---

## 7. Paste the fingerprint into the firmware and flash

In the firmware repo at `firmware/bmo_face_anim/`:

1. Copy the template:
   ```bash
   cp include/secrets.h.in include/secrets.h
   ```
2. Edit `include/secrets.h` and replace the four placeholders:
   ```cpp
   #define BMO_WIFI_SSID     "your-wifi-ssid"
   #define BMO_WIFI_PASS     "your-wifi-password"
   #define BMO_DASHBOARD_URL "https://bmo-dashboard.vercel.app"
   #define BMO_FINGERPRINT   "<paste-the-fingerprint-from-step-6>"
   ```
3. The file `include/secrets.h` is gitignored — safe to keep on disk, never committed.
4. Plug in the BMO board, then build and flash:
   ```bash
   pio run -e esp32c3_supermini -t upload
   ```
5. Open the serial monitor:
   ```bash
   pio device monitor -e esp32c3_supermini
   ```
   You should see WiFi connect, then a successful HTTPS handshake to `BMO_DASHBOARD_URL` on the first interaction.

---

## 8. Verify end-to-end with curl

Replace the URL and fingerprint below with your real values, then check that the firmware-facing API answers:

```bash
curl -i \
  -H "X-BMO-Fingerprint: <paste-the-fingerprint>" \
  https://bmo-dashboard.vercel.app/api/openrouter/credits
```

Expected: `HTTP/2 200` with a JSON body like:

```json
{ "total": 5.00, "used": 0.13, "remaining": 4.87, "currency": "USD", "fetchedAt": 1735340000 }
```

Negative test (proves the guard works): omit the header, expect `401 unauthorized`:

```bash
curl -i https://bmo-dashboard.vercel.app/api/openrouter/credits
# HTTP/2 401
```

A second negative test (proves rotation works): change the fingerprint in the dashboard's **Fingerprint** page, retry the curl with the old value, expect `401`. Re-flash the firmware with the new value to restore connectivity.

---

## Done

The dashboard is live, the firmware is paired, and the activity log will start filling in as the firmware makes calls. From here, see:

- `docs/RECOVERY.md` — what to do if the admin password or fingerprint is lost
- `docs/HARDWARE-SMOKE-TEST.md` — full end-to-end voice test with the physical device
- `docs/SUPABASE-SETUP.md` — extra notes on Supabase config (URL allowlist, etc.)
