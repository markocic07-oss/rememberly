import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.49.1?target=deno";
import Stripe from "https://esm.sh/stripe@17.7.0?target=deno";

const localOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

export function getAllowedOrigins(): Set<string> {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const appUrl = Deno.env.get("APP_URL");
  if (appUrl) configured.push(new URL(appUrl).origin);
  if (Deno.env.get("ENVIRONMENT") !== "production") {
    configured.push(...localOrigins);
  }
  return new Set(configured);
}

export function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") || "";
  const allowed = getAllowedOrigins();
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, stripe-signature",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

export function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" }
  });
}

export function preflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(request) });
}

export function validateReturnUrl(request: Request, value: unknown): string {
  if (typeof value !== "string") throw new Error("A valid return URL is required.");
  const url = new URL(value);
  const origin = request.headers.get("origin") || "";
  const allowedOrigins = getAllowedOrigins();
  if (url.protocol !== "https:" && !url.origin.startsWith("http://localhost") && !url.origin.startsWith("http://127.0.0.1")) {
    throw new Error("Return URLs must use HTTPS.");
  }
  if (!allowedOrigins.has(url.origin) || (origin && url.origin !== origin)) {
    throw new Error("The requested return URL is not allowed.");
  }
  return url.toString();
}

export function createAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) throw new Error("Supabase service configuration is missing.");
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError("Sign in is required.", 401);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new HttpError("Supabase authentication configuration is missing.", 503);
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new HttpError("The Supabase session is invalid or expired.", 401);
  return data.user;
}

export function createStripe(): Stripe {
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secretKey) throw new Error("Stripe is not configured. Paid billing is unavailable.");
  return new Stripe(secretKey, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient()
  });
}

export function assertLiveBillingEnabled(): void {
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const isLiveKey = secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_");
  if (isLiveKey && Deno.env.get("ENABLE_LIVE_BILLING") !== "true") {
    throw new HttpError("Live billing is disabled until the operator explicitly enables it.", 503);
  }
}

export function stripeMode(secretKey: string): "live" | "test" | "unconfigured" {
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  return "unconfigured";
}

export function priceForPlan(plan: unknown): string {
  if (plan === "pro") {
    const price = Deno.env.get("STRIPE_PRICE_PRO_MONTHLY");
    if (price) return price;
  } else if (plan === "premium") {
    const price = Deno.env.get("STRIPE_PRICE_PREMIUM_MONTHLY");
    if (price) return price;
  } else {
    throw new Error("Choose a supported paid plan.");
  }
  throw new Error(`Stripe price configuration is missing for the ${plan} plan.`);
}

export async function verifiedPriceForPlan(stripe: Stripe, plan: unknown): Promise<string> {
  const priceId = priceForPlan(plan);
  const price = await stripe.prices.retrieve(priceId);
  const expectedAmount = plan === "pro" ? 500 : 999;
  if (!price.active
    || price.currency !== "usd"
    || price.unit_amount !== expectedAmount
    || price.recurring?.interval !== "month") {
    throw new Error(`The configured ${plan} Stripe price must be active and exactly $${(expectedAmount / 100).toFixed(2)} USD per month.`);
  }
  return price.id;
}

export function planForPrice(priceId: string | null | undefined): "pro" | "premium" | null {
  if (priceId && priceId === Deno.env.get("STRIPE_PRICE_PRO_MONTHLY")) return "pro";
  if (priceId && priceId === Deno.env.get("STRIPE_PRICE_PREMIUM_MONTHLY")) return "premium";
  return null;
}

export function customerId(value: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (typeof value === "string") return value;
  return value?.id || null;
}

export function stripePeriod(value: number | null | undefined): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

export function appOrigin(): string {
  const appUrl = Deno.env.get("APP_URL");
  if (!appUrl) throw new Error("APP_URL must be configured for billing redirects.");
  return new URL(appUrl).origin;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function errorResponse(request: Request, error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : "The billing request could not be completed.";
  console.error("Rememberly billing request failed:", message);
  return jsonResponse(request, { error: message }, status);
}
