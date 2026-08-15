import { NextResponse, type NextRequest } from "next/server";
import {
  ATTR_COOKIE,
  ATTR_TTL_SECONDS,
  mergeAttribution,
  parseAttributionFromUrl,
  readAttrCookie,
} from "@/lib/attribution";

/**
 * L1 — attribution capture at the edge.
 *
 * This is THE fix for blank UTMs on paid orders. Previously the only capture
 * was a React `useEffect` (components/UtmCapture.tsx), so attribution
 * survived only if hydration beat the user's tap on the CTA. Inside the
 * Facebook iOS in-app browser on a heavy landing page it frequently didn't,
 * and the resulting orders had every `utm_*` blank with no way to recover
 * them. Middleware runs before a single byte of JS, so the query string is
 * captured whether or not the page ever hydrates.
 *
 * The client-side capture stays as a supplement (it still populates
 * sessionStorage for same-tab UX), but the cookie written here is what
 * create-order and the Razorpay webhook actually trust.
 *
 * Cookie is deliberately SEPARATE from `arjun_mam`. Two cookies, two
 * concerns: `arjun_mam` = hashed PII for the Pixel, `arjun_attr` = raw
 * attribution. Never merge them.
 *
 * `httpOnly: false` is intentional — lib/utm.ts reads this cookie client-side
 * as a fallback when sessionStorage is empty. It holds no PII, only campaign
 * identifiers that were already visible in the URL.
 */
export function middleware(req: NextRequest): NextResponse {
  const res = NextResponse.next();

  try {
    const live = parseAttributionFromUrl(req.nextUrl.search);
    const stored = readAttrCookie(req.cookies.get(ATTR_COOKIE)?.value);

    const { attr, changed } = mergeAttribution(stored, {
      live,
      landingUrl: req.nextUrl.href,
      referrer: req.headers.get("referer") ?? "",
      now: Date.now(),
    });

    // Untagged internal navigation with context already stored → no write.
    // Avoids a Set-Cookie on every single page view.
    if (changed) {
      res.cookies.set(ATTR_COOKIE, encodeURIComponent(JSON.stringify(attr)), {
        path: "/",
        maxAge: ATTR_TTL_SECONDS,
        sameSite: "lax",
        httpOnly: false,
        secure: req.nextUrl.protocol === "https:",
      });
    }
  } catch {
    // Attribution must NEVER break page delivery.
  }

  return res;
}

export const config = {
  // Skip API routes (they read the cookie, they don't set it), Next internals,
  // and anything with a file extension (images, fonts, the transformations/
  // gallery) so the middleware doesn't run on static assets.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
