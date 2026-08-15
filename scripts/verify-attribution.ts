/* Phase E verification harness — playbook §9. Run with tsx/ts-node. */
import {
  mergeAttribution,
  packJsonNote,
  parseFbc,
  resolveAttribution,
  readNotesAttribution,
  type StoredAttribution,
} from "../lib/attribution";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── The real regression fixture from the post-mortem ────────────────────────
const REAL_FBCLID =
  "IwcGRvZgVmZGlkFlDIkqwYdjSfqcsB2tdCqlo2UlknuHdleHRuA2FlbQEwAGFkaWQBqzpNT5GHlHNydGMGYXBwX2lkCjY2Mjg1NjgzNzkAAR7CMVN7FggThhPp4fjvWaxb3m5Snsv1Nnuhanb0IqkZYMeDf6GQLLbaUyMhCw_aem_h9PxjwKywDlTqLI66MolCw";

const notes = {
  clid: "",
  ts: "",
  utm: '{"s":"","m":"","c":"","n":"","t":""}',
  rf: "https://example.com/?utm_source=Facebook_Mobile_Reels&utm_medium=Testosterone+Drop+Podcast&utm_campaign=TGO+Hardik+VSL+Men+32-55+14.8.26&utm_content=Broad&utm_term=120253918515750404&fbclid=IwcGRvZgVmZGlkFlDIkqwYdjSfqcsB2tdCqlo2UlknuHdleHR",
  lu: "https://example.com/checkout",
  fbc: `fb.1.1786771769851.${REAL_FBCLID}`,
};

console.log("\n[1] Real regression fixture");
const r = resolveAttribution({
  cookieAttr: {},
  bodyAttr: {},
  referrer: notes.rf,
  landingUrl: notes.lu,
  fbc: notes.fbc,
});

check("utm_source recovered from rf", r.utm.source === "Facebook_Mobile_Reels", r.utm.source);
check("utm_medium recovered", r.utm.medium === "Testosterone Drop Podcast", r.utm.medium);
check("utm_campaign recovered", r.utm.campaign === "TGO Hardik VSL Men 32-55 14.8.26", r.utm.campaign);
check("utm_content recovered", r.utm.content === "Broad", r.utm.content);
check("utm_term recovered", r.utm.term === "120253918515750404", r.utm.term);
check(
  `fbclid full length (${REAL_FBCLID.length} chars) from _fbc, not the 49-char rf value`,
  r.fbclid === REAL_FBCLID,
  `got ${r.fbclid.length} chars`,
);
check("click ts recovered", r.fbclidTs === 1786771769851, String(r.fbclidTs));
check("provenance", r.provenance === "utm:referrer|clid:fbc", r.provenance);

// Prove the truncated rf fbclid is genuinely shorter — i.e. that preferring
// _fbc is load-bearing, not cosmetic.
const rfClid = new URL(notes.rf).searchParams.get("fbclid") ?? "";
check("rf fbclid is truncated (proves the bug)", rfClid.length === 49 && rfClid !== REAL_FBCLID, `${rfClid.length} chars`);

console.log("\n[2] Precedence");
const cookieAttr: StoredAttribution = { source: "ck", fbclid: "CK_CLID", ts: 111 };
const bodyAttr: StoredAttribution = { source: "bd", fbclid: "BD_CLID", ts: 222 };
check(
  "cookie beats body",
  resolveAttribution({ cookieAttr, bodyAttr }).utm.source === "ck",
);
check(
  "body beats referrer",
  resolveAttribution({ bodyAttr, referrer: notes.rf }).utm.source === "bd",
);
check(
  "captured fbclid beats _fbc derivation",
  resolveAttribution({ cookieAttr, fbc: notes.fbc }).fbclid === "CK_CLID",
);
const empty = resolveAttribution({});
check("empty everything → utm:none|clid:none", empty.provenance === "utm:none|clid:none", empty.provenance);

console.log("\n[3] Touch policy");
const t1 = mergeAttribution(
  {},
  { live: { source: "fb" }, landingUrl: "https://x.com/?utm_source=fb", referrer: "https://l.facebook.com/", now: 1000 },
);
check("first-touch landing_url set once", t1.attr.landing_url === "https://x.com/?utm_source=fb");
check("first-touch referrer captured", t1.attr.referrer === "https://l.facebook.com/");

const t2 = mergeAttribution(t1.attr, {
  live: {},
  landingUrl: "https://x.com/checkout",
  referrer: "https://x.com/",
  now: 2000,
});
check("clean internal URL does not wipe attribution", t2.attr.source === "fb");
check("landing_url NOT overwritten by internal hop", t2.attr.landing_url === "https://x.com/?utm_source=fb");
check("untagged internal nav writes no cookie", t2.changed === false);

