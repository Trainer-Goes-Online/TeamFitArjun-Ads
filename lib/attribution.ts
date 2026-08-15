/**
 * Attribution capture + resolution — the single source of truth for where a
 * buyer came from.
 *
 * ⚠️ EDGE-SAFE. This module is imported by middleware.ts, which runs on the
 * Vercel Edge runtime. No `node:crypto`, no DOM, no Node built-ins. Keep it
 * pure so it can be unit-tested and run in every runtime we have.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Attribution used to be captured ONLY by a React `useEffect`
 * (components/UtmCapture.tsx), which means it had to win a race against the
 * user tapping the CTA. On a heavy landing page inside the Facebook iOS
 * in-app browser, it often lost — producing paid orders with every `utm_*`
 * blank. The misses are biased toward in-app browsers, i.e. exactly the
 * traffic we buy. That is not fixable by making the JS faster; it has to be
 * captured server-side, which is what middleware.ts now does using this file.
 *
 * ── Precedence, per field ──────────────────────────────────────────────────
 *   URL → cookie → client body → referrer → _fbc → none
 *
 * `referrer` is deliberately SKIPPED for `fbclid`. Razorpay caps note values
 * at 256 chars, and a real ad referrer overflows that: the fbclid sits at the
 * END of the query string, so it gets sliced. A truncated fbclid is worse
 * than none — it looks valid and silently mis-attributes. `_fbc` is the only
 * complete source, and it is what parseFbc() reads.
 */

export const ATTR_COOKIE = "arjun_attr";
export const ATTR_TTL_SECONDS = 30 * 24 * 60 * 60;

/** URL param → short storage key. */
export const URL_TO_KEY: Record<string, string> = {
  utm_source: "source",
  utm_medium: "medium",
  utm_campaign: "campaign",
  utm_content: "content",
  utm_term: "term",
  fbclid: "fbclid",
  gclid: "gclid",
};

export const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/** Raw attribution as persisted in the `arjun_attr` cookie. */
export interface StoredAttribution {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  fbclid?: string;
  gclid?: string;
  /** Click timestamp in unix ms — from the URL hit, or derived from _fbc. */
  ts?: number;
  /** FIRST-touch landing URL. Written once, never overwritten. */
  landing_url?: string;
  /** FIRST-touch external referrer. Written once, alongside landing_url. */
  referrer?: string;
}

export interface ResolvedAttribution {
  utm: Record<UtmKey, string>;
  fbclid: string;
  fbclidTs: number;
  gclid: string;
  referrer: string;
  landingUrl: string;
  /** e.g. `utm:cookie|clid:fbc` — for logging + monitoring. */
  provenance: string;
  utmSource: "cookie" | "body" | "referrer" | "none";
  clidSource: "cookie" | "body" | "fbc" | "none";
}

const isFilled = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/**
 * Pull attribution params out of a URL or bare query string. Accepts a full
 * href, a `?a=b` search string, or `a=b`.
 */
export function parseAttributionFromUrl(input: string | undefined): StoredAttribution {
  const out: StoredAttribution = {};
  if (!isFilled(input)) return out;
  try {
    const search = input.includes("?") ? input.slice(input.indexOf("?")) : input;
    const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    for (const [param, key] of Object.entries(URL_TO_KEY)) {
      const v = sp.get(param);
      if (isFilled(v)) (out as Record<string, string>)[key] = v;
    }
  } catch {
    // Malformed URL — callers treat an empty object as "nothing found".
  }
  return out;
}

/**
 * Split Meta's `_fbc` cookie: `fb.<subdomainIndex>.<clickTsMs>.<fbclid>`.
 *
 * The fbclid itself can contain dots, so everything from index 3 onward is
 * rejoined. This is the ONLY complete source of fbclid once the URL is gone.
 */
export function parseFbc(fbc: string | undefined): { fbclid?: string; ts?: number } {
  if (!isFilled(fbc)) return {};
  const parts = fbc.split(".");
  if (parts.length < 4 || parts[0] !== "fb") return {};
  const ts = Number(parts[2]);
  return {
    fbclid: parts.slice(3).join("."),
    ts: Number.isFinite(ts) && ts > 0 ? ts : undefined,
  };
}

/** Rebuild a Meta-format `_fbc` from its parts. */
export function buildFbc(fbclid: string, ts: number): string {
  return `fb.1.${ts}.${fbclid}`;
}

