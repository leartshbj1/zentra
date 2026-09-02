begin;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'zentra-invoice-archives',
  'zentra-invoice-archives',
  false,
  12582912,
  array['application/pdf']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists zentra_invoice_archives_read_member on storage.objects;

create policy zentra_invoice_archives_read_member
on storage.objects
for select
to authenticated
using (
  bucket_id = 'zentra-invoice-archives'
  and (storage.foldername(name))[1] = 'organizations'
  and (select private.is_organization_member((storage.foldername(name))[2]))
);

-- Aucun droit INSERT/UPDATE/DELETE n'est accordé aux clients. Le serveur
-- privilégié écrit un objet unique, puis finalise la métadonnée pending.

commit;
