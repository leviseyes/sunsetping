const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TOLERANCE_SECONDS = 300;
const PLACEHOLDER_LOCATION = "Add a location";
const DOWNGRADE_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);
const ACTIVE_STATUSES = new Set(["active", "trialing"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function stripeId(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function parseStripeSignature(header) {
  let timestamp = "";
  const signatures = [];
  for (const part of String(header || "").split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyStripeSignature(payload, header, secret, nowSeconds = Date.now() / 1000) {
  if (!secret) return { ok: false, status: 500, reason: "unconfigured" };
  const { timestamp, signatures } = parseStripeSignature(header);
  const ts = Number(timestamp);
  if (!timestamp || !signatures.length || !Number.isFinite(ts)) return { ok: false, status: 400, reason: "header" };
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, status: 400, reason: "tolerance" };
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  const match = signatures.some((sig) => timingSafeEqual(sig, expected));
  return match ? { ok: true } : { ok: false, status: 400, reason: "mismatch" };
}

function newToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function sessionEmail(session) {
  const raw = session?.customer_details?.email || session?.customer_email || "";
  const email = String(raw).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return "";
  return email;
}

async function remember(db, event) {
  await db.prepare("INSERT INTO stripe_events (id, type) VALUES (?1, ?2)").bind(event.id, event.type).run();
}

async function grantPro(db, row, customer, subscription) {
  await db.prepare(
    "UPDATE subscribers SET plan='pro', stripe_customer_id=?1, stripe_subscription_id=?2 WHERE id=?3"
  ).bind(customer, subscription, row.id).run();
  row.plan = "pro";
  row.stripe_customer_id = customer;
  row.stripe_subscription_id = subscription;
}

async function findByStripe(db, customer, subscription) {
  if (!customer && !subscription) return null;
  return db.prepare(
    `SELECT id, email, plan, status, stripe_customer_id, stripe_subscription_id
     FROM subscribers WHERE stripe_customer_id = ?1 OR stripe_subscription_id = ?2`
  ).bind(customer, subscription).first();
}

async function onCheckoutCompleted(db, event) {
  const session = event.data?.object || {};
  if (session.payment_status === "unpaid") {
    console.log(JSON.stringify({ event: "stripe_checkout_skipped", id: event.id, reason: "unpaid" }));
    return { ignored: "unpaid" };
  }
  const email = sessionEmail(session);
  if (!email) {
    console.log(JSON.stringify({ event: "stripe_checkout_skipped", id: event.id, reason: "email" }));
    return { ignored: "email" };
  }
  const customer = stripeId(session.customer);
  const subscription = stripeId(session.subscription);
  const row = await db.prepare(
    "SELECT id, email, plan, status, stripe_customer_id, stripe_subscription_id FROM subscribers WHERE email = ?1"
  ).bind(email).first();
  if (row) {
    await grantPro(db, row, customer || row.stripe_customer_id || null, subscription || row.stripe_subscription_id || null);
    return { plan: "pro", email, created: false };
  }
  const token = newToken();
  await db.prepare(
    `INSERT INTO subscribers (email, location, lat, lon, tz, unsubscribe_token, status, plan, stripe_customer_id, stripe_subscription_id)
     VALUES (?1, ?2, NULL, NULL, NULL, ?3, 'active', 'pro', ?4, ?5)`
  ).bind(email, PLACEHOLDER_LOCATION, token, customer, subscription).run();
  return { plan: "pro", email, created: true };
}

async function onSubscription(db, event) {
  const sub = event.data?.object || {};
  const customer = stripeId(sub.customer);
  const subscription = stripeId(sub.id);
  const row = await findByStripe(db, customer, subscription);
  if (!row) {
    console.log(JSON.stringify({ event: "stripe_subscription_unmatched", id: event.id, type: event.type, customer, subscription }));
    return { unmatched: true };
  }
  const deleted = event.type === "customer.subscription.deleted";
  const status = String(sub.status || "");
  if (deleted || DOWNGRADE_STATUSES.has(status)) {
    await db.prepare(
      "UPDATE subscribers SET plan='free' WHERE stripe_customer_id = ?1 OR stripe_subscription_id = ?2"
    ).bind(customer, subscription).run();
    return { plan: "free", email: row.email };
  }
  if (ACTIVE_STATUSES.has(status)) {
    await grantPro(db, row, customer || row.stripe_customer_id || null, subscription || row.stripe_subscription_id || null);
    return { plan: "pro", email: row.email };
  }
  return { ignored: status || "status" };
}

function onPaymentFailed(event) {
  const invoice = event.data?.object || {};
  console.log(JSON.stringify({
    event: "invoice_payment_failed",
    id: event.id,
    customer: stripeId(invoice.customer),
    subscription: stripeId(invoice.subscription),
    email: invoice.customer_email || null,
  }));
  return { logged: true };
}

export async function applyStripeEvent(db, event) {
  const seen = await db.prepare("SELECT id FROM stripe_events WHERE id = ?1").bind(event.id).first();
  if (seen) return { duplicate: true };
  let outcome = { ignored: true };
  if (event.type === "checkout.session.completed") outcome = await onCheckoutCompleted(db, event);
  else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") outcome = await onSubscription(db, event);
  else if (event.type === "invoice.payment_failed") outcome = onPaymentFailed(event);
  await remember(db, event);
  return outcome;
}

export async function stripeWebhook(req, env) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const payload = await req.text();
  const verified = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) {
    const message = verified.status === 500 ? "Webhook is not configured" : "Invalid signature";
    return json({ error: message }, verified.status);
  }
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.id) {
    return json({ error: "Invalid payload" }, 400);
  }
  try {
    const result = await applyStripeEvent(env.DB, event);
    return json({ received: true, ...result });
  } catch (err) {
    console.log(JSON.stringify({ event: "stripe_webhook_error", id: event.id, type: event.type, message: String(err?.message || err) }));
    return json({ error: "Webhook handler failed" }, 500);
  }
}

export function appendPrefilledEmail(url, email) {
  const normalized = checkoutCustomerEmail(email);
  if (!normalized) return url;
  const next = new URL(url);
  next.searchParams.set("prefilled_email", normalized);
  return next.toString();
}

/** Restricted key: Checkout Sessions write only. Set with `wrangler secret put STRIPE_SECRET_KEY`. */
export const CHECKOUT_PRICES = {
  monthly: "price_1UQhIqGTgTEb9hzMidkH62bY",
  yearly: "price_1UQhIrGTgTEb9hzM87TinKO1",
};

export const CHECKOUT_SUCCESS_URL = "https://sunsetping.com/pro?welcome=1";
export const CHECKOUT_CANCEL_URL = "https://sunsetping.com/pro?canceled=1";

export function checkoutCustomerEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 254) return "";
  return normalized;
}

