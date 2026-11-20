import {
  errorResponse,
  jsonResponse,
  preflight,
  requireUser,
  stripeMode,
  verifiedPriceForPlan
} from "../_shared/billing.ts";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

Deno.serve(async (request: Request) => {
  const options = preflight(request);
  if (options) return options;
  if (request.method !== "POST") return jsonResponse(request, { error: "Method not allowed." }, 405);

  try {
    await requireUser(request);
    const required = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_PRO_MONTHLY",
      "STRIPE_PRICE_PREMIUM_MONTHLY",
      "APP_URL"
    ];
    const missing = required.filter((name) => !Deno.env.get(name));
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const mode = stripeMode(secretKey);
    if (mode === "live" && Deno.env.get("ENABLE_LIVE_BILLING") !== "true") {
      missing.push("ENABLE_LIVE_BILLING=true (live charges disabled by default)");
    }

    if (!missing.length) {
      const stripe = new Stripe(secretKey, {
        apiVersion: "2024-06-20",
        httpClient: Stripe.createFetchHttpClient()
      });
      for (const [plan, secretName] of [["pro", "STRIPE_PRICE_PRO_MONTHLY"], ["premium", "STRIPE_PRICE_PREMIUM_MONTHLY"]] as const) {
        try {
          await verifiedPriceForPlan(stripe, plan);
        } catch {
          missing.push(`${secretName} (must be active USD monthly price at the configured plan amount)`);
        }
      }
    }

    return jsonResponse(request, { billing_ready: missing.length === 0, mode, missing_configuration: missing });
  } catch (error) {
    return errorResponse(request, error);
  }
});
