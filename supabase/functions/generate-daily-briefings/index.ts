import webpush from "npm:web-push@3.6.7";
import { createAdminClient } from "../_shared/billing.ts";

type Settings = {
  user_id: string;
  daily_briefing_enabled: boolean;
  briefing_time: string;
  timezone: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  notification_categories: Record<string, boolean>;
  notification_frequency: string;
  push_enabled: boolean;
};

type BriefingEvent = {
  id: string;
  source_id: string;
  source_type: string;
  category: string;
  title: string;
  due_date: string;
  importance: number;
  related_memory_id: string | null;
  related_document_id: string | null;
  completed_at: string | null;
  dismissed_at: string | null;
  created_at: string;
};

const stages = new Map<number, string>([[30, "30_days"], [14, "14_days"], [7, "7_days"], [3, "3_days"], [1, "1_day"], [0, "due_today"]]);
const requiredFeature: Record<string, string> = {
  document_expiration: "document_expiration_notifications",
  warranty: "warranty_notifications",
  bill: "bill_notifications",
  subscription_renewal: "subscription_renewal_notifications",
  travel: "travel_notifications",
  reminder: "basic_reminders",
  appointment: "document_expiration_notifications"
};
const safeCategoryMessage: Record<string, string> = {
  document_expiration: "An important document deadline is approaching.",
  warranty: "A saved warranty deadline is approaching.",
  bill: "A payment due date is approaching.",
  subscription_renewal: "A saved renewal date is approaching.",
  travel: "A saved travel date is approaching.",
  reminder: "You have an important task coming up.",
  appointment: "You have an appointment coming up."
};

function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function clockMinutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isQuietHour(now: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function daysBetween(from: string, to: string): number {
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  return Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
}

function priority(days: number, importance: number): "low" | "medium" | "high" | "urgent" {
  if (days === 0 || (importance >= 3 && days === 1)) return "urgent";
  if (days <= 3) return "high";
  if (days <= 14) return "medium";
  return "low";
}

function stageFor(days: number, importance: number): string | null {
  if (days < 0) return null;
  if (days === 30 && importance >= 3) return stages.get(30) || null;
  return stages.get(days) || null;
}

async function hasFeature(admin: ReturnType<typeof createAdminClient>, userId: string, feature: string): Promise<boolean> {
  const { data, error } = await admin.rpc("has_active_feature", { p_user_id: userId, p_feature: feature });
  if (error) throw error;
  return data === true;
}

function validSettingsTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function claimDelivery(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  eventId: string,
  stage: string,
  channel: "in_app" | "web_push",
  notification: Record<string, unknown>
) {
  const { data, error } = await admin.rpc("claim_notification_delivery", {
    p_user_id: userId,
    p_event_id: eventId,
    p_stage: stage,
    p_channel: channel,
    p_notification: notification
  });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

async function finishDelivery(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  eventId: string,
  stage: string,
  channel: "in_app" | "web_push",
  status: "delivered" | "failed" | "skipped",
  error?: string | null,
  notificationId?: string | null
) {
  const { error: finishError } = await admin.rpc("finish_notification_delivery", {
    p_user_id: userId,
    p_event_id: eventId,
    p_stage: stage,
    p_channel: channel,
    p_status: status,
    p_error: error || null,
    p_notification_id: notificationId || null
  });
  if (finishError) throw finishError;
}

async function pushBriefing(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  briefingDate: string,
  summary: string,
  eventCount: number
): Promise<"push_delivered" | "push_failed" | "no_push_subscription"> {
  const { data: subscriptions, error } = await admin.from("push_subscriptions")
    .select("id,endpoint,subscription_data")
    .eq("user_id", userId);
  if (error) throw error;
  if (!subscriptions?.length) return "no_push_subscription";

  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!vapidPublic || !vapidPrivate || !vapidSubject) {
    console.error("Web Push is enabled for a user but VAPID secrets are not configured.");
    return "push_failed";
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const deliveryId = `briefing:${briefingDate}`;
  const notificationId = await claimDelivery(admin, userId, deliveryId, "daily", "web_push", {
    title: "Good morning!",
    message: summary,
    category: "daily_briefing",
    priority: eventCount > 0 ? "medium" : "low",
    scheduled_at: new Date().toISOString()
  });
  if (!notificationId) {
    const { data: previousDelivery, error } = await admin.from("notification_delivery_log")
      .select("delivery_status")
      .eq("user_id", userId)
      .eq("event_id", deliveryId)
      .eq("notification_stage", "daily")
      .eq("delivery_channel", "web_push")
      .maybeSingle();
    if (error) throw error;
    return previousDelivery?.delivery_status === "delivered" ? "push_delivered" : "push_failed";
  }

  const payload = JSON.stringify({
    title: "Good morning!",
    body: summary,
    url: "/?briefing=1",
    tag: `rememberly-briefing-${briefingDate}`
  });
  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription.subscription_data, payload, { TTL: 60 * 60 });
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode: unknown }).statusCode)
        : 0;
      if (statusCode === 404 || statusCode === 410) {
        const { error: deleteError } = await admin.from("push_subscriptions").delete().eq("id", subscription.id);
        if (deleteError) throw deleteError;
      }
      throw error;
    }
  }));
  const delivered = results.some((result) => result.status === "fulfilled");
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const errorMessage = failures.length ? failures.map((failure) => String(failure.reason)).join("; ").slice(0, 1000) : null;
  await finishDelivery(admin, userId, deliveryId, "daily", "web_push", delivered ? "delivered" : "failed", errorMessage, notificationId);
  return delivered ? "push_delivered" : "push_failed";
}