/** Return path on sunsetping.com, or the Pro page when the referer is somewhere else. */
export function checkoutCancelUrl(referer) {
  try {
    const from = new URL(String(referer || ""));
    const host = from.hostname.toLowerCase();
    if (host !== "sunsetping.com" && host !== "www.sunsetping.com") return CHECKOUT_CANCEL_URL;
    if (from.protocol !== "https:" && from.protocol !== "http:") return CHECKOUT_CANCEL_URL;
    if (!from.pathname || from.pathname.startsWith("/api/")) return CHECKOUT_CANCEL_URL;
    const next = new URL(`https://sunsetping.com${from.pathname}`);
    for (const [key, value] of from.searchParams) {
      if (key !== "canceled" && key !== "welcome") next.searchParams.append(key, value);
    }
    next.searchParams.set("canceled", "1");
    return next.toString();
  } catch {
    return CHECKOUT_CANCEL_URL;
  }
}

/**
 * Create a subscription Checkout Session. Returns the hosted URL, or null when
 * STRIPE_SECRET_KEY is unset. Throws when Stripe rejects the request.
 */
export async function createCheckoutSession({ env, plan, email, cancelUrl, fetchImpl = fetch }) {
  const key = env?.STRIPE_SECRET_KEY;
  if (!key || typeof key !== "string") return null;
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][price]", plan === "yearly" ? CHECKOUT_PRICES.yearly : CHECKOUT_PRICES.monthly);
  body.set("line_items[0][quantity]", "1");
  body.set("success_url", CHECKOUT_SUCCESS_URL);
  body.set("cancel_url", cancelUrl || CHECKOUT_CANCEL_URL);
  body.set("allow_promotion_codes", "true");
  const customer = checkoutCustomerEmail(email);
  if (customer) body.set("customer_email", customer);
  const res = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Stripe checkout failed (${res.status}) ${detail.slice(0, 180)}`.trim());
  }
  const data = await res.json().catch(() => ({}));
  let sessionUrl;
  try {
    sessionUrl = new URL(String(data?.url || ""));
  } catch {
    throw new Error("Stripe checkout returned no url");
  }
  if (sessionUrl.protocol !== "https:") throw new Error("Stripe checkout returned no url");
  return sessionUrl.toString();
}
