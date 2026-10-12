-- PLAN_PHASE2.md section 3/7: one Storage bucket for every photo this
-- phase's forms collect (manager remarks/photos 5.4.H, cashier channel
-- photos 5.5.B, the banking slip photo 5.5.G), private, path-scoped as
-- day-records/{trading_date}/{role}/{filename}.
--
-- storage.objects already has RLS enabled by Supabase on every project;
-- this migration only adds policies, same as every table before it.
-- storage.foldername(name) is Supabase's own built-in — it splits the
-- object's path and returns every segment except the filename, so
-- foldername(name)[1] is the trading_date segment and [2] is the role
-- segment for a path shaped like this bucket's convention.
--
-- Rollback: drop the three policies, then the bucket row.

insert into storage.buckets (id, name, public)
values ('day-records', 'day-records', false)
on conflict (id) do nothing;

create policy day_records_storage_select on storage.objects
  for select
  using (
    bucket_id = 'day-records'
    and (
      is_admin()
      or ((storage.foldername(name))[2] = 'manager' and is_manager_for(((storage.foldername(name))[1])::date))
      or ((storage.foldername(name))[2] = 'cashier' and is_cashier_for(((storage.foldername(name))[1])::date))
    )
  );

create policy day_records_storage_insert on storage.objects
  for insert
  with check (
    bucket_id = 'day-records'
    and (
      ((storage.foldername(name))[2] = 'manager' and can_manager_edit(((storage.foldername(name))[1])::date))
      or ((storage.foldername(name))[2] = 'cashier' and can_cashier_edit(((storage.foldername(name))[1])::date))
    )
  );

create policy day_records_storage_delete_admin on storage.objects
  for delete
  using (bucket_id = 'day-records' and is_admin());
