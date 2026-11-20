create extension if not exists pgcrypto;

create table if not exists public.stripe_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  stripe_customer_id text references public.stripe_customers(stripe_customer_id) on delete set null,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan text not null default 'free' check (plan in ('free', 'pro', 'premium')),
  status text not null default 'free' check (status in ('free', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  billing_interval text check (billing_interval is null or billing_interval = 'month'),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_tracking (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  resource_type text not null,
  usage_count bigint not null default 0 check (usage_count >= 0),
  storage_used bigint not null default 0 check (storage_used >= 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (user_id, resource_type, period_start)
);

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  subscription_id text,
  stripe_event_id text not null unique,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_invoice_id text not null unique,
  amount_total bigint,
  currency text not null default 'usd',
  status text not null,
  description text,
  invoice_url text,
  invoice_pdf text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);

create index if not exists subscriptions_customer_id_idx on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_status_period_idx on public.subscriptions (user_id, status, current_period_end);
create index if not exists usage_tracking_user_resource_period_idx on public.usage_tracking (user_id, resource_type, period_start desc);
create index if not exists subscription_events_user_created_idx on public.subscription_events (user_id, created_at desc);
create index if not exists billing_history_user_created_idx on public.billing_history (user_id, created_at desc);

alter table public.stripe_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_tracking enable row level security;
alter table public.subscription_events enable row level security;
alter table public.billing_history enable row level security;
alter table public.stripe_webhook_events enable row level security;

create policy "Users can read their Stripe customer mapping"
  on public.stripe_customers for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can read their subscription"
  on public.subscriptions for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can read their usage"
  on public.usage_tracking for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can read their subscription events"
  on public.subscription_events for select to authenticated
  using (auth.uid() = user_id);
create policy "Users can read their billing history"
  on public.billing_history for select to authenticated
  using (auth.uid() = user_id);

revoke insert, update, delete on public.stripe_customers from anon, authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
revoke insert, update, delete on public.usage_tracking from anon, authenticated;
revoke insert, update, delete on public.subscription_events from anon, authenticated;
revoke insert, update, delete on public.billing_history from anon, authenticated;
revoke all on public.stripe_webhook_events from anon, authenticated;
grant select on public.stripe_customers, public.subscriptions, public.usage_tracking,
  public.subscription_events, public.billing_history to authenticated;

create or replace function public.user_has_feature(p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with user_plan as (
    select case
      when s.plan in ('pro', 'premium')
        and s.status in ('active', 'trialing')
        and (s.current_period_end is null or s.current_period_end > now())
      then s.plan
      else 'free'
    end as plan
    from (select auth.uid() as user_id) u
    left join public.subscriptions s on s.user_id = u.user_id
  )
  select coalesce(case p_feature
    when 'basic_text_notes' then true
    when 'basic_categories' then true
    when 'basic_search' then true
    when 'basic_reminders' then true
    when 'ai_organization' then (select plan in ('pro', 'premium') from user_plan)
    when 'ai_search' then (select plan in ('pro', 'premium') from user_plan)
    when 'voice_capture' then (select plan in ('pro', 'premium') from user_plan)
    when 'document_vault' then (select plan in ('pro', 'premium') from user_plan)
    when 'receipt_manager' then (select plan in ('pro', 'premium') from user_plan)
    when 'warranty_tracker' then (select plan in ('pro', 'premium') from user_plan)
    when 'unlimited_collections' then (select plan in ('pro', 'premium') from user_plan)
    when 'advanced_reminders' then (select plan in ('pro', 'premium') from user_plan)
    when 'smart_document_categorization' then (select plan in ('pro', 'premium') from user_plan)
    when 'advanced_ai_assistant' then (select plan = 'premium' from user_plan)
    when 'advanced_ocr' then (select plan = 'premium' from user_plan)
    when 'semantic_search' then (select plan = 'premium' from user_plan)
    when 'subscription_tracker' then (select plan = 'premium' from user_plan)
    when 'travel_organizer' then (select plan = 'premium' from user_plan)
    when 'personal_inventory' then (select plan = 'premium' from user_plan)
    when 'advanced_analytics' then (select plan = 'premium' from user_plan)
    else false
  end, false)
  where auth.uid() is not null;
$$;

create or replace function public.validate_usage_limit(
  p_resource_type text,
  p_requested bigint default 1
)
returns table (allowed boolean, used bigint, usage_limit bigint, remaining bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan text := 'free';
  v_used bigint := 0;
  v_limit bigint := null;
  v_period_start timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_requested is null or p_requested < 0 then
    raise exception 'Requested usage must be a non-negative number' using errcode = '22023';
  end if;

  select case
    when s.plan in ('pro', 'premium')
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    then coalesce(s.current_period_start, date_trunc('month', now()))
    else date_trunc('month', now())
  end into v_period_start
  from (select v_user_id as user_id) u
  left join public.subscriptions s on s.user_id = u.user_id;

  select case
    when s.plan in ('pro', 'premium')
      and s.status in ('active', 'trialing')
      and (s.current_period_end is null or s.current_period_end > now())
    then s.plan
    else 'free'
  end into v_plan
  from (select v_user_id as user_id) u
  left join public.subscriptions s on s.user_id = u.user_id;

  if p_resource_type = 'memories' then
    v_limit := case v_plan when 'free' then 50 when 'pro' then 2000 else null end;
  elsif p_resource_type = 'documents' then
    v_limit := case v_plan when 'free' then 5 else null end;
  elsif p_resource_type = 'document_storage_bytes' then
    v_limit := case v_plan when 'pro' then 10::bigint * 1024 * 1024 * 1024 when 'premium' then 50::bigint * 1024 * 1024 * 1024 else null end;
  elsif p_resource_type = 'collections' then
    v_limit := case v_plan when 'free' then 1 else null end;
  else
    raise exception 'Unsupported usage resource: %', p_resource_type using errcode = '22023';
  end if;

  if p_resource_type = 'document_storage_bytes' then
    select coalesce(storage_used, 0)
    into v_used
    from public.usage_tracking
    where user_id = v_user_id and resource_type = p_resource_type
    order by updated_at desc
    limit 1;
    v_used := coalesce(v_used, 0);
  elsif p_resource_type in ('memories', 'documents', 'collections') then
    select coalesce(usage_count, 0)
    into v_used
    from public.usage_tracking
    where user_id = v_user_id and resource_type = p_resource_type
    order by updated_at desc
    limit 1;
    v_used := coalesce(v_used, 0);
  else
    select coalesce(sum(usage_count), 0)
    into v_used
    from public.usage_tracking
    where user_id = v_user_id
      and resource_type = p_resource_type
      and period_start = v_period_start;
  end if;

  return query select
    (v_limit is null or v_used + p_requested <= v_limit),
    v_used,
    v_limit,
    case when v_limit is null then null else greatest(v_limit - v_used, 0) end;
end;
$$;

create or replace function public.process_stripe_event(p_payload jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id text := p_payload ->> 'event_id';
  v_event_type text := p_payload ->> 'event_type';
  v_customer_id text := nullif(p_payload ->> 'customer_id', '');
  v_user_id uuid := nullif(p_payload ->> 'user_id', '')::uuid;
  v_subscription_id text := nullif(p_payload ->> 'subscription_id', '');
  v_plan text := nullif(p_payload ->> 'plan', '');
  v_invoice jsonb := p_payload -> 'invoice';
  v_inserted integer;
begin
  if v_event_id is null or v_event_type is null then
    raise exception 'Stripe event id and type are required' using errcode = '22023';
  end if;

  insert into public.stripe_webhook_events (event_id, event_type, event_data)
  values (v_event_id, v_event_type, coalesce(p_payload -> 'event_data', '{}'::jsonb))
  on conflict (event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return false;
  end if;

  if v_user_id is null and v_customer_id is not null then
    select c.user_id into v_user_id
    from public.stripe_customers c
    where c.stripe_customer_id = v_customer_id;
  end if;
  if v_user_id is null then
    raise exception 'No Rememberly user is linked to Stripe event %', v_event_id using errcode = '23503';
  end if;

  if v_customer_id is not null then
    insert into public.stripe_customers (user_id, stripe_customer_id)
    values (v_user_id, v_customer_id)
    on conflict (user_id) do update set
      stripe_customer_id = excluded.stripe_customer_id,
      updated_at = now();
  end if;

  if v_subscription_id is not null and v_plan in ('pro', 'premium') then
    insert into public.subscriptions (
      user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, plan,
      status, billing_interval, current_period_start, current_period_end,
      cancel_at_period_end, updated_at
    ) values (
      v_user_id, v_customer_id, v_subscription_id,
      nullif(p_payload ->> 'price_id', ''), v_plan,
      coalesce(nullif(p_payload ->> 'status', ''), 'incomplete'),
      coalesce(nullif(p_payload ->> 'billing_interval', ''), 'month'),
      nullif(p_payload ->> 'current_period_start', '')::timestamptz,
      nullif(p_payload ->> 'current_period_end', '')::timestamptz,
      coalesce((p_payload ->> 'cancel_at_period_end')::boolean, false),
      now()
    )
    on conflict (user_id) do update set
      stripe_customer_id = coalesce(excluded.stripe_customer_id, public.subscriptions.stripe_customer_id),
      stripe_subscription_id = excluded.stripe_subscription_id,
      stripe_price_id = excluded.stripe_price_id,
      plan = excluded.plan,
      status = excluded.status,
      billing_interval = excluded.billing_interval,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      updated_at = now();
  end if;

  insert into public.subscription_events (user_id, event_type, subscription_id, stripe_event_id, event_data)
  values (v_user_id, v_event_type, v_subscription_id, v_event_id, coalesce(p_payload -> 'event_data', '{}'::jsonb))
  on conflict (stripe_event_id) do nothing;

  if v_invoice is not null and nullif(v_invoice ->> 'id', '') is not null then
    insert into public.billing_history (
      user_id, stripe_invoice_id, amount_total, currency, status, description,
      invoice_url, invoice_pdf, paid_at
    ) values (
      v_user_id,
      v_invoice ->> 'id',
      nullif(v_invoice ->> 'amount_total', '')::bigint,
      coalesce(nullif(v_invoice ->> 'currency', ''), 'usd'),
      coalesce(nullif(v_invoice ->> 'status', ''), 'unknown'),
      nullif(v_invoice ->> 'description', ''),
      nullif(v_invoice ->> 'invoice_url', ''),
      nullif(v_invoice ->> 'invoice_pdf', ''),
      nullif(v_invoice ->> 'paid_at', '')::timestamptz
    )
    on conflict (stripe_invoice_id) do update set
      amount_total = excluded.amount_total,
      currency = excluded.currency,
      status = excluded.status,
      description = excluded.description,
      invoice_url = excluded.invoice_url,
      invoice_pdf = excluded.invoice_pdf,
      paid_at = excluded.paid_at;
  end if;

  return true;
end;
$$;

revoke all on function public.user_has_feature(text) from public, anon;
revoke all on function public.validate_usage_limit(text, bigint) from public, anon;
revoke all on function public.process_stripe_event(jsonb) from public, anon, authenticated;
grant execute on function public.user_has_feature(text) to authenticated;
grant execute on function public.validate_usage_limit(text, bigint) to authenticated;
grant execute on function public.process_stripe_event(jsonb) to service_role;
