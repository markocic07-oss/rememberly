create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null default '',
  category text not null default 'Personal',
  tags text[] not null default '{}',
  type text not null default 'text',
  summary text,
  favorite boolean not null default false,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memories_user_created_idx
  on public.memories (user_id, created_at desc);

alter table public.memories enable row level security;

drop policy if exists "Users can read their own memories" on public.memories;
create policy "Users can read their own memories"
  on public.memories for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their own memories" on public.memories;
create policy "Users can create their own memories"
  on public.memories for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own memories" on public.memories;
create policy "Users can update their own memories"
  on public.memories for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own memories" on public.memories;
create policy "Users can delete their own memories"
  on public.memories for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.memories to authenticated;
