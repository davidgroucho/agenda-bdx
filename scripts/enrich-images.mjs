#!/usr/bin/env node
/**
 * Batch image enrichment for Bordeaux agenda events (met_agenda dataset).
 *
 * What it does:
 *  - Fetch events from Bordeaux Metropole OpenData (Opendatasoft API v2.1)
 *  - Keep only events with no upstream image (location_image empty/null)
 *  - Search a suitable openly-licensed image (Openverse first, Wikimedia Commons fallback)
 *  - Write/merge assets/event-images.json keyed by uid (and optionally slug)
 *
 * Usage (local):
 *   node scripts/enrich-images.mjs
 *
 * Env vars (optional):
 *   MAX_EVENTS=300            # limit number of events processed per run
 *   CONCURRENCY=3             # parallel searches
 *   MIN_WIDTH=1200            # skip tiny images
 *   ALLOWED_LICENSES=cc0,pdm,by,by-sa   # Openverse license codes (comma-separated)
 *   OPENVERSE_PAGE_SIZE=20
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const TARGET_UID = (process.env.TARGET_UID || "").trim();
const BORDEAUX_API_BASE =
  "https://datahub.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets/met_agenda/records";

const OUT_PATH = path.resolve(__dirname, "..", "assets", "event-images.json");

const MAX_EVENTS = parseInt(process.env.MAX_EVENTS || "5000", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "1", 10);

const OPENAGENDA_KEY = (process.env.OPENAGENDA_KEY || "").trim();
// OFFICIAL_IMAGES=1 => on tente OpenAgenda avant Openverse/Wikimedia
const OFFICIAL_IMAGES = (process.env.OFFICIAL_IMAGES || "").trim() === "1";

const MIN_WIDTH = parseInt(process.env.MIN_WIDTH || "1200", 10);

const OPENVERSE_PAGE_SIZE = parseInt(process.env.OPENVERSE_PAGE_SIZE || "20", 10);
const ALLOWED_LICENSES = (process.env.ALLOWED_LICENSES || "cc0,pdm,by,by-sa")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const PREFERRED_OPENVERSE_PROVIDERS = new Set([
  "wikimedia",
  "commons.wikimedia.org",
  "unsplash",
  "pexels",
]);

// --- Small helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOpenAgendaEvent({ agendaUID, eventUID, apiKey }) {
  const url = `https://api.openagenda.com/v2/agendas/${agendaUID}/events/${eventUID}`;
  const res = await fetch(url, { headers: { key: apiKey, Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.event || data; // selon la forme de réponse
}

// Si jamais l'UID n'est PAS le même entre Bordeaux et OpenAgenda,
// OpenAgenda prévoit aussi une lecture “par identifiant externe” via /events/ext/... :contentReference[oaicite:4]{index=4}
async function fetchOpenAgendaEventByExt({ agendaUID, extKey, extValue, apiKey }) {
  const url = `https://api.openagenda.com/v2/agendas/${agendaUID}/events/ext/${extKey}/${extValue}`;
  const res = await fetch(url, { headers: { key: apiKey, Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  return data.event || data;
}

function pickOAImage(evt) {
  // champs typiques côté OpenAgenda (image / thumbnail / originalImage + credits) :contentReference[oaicite:5]{index=5}
  const url =
    evt?.image ||
    evt?.thumbnail ||
    evt?.originalImage ||
    evt?.location?.image ||
    "";
  const credit = evt?.imageCredits || evt?.location?.imageCredits || "";
  return url ? { url, credit } : null;
}


function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchOneByUid(uid) {
  const url = new URL(BORDEAUX_API_BASE);
  url.searchParams.set("where", `uid=${uid}`);
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
      Accept: "application/json",
    },
  });

  if (!res.ok) throw new Error(`Bordeaux API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.results?.[0] || null;
}

function tokens(s) {
  const t = normalizeText(s).split(" ").filter(Boolean);
  // remove very short tokens
  return t.filter((x) => x.length >= 3);
}

function overlapScore(aTokens, bText) {
  const b = new Set(tokens(bText));
  let score = 0;
  for (const t of aTokens) if (b.has(t)) score += 1;
  return score;
}

function isMissingImage(row) {
  const v = row?.location_image;
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  // Sometimes Opendatasoft returns {url: "..."} or similar
  if (typeof v === "object") {
    const url = v?.url || v?.href;
    return !url;
  }
  return false;
}

function bestImageUrlFromRow(row) {
  // if you want to allow upstream images, you can extract them here
  const v = row?.location_image;
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v?.[0]?.url || v?.[0] || "";
  if (typeof v === "object") return v?.url || v?.href || "";
  return "";
}

// --- Bordeaux Metropole events fetch ---
async function fetchAgendaPage(offset, limit) {
  const url = new URL(BORDEAUX_API_BASE);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order_by", "updatedat desc");

  // NOTE: we intentionally do NOT use the `select` parameter here.
  // The met_agenda schema can evolve and unknown fields would break the job (HTTP 400).
  // Fetching full records is slower but much more robust.

  // NOTE: filtering via `where` is possible but field shapes vary.
  // We fetch pages and filter client-side to avoid missing records.
const res = await fetch(url.toString(), {
  headers: {
    "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
    Accept: "application/json",
  },
});

if (res.ok) return res.json();

const body = await res.text();

// If the dataset schema changed (unknown field in SELECT), retry without SELECT.
if (res.status === 400 && body.includes("Unknown field")) {
  const url2 = new URL(url.toString());
  url2.searchParams.delete("select");

  const res2 = await fetch(url2.toString(), {
    headers: {
      "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
      Accept: "application/json",
    },
  });

  if (res2.ok) return res2.json();
  throw new Error(`Bordeaux API error ${res2.status} after retry: ${await res2.text()}`);
}

throw new Error(`Bordeaux API error ${res.status}: ${body}`);

}

async function fetchEventsMissingImages(maxEvents) {
  const limit = 100;
  let offset = 0;
  const out = [];

  while (out.length < maxEvents) {
    const data = await fetchAgendaPage(offset, limit);
    const rows = data?.results || [];
    if (!rows.length) break;

    for (const row of rows) {
      if (isMissingImage(row)) out.push(row);
      if (out.length >= maxEvents) break;
    }
    offset += rows.length;

    // Safety stop (avoid infinite loops if API behaves oddly)
    if (offset > 20000) break;
  }

  return out;
}

// --- Openverse ---
async function openverseSearch(query) {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", query);
  url.searchParams.set("page_size", String(Math.min(OPENVERSE_PAGE_SIZE, 20))); // unauth often limited to 20
  // Filter to licenses you accept
  // Openverse expects license codes separated by comma
  url.searchParams.set("license", ALLOWED_LICENSES.join(","));

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Openverse error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

function scoreOpenverseResult(evTokens, r) {
  const title = r?.title || "";
  const creator = r?.creator || r?.creator_name || "";
  const tags = Array.isArray(r?.tags) ? r.tags.map((t) => t?.name || t).join(" ") : "";
  const provider = (r?.provider || r?.source || "").toString().toLowerCase();

  const width = r?.width || 0;
  const height = r?.height || 0;

  let score = 0;
  score += overlapScore(evTokens, title) * 3;
  score += overlapScore(evTokens, creator) * 1;
  score += overlapScore(evTokens, tags) * 1;

  if (width >= 2000 || height >= 2000) score += 4;
  else if (width >= MIN_WIDTH) score += 2;

  if (PREFERRED_OPENVERSE_PROVIDERS.has(provider)) score += 4;

  // Prefer results with clear attribution fields
  if (creator) score += 1;
  if (r?.license) score += 1;
  if (r?.foreign_landing_url) score += 1;

  return score;
}

function toMappingFromOpenverse(r) {
  return {
    url: r?.url || r?.thumbnail || "",
    provider: r?.provider || "Openverse",
    page_url: r?.foreign_landing_url || "",
    author: r?.creator || r?.creator_name || "",
    license: r?.license || "",
    // optional (nice to keep)
    source_url: r?.source || "",
    credit: [r?.creator || r?.creator_name, r?.license].filter(Boolean).join(" · "),
    width: r?.width || null,
    height: r?.height || null,
  };
}

// --- Wikimedia Commons fallback (MediaWiki Action API) ---
async function commonsSearchFiles(query) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("list", "search");
  url.searchParams.set("srnamespace", "6"); // File:
  url.searchParams.set("srlimit", "10");
  url.searchParams.set("srsearch", query);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Commons search error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.query?.search) ? data.query.search : [];
}

async function commonsFetchImageInfo(titles) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata");
  // Ask Commons for a "big enough" thumbnail (original url is usually in `url`)
  url.searchParams.set("iiurlwidth", String(Math.max(MIN_WIDTH, 1600)));
  url.searchParams.set("titles", titles.join("|"));

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "agenda-bdx-image-enricher/1.0 (GitHub Actions)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Commons imageinfo error ${res.status}`);
  const data = await res.json();
  const pages = data?.query?.pages || {};
  return Object.values(pages);
}

function scoreCommonsPage(evTokens, page) {
  const title = page?.title || "";
  const info = page?.imageinfo?.[0] || {};
  const meta = info?.extmetadata || {};
  const artist = stripHtml(meta?.Artist?.value || "");
  const license = stripHtml(meta?.LicenseShortName?.value || "");

  let score = 0;
  score += overlapScore(evTokens, title) * 3;
  score += overlapScore(evTokens, artist) * 1;

  // Prefer well-identified licenses
  if (license) score += 2;

  // Prefer bigger images (if dims present)
  const w = info?.width || 0;
  const h = info?.height || 0;
  if (w >= 2000 || h >= 2000) score += 3;
  else if (w >= MIN_WIDTH) score += 2;

  return score;
}

function toMappingFromCommons(page) {
  const info = page?.imageinfo?.[0] || {};
  const meta = info?.extmetadata || {};
  const author = stripHtml(meta?.Artist?.value || "");
  const license = stripHtml(meta?.LicenseShortName?.value || meta?.License?.value || "");

  const pageTitle = page?.title || "";
  const commonsPageUrl = pageTitle
    ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(pageTitle).replace(/%3A/g, ":")}`
    : "";

  return {
    url: info?.thumburl || info?.url || "",
    provider: "Wikimedia Commons",
    page_url: commonsPageUrl,
    author,
    license,
    credit: [author, license].filter(Boolean).join(" · "),
    width: info?.width || null,
    height: info?.height || null,
  };
}

// --- Concurrency limiter ---
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// --- Main enrichment logic ---
function buildSearchQuery(row) {
  const title = row?.title_fr || row?.title || row?.title_en || "";
  const place = row?.location_name || row?.location || row?.location_title || "";
  const city = row?.location_city || row?.city || "Bordeaux";
  // Add city to disambiguate
  return [title, place, city].filter(Boolean).join(" ");
}

async function pickBestImageForEvent(row) {
  const q = buildSearchQuery(row);
  const evTokens = tokens(q);
  const agendaUID = String(row?.originagenda_uid || "").trim();

    // 0) Try OpenAgenda "official" image first (if enabled)
  if (OFFICIAL_IMAGES && OPENAGENDA_KEY && agendaUID) {
    // tentative 1: supposer que row.uid == eventUID OpenAgenda
    const oa = await fetchOpenAgendaEvent({
      agendaUID,
      eventUID: String(row?.uid || "").trim(),
      apiKey: OPENAGENDA_KEY
    });

    const oaImg = oa ? pickOAImage(oa) : null;
    if (oaImg?.url) {
      return {
        url: oaImg.url,
        provider: "OpenAgenda",
        page_url: oa?.canonicalUrl || oa?.url || "",
        author: "",
        license: "",
        credit: oaImg.credit || "",
        source_url: oa?.canonicalUrl || oa?.url || ""
      };
    }
  }

  // 1) Openverse
  try {
    const results = await openverseSearch(q);
    const best = results
      .map((r) => ({ r, s: scoreOpenverseResult(evTokens, r) }))
      .sort((a, b) => b.s - a.s)[0];

    if (best?.r) {
      const mapped = toMappingFromOpenverse(best.r);
      const width = best.r?.width || 0;
      if (mapped.url && (width >= MIN_WIDTH || !width)) return mapped;
    }
  } catch (e) {
    // continue to fallback
  }

  // 2) Wikimedia Commons fallback
  try {
    const files = await commonsSearchFiles(q);
    const titles = files.map((x) => x?.title).filter(Boolean).slice(0, 6);
    if (!titles.length) return null;

    const pages = await commonsFetchImageInfo(titles);
    const bestPage = pages
      .map((p) => ({ p, s: scoreCommonsPage(evTokens, p) }))
      .sort((a, b) => b.s - a.s)[0]?.p;

    if (bestPage) {
      const mapped = toMappingFromCommons(bestPage);
      if (mapped.url) return mapped;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

function readExistingMap(outPath) {
  try {
    const txt = fs.readFileSync(outPath, "utf-8");
    const data = JSON.parse(txt);
    if (data && typeof data === "object") return data;
    return {};
  } catch {
    return {};
  }
}

function ensureDirExists(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

async function main() {
  console.log(`[enrich] Fetching up to ${MAX_EVENTS} events missing images…`);
  //const rows = await fetchEventsMissingImages(MAX_EVENTS);
  const rows = TARGET_UID
  ? [await fetchOneByUid(TARGET_UID)].filter(Boolean)
  : await fetchEventsMissingImages(MAX_EVENTS);

  console.log(`[enrich] TARGET_UID=${TARGET_UID || "(none)"}; rows=${rows.length}`);
  //
  console.log(`[enrich] Found ${rows.length} events without images`);

  ensureDirExists(OUT_PATH);
  const existing = readExistingMap(OUT_PATH);

  const limiter = createLimiter(CONCURRENCY);

  let done = 0;
  let added = 0;

  const tasks = rows.map((row) =>
    limiter(async () => {
      const uid = String(row?.uid || "").trim();
      const slug = String(row?.slug || "").trim();
      if (!uid && !slug) return;

      // Don't overwrite existing entries
      if (uid && existing[uid]?.url) {
        done += 1;
        return;
      }

      const picked = await pickBestImageForEvent(row);
      // small delay to be gentle on APIs
      await sleep(250);

      if (picked?.url) {
        const entry = {
          ...picked,
          // optional: keep a tiny trace for debugging
          q: buildSearchQuery(row),
          updated_at: new Date().toISOString(),
        };
        if (uid) existing[uid] = entry;
        // Optionally also map by slug
        if (slug && !existing[slug]) existing[slug] = entry;
        added += 1;
        console.log(`[enrich] + ${uid || slug} -> ${picked.provider}`);
      } else {
        console.log(`[enrich] - ${uid || slug} (no match)`);
      }

      done += 1;
      if (done % 25 === 0) console.log(`[enrich] Progress ${done}/${rows.length}`);
    })
  );

  await Promise.all(tasks);

  fs.writeFileSync(OUT_PATH, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  console.log(`[enrich] Wrote ${OUT_PATH} (added ${added} entries)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
