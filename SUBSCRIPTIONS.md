# Rememberly subscriptions setup

The app stays in an explicitly labeled Free development preview until Supabase and Stripe are configured. The browser only receives the Supabase project URL and publishable/anon key; Stripe secrets belong in Supabase Edge Function secrets and must never be added to `config.js`.

## 1. Configure Supabase

1. Create a Supabase project and enable email/password authentication. To allow users to register without verifying their email, open **Authentication → Providers → Email** in the Supabase Dashboard and turn off **Confirm email**. This is a project-level Supabase setting; the app cannot disable it itself. With confirmation disabled, Supabase returns an authenticated session immediately after signup. This reduces protection against mistyped or unverified email addresses.
2. Apply the migrations in `supabase/migrations/` with the Supabase CLI or SQL editor, including `20261120000000_subscription_billing.sql`, `20261120120000_daily_briefing.sql`, `20261121100000_memories.sql`, and `20261121130000_receipts.sql`.
3. Set `supabaseUrl` and the project's publishable/anon key in `config.js`.
4. Serve the app from an HTTP(S) origin. Add the deployed site origin to the Supabase Auth URL allow-list.
5. In Supabase Edge Function secrets, set:

   - `STRIPE_SECRET_KEY` — Stripe server-side secret API key (never the publishable key).
   - `STRIPE_WEBHOOK_SECRET` — signing secret for the deployed webhook endpoint.
   - `STRIPE_PRICE_PRO_MONTHLY` — Stripe recurring USD price ID for $5.00/month.
   - `STRIPE_PRICE_PREMIUM_MONTHLY` — Stripe recurring USD price ID for $9.99/month.
   - `APP_URL` — the exact public app origin, for example `https://rememberly.example`.
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` — Web Push keys/contact. Only the public key belongs in `config.js` as `vapidPublicKey`.
   - `BRIEFING_SCHEDULER_SECRET` — a long random secret used by the scheduled Edge Function caller.
   - `ENABLE_LIVE_BILLING=true` — required only when using live Stripe keys; omit this to keep live charges disabled.
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` — Supabase project values. Supabase supplies these automatically in hosted Edge Functions; set them explicitly only for local development if needed.

6. For production, also set `ENVIRONMENT=production` so local development origins are not added to the Edge Function CORS allow-list.
7. Deploy `billing-status`, `create-checkout-session`, `create-portal-session`, `subscription-action`, and `stripe-webhook` from `supabase/functions`.
8. In Stripe, create the two monthly recurring USD prices above, configure the Customer Portal for payment-method updates and cancellation, and register the deployed `stripe-webhook` endpoint.
9. Subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
10. Run a test-mode checkout and verify that the plan changes only after the signed webhook updates the Supabase row. Do not set `ENABLE_LIVE_BILLING=true` until memories/documents have been migrated to authenticated server-backed storage and all paid features shown in pricing are actually implemented and metered.

Typical deployment commands (run from this folder after `supabase login` and `supabase link`):

```sh
supabase db push
supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... \
  STRIPE_PRICE_PRO_MONTHLY=... STRIPE_PRICE_PREMIUM_MONTHLY=... \
  APP_URL=https://rememberly.example ENVIRONMENT=production
supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:admin@rememberly.example BRIEFING_SCHEDULER_SECRET=...
supabase functions deploy create-checkout-session
supabase functions deploy create-portal-session
supabase functions deploy subscription-action
supabase functions deploy stripe-webhook
supabase functions deploy billing-status
supabase functions deploy generate-daily-briefings
```

### Receipts and subscription records

Apply `supabase/migrations/20261121130000_receipts.sql` before deploying the matching app update. It creates the owner-protected `public.receipts` table and the private `receipt-files` Storage bucket with per-user object policies. Receipt metadata and subscription amounts are saved in the table; attached receipt files are uploaded to Storage. On first sign-in after the update, locally cached receipts are migrated to Supabase. Other document categories remain browser-local.

Generate a VAPID key pair with a trusted Web Push tooling installation, and use a unique random scheduler secret. Do not commit either private value. Put the matching public VAPID key in `config.js` as `vapidPublicKey` (the public key is safe to expose).

### Daily briefing scheduling

The scheduler runs every five minutes and is idempotent per user/local date and event stage. Configure a Supabase Cron job to POST to the `generate-daily-briefings` Edge Function URL with the `x-briefing-scheduler-secret` header set to `BRIEFING_SCHEDULER_SECRET`. Keep that secret in Supabase Vault; never put it in `config.js` or browser code. For example, after saving `BRIEFING_SCHEDULER_SECRET` as a Vault secret named `briefing_scheduler_secret` and enabling `pg_cron` and `pg_net`:

```sql
select cron.schedule(
  'rememberly-daily-briefings',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/generate-daily-briefings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-briefing-scheduler-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'briefing_scheduler_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
```

In addition, copy the matching `VAPID_PUBLIC_KEY` value into `config.js`. If the browser push permission is denied, the user can still see in-app notifications the next time they open the app. No push is reported as delivered unless the Web Push provider confirms delivery acceptance. Email delivery is not implemented; email consent is stored, but no email is sent.

The scheduler reads title, category, and date metadata from `briefing_events`. The current app syncs this limited metadata from locally saved documents/reminders to the signed-in user's own Supabase rows when Supabase is configured. Document contents and uploaded files remain in local browser storage; this metadata sync is not a document backup. Users must open the app for existing local dates to sync the first time. The scheduler retries failed push deliveries with an idempotent five-attempt limit; a briefing is only marked push-delivered after the Web Push provider accepts at least one recipient.

## 2. Important current application boundary

Authentication switches to Supabase Auth when `config.js` contains project credentials. Memories are stored in the user's `public.memories` rows and loaded from Supabase after sign-in. Existing local memories are uploaded when the account first syncs; the browser keeps a local cache and retries pending memory writes on a later sync. Row-level security restricts memory reads and writes to the authenticated owner. Receipts and subscription metadata are stored in `public.receipts`; attached receipt files are stored in the private `receipt-files` Supabase Storage bucket. Existing local receipts are uploaded on sign-in, while other document categories and their files remain in browser `localStorage`.

Subscription tables, webhook synchronization, and server-side `has_feature` / `validate_usage_limit` database functions are also provided. Memory caps and gated screens in the browser are still user-experience checks, not tamper-proof enforcement; document storage and usage checks are not yet fully server-backed. Do not treat the current subscription limits as production-secure until all relevant writes and usage accounting are enforced by authenticated server-side operations.

The existing app also does not yet connect external AI/OCR services or implement all Premium modules (subscription tracking, travel organization, inventory, and advanced analytics). Their plan definitions/access flags are present, but those services must be completed before selling plans that promise them.

## 3. Development preview

With empty Supabase settings, the app continues to use its existing local demo authentication and displays Free-plan previews. Checkout, subscription cancellation, and paid-plan activation are unavailable; preview actions never mark a user as paid.
