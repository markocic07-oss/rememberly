import {
  createAdminClient,
  createStripe,
  assertLiveBillingEnabled,
  errorResponse,
  jsonResponse,
  preflight,
  requireUser,
  validateReturnUrl,
  verifiedPriceForPlan
} from "../_shared/billing.ts";

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(request);
    const body = await request.json();
    const plan = body?.plan;
    if (plan !== "pro" && plan !== "premium") {
      return jsonResponse(request, { error: "Choose Pro or Premium." }, 400);
    }
    const successUrl = validateReturnUrl(request, body?.success_url);
    const cancelUrl = validateReturnUrl(request, body?.cancel_url);
    const admin = createAdminClient();
    const { data: current, error: subscriptionError } = await admin
      .from("subscriptions")
      .select("plan,status,current_period_end")
      .eq("user_id", user.id)
      .maybeSingle();
    if (subscriptionError) throw subscriptionError;
    if (current && ["active", "trialing", "past_due"].includes(current.status)) {
      return jsonResponse(request, { error: "An active subscription already exists. Use My Subscription to change or manage it." }, 409);
    }
    if (current?.status === "incomplete") {
      return jsonResponse(request, { error: "A Stripe payment is still pending. Continue billing setup before starting another checkout." }, 409);
    }

    const stripe = createStripe();
    assertLiveBillingEnabled();
    const priceId = await verifiedPriceForPlan(stripe, plan);
    const { data: customerMapping, error: mappingError } = await admin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (mappingError) throw mappingError;

    let customer = customerMapping?.stripe_customer_id;
    if (!customer) {
      const created = await stripe.customers.create({
        email: user.email,
        name: typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : undefined,
        metadata: { rememberly_user_id: user.id }
      }, { idempotencyKey: `rememberly-customer-${user.id}` });
      customer = created.id;
      const { error: saveCustomerError } = await admin
        .from("stripe_customers")
        .upsert({ user_id: user.id, stripe_customer_id: customer }, { onConflict: "user_id" });
      if (saveCustomerError) {
        const { data: existingMapping, error: retryError } = await admin
          .from("stripe_customers")
          .select("stripe_customer_id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (retryError || !existingMapping) throw saveCustomerError;
        customer = existingMapping.stripe_customer_id;
      }
    }

    const minuteBucket = Math.floor(Date.now() / 60_000);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      metadata: { rememberly_user_id: user.id, rememberly_plan: plan },
      subscription_data: { metadata: { rememberly_user_id: user.id, rememberly_plan: plan } },
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true
    }, { idempotencyKey: `rememberly-checkout-${user.id}-${plan}-${minuteBucket}` });

    if (!session.url) throw new Error("Stripe did not return a checkout URL.");
    return jsonResponse(request, { url: session.url });
  } catch (error) {
    return errorResponse(request, error);
  }
});
