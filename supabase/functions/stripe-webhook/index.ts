import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";
import {
  createAdminClient,
  createStripe,
  customerId,
  jsonResponse,
  planForPrice,
  stripePeriod
} from "../_shared/billing.ts";

const handledEvents = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed"
]);

function priceIdOf(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price.id || null;
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed." }, 405);
  const signature = request.headers.get("stripe-signature");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!signature || !secret) return jsonResponse(request, { error: "Webhook signature configuration is missing." }, 400);

  let event: Stripe.Event;
  try {
    const stripe = createStripe();
    const payload = await request.text();
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse(request, { error: "Invalid Stripe webhook signature." }, 400);
  }

  if (!handledEvents.has(event.type)) return jsonResponse(request, { received: true, ignored: true });

  try {
    const stripe = createStripe();
    const eventObject = event.data.object;
    let subscription: Stripe.Subscription | null = null;
    let customer: string | null = null;
    let userId: string | null = null;
    let invoiceData: Record<string, string | number | null> | null = null;

    if (event.type === "checkout.session.completed") {
      const session = eventObject as Stripe.Checkout.Session;
      customer = customerId(session.customer);
      userId = session.client_reference_id || session.metadata?.rememberly_user_id || null;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (subscriptionId) subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } else if (event.type.startsWith("customer.subscription.")) {
      const eventSubscription = eventObject as Stripe.Subscription;
      subscription = await stripe.subscriptions.retrieve(eventSubscription.id);
      customer = customerId(subscription.customer);
    } else {
      const invoice = eventObject as Stripe.Invoice;
      customer = customerId(invoice.customer);
      const invoiceSubscription = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
      if (invoiceSubscription) subscription = await stripe.subscriptions.retrieve(invoiceSubscription);
      invoiceData = {
        id: invoice.id,
        amount_total: invoice.amount_paid || invoice.total || 0,
        currency: invoice.currency,
        status: event.type === "invoice.paid" ? "paid" : "payment_failed",
        description: invoice.lines.data[0]?.description || "Rememberly subscription",
        invoice_url: invoice.hosted_invoice_url,
        invoice_pdf: invoice.invoice_pdf,
        paid_at: invoice.status_transitions.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null
      };
    }

    if (subscription) {
      customer = customerId(subscription.customer) || customer;
      userId = subscription.metadata.rememberly_user_id || userId;
    }
    if (!userId && customer) {
      const admin = createAdminClient();
      const { data: mapping, error } = await admin.from("stripe_customers")
        .select("user_id")
        .eq("stripe_customer_id", customer)
        .maybeSingle();
      if (error) throw error;
      userId = mapping?.user_id || null;
    }
    if (!userId) throw new Error(`Could not map Stripe event ${event.id} to a Rememberly user.`);

    const priceId = subscription ? priceIdOf(subscription) : null;
    const plan = planForPrice(priceId);
    if (subscription && !plan) throw new Error(`Stripe subscription ${subscription.id} uses an unrecognized price.`);
    const status = subscription?.status || "incomplete";
    const eventData = {
      stripe_event_id: event.id,
      event_type: event.type,
      created: event.created,
      customer_id: customer,
      subscription_id: subscription?.id || null,
      status,
      plan,
      price_id: priceId
    };
    const normalized = {
      event_id: event.id,
      event_type: event.type,
      user_id: userId,
      customer_id: customer,
      subscription_id: subscription?.id || null,
      price_id: priceId,
      plan,
      status,
      billing_interval: "month",
      current_period_start: subscription ? stripePeriod(subscription.current_period_start) : null,
      current_period_end: subscription ? stripePeriod(subscription.current_period_end) : null,
      cancel_at_period_end: subscription?.cancel_at_period_end || false,
      event_data: eventData,
      invoice: invoiceData
    };
    const admin = createAdminClient();
    const { data: processed, error } = await admin.rpc("process_stripe_event", { p_payload: normalized });
    if (error) throw error;
    return jsonResponse(request, { received: true, processed: processed === true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown webhook processing error.";
    console.error("Stripe webhook processing failed:", message);
    return jsonResponse(request, { error: "Webhook processing failed; Stripe may retry this event." }, 500);
  }
});
