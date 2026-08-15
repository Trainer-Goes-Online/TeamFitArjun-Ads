import { NextResponse } from "next/server";
import { getRazorpay } from "@/lib/razorpay";
import { clientConfig } from "@/client.config";
import {
  ATTR_COOKIE,
  buildFbc,
  packJsonNote,
  readAttrCookie,
  resolveAttribution,
  type StoredAttribution,
} from "@/lib/attribution";
import type {
  ApiErrorResponse,
  CreateOrderRequest,
  CreateOrderResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_CURRENCIES = new Set(["INR"]);

/** Read one cookie out of a raw Cookie header. */
function readCookie(cookieHeader: string, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export async function POST(
  request: Request,
): Promise<NextResponse<CreateOrderResponse | ApiErrorResponse>> {
  let body: CreateOrderRequest;
  try {
    body = (await request.json()) as CreateOrderRequest;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const requested = Math.round(body.amount);
  const expected = clientConfig.pricing.price;

  if (!Number.isFinite(requested) || requested <= 0) {
    return NextResponse.json(
      { success: false, error: "Invalid amount" },
      { status: 400 },
    );
  }

  // Server enforces price — the client cannot lower it via DevTools.
  // (We still accept `amount` so future coupon flow can adjust server-side.)
  if (requested !== expected) {
    console.warn(
      `[create-order] Amount mismatch: client sent ${requested}, expected ${expected} — forcing server value`,
    );
  }
  const amount = expected;

  const currency = (body.currency || clientConfig.pricing.currency).toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    return NextResponse.json(
      { success: false, error: `Unsupported currency: ${currency}` },
      { status: 400 },
    );
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  if (!keyId) {
    return NextResponse.json(
      {
        success: false,
        error: "Server missing Razorpay credentials",
        code: "MISSING_KEY_ID",
      },
      { status: 500 },
    );
  }

  // Pack EVERY field the Pabbly purchase webhook needs into Razorpay's
  // order `notes`. The webhook fallback (app/api/razorpay/webhook/route.ts)
  // reads these back via orders.fetch when the browser-side verify-payment
  // call fails to land — so Pabbly gets identical complete data on either
  // delivery path.
  //
  // Razorpay's documented limit is 15 keys per `notes` object with values up
  // to 256 chars each. We sit at 14, leaving one spare. Empty values are
  // sent as "" so the webhook can deterministically rebuild the payload.
  //
  // CRITICAL: The first key is `funnel: clientConfig.funnel.slug`. This is
  // the cross-business pollution guardrail. The Razorpay account that
  // processes this funnel ALSO processes payments for unrelated businesses
  // (WooCommerce sites, other coaching brands, etc.). All those payments
  // trigger OUR webhook URL because Razorpay webhook subscriptions are
  // account-level, not per-funnel. Without this marker, the webhook would
  // fire Pabbly + CAPI for every unrelated payment too, polluting CRM rows
  // and inflating Meta conversion counts. The webhook reads orders.fetch
  // notes and skips silently when notes.funnel !== clientConfig.funnel.slug.
  //
  // ── L2/L3/L4/L5 — attribution is resolved SERVER-SIDE ───────────────────
  //
  // The `arjun_attr` cookie (written by middleware.ts before any JS runs) is
  // the primary source. The client's `body.utm` is demoted to a supplement:
  // it comes from sessionStorage, which is only populated if a React effect
  // won a race against the CTA tap — the exact race that produced paid orders
  // with every utm_* blank.
  //
  // Notes budget: Razorpay allows 15 keys × 256 chars. The five utm_* keys
  // are consolidated into ONE packed `utm` note, which frees the slots for
  // `rf` and `fbc` — the two fields that make attribution recoverable after
  // the fact. Count below is 14/15.
  const customer = body.customer ?? {};
  const bodyUtm = body.utm ?? {};
  const clamp = (v: string | undefined): string => (v ?? "").toString().slice(0, 256);

  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieAttr = readAttrCookie(readCookie(cookieHeader, ATTR_COOKIE));
  const cookieFbc = readCookie(cookieHeader, "_fbc");
  const cookieFbp = readCookie(cookieHeader, "_fbp");

  // Map the client's legacy `utm_*` shape onto the compact storage keys.
  const bodyAttr: StoredAttribution = {
    source: bodyUtm.utm_source,
    medium: bodyUtm.utm_medium,
    campaign: bodyUtm.utm_campaign,
    content: bodyUtm.utm_content,
    term: bodyUtm.utm_term,
    fbclid: bodyUtm.fbclid,
    gclid: bodyUtm.gclid,
    landing_url: bodyUtm.landing_url,
    referrer: bodyUtm.referrer,
  };

  const resolved = resolveAttribution({
    cookieAttr,
    bodyAttr,
    referrer: bodyUtm.referrer ?? request.headers.get("referer") ?? "",
    landingUrl: bodyUtm.landing_url,
    fbc: cookieFbc,
  });

  // The real `_fbc` cookie wins; synthesise only when the pixel never set one.
  // Synthesising uses the CLICK timestamp we captured, not "now" — stamping
  // payment time as click time silently mis-dates the attribution window.
  const fbc =
    cookieFbc ||
    (resolved.fbclid ? buildFbc(resolved.fbclid, resolved.fbclidTs) : "");

  if (resolved.utmSource === "none" && resolved.clidSource === "none") {
    console.error(
      "[create-order] ATTRIBUTION MISSING — no utm_* and no fbclid from cookie, body, referrer or _fbc",
    );
  } else {
    console.log(`[create-order] attribution ${resolved.provenance}`);
  }

  const notes: Record<string, string> = {
    funnel: clientConfig.funnel.slug,
    first_name: clamp(customer.firstName),
    last_name: clamp(customer.lastName),
    customer_email: clamp(customer.email),
    customer_phone: clamp(customer.phone),
    country_code: clamp(customer.countryCode),
    city: clamp(customer.city),
    // L5 — JSON-safe packing. Never `JSON.stringify(...).slice(0, 256)`:
    // that slices mid-JSON on a long campaign name and the reader loses
    // every field instead of one being clipped.
    utm: packJsonNote({
      s: resolved.utm.source,
      m: resolved.utm.medium,
      c: resolved.utm.campaign,
      n: resolved.utm.content,
      t: resolved.utm.term,
    }),
    fbclid: clamp(resolved.fbclid),
    ts: clamp(String(resolved.fbclidTs || "")),
    fbc: clamp(fbc),
    fbp: clamp(body.fbp || cookieFbp),
    rf: clamp(resolved.referrer),
    landing_url: clamp(resolved.landingUrl),
  };

  try {
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency,
      receipt: `rcpt_${Date.now()}`,
      notes,
    });

    return NextResponse.json({
      orderId: order.id,
      amount,
      currency,
      keyId,
      // Placeholder — the real event_id used downstream is the Razorpay
      // payment_id, which is only known after the payment completes.
      eventId: order.id,
    });
  } catch (err) {
    console.error("[create-order] Razorpay order creation failed", err);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to create Razorpay order",
        code: "RAZORPAY_ORDER_FAILED",
      },
      { status: 500 },
    );
  }
}
