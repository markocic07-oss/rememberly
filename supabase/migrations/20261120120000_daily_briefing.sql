create table if not exists public.user_notification_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  daily_briefing_enabled boolean not null default true,
  briefing_time time not null default '08:00',
  timezone text not null default 'UTC',
  quiet_hours_start time not null default '22:00',
  quiet_hours_end time not null default '07:00',
  notification_categories jsonb not null default '{
    "document_expiration": true,
    "warranty": true,
    "bill": true,
    "subscription_renewal": true,
    "travel": true,
    "reminder": true,
    "appointment": true
  }'::jsonb,
  notification_frequency text not null default 'daily_briefing'
    check (notification_frequency in ('daily_briefing', 'important_only', 'critical_only', 'weekly_summary')),
  push_enabled boolean not null default false,
  email_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.briefing_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id text not null,
  source_type text not null check (source_type in ('document', 'memory', 'reminder')),
  category text not null check (category in ('document_expiration', 'warranty', 'bill', 'subscription_renewal', 'travel', 'reminder', 'appointment')),
  title text not null,
  due_date date not null,
  importance smallint not null default 2 check (importance between 1 and 3),
  related_memory_id text,
  related_document_id text,
  completed_at timestamptz,
  dismissed_at timestamptz,
  source_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_id, category)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  message text not null,
  category text not null,
  priority text not null check (priority in ('low', 'medium', 'high', 'urgent')),
  related_memory_id text,
  related_document_id text,
  related_reminder_id text,
  event_id text,
  notification_stage text,
  scheduled_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,
  completed_at timestamptz,
  snoozed_until timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_delivery_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id text not null,
  notification_stage text not null,
  delivery_channel text not null check (delivery_channel in ('in_app', 'web_push', 'email')),
  delivery_status text not null check (delivery_status in ('pending', 'delivered', 'failed', 'skipped')),
  error_message text,
  attempt_count integer not null default 1,
  notification_id uuid references public.notifications(id) on delete set null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, event_id, notification_stage, delivery_channel)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.daily_briefings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  briefing_date date not null,
  summary text not null,
  included_events jsonb not null default '[]'::jsonb,
  delivery_status text not null default 'in_app'
    check (delivery_status in ('in_app', 'push_delivered', 'push_failed', 'no_push_subscription')),
  created_at timestamptz not null default now(),
  unique (user_id, briefing_date)
);

create index if not exists briefing_events_due_idx
  on public.briefing_events (due_date, category) where completed_at is null and dismissed_at is null;
create index if not exists briefing_events_user_due_idx
  on public.briefing_events (user_id, due_date) where completed_at is null and dismissed_at is null;
create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index if not exists notification_delivery_retry_idx
  on public.notification_delivery_log (delivery_status, created_at) where delivery_status = 'failed';
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
create index if not exists daily_briefings_user_date_idx on public.daily_briefings (user_id, briefing_date desc);

alter table public.user_notification_settings enable row level security;
alter table public.briefing_events enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_delivery_log enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.daily_briefings enable row level security;

create policy "Users manage their notification settings"
  on public.user_notification_settings for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their briefing event metadata"
  on public.briefing_events for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read and update their notifications"
  on public.notifications for select to authenticated
  using (auth.uid() = user_id);
create policy "Users update notification state"
  on public.notifications for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete their notification history"
  on public.notifications for delete to authenticated
  using (auth.uid() = user_id);
create policy "Users read their notification delivery history"
  on public.notification_delivery_log for select to authenticated
  using (auth.uid() = user_id);
create policy "Users manage their push subscriptions"
  on public.push_subscriptions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read their daily briefings"
  on public.daily_briefings for select to authenticated
  using (auth.uid() = user_id);

revoke all on public.user_notification_settings, public.briefing_events, public.notifications,
  public.notification_delivery_log, public.push_subscriptions, public.daily_briefings from anon;
grant select, insert, update, delete on public.user_notification_settings,
  public.briefing_events, public.push_subscriptions to authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at, snoozed_until, completed_at) on public.notifications to authenticated;
grant select on public.notification_delivery_log, public.daily_briefings to authenticated;