/**
 * Parse the `arjun_attr` cookie, tolerating however many layers of URI
 * encoding it picked up.
 *
 * This matters because the number of layers depends on the reader:
 * `NextRequest.cookies.get()` decodes once, a raw `Cookie:` header regex
 * decodes zero times, and the writer adds its own `encodeURIComponent` on top
 * of the one `res.cookies.set()` applies. Rather than have every call site
 * count layers correctly, decode until it parses as JSON.
 */
export function readAttrCookie(raw: string | undefined): StoredAttribution {
  if (!isFilled(raw)) return {};

  let candidate = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as StoredAttribution)
        : {};
    } catch {
      // Not JSON yet — peel one encoding layer and retry.
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return {};
    }
    if (decoded === candidate) return {};
    candidate = decoded;
  }
  return {};
}

/**
 * Merge a fresh URL hit into stored attribution.
 *
 * Two different policies on purpose:
 *   - ATTRIBUTION (utm/fbclid/gclid) is LAST-touch. Someone who arrived via
 *     link-in-bio and later clicked the ad should be credited to the ad.
 *   - CONTEXT (landing_url/referrer) is FIRST-touch. These exist to answer
 *     "where did this person enter the funnel", so an internal hop to
 *     /checkout must not overwrite them. The old useEffect capture rewrote
 *     both on every page, which is why landing_url always read "/checkout".
 *
 * Returns `changed: false` for untagged internal navigation so we don't
 * rewrite the cookie on every page view.
 */
export function mergeAttribution(
  stored: StoredAttribution,
  opts: {
    live: StoredAttribution;
    landingUrl?: string;
    referrer?: string;
    now: number;
  },
): { attr: StoredAttribution; changed: boolean } {
  const attr: StoredAttribution = { ...stored };
  let changed = false;

  // First-touch context — only ever written once.
  if (!isFilled(attr.landing_url) && isFilled(opts.landingUrl)) {
    attr.landing_url = opts.landingUrl;
    attr.referrer = isFilled(opts.referrer) ? opts.referrer : "";
    changed = true;
  }

  // Last-touch attribution — a newly tagged URL always wins.
  if (Object.keys(opts.live).length > 0) {
    Object.assign(attr, opts.live, { ts: opts.now });
    changed = true;
  }

  return { attr, changed };
}

/**
 * Collapse every available source into one answer, recording WHERE each half
 * came from so a blank row is distinguishable from an organic one in logs.
 */
export function resolveAttribution(input: {
  cookieAttr?: StoredAttribution;
  bodyAttr?: StoredAttribution;
  referrer?: string;
  landingUrl?: string;
  fbc?: string;
  now?: number;
}): ResolvedAttribution {
  const {
    cookieAttr = {},
    bodyAttr = {},
    referrer = "",
    landingUrl = "",
    fbc = "",
    now = Date.now(),
  } = input;

  // ── utm_*: cookie → body → referrer/landing_url ──────────────────────────
  const utm = {} as Record<UtmKey, string>;
  let utmSource: ResolvedAttribution["utmSource"] = "none";

  for (const [label, src] of [
    ["cookie", cookieAttr],
    ["body", bodyAttr],
  ] as const) {
    for (const key of UTM_KEYS) {
      if (!isFilled(utm[key]) && isFilled(src[key])) {
        utm[key] = src[key] as string;
        if (utmSource === "none") utmSource = label;
      }
    }
  }

  // Nothing survived — try to reconstruct from the URLs we still hold. The
  // referrer of an internal hop is the tagged landing page, so this recovers
  // real campaigns that the client-side capture missed entirely.
  if (UTM_KEYS.every((k) => !isFilled(utm[k]))) {
    const recovered = {
      ...parseAttributionFromUrl(landingUrl),
      ...parseAttributionFromUrl(referrer),
    };
    let used = false;
    for (const key of UTM_KEYS) {
      if (isFilled(recovered[key])) {
        utm[key] = recovered[key] as string;
        used = true;
      }
    }
    if (used) utmSource = "referrer";
  }

  for (const key of UTM_KEYS) if (!isFilled(utm[key])) utm[key] = "";

  // ── fbclid: cookie → body → _fbc. NEVER from referrer (truncation). ──────
  let fbclid = "";
  let fbclidTs = 0;
  let clidSource: ResolvedAttribution["clidSource"] = "none";

  if (isFilled(cookieAttr.fbclid)) {
    fbclid = cookieAttr.fbclid;
    clidSource = "cookie";
    fbclidTs = Number(cookieAttr.ts) || 0;
  } else if (isFilled(bodyAttr.fbclid)) {
    fbclid = bodyAttr.fbclid;
    clidSource = "body";
    fbclidTs = Number(bodyAttr.ts) || 0;
  } else {
    const parsed = parseFbc(fbc);
    if (isFilled(parsed.fbclid)) {
      fbclid = parsed.fbclid;
      clidSource = "fbc";
      fbclidTs = parsed.ts ?? 0;
    }
  }

  // When the fbclid came from cookie/body, its `ts` is when the browser hit
  // our page — not when the ad was clicked. If Meta's own `_fbc` is present
  // and describes the SAME click, prefer its timestamp: that is the real
  // click time, and it is what Meta expects inside an `fb.1.<ts>.<fbclid>`.
  if (clidSource === "cookie" || clidSource === "body") {
    const fromFbc = parseFbc(fbc);
    if (fromFbc.fbclid === fbclid && fromFbc.ts) fbclidTs = fromFbc.ts;
  }

  if (!fbclidTs) fbclidTs = Number(cookieAttr.ts) || Number(bodyAttr.ts) || 0;

  const firstFilled = (...vals: (string | undefined)[]): string =>
    vals.find(isFilled) ?? "";

  return {
    utm,
    fbclid,
    fbclidTs: fbclidTs || now,
    gclid: firstFilled(cookieAttr.gclid, bodyAttr.gclid),
    referrer: firstFilled(referrer, cookieAttr.referrer, bodyAttr.referrer),
    landingUrl: firstFilled(landingUrl, cookieAttr.landing_url, bodyAttr.landing_url),
    provenance: `utm:${utmSource}|clid:${clidSource}`,
    utmSource,
    clidSource,
  };
}

