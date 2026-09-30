# Shell Nasuuti — Daily Sales & Gross Profit App: Build Brief

## 1. Objective
Rebuild the working prototype (`nasuuti-daily-gp.html`, in this folder) as a standalone web app:
- Hosted on the owner's own hosting (ask for hosting type, domain/subdomain and deploy access before deploying).
- Supabase for the database and authentication.
- Usable on a phone browser by station staff who have no Claude account.

**Feature parity with the prototype is mandatory**, except where section 5 below explicitly changes the forecourt-sales / cash model. Treat the prototype's calculation functions (`compute`, `stockChain`, `discrepancies`, `totals`) as the reference implementation everywhere else, and port them unchanged in behaviour.

## 2. Stack
- **Front end:** plain HTML/CSS/JS or Vite + vanilla JS, built to static files. No framework is required, so keep it light.
- **Supabase JS client** (`@supabase/supabase-js`) for authentication and data.
- **Exports:** SheetJS (xlsx) and jsPDF + jspdf-autotable, bundled locally rather than loaded from a CDN.
- **Config:** Supabase URL and anon key in `.env`. Never commit the service-role key.

## 3. Roles
| Role | Who | Can do |
|---|---|---|
| `admin` | Directors (D1, D2) | Everything: prices and margins, tolerance, delete entries, manage users |
| `entry` | Cashier | Create and update daily entries, view reports, export |
| `viewer` | Optional (e.g. funder or accountant) | View reports and export only |

Enforce roles with Supabase row-level security (RLS), not only in the UI.

## 4. Database schema (Postgres / Supabase)
```sql
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin','entry','viewer')) default 'entry',
  created_at timestamptz default now()
);

create table price_sets (
  id bigserial primary key,
  effective_from date not null unique,
  pms_price numeric not null, pms_margin numeric not null,
  ago_price numeric not null, ago_margin numeric not null,
  vp_price  numeric not null, vp_margin  numeric not null,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table settings (
  id int primary key default 1 check (id = 1),
  shop_margin_pct numeric not null default 0,
  lpg_margin_pct numeric not null default 0,
  lubes_margin_pct numeric not null default 0,
  stock_tolerance_pct numeric not null default 0.5,
  banking_account_name text not null default 'Centenary',
  single_account_banking_from date not null default '2026-09-29',
  updated_by uuid references profiles(id),
  updated_at timestamptz default now()
);

create table daily_entries (
  trading_date date primary key,
  dip_pms numeric, dip_ago numeric, dip_vp numeric,             -- closing dip, taken next morning
  deliv_pms numeric, deliv_ago numeric, deliv_vp numeric,       -- litres received
  sold_pms numeric, sold_ago numeric, sold_vp numeric,          -- litres sold (meters)
  forecourt_cash_drop numeric, shop_sales numeric, lpg_sales numeric, lubes_sales numeric,
  pay_cash numeric,   -- cash collected: forecourt + shop, LPG, lubes combined
  pay_momo numeric, pay_shell_card numeric, pay_visa numeric, pay_credit numeric,
  bank_centenary numeric,  -- banked to the one account (its name is admin-configurable)
  bank_exim numeric,       -- legacy second account; read-only from the single-account switchover date on
  expenses numeric,
  notes text,
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Audit trail: every insert, update and delete on daily_entries, price_sets and settings
create table audit_log (
  id bigserial primary key,
  table_name text not null,
  record_key text not null,
  action text not null check (action in ('insert','update','delete')),
  old_data jsonb, new_data jsonb,
  changed_by uuid references profiles(id),
  changed_at timestamptz default now()
);
```

Also implement:
- Triggers that write to `audit_log` and set `updated_at` / `updated_by`.
- RLS on all tables:
  - Read: all authenticated users with a profile.
  - Write to `daily_entries`: `admin`, `entry`.
  - Delete on `daily_entries`: `admin` only.
  - Write to `price_sets` and `settings`: `admin` only.
  - `audit_log`: read by `admin` only; writes only via triggers.