create or replace function public.claim_notification_delivery(
  p_user_id uuid,
  p_event_id text,
  p_stage text,
  p_channel text,
  p_notification jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_notification_id uuid;
  v_inserted integer;
begin
  insert into public.notification_delivery_log (
    user_id, event_id, notification_stage, delivery_channel, delivery_status
  ) values (p_user_id, p_event_id, p_stage, p_channel, 'pending')
  on conflict (user_id, event_id, notification_stage, delivery_channel) do update set
    delivery_status = 'pending',
    error_message = null,
    attempt_count = public.notification_delivery_log.attempt_count + 1
  where public.notification_delivery_log.delivery_status = 'failed'
    and public.notification_delivery_log.attempt_count < 5
    and public.notification_delivery_log.created_at < now() - interval '5 minutes'
  returning notification_id into v_notification_id;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    return null;
  end if;

  if v_notification_id is not null then
    return v_notification_id;
  end if;

  insert into public.notifications (
    user_id, title, message, category, priority, related_memory_id,
    related_document_id, related_reminder_id, event_id, notification_stage,
    scheduled_at, sent_at
  ) values (
    p_user_id,
    p_notification ->> 'title',
    p_notification ->> 'message',
    p_notification ->> 'category',
    p_notification ->> 'priority',
    nullif(p_notification ->> 'related_memory_id', ''),
    nullif(p_notification ->> 'related_document_id', ''),
    nullif(p_notification ->> 'related_reminder_id', ''),
    p_event_id,
    p_stage,
    coalesce(nullif(p_notification ->> 'scheduled_at', '')::timestamptz, now()),
    case when p_channel = 'in_app' then now() else null end
  )
  returning id into v_notification_id;
  update public.notification_delivery_log
  set notification_id = v_notification_id
  where user_id = p_user_id and event_id = p_event_id
    and notification_stage = p_stage and delivery_channel = p_channel;

  if p_channel = 'in_app' then
    update public.notification_delivery_log
    set delivery_status = 'delivered', delivered_at = now()
    where user_id = p_user_id and event_id = p_event_id
      and notification_stage = p_stage and delivery_channel = p_channel;
  end if;

  return v_notification_id;
end;
$$;

create or replace function public.finish_notification_delivery(
  p_user_id uuid,
  p_event_id text,
  p_stage text,
  p_channel text,
  p_status text,
  p_error text default null,
  p_notification_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('delivered', 'failed', 'skipped') then
    raise exception 'Unsupported delivery status' using errcode = '22023';
  end if;

  update public.notification_delivery_log
  set delivery_status = p_status,
      error_message = left(p_error, 1000),
      delivered_at = case when p_status = 'delivered' then now() else null end
  where user_id = p_user_id and event_id = p_event_id
    and notification_stage = p_stage and delivery_channel = p_channel;

  if p_notification_id is not null then
    update public.notifications
    set sent_at = case when p_status = 'delivered' then now() else sent_at end
    where id = p_notification_id and user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.claim_notification_delivery(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.finish_notification_delivery(uuid, text, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.finish_notification_delivery(uuid, text, text, text, text, text, uuid) to service_role;

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
    when 'daily_briefing' then true
    when 'basic_reminders' then true
    when 'document_expiration_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'warranty_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'bill_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'subscription_renewal_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'travel_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'custom_briefing_time' then (select plan in ('pro', 'premium') from user_plan)
    when 'notification_push' then (select plan in ('pro', 'premium') from user_plan)
    when 'notification_customization' then (select plan = 'premium' from user_plan)
    when 'weekly_summary' then (select plan = 'premium' from user_plan)
    when 'advanced_briefing_summary' then (select plan = 'premium' from user_plan)
    else false
  end, false)
  where auth.uid() is not null;
$$;
revoke all on function public.user_has_feature(text) from public, anon;
grant execute on function public.user_has_feature(text) to authenticated;

create or replace function public.has_active_feature(p_user_id uuid, p_feature text)
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
    from (select p_user_id as user_id) u
    left join public.subscriptions s on s.user_id = u.user_id
  )
  select coalesce(case p_feature
    when 'daily_briefing' then true
    when 'basic_reminders' then true
    when 'document_expiration_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'warranty_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'bill_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'subscription_renewal_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'travel_notifications' then (select plan in ('pro', 'premium') from user_plan)
    when 'custom_briefing_time' then (select plan in ('pro', 'premium') from user_plan)
    when 'notification_push' then (select plan in ('pro', 'premium') from user_plan)
    when 'notification_customization' then (select plan = 'premium' from user_plan)
    when 'weekly_summary' then (select plan = 'premium' from user_plan)
    when 'advanced_briefing_summary' then (select plan = 'premium' from user_plan)
    else false
  end, false);
$$;
revoke all on function public.has_active_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.has_active_feature(uuid, text) to service_role;
