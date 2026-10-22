-- Jalankan satu kali setelah supabase/setup.sql.
-- File GeoJSON disimpan di Storage agar tidak dikirim sebagai JSONB besar.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'zone-geojson',
  'zone-geojson',
  true,
  52428800,
  array['application/geo+json', 'application/json']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "zone_geojson_public_metadata_read" on storage.objects;
create policy "zone_geojson_public_metadata_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'zone-geojson'
    and exists (
      select 1 from public.webgis_admins
      where user_id = (select auth.uid())
    )
  );

drop policy if exists "zone_geojson_admin_upload" on storage.objects;
create policy "zone_geojson_admin_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'zone-geojson'
    and exists (
      select 1 from public.webgis_admins
      where user_id = (select auth.uid())
    )
  );

drop policy if exists "zone_geojson_admin_update" on storage.objects;
create policy "zone_geojson_admin_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'zone-geojson'
    and exists (
      select 1 from public.webgis_admins
      where user_id = (select auth.uid())
    )
  )
  with check (
    bucket_id = 'zone-geojson'
    and exists (
      select 1 from public.webgis_admins
      where user_id = (select auth.uid())
    )
  );

drop policy if exists "zone_geojson_admin_delete" on storage.objects;
create policy "zone_geojson_admin_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'zone-geojson'
    and exists (
      select 1 from public.webgis_admins
      where user_id = (select auth.uid())
    )
  );
