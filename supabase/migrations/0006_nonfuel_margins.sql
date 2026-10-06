-- Section 4.1: dated shop/LPG/lubes margins, extending the existing
-- price_sets pattern (one row per effective_from, all products together)
-- rather than duplicating it with a different shape. end_date is an
-- admin-entered annotation only — the "price/margin in force" lookup still
-- works by latest effective_from <= date, same as price_sets; end_date
-- does not participate in that lookup, it's just visible history for
-- whoever reads the margin table.
--
-- Rollback: drop table nonfuel_margins (and its policies/triggers via
-- cascade). settings.shop_margin_pct etc. are untouched either way, so a
-- rollback here reverts to today's singleton-margin behaviour exactly.

create table nonfuel_margins (
  id bigserial primary key,
  effective_from date not null unique,
  shop_pct numeric not null,
  lpg_pct numeric not null,
  lubes_pct numeric not null,
  end_date date,
  reason text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create trigger nonfuel_margins_set_created_by
  before insert on nonfuel_margins
  for each row execute function set_created_by();

create trigger nonfuel_margins_audit
  after insert or update or delete on nonfuel_margins
  for each row execute function audit_row();

alter table nonfuel_margins enable row level security;

create policy nonfuel_margins_select on nonfuel_margins
  for select
  using (is_active_profile());

create policy nonfuel_margins_write_admin on nonfuel_margins
  for all
  using (is_admin())
  with check (is_admin());

-- Back-fill: the station's actual shop margin for every day on record
-- (all >= 09/09/2026) is 22.4%, not the 30% currently in
-- settings.shop_margin_pct — effective_from is dated 01/09/2026 so it
-- covers the whole back-filled period. LPG and lubes are unchanged at
-- today's settings values. settings.shop_margin_pct itself is left alone
-- (ground rule: don't drop/rewrite existing columns) — the app simply
-- stops reading it for any date this table covers.
insert into nonfuel_margins (effective_from, shop_pct, lpg_pct, lubes_pct, reason)
values ('2026-09-01', 22.4, 10.2, 8.4, 'Correction: shop margin was recorded at 30% in settings; actual is 22.4%.')
on conflict (effective_from) do update set
  shop_pct = excluded.shop_pct, lpg_pct = excluded.lpg_pct, lubes_pct = excluded.lubes_pct,
  reason = excluded.reason;

-- Section 4.1 also covers a fuel margin: V-Power's margin becomes 108
-- UGX/L effective 09/09/2026, replacing 102. Both existing price_sets
-- rows (09/09 and 20/09) currently carry the old 102 — fixing both so a
-- day on or after 20/09 doesn't look up the stale value via the
-- "latest effective_from <= date" rule. No price change was specified
-- for V-Power alongside this, so vp_price is left exactly as it was on
-- each row.
update price_sets set vp_margin = 108 where effective_from in ('2026-09-09', '2026-09-20');
