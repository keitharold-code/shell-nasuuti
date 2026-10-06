-- Section 3: "Fuel cost basis" switch. Default FIXED matches today's
-- behaviour exactly (cost = pump price - dated margin), so adding this
-- column changes nothing until a director switches it.
--
-- Rollback: drop column. Reporting views (0017) must treat a missing
-- column the same as FIXED, so a rollback here is silently safe too.

alter table settings
  add column if not exists fuel_cost_basis text not null default 'FIXED'
    check (fuel_cost_basis in ('FIXED', 'LATEST_INVOICE', 'WEIGHTED_AVG'));
