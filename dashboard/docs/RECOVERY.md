# Recovery

The dashboard has no in-product password reset and no fingerprint reveal. This is intentional — the system stores only argon2id hashes and exposes no path to lower that bar.

Recovery happens by editing the Supabase database directly. This document lists every recovery flow as concrete SQL plus the dashboard click steps that follow.

You will need:
- Access to the Supabase project's **SQL Editor** (project owner or member with `service_role`)
- The deployed dashboard URL

---

## Flow 1 — Lost admin password

You can still log into Supabase but you cannot log into the dashboard.

The dashboard does not let you change a password through the UI. The fix is to delete the admin row, then re-run the onboarding wizard with new credentials.

> **Heads up.** Deleting the admin row also makes `/onboarding` reachable again. Anyone who hits the URL between your delete and your re-onboarding can claim the dashboard. Do this from a machine that can immediately re-run onboarding.

### Steps

1. Open Supabase → **SQL Editor** for the BMO Dashboard project.
2. Run:
   ```sql
   delete from public.admin where id = 1;
   delete from public.auth_attempts;  -- clear any pending lockouts
   ```
3. Visit the dashboard URL. The middleware will detect zero admin rows and redirect to `/onboarding`.
4. Complete the onboarding wizard with a new username and password.
5. The wizard will render a **new** plaintext fingerprint exactly once. Either:
   - Copy this new fingerprint, paste into `firmware/bmo_face_anim/include/secrets.h`, and re-flash the firmware. Or:
   - Skip the new value and immediately go to the **Fingerprint** page in the dashboard to rotate back to a value you control. (Either way, the firmware needs re-flashing because the stored hash changed.)
6. Test login with the new password.

### Why not just update `password_hash`?

You could, but the dashboard has no API for hashing argon2id outside the running app, so you'd have to script it in Node with `@node-rs/argon2`. The delete + re-onboard flow is faster and uses code paths that already exist.

---

## Flow 2 — Lost fingerprint (you can still log in)

You can sign in to the dashboard but the firmware is stuck on a fingerprint you no longer have, or you never wrote down the original.

This is the easy case. The dashboard's **Fingerprint** page lets you rotate the fingerprint while logged in.

### Steps

1. Sign in to the dashboard.
2. Navigate to **Fingerprint** in the sidebar.
3. Click **Rotate**.
4. The page renders the new plaintext fingerprint **exactly once**, with a copy-to-clipboard button. The plaintext is removed from the page after 60 seconds.
5. Paste the new fingerprint into `firmware/bmo_face_anim/include/secrets.h` (replace the `BMO_FINGERPRINT` macro).
6. Re-flash:
   ```bash
   pio run -e esp32c3_supermini -t upload
   ```
7. Verify with the curl from `docs/DEPLOY.md` step 8.

The old fingerprint stops working within 5 seconds (the config-cache TTL) and is fully unusable within 60 seconds (the SLA in design.md Property 22).

---

## Flow 3 — Lost both admin password AND fingerprint

You cannot log in and you cannot rotate the fingerprint from the UI.

The fix is the same SQL as Flow 1 — deleting the admin row also makes `/onboarding` accept a fresh setup, which writes a fresh `config.fingerprint_hash`. One delete fixes both losses.

### Steps

1. Run in Supabase SQL Editor:
   ```sql
   delete from public.admin where id = 1;
   delete from public.auth_attempts;
   -- The config row is preserved (singleton), but its fingerprint_hash will be
   -- overwritten by the next onboarding submission. Soul, skills, and model
   -- selections are kept.
   ```
2. If you also want to wipe the soul / skills / model config to factory defaults, additionally run:
   ```sql
   delete from public.config where id = 1;
   -- Then re-run dashboard/supabase/seed.sql to repopulate defaults.
   ```
3. Visit the dashboard URL → it redirects to `/onboarding`.
4. Complete the wizard. Copy the new fingerprint from the one-time reveal.
5. Paste into `secrets.h` and re-flash the firmware (same steps as Flow 2).

---

## Flow 4 — Stuck onboarding (duplicate-row race)

Symptom: the onboarding form returns "already onboarded" but you never finished the wizard, or two browser tabs both submitted at the same time and one of them hangs.

The schema enforces `check (id = 1)` on `admin` and the server action uses `INSERT … ON CONFLICT (id) DO NOTHING` plus a re-check of admin count, so concurrent submissions cannot both succeed (design.md Property 1, Property 2). The losing tab gets a 409 response. If a tab is hung, it is hung in the browser, not in the database.

### Diagnose first

```sql
select id, username, created_at from public.admin;
select count(*) from public.admin;
```

- If the count is 1 and you recognize the username, onboarding actually completed. Go log in. If you forgot the password, use Flow 1.
- If the count is 1 and you do not recognize the username, somebody else got there first. Use Flow 1 (delete + redo) — but consider whether the dashboard URL was leaked.
- If the count is 0 but the form keeps saying already-onboarded, you are looking at stale middleware cache. The middleware caches the admin count for 30 seconds per Vercel function instance. Wait 30 seconds, hard refresh, retry.
- If the count is > 1, the schema is corrupted. This should be impossible given the `check (id = 1)` constraint; if you somehow see it, file a bug and run:
  ```sql
  delete from public.admin where id <> 1;
  ```

### Force-reset onboarding

If the diagnosis above does not unblock you, the cleanest fix is the Flow 1 SQL — delete the row and start over.

```sql
delete from public.admin where id = 1;
delete from public.auth_attempts;
```

Then visit `/onboarding` again. The middleware revalidates within 30 seconds (and a fresh function instance sees the change immediately).

---

## Flow 5 — Locked out of login (rate limit hit)

Symptom: the login form keeps returning "too many attempts" even after you've remembered the right password.

The `auth_attempts` table records every failed login with a 15-minute sliding window. After 5 failures, the username is locked for 15 minutes from the last failure. Wait it out, or clear manually:

```sql
delete from public.auth_attempts where username = 'your-username';
```

This is reactive only. Do **not** add a UI control for it — the rate limit is the only thing standing between an attacker and an offline-crackable argon2id hash.

---

## What never gets recovered

- **The original plaintext fingerprint.** It is shown exactly once at onboarding (or rotation) and only the argon2id hash is stored. If you lose it, rotate.
- **Activity log entries with masked PII.** The log writer strips known secret-shaped fields before insert (design.md Property 14). Once stripped, those fields are gone from the row even if the request itself was malformed.

---

## Auditing a recovery

Every recovery action above leaves a trail:

- Supabase keeps a query history in **Database → Logs → Postgres logs** for the last 7 days (free tier).
- The dashboard's `activity_log` table records the new admin's first API calls but not the SQL recovery itself — that is intentional, the log is for runtime activity, not DB ops.
- After any recovery, run the day-one verification curl from `docs/DEPLOY.md` step 8 to confirm the system is back to healthy.
