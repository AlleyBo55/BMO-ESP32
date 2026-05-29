# Supabase Setup

This document is the one-time setup runbook for the BMO Dashboard's persistence layer. After it, the dashboard owns the database; you never need to touch Supabase manually again unless you're recovering from a lost admin password or rotating the fingerprint without going through the UI.

## What you'll end up with

- A Supabase project with four tables: `admin`, `config`, `activity_log`, `auth_attempts`.
- Row-level security enabled on all four, with a deny-all policy for the `anon` role. The dashboard's server-side code uses the **service-role** key (which bypasses RLS); nothing else can read these tables.
- A single `config` row seeded with a default BMO persona and the six default skill toggles. `fingerprint_hash` is empty until onboarding runs.
- Three values copied into Vercel: project URL, anon key, service-role key.

## 1. Create the Supabase project

1. Go to <https://supabase.com> and sign in.
2. Click **New project**. Pick the region closest to where the firmware will live; the firmware's per-request latency depends on it.
3. Set a strong database password (you won't need it again, just store it in your password manager).
4. Wait for provisioning to finish.

## 2. Run the schema

1. In the Supabase dashboard, open **SQL Editor**.
2. Open `dashboard/supabase/schema.sql` from this repo, copy its contents, paste into the editor.
3. Click **Run**. You should see `Success. No rows returned`.

The schema is idempotent (uses `create table if not exists` and `drop policy if exists ... create policy ...`), so re-running it is safe.

### Verify the tables exist

Run each one-liner in the SQL editor; each should return one row.

```sql
select to_regclass('public.admin')         as admin_table;
select to_regclass('public.config')        as config_table;
select to_regclass('public.activity_log')  as activity_log_table;
select to_regclass('public.auth_attempts') as auth_attempts_table;
```

A `null` in any cell means that table didn't get created — re-run `schema.sql`.

### Verify RLS is on and the deny-all policy is active

```sql
select relname, relrowsecurity
from pg_class
where relname in ('admin','config','activity_log','auth_attempts');
-- Expect relrowsecurity = true for all four.

select schemaname, tablename, policyname, roles, cmd, qual
from pg_policies
where tablename in ('admin','config','activity_log','auth_attempts')
order by tablename;
-- Expect one policy per table, named *_no_anon, with roles = {anon}, qual = false.
```

If any row is missing or `relrowsecurity = false`, the dashboard is **not** safe to use — re-run `schema.sql` before continuing.

## 3. Run the seed

1. Open `dashboard/supabase/seed.sql`, copy, paste into the SQL editor, **Run**.
2. Confirm the row landed:

```sql
select id, length(soul_md) as soul_chars, jsonb_object_keys(skills) as skill, fingerprint_hash = '' as fp_placeholder
from public.config;
-- Expect one row, soul_chars > 1000, skill listing all six skill names, fp_placeholder = true.
```

The seed uses `on conflict (id) do nothing`, so re-running it will not clobber an admin-edited soul or skill list.

## 4. Copy the keys to Vercel

In the Supabase project, open **Project Settings → API Keys**. Copy:

- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **Publishable key** → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- **Secret key** → `SUPABASE_SECRET_KEY`

> If your project still shows the old `anon` / `service_role` names, the
> legacy variants `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
> `SUPABASE_SERVICE_ROLE_KEY` are still accepted.

Then in the Vercel project for the dashboard:

1. **Settings → Environment Variables**.
2. Paste each value with the env-var name above. Mark `SUPABASE_SECRET_KEY` as **Sensitive**.
3. Apply to **Production**, **Preview**, and **Development** unless you have a reason to scope tighter.
4. Redeploy so the new env vars take effect.

You can sanity-check that the dashboard sees them by hitting `/` after deploy: with no admin row yet, the middleware should redirect you to `/onboarding`.

## RLS implications (important)

- The **publishable key** (formerly *anon* key) is what gets bundled into the browser. It is **public** by design; treat it as such. Because every BMO Dashboard table denies the `anon` role, the publishable key cannot read or write any of these four tables. This is intentional.
- The **secret key** (formerly *service-role* key) bypasses RLS. It must never reach the browser. In this codebase it is read only by `lib/supabase-admin.ts`, which begins with `import 'server-only'`. ESLint enforces that no client-bundled file imports it.
- This means **you cannot query these tables from the browser console**, or from a client-side `createClient(NEXT_PUBLIC_SUPABASE_URL, publishableKey)`. That's the design. All reads/writes go through the dashboard's server-side code.
- If you want to inspect the data, use the Supabase SQL editor (which uses the secret key internally) or the Supabase Table Editor.

## Recovery flows

The dashboard intentionally exposes no UI for admin password reset or fingerprint reveal. Recovery is performed by direct SQL only.

### Reset the admin (forgot password, locked yourself out)

```sql
-- Delete the existing admin row.  This re-arms the onboarding gate; the next
-- visit to the dashboard will redirect to /onboarding to create a new admin.
delete from public.admin;

-- Optional: clear any stale lockout rows so you can log in straight away
-- after re-onboarding.
delete from public.auth_attempts;
```

After running this, visit the dashboard URL. Middleware sees zero admin rows and sends you to `/onboarding`. Complete it again with a fresh username, password, and fingerprint.

Note: re-onboarding produces a new fingerprint. The firmware will be 401-ing until you re-flash `secrets.h` with the new value.

### Rotate the fingerprint manually (without using the UI)

The dashboard's fingerprint page is the supported path. If for some reason you need to bypass it (the dashboard is down, you've lost browser access, etc.), you can rotate the fingerprint by writing a fresh argon2id hash directly:

1. Generate a new high-entropy fingerprint locally:

   ```bash
   # 32 bytes, base64-encoded — copy this into the firmware's secrets.h
   openssl rand -base64 32
   ```

2. Hash it with argon2id. Easiest path is a tiny Node script run locally
   (the dashboard already depends on `@node-rs/argon2`, so this works once
   you've installed the dashboard's deps):

   ```bash
   node -e "import('@node-rs/argon2').then(async m=>{const h=await m.hash(process.argv[1],{memoryCost:65536,timeCost:3,parallelism:4,algorithm:2});console.log(h);})" 'PASTE_THE_FINGERPRINT_HERE'
   ```

   Copy the printed `$argon2id$...` string.

3. In the Supabase SQL editor, write the hash into `config`:

   ```sql
   update public.config
   set fingerprint_hash = '$argon2id$...PASTE_HASH_HERE...',
       updated_at = now()
   where id = 1;
   ```

4. The dashboard's per-instance config cache is 5 seconds, so the next firmware request after that window will validate against the new hash. Old fingerprints are rejected with 401.

5. Re-flash the firmware's `secrets.h` with the **plaintext** fingerprint from step 1, not the hash. The dashboard never stores the plaintext.

### Wipe activity logs

```sql
-- Optional housekeeping; the dashboard's activity page also supports
-- per-row delete.
delete from public.activity_log;
```

There is no scheduled retention; logs accumulate until you delete them or the project hits Supabase's storage limits.
