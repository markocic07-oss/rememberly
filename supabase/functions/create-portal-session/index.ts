import {
  createAdminClient,
  createStripe,
  appOrigin,
  errorResponse,
  jsonResponse,
  preflight,
  requireUser,
  validateReturnUrl
} from "../_shared/billing.ts";

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(request);
    const returnUrl = validateReturnUrl(request, `${appOrigin()}/?billing=return`);
    const admin = createAdminClient();
    const { data: customer, error: customerError } = await admin
      .from("stripe_customers")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer?.stripe_customer_id) throw new Error("No Stripe customer is associated with this account.");

    const session = await createStripe().billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: returnUrl
    });
    return jsonResponse(request, { url: session.url });
  } catch (error) {
    return errorResponse(request, error);
  }
});