async function handleUser(admin: ReturnType<typeof createAdminClient>, settings: Settings, now: Date) {
  if (!settings.daily_briefing_enabled) return { user_id: settings.user_id, status: "disabled" };
  const timezone = validSettingsTimezone(settings.timezone) ? settings.timezone : "UTC";
  const parts = localParts(now, timezone);
  const localNow = Number(parts.hour) * 60 + Number(parts.minute);
  const weekly = settings.notification_frequency === "weekly_summary";
  const briefingEnabled = await hasFeature(admin, settings.user_id, "daily_briefing");
  const customTimeAllowed = await hasFeature(admin, settings.user_id, "custom_briefing_time");
  const quietStart = customTimeAllowed ? settings.quiet_hours_start : "22:00";
  const quietEnd = customTimeAllowed ? settings.quiet_hours_end : "07:00";
  const quiet = isQuietHour(localNow, clockMinutes(quietStart), clockMinutes(quietEnd));
  const effectiveTime = customTimeAllowed ? clockMinutes(settings.briefing_time) : 8 * 60;
  const isBriefingTime = localNow >= effectiveTime && (!weekly || parts.weekday === "Sun");
  if (!briefingEnabled || !isBriefingTime) return { user_id: settings.user_id, status: "not_due" };
  if (weekly && !(await hasFeature(admin, settings.user_id, "weekly_summary"))) {
    return { user_id: settings.user_id, status: "weekly_summary_requires_premium" };
  }

  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const endDate = new Date(`${localDate}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 30);
  const { data: sourceEvents, error: eventsError } = await admin.from("briefing_events")
    .select("id,source_id,source_type,category,title,due_date,importance,related_memory_id,related_document_id,completed_at,dismissed_at,created_at")
    .eq("user_id", settings.user_id)
    .gte("due_date", localDate)
    .lte("due_date", endDate.toISOString().slice(0, 10))
    .is("completed_at", null)
    .is("dismissed_at", null);
  if (eventsError) throw eventsError;

  const canCustomizeNotifications = await hasFeature(admin, settings.user_id, "notification_customization");
  const categoryPreferences = canCustomizeNotifications
    ? settings.notification_categories || {}
    : {};
  const canChooseFrequency = canCustomizeNotifications;
  const effectiveFrequency = canChooseFrequency ? settings.notification_frequency : "daily_briefing";
  const eligible: Array<{ event: BriefingEvent; days: number; stage: string }> = [];
  for (const event of (sourceEvents || []) as BriefingEvent[]) {
    const feature = requiredFeature[event.category];
    if (!feature || categoryPreferences[event.category] === false || !(await hasFeature(admin, settings.user_id, feature))) continue;
    const days = daysBetween(localDate, event.due_date);
    const stage = stageFor(days, event.importance);
    if (!stage) continue;
    if (effectiveFrequency === "important_only" && days > 3) continue;
    if (effectiveFrequency === "critical_only" && days > 1) continue;
    eligible.push({ event, days, stage });
  }

  const dailyEvents = eligible.filter(({ days }) => days <= 7).sort((a, b) => a.days - b.days || b.event.importance - a.event.importance);
  const stageEvents = eligible.filter(({ stage }) => stage !== "30_days" || dailyEvents.length === 0);
  for (const { event, days, stage } of stageEvents) {
    const notificationId = await claimDelivery(admin, settings.user_id, event.source_id, stage, "in_app", {
      title: safeCategoryMessage[event.category] || "An important date is approaching.",
      message: `${event.title} · ${days === 0 ? "Due today" : `in ${days} days`}.`,
      category: event.category,
      priority: priority(days, event.importance),
      related_memory_id: event.related_memory_id,
      related_document_id: event.related_document_id,
      related_reminder_id: event.source_type === "reminder" ? event.source_id.replace(/^reminder:/, "").split(":")[0] : null,
      scheduled_at: now.toISOString()
    });
    if (notificationId) console.info("Created in-app notification for event stage", event.source_id, stage);
  }

  if (!dailyEvents.length) return { user_id: settings.user_id, status: "no_relevant_items" };
  if (quiet) return { user_id: settings.user_id, status: "quiet_hours_in_app_only", event_count: dailyEvents.length };

  const summary = `Good morning! You have ${dailyEvents.length} important thing${dailyEvents.length === 1 ? "" : "s"} to take care of today.`;
  const includedEvents = dailyEvents.map(({ event, days }) => ({
    source_id: event.source_id,
    category: event.category,
    title: event.title,
    due_date: event.due_date,
    days_remaining: days
  }));
  const { data: existingBriefing, error: existingBriefingError } = await admin.from("daily_briefings")
    .select("id,delivery_status")
    .eq("user_id", settings.user_id)
    .eq("briefing_date", localDate)
    .maybeSingle();
  if (existingBriefingError) throw existingBriefingError;
  if (existingBriefing?.delivery_status === "push_delivered") {
    return { user_id: settings.user_id, status: "already_briefed" };
  }
  let briefingId = existingBriefing?.id;
  if (!briefingId) {
    const { data: briefing, error: briefingError } = await admin.from("daily_briefings").upsert({
      user_id: settings.user_id,
      briefing_date: localDate,
      summary,
      included_events: includedEvents,
      delivery_status: "in_app"
    }, { onConflict: "user_id,briefing_date", ignoreDuplicates: true }).select("id").maybeSingle();
    if (briefingError) throw briefingError;
    if (!briefing) return { user_id: settings.user_id, status: "already_briefed" };
    briefingId = briefing.id;
  }

  const inAppId = await claimDelivery(admin, settings.user_id, `briefing:${localDate}`, "daily", "in_app", {
    title: "Good morning!",
    message: summary,
    category: "daily_briefing",
    priority: "medium",
    scheduled_at: now.toISOString()
  });
  const canPush = settings.push_enabled && await hasFeature(admin, settings.user_id, "notification_push");
  if (!canPush) {
    const { error: updateError } = await admin.from("daily_briefings")
      .update({ delivery_status: "in_app" })
      .eq("id", briefingId);
    if (updateError) throw updateError;
    return { user_id: settings.user_id, status: "in_app", event_count: dailyEvents.length };
  }

  const pushSummary = dailyEvents.length > 3
    ? `Good morning! ${dailyEvents.slice(0, 3).map(({ event }) => safeCategoryMessage[event.category]).join(" ")} You have ${dailyEvents.length - 3} more important updates.`
    : summary;
  const deliveryStatus = await pushBriefing(admin, settings.user_id, localDate, pushSummary, dailyEvents.length);
  const { error: updateError } = await admin.from("daily_briefings")
    .update({ delivery_status: deliveryStatus })
    .eq("id", briefingId);
  if (updateError) throw updateError;
  return { user_id: settings.user_id, status: deliveryStatus, event_count: dailyEvents.length, in_app_notification_id: inAppId };
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const expectedSecret = Deno.env.get("BRIEFING_SCHEDULER_SECRET");
  if (!expectedSecret || request.headers.get("x-briefing-scheduler-secret") !== expectedSecret) {
    return Response.json({ error: "Unauthorized scheduler request." }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const results = [];
    const pageSize = 100;
    const batchSize = 10;
    const now = new Date();
    let afterUserId: string | null = null;
    for (;;) {
      let userQuery = admin.from("user_notification_settings")
        .select("user_id,daily_briefing_enabled,briefing_time,timezone,quiet_hours_start,quiet_hours_end,notification_categories,notification_frequency,push_enabled")
        .eq("daily_briefing_enabled", true);
      if (afterUserId) userQuery = userQuery.gt("user_id", afterUserId);
      const { data: users, error } = await userQuery.order("user_id", { ascending: true }).range(0, pageSize - 1);
      if (error) {
        console.error("Could not load briefing schedules:", error.message);
        return Response.json({ error: "Could not load scheduled users." }, { status: 500 });
      }
      const page = (users || []) as Settings[];
      for (let start = 0; start < page.length; start += batchSize) {
        const batch = page.slice(start, start + batchSize);
        const outcomes = await Promise.all(batch.map(async (settings) => {
          try {
            return await handleUser(admin, settings, now);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown scheduled briefing error.";
            console.error("Daily briefing failed for user", settings.user_id, message);
            return { user_id: settings.user_id, status: "failed" };
          }
        }));
        results.push(...outcomes);
      }
      afterUserId = page[page.length - 1]?.user_id || afterUserId;
      if (page.length < pageSize) break;
    }
    return Response.json({ processed: results.length, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown scheduler error.";
    console.error("Could not initialize daily briefing scheduler:", message);
    return Response.json({ error: "Could not initialize the scheduler." }, { status: 500 });
  }
});
