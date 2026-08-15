"use client";

import { useEffect } from "react";
import { clientConfig } from "@/client.config";
import { persistUtm, readUtmFromSearch, readUtmFromStorage } from "@/lib/utm";

/**
 * Mount-once UTM capture — a SUPPLEMENT to the real capture.
 *
 * The authoritative capture is middleware.ts, which writes the `arjun_attr`
 * cookie before any JS runs. This effect only keeps sessionStorage warm for
 * same-tab client use (the landing CTA's query string, checkout's hidden
 * fields). It is no longer load-bearing: if it never runs because the user
 * tapped the CTA before hydration, the server still has the cookie.
 *
 * `landing_url` and `referrer` are FIRST-touch and written once. Previously
 * both were rewritten on every page, so `landing_url` always ended up as
 * "/checkout" and `referrer` as our own landing page — destroying the two
 * fields attribution recovery depends on.
 */
export function UtmCapture(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromUrl = readUtmFromSearch(window.location.search);

    const stored = readUtmFromStorage(clientConfig.funnel.sessionStorageKey);
    if (!stored.landing_url) {
      fromUrl.landing_url = window.location.href;
      if (document.referrer) fromUrl.referrer = document.referrer;
    }

    persistUtm(clientConfig.funnel.sessionStorageKey, fromUrl);
  }, []);
  return null;
}