## 5. Calculation rules (must match the prototype exactly, except as noted)
- **Price in force** for a date: the `price_sets` row with the latest `effective_from` on or before that date.
- **Fuel GP** = Σ litres sold × margin/L, per product.
- **Forecourt sales** = Σ litres sold × pump price. This is the sales figure used in all reports and totals — it is always computed, never a manually-typed value, so it is never blank for a day that has litres sold and a price in force.
- **Cash expected** = forecourt sales − (mobile money + Shell Card + Visa + credit). Cash itself is not subtracted — it's the thing being checked, not a channel netted out of the total.
- **Cash over/short** = forecourt cash drop declared − cash expected. Only meaningful once a cash drop is actually declared for the day.
- **Total sales** = forecourt sales + shop + LPG + lubes.
- **Non-fuel GP** = shop × shop% + LPG × LPG% + lubes × lubes%.
- **Total GP** = fuel GP + non-fuel GP. **GP after expenses** = total GP − expenses.
- **Cash collected** is one field (`pay_cash`) covering forecourt cash plus shop, LPG and lubes cash together — the station banks all of it as a single daily drop, so it isn't split by source.
- **Total banked** = the one banking account (`bank_centenary`) + `bank_exim`. `bank_exim` is a legacy column: the app never writes to it for entries dated on or after `single_account_banking_from`, but its historical values keep counting here unmigrated, so past totals stay correct.
- **Unaccounted sales** = total sales − (cash collected + mobile money + Shell Card + Visa + credit). Replaces the older, differently-signed "payments check" — this is total sales minus everything received, so a positive value means sales that weren't accounted for by any payment method, a negative value means more was received than the sales figure explains.
- **Cash not banked** = cash collected − expenses − banked. What should be left over after petty cash/expenses are taken out and the rest is banked.
- Both of the above are **only computed for entries dated on or after `settings.single_account_banking_from`** (default 2026-09-29) — before that date the station banked to two accounts on a split that isn't checkable this way, so they show "—", not zero: zero would read as "checked, no problem" for a day that was never checkable. Report and export totals for these two figures sum only the applicable days; if no day in the period qualifies, the total is "—" too. Every other figure (GP, stock, forecourt cash drop) is computed identically for every date regardless of this setting — it only ever gates these two checks.
- Both are **flagged whenever not zero**, in either direction — unlike the forecourt cash-drop check and the stock checks, a positive value here isn't a good sign, just the sign of a different kind of problem, so there's no separate "good"/"bad" color for the sign.
- **Daily stock check**, per product:
  - Book = previous entry's dip + delivered − sold.
  - Variance = actual dip − book.
  - Flag when |variance| > tolerance% × litres sold (and ≥ 0.5 L).
  - Flag gains as well as losses.
  - When nothing was delivered, the message is "Dip doesn't match sales, no delivery".
- **Cumulative stock check**, per product:
  - A run is the consecutive entries since the last delivery.
  - A delivery day, or a missing dip, starts a new run from that day's dip.
  - Cumulative book = run-start dip − cumulative litres sold.
  - Flag when |cumulative variance| > tolerance% × cumulative litres sold.
- **Opening stock** comes from the most recent earlier entry. If dates are missing in between, show how many days are missing.

## 6. Screens
1. **Login.** Email and password, plus password reset.
2. **Daily entry.** Default trading date = yesterday; selecting a date loads any existing entry. Live GP readout, forecourt cash check (unchanged), stock reconciliation (daily and cumulative), and totals — including Unaccounted sales and Cash not banked, both red-flagged when nonzero and shown as "—" before the single-account switchover date.
3. **Reports.**
   - Periods: last 7 days, this month, last month, all, or custom.
   - KPIs, daily GP chart (fuel vs non-fuel), daily table with a totals row (including Unaccounted sales and Cash not banked columns), and a stock discrepancies table.
   - Selecting a row opens that day's entry.
4. **Admin.** Price history (add or remove, with effective date), non-fuel margins, tolerance, banking account name and single-account-banking-from date, and user management (invite a user, set role, deactivate).
5. **Audit log** (admin only). Filter by date and user.

## 7. Exports
- **Excel**, with sheets:
  - Summary (including payments and banking by account)
  - Daily
  - Dips & cash
  - Stock check
  - Prices
- **PDF**, A4 landscape: header band, summary table, product/stock table, daily table with totals, stock discrepancies table, and page numbers.
- **Filename:** `ShellNasuuti_GP_<from>_to_<to>.(xlsx|pdf)`.

## 8. Non-functional requirements
- Mobile-first: the cashier will use a phone. Use large tap targets and a numeric keypad for number fields.
- Serve over HTTPS only.
- Handle a lost connection: warn before losing unsaved form data, and don't show a success message until Supabase confirms the save.
- Show all money in UGX with no decimals and all litres to 2 decimal places.
- No secrets in client code other than the Supabase anon key.

## 9. Deployment
1. Ask the owner for hosting type (cPanel / VPS / other), domain or subdomain, and deploy method (SFTP / SSH / Git).
2. Build the static bundle and deploy it to the subdomain. Confirm HTTPS works (Let's Encrypt or the host's SSL).
3. In Supabase, run the migrations and set Site URL and redirect URLs to the production domain.
4. Create the first admin user and seed `settings` (id = 1).
5. Write a short `README.md` covering how to redeploy, add users and back up (Supabase daily backups plus a monthly Excel export).

## 10. Acceptance tests
Run these with sample prices before handover.
1. **Price in force:** add price sets effective 01/09 and 20/09. An entry on 22/09 must use the 20/09 set, and one on 15/09 must use the 01/09 set.
2. **GP calculation:** enter the sample day (PMS 2,578.33 L, AGO 758.64 L, V-Power 293.68 L; forecourt cash drop 18,624,000; shop 869,700; LPG 753,000; lubes 601,000). GP must equal Σ litres × margin + non-fuel sales × margin %.
3. **Cumulative flag:** set PMS dips to 12,000, 11,500, 10,990 and 10,480 on four consecutive days, with 500 L sold each day and no delivery.
   - Day 2: no flag.
   - Days 3 and 4: flagged.
   - Cumulative variance on day 4 = −20 L (−1.33%).
4. **Run reset:** a delivery on day 5 starts a new run.
5. **Permissions:** the cashier cannot open Admin, cannot change prices (also blocked when calling the API directly), and cannot delete entries.
6. **Audit log:** every edit shows who changed it, when, and the old and new values.
7. **Exports:** the Excel and PDF totals match the on-screen totals for the same period.
