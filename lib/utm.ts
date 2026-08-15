import type { UtmPayload } from "./types";
import { ATTR_COOKIE, readAttrCookie } from "./attribution";

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "referrer",
  "landing_url",
] as const satisfies readonly (keyof UtmPayload)[];

/** Read UTM + attribution params from a search string. */
export function readUtmFromSearch(search: string): UtmPayload {
  const params = new URLSearchParams(search);
  const out: UtmPayload = {};
  for (const key of UTM_KEYS) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** Read previously persisted UTM payload from sessionStorage. */
export function readUtmFromStorage(storageKey: string): UtmPayload {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as UtmPayload;
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist UTM to sessionStorage. Only overwrites if the incoming payload
 * has at least one defined value — protects against losing first-touch attribution.
 */
export function persistUtm(storageKey: string, utm: UtmPayload): void {
  if (typeof window === "undefined") return;
  const hasAny = Object.values(utm).some((v) => v && v.length > 0);
  if (!hasAny) return;
  try {
    const existing = readUtmFromStorage(storageKey);
    const merged: UtmPayload = { ...existing, ...utm };
    window.sessionStorage.setItem(storageKey, JSON.stringify(merged));
  } catch {
    // private mode / quota — fail silently
  }
}

/** Encode UTM payload as a query string fragment, prefixed with `&`. Empty if nothing. */
export function utmToQueryString(utm: UtmPayload): string {
  const params = new URLSearchParams();
  for (const key of UTM_KEYS) {
    const v = utm[key];
    if (v) params.set(key, v);
  }
  const s = params.toString();
  return s ? `&${s}` : "";
}

/** Read a cookie by name (for _fbp / _fbc lookup on the client). */
export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=")[1] ?? "") : undefined;
}

/**
 * Read attribution from the `arjun_attr` cookie into the legacy `utm_*`
 * shape this module exposes.
 *
 * The cookie is written by middleware.ts on the very first request, so it is
 * populated even when sessionStorage is empty — a new tab, an in-app-browser
 * handoff to Safari, or a hydration race lost to the CTA. Callers merge it
 * UNDER sessionStorage (which may hold a fresher last-touch value).
 *
 * `buildFbcFromFbclid` used to live here. It is gone: it stamped
 * `Date.now()` as the click time, which is the payment moment on the webhook
 * path — hours off. Use `buildFbc(fbclid, ts)` from lib/attribution.ts with a
 * real captured timestamp instead.
 */
export function readUtmFromAttrCookie(): UtmPayload {
  const raw = readCookie(ATTR_COOKIE);
  const attr = readAttrCookie(raw);
  const out: UtmPayload = {};
  if (attr.source) out.utm_source = attr.source;
  if (attr.medium) out.utm_medium = attr.medium;
  if (attr.campaign) out.utm_campaign = attr.campaign;
  if (attr.content) out.utm_content = attr.content;
  if (attr.term) out.utm_term = attr.term;
  if (attr.fbclid) out.fbclid = attr.fbclid;
  if (attr.gclid) out.gclid = attr.gclid;
  if (attr.referrer) out.referrer = attr.referrer;
  if (attr.landing_url) out.landing_url = attr.landing_url;
  return out;
}
