import {
  createAdminClient,
  createStripe,
  assertLiveBillingEnabled,
  customerId,
  errorResponse,
  jsonResponse,
  preflight,
  planForPrice,
  requireUser,
  verifiedPriceForPlan
} from "../_shared/billing.ts";

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(request);
    const body = await request.json();
    const action = body?.action;
    if (!["cancel", "reactivate", "change_plan"].includes(action)) {
      return jsonResponse(request, { error: "Unsupported subscription action." }, 400);
    }

    const admin = createAdminClient();
    const { data: subscription, error: subscriptionError } = await admin
      .from("subscriptions")
      .select("stripe_subscription_id,stripe_customer_id,plan,status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (subscriptionError) throw subscriptionError;
    if (!subscription?.stripe_subscription_id || !subscription.stripe_customer_id) {
      return jsonResponse(request, { error: "No paid subscription is available to manage." }, 404);
    }
    if (!["active", "trialing", "past_due"].includes(subscription.status)) {
      return jsonResponse(request, { error: "This subscription is not in a state that can be changed." }, 409);
    }

    const stripe = createStripe();
    const providerSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
    if (customerId(providerSubscription.customer) !== subscription.stripe_customer_id
      || providerSubscription.metadata.rememberly_user_id !== user.id) {
      return jsonResponse(request, { error: "The Stripe subscription could not be verified for this account." }, 403);
    }

    let updated;
    if (action === "cancel") {
      if (providerSubscription.status === "canceled") {
        return jsonResponse(request, { error: "This subscription has already ended." }, 409);
      }
      updated = await stripe.subscriptions.update(providerSubscription.id, { cancel_at_period_end: true });
    } else if (action === "reactivate") {
      if (providerSubscription.status === "canceled") {
        return jsonResponse(request, { error: "This subscription has ended and cannot be reactivated. Start a new checkout instead." }, 409);
      }
      assertLiveBillingEnabled();
      updated = await stripe.subscriptions.update(providerSubscription.id, { cancel_at_period_end: false });
    } else {
      assertLiveBillingEnabled();
      const targetPlan = body?.plan;
      if (providerSubscription.status !== "active" && providerSubscription.status !== "trialing") {
        return jsonResponse(request, { error: "Plan changes are unavailable while payment is pending. Update your payment method first." }, 409);
      }
      const currentPrice = providerSubscription.items.data[0]?.price.id;
      const currentPlan = planForPrice(currentPrice);
      if (!currentPlan || (targetPlan !== "pro" && targetPlan !== "premium") || currentPlan === targetPlan) {
        return jsonResponse(request, { error: "This plan change is not available for the current subscription." }, 400);
      }
      const targetPrice = await verifiedPriceForPlan(stripe, targetPlan);
      const item = providerSubscription.items.data[0];
      if (!item) throw new Error("Stripe did not return a subscription item to update.");
      updated = await stripe.subscriptions.update(providerSubscription.id, {
        items: [{ id: item.id, price: targetPrice }],
        proration_behavior: "create_prorations",
        metadata: { rememberly_user_id: user.id, rememberly_plan: targetPlan }
      });
    }

    return jsonResponse(request, {
      request_status: "submitted_to_stripe",
      stripe_status: updated.status,
      cancel_at_period_end: updated.cancel_at_period_end,
      message: "Stripe accepted the request. The app will reflect the change after the verified webhook updates Supabase."
    });
  } catch (error) {
    return errorResponse(request, error);
  }
});