/**
 * L6 — read attribution out of Razorpay order notes, tolerating BOTH shapes:
 *
 *   new    — one packed `utm` JSON note {"s","m","c","n","t"}, plus fbclid/ts/rf/fbc
 *   legacy — flat utm_source / utm_medium / utm_campaign / ... keys, no rf, no fbc
 *
 * Orders created before the packed shape shipped keep resolving correctly, so
 * a mid-flight deploy loses nothing. A malformed `utm` note falls through to
 * the legacy keys rather than throwing.
 */
export function readNotesAttribution(notes: Record<string, string>): StoredAttribution {
  const attr: StoredAttribution = {};

  if (notes.utm) {
    try {
      const parsed = JSON.parse(notes.utm) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        if (parsed.s) attr.source = parsed.s;
        if (parsed.m) attr.medium = parsed.m;
        if (parsed.c) attr.campaign = parsed.c;
        if (parsed.n) attr.content = parsed.n;
        if (parsed.t) attr.term = parsed.t;
      }
    } catch {
      // Malformed — fall through to the legacy flat keys below.
    }
  }

  if (!attr.source && notes.utm_source) attr.source = notes.utm_source;
  if (!attr.medium && notes.utm_medium) attr.medium = notes.utm_medium;
  if (!attr.campaign && notes.utm_campaign) attr.campaign = notes.utm_campaign;
  if (!attr.content && notes.utm_content) attr.content = notes.utm_content;
  if (!attr.term && notes.utm_term) attr.term = notes.utm_term;

  if (notes.fbclid) attr.fbclid = notes.fbclid;
  if (notes.gclid) attr.gclid = notes.gclid;
  if (notes.landing_url) attr.landing_url = notes.landing_url;
  if (notes.rf) attr.referrer = notes.rf;

  const ts = Number(notes.ts);
  if (Number.isFinite(ts) && ts > 0) attr.ts = ts;

  return attr;
}

/**
 * Serialise an object to JSON that is GUARANTEED valid under `max` chars, by
 * repeatedly shortening whichever value is currently longest.
 *
 * Do NOT replace this with `JSON.stringify(obj).slice(0, max)`. That slices
 * mid-JSON on a long campaign name, the reader's JSON.parse throws, the catch
 * returns {}, and EVERY field is lost rather than one being clipped. A real
 * Advantage+ campaign name is enough to trigger it.
 */
export function packJsonNote(obj: Record<string, unknown>, max = 256): string {
  const work: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    work[k] = typeof v === "string" ? v : String(v ?? "");
  }

  let json = JSON.stringify(work);
  let guard = 0;
  while (json.length > max && guard < 200) {
    guard += 1;
    let key: string | null = null;
    let len = 0;
    for (const [k, v] of Object.entries(work)) {
      if (v.length > len) {
        len = v.length;
        key = k;
      }
    }
    if (!key || len === 0) break;
    const cut = Math.max(1, Math.min(len, json.length - max));
    work[key] = work[key].slice(0, len - cut);
    json = JSON.stringify(work);
  }

  // Even empty-valued keys overflow `max` — better to lose the note than to
  // hand the reader malformed JSON.
  return json.length > max ? "{}" : json;
}
