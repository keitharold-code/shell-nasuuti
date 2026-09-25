# Shell Nasuuti — Daily Sales & Gross Profit

A mobile-first web app for recording daily fuel-station sales and seeing
gross profit, cash checks and stock reconciliation calculated live. Built
against `BUILD_BRIEF.md`; the prototype's calculation logic (`compute`,
`stockChain`, `discrepancies`, `totals`) is ported unchanged into
`src/lib/calc.js`.

- **Front end:** static HTML/JS bundled with Vite (no framework).
- **Backend:** Supabase (Postgres + Auth + Row-Level Security + Realtime).
- **Exports:** Excel (SheetJS) and PDF (jsPDF + autotable), bundled locally.

## 1. First-time setup

### 1.1 Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/migrations/0001_init.sql`. This creates
   every table, trigger, and RLS policy, and seeds the `settings` singleton
   row.
3. Deploy the admin-users edge function (needed for **inviting** and
   **deactivating** users from the Admin screen):
   ```
   supabase functions deploy admin-users --project-ref YOUR-PROJECT-REF
   ```
   No extra secrets are needed — Supabase injects `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` into every edge function automatically. That
   service-role key never appears in this repo or in the client bundle.
4. In **Authentication > URL Configuration**, set the Site URL and add a
   Redirect URL for your production domain (and `http://localhost:5173`
   for local dev).

### 1.2 Create the first admin

Invite yourself from **Authentication > Users > Invite user** in the
Supabase dashboard (the app's own Admin screen needs an admin to already
exist, so the very first one is created here). Accept the invite email,
set your password, then in the SQL editor run:

```sql
update profiles set role = 'admin' where id =
  (select id from auth.users where email = 'you@example.com');
```

Every admin invited after that can be promoted from the app's own Admin
screen — no more manual SQL needed.

### 1.3 Configure the app

```bash
cp .env.example .env.local
```

Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from
**Settings > API** in the Supabase dashboard. Never put the service-role
key here or anywhere else in this repo.

```bash
npm install
npm run dev      # local dev server
npm run build    # static bundle -> dist/
```

## 2. Deploying

`npm run build` produces a static `dist/` folder — any static host works
(the brief leaves the specific host, domain, and deploy method to be
confirmed with the station owner before the first deploy).

1. Upload the contents of `dist/` to the web root of your subdomain.
2. Confirm HTTPS is active (Let's Encrypt or the host's own SSL) — the app
   must be served over HTTPS only.
3. Make sure the domain you deployed to is listed in Supabase's Redirect
   URLs (see 1.1) — password reset links won't work otherwise.
4. Re-run `npm run build` and re-upload `dist/` after any code change;
   there's no build step on the server.

## 3. Roles

| Role | Can do |
|---|---|
| `admin` | Everything: prices/margins, tolerance, delete entries, manage users, audit log |
| `entry` | Create/update daily entries, view reports, export |
| `viewer` | View reports and export only |

Every role is enforced by Postgres RLS, not just hidden in the UI — a
cashier's token cannot write prices even by calling the API directly.

## 4. Adding / removing users

- **Invite:** Admin screen → "Invite a user". Sends a Supabase Auth invite
  email; the user sets their own password from the link.
- **Change role:** Admin screen → pick the role from the dropdown next to
  their name.
- **Deactivate:** Admin screen → "Deactivate". This bans the account in
  Supabase Auth (so they can no longer sign in) and marks their profile
  inactive. "Reactivate" undoes both.

## 5. Backups

- Supabase takes daily automatic backups of the Postgres database (see
  **Database > Backups** in the dashboard; retention depends on your
  Supabase plan).
- In addition, export a full Excel report monthly (Reports tab → period
  "All entries" → Export Excel) and store it off-platform (e.g. Google
  Drive) as a second, human-readable copy of the trading history.

## 6. Project structure

```
src/
  lib/         calc.js (reference calculation engine), format.js, data.js
               (Supabase <-> app-shape adapters + CRUD + realtime),
               session.js (auth), store.js (app state), adminUsers.js
  pages/       login, entry, reports, admin, audit — one render function each
  exports/     xlsx.js, pdf.js
supabase/
  migrations/  0001_init.sql — schema, RLS, triggers
  functions/   admin-users — invite/deactivate (needs the service-role key,
               which is why it's a server-side edge function, not client code)
```

## 7. Acceptance tests

The scenarios in `BUILD_BRIEF.md` section 10 (price-in-force by date, the
sample-day GP calculation, the four-day cumulative stock flag, run reset on
delivery, role permissions, audit log, export totals matching on-screen
totals) should all be run against a seeded project before handover.
