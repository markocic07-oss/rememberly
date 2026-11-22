create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  tags text not null default '',
  purchase_date date,
  expiration date,
  warranty_date date,
  store text not null default '',
  reminder text not null default '',
  amount numeric(12, 2) check (amount is null or amount >= 0),
  is_subscription boolean not null default false,
  monthly_amount numeric(12, 2),
  file_path text,
  file_name text,
  file_type text,
  file_size bigint not null default 0 check (file_size >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receipts_monthly_amount_valid
    check (monthly_amount is null or monthly_amount > 0),
  constraint receipts_subscription_amount_required
    check (not is_subscription or monthly_amount is not null)
);

create index if not exists receipts_user_created_idx
  on public.receipts (user_id, created_at desc);

alter table public.receipts enable row level security;

drop policy if exists "Users can read their own receipts" on public.receipts;
create policy "Users can read their own receipts"
  on public.receipts for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own receipts" on public.receipts;
create policy "Users can create their own receipts"
  on public.receipts for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own receipts" on public.receipts;
create policy "Users can update their own receipts"
  on public.receipts for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own receipts" on public.receipts;
create policy "Users can delete their own receipts"
  on public.receipts for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.receipts to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipt-files',
  'receipt-files',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their own receipt files" on storage.objects;
create policy "Users can read their own receipt files"
  on storage.objects for select to authenticated
  using (bucket_id = 'receipt-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can upload their own receipt files" on storage.objects;
create policy "Users can upload their own receipt files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'receipt-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can update their own receipt files" on storage.objects;
create policy "Users can update their own receipt files"
  on storage.objects for update to authenticated
  using (bucket_id = 'receipt-files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipt-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users can delete their own receipt files" on storage.objects;
create policy "Users can delete their own receipt files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'receipt-files' and (storage.foldername(name))[1] = auth.uid()::text);