const t3 = mergeAttribution(t1.attr, {
  live: { source: "ig", campaign: "c2" },
  landingUrl: "https://x.com/?utm_source=ig",
  referrer: "",
  now: 3000,
});
check("last-touch: second tagged URL overwrites", t3.attr.source === "ig" && t3.attr.ts === 3000);

console.log("\n[4] packJsonNote vs the old truncate(JSON.stringify(...))");
const bigCampaign =
  "ADV+ | Men 32-55 | Testosterone Drop Podcast Hook v4 | Broad Interest Expansion | IN-Metro-Tier1 | 14.8.26 | creative_batch_07_variant_c_longform | LAL_1pct_purchasers_180d | placement_reels_stories_feed | bid_cap_450 | test_cell_B";
const blob = {
  s: "Facebook_Mobile_Reels",
  m: "Testosterone Drop Podcast",
  c: bigCampaign,
  n: "Broad",
  t: "120253918515750404",
};
const naiveSerialised = JSON.stringify(blob);
console.log(`  (fixture serialises to ${naiveSerialised.length} chars — must exceed 256)`);
check("fixture is genuinely oversized", naiveSerialised.length > 256, `${naiveSerialised.length}`);

const oldWay = naiveSerialised.slice(0, 256);
let oldWayValid = true;
try {
  JSON.parse(oldWay);
} catch {
  oldWayValid = false;
}
check("OLD truncate(JSON.stringify) → INVALID json (proves the bug)", !oldWayValid);

const packed = packJsonNote(blob, 256);
let parsed: Record<string, string> = {};
let newWayValid = true;
try {
  parsed = JSON.parse(packed) as Record<string, string>;
} catch {
  newWayValid = false;
}
check("packJsonNote → valid JSON", newWayValid);
check("packJsonNote → fits 256", packed.length <= 256, `${packed.length}`);
check("only the longest value clipped; short fields intact", parsed.s === "Facebook_Mobile_Reels" && parsed.n === "Broad" && parsed.t === "120253918515750404");
check("longest value was the one shortened", (parsed.c ?? "").length < bigCampaign.length && (parsed.c ?? "").length > 0);

console.log("\n[5] L6 — webhook repair of orders created BEFORE this shipped");
// The exact legacy shape: flat utm_* keys all blank, no rf, no fbc, no ts.
const legacyNotes: Record<string, string> = {
  funnel: "arjun-blueprint-ads",
  utm_source: "",
  utm_medium: "",
  utm_campaign: "",
  utm_content: "",
  utm_term: "",
  fbclid: "",
  fbp: "fb.1.1786771769851.1234567890",
  landing_url: notes.lu,
};
const legacyAttr = readNotesAttribution(legacyNotes);
const legacyResolved = resolveAttribution({
  cookieAttr: legacyAttr,
  referrer: legacyNotes.rf ?? "",
  landingUrl: legacyNotes.landing_url,
  fbc: legacyNotes.fbc ?? "",
});
check(
  "legacy order with nothing recoverable → logged as utm:none|clid:none",
  legacyResolved.provenance === "utm:none|clid:none",
  legacyResolved.provenance,
);

// Same legacy order, but the referrer + _fbc survived — the post-mortem case.
const repairable: Record<string, string> = {
  ...legacyNotes,
  rf: notes.rf,
  fbc: notes.fbc,
};
const repaired = resolveAttribution({
  cookieAttr: readNotesAttribution(repairable),
  referrer: repairable.rf,
  landingUrl: repairable.landing_url,
  fbc: repairable.fbc,
});
check("legacy order REPAIRED: utm from rf", repaired.utm.source === "Facebook_Mobile_Reels");
check("legacy order REPAIRED: fbclid full from _fbc", repaired.fbclid === REAL_FBCLID);
check("legacy repair provenance", repaired.provenance === "utm:referrer|clid:fbc", repaired.provenance);

// New packed shape must win over legacy flat keys when both somehow exist.
const mixed = readNotesAttribution({
  utm: JSON.stringify({ s: "packed", m: "", c: "", n: "", t: "" }),
  utm_source: "legacy",
});
check("packed utm note beats legacy flat key", mixed.source === "packed", mixed.source);

const malformed = readNotesAttribution({ utm: "{not json", utm_source: "legacy_fallback" });
check("malformed utm note falls back to legacy keys", malformed.source === "legacy_fallback");

console.log("\n[6] parseFbc edge cases");
check("fbclid containing dots rejoins", parseFbc("fb.1.123.a.b.c").fbclid === "a.b.c");
check("garbage → {}", Object.keys(parseFbc("nonsense")).length === 0);
check("empty → {}", Object.keys(parseFbc(undefined)).length === 0);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
