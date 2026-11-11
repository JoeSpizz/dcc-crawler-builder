// Race & Class Builder API: one Netlify Function, data in Netlify Blobs. No password: anyone
// who can open the site can read and change the builds.
//
//   GET    /api/builds?since=<version>  -> { builds: [...], version }, or { unchanged: true, version }
//                                         when nothing changed since <version> (cheap polling)
//   PUT    /api/builds/:id              -> save one build        body { build, baseRev?, force? }
//                                         409 + { build } when someone else saved it since baseRev
//   POST   /api/builds                  -> import several builds body { builds: [...] }
//                                         (same id replaces, new ids are added; nothing is removed)
//   DELETE /api/builds/:id              -> delete a build
//
// Every build lives in one blob ("builds"), so a page load or a poll is a single read.
// Guardrails, since the API is open to the internet: every field is trimmed to a sane size, and
// the site holds at most MAX_BUILDS builds (env var, default 1000) and MAX_TOTAL bytes.

import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";

const KEY = "builds";
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const isId = (v) => typeof v === "string" && ID.test(v);   // ID.test(undefined) would test "undefined"
const MAX_BODY = 64 * 1024;            // one build
const MAX_IMPORT = 2 * 1024 * 1024;    // an import file
const MAX_TOTAL = 8 * 1024 * 1024;     // everything stored
const MAX_TRAITS = 40;                 // benefits (or detriments) per build

class HttpError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const maxBuilds = () => Math.max(1, Math.trunc(Number(Netlify.env.get("MAX_BUILDS"))) || 1000);

async function readBody(req, limit) {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, "That's too much data for one save.");
  try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "Request body isn't valid JSON."); }
}
function checkId(id) {
  if (!isId(id)) throw new HttpError(400, "Invalid id.");
  return id;
}

// Keep only the fields a build has, each cut to a sane length.
const str = (v, n) => String(v ?? "").slice(0, n);
const list = (a) => (Array.isArray(a) ? a : []).slice(0, MAX_TRAITS).map((t) => ({
  id: isId(t?.id) ? t.id : randomUUID(),
  text: str(t?.text, 600),
  cost: Math.max(0, Math.min(10, Math.trunc(Number(t?.cost)) || 0)),
  tier: str(t?.tier, 30),
  color: typeof t?.color === "string" && HEX.test(t.color) ? t.color : "",
}));
function cleanBuild(b, id) {
  const name = str(b?.name, 120).trim();
  if (!name) throw new HttpError(400, "A build needs a name.");
  return {
    id, name,
    kind: b.kind === "class" ? "class" : "race",
    origin: b.origin === "Alien" ? "Alien" : "Earth",
    typeTags: str(b.typeTags, 200),
    flavor: str(b.flavor, 2000),
    benefits: list(b.benefits),
    detriments: list(b.detriments),
  };
}

// Read-modify-write of the one blob that only commits if nobody else wrote in between; retries on a race.
async function update(store, change) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    const doc = cur?.data?.builds ? cur.data : { builds: {} };
    change(doc);
    const size = JSON.stringify(doc).length;
    if (size > MAX_TOTAL) throw new HttpError(507, "This site's storage is full. Delete some old builds first.");
    const res = await store.setJSON(KEY, doc, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return doc;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  }
  throw new HttpError(503, "Too many people saving at once. Try again.");
}
function roomFor(doc, adding) {
  const n = Object.keys(doc.builds).length + adding, max = maxBuilds();
  if (n > max) throw new HttpError(507, `This site is full (${max} builds). Delete some old ones first.`);
}
function stamp(clean, cur) {
  return { ...clean, sheetRev: (cur?.sheetRev || 0) + 1, createdAt: cur?.createdAt || now(), updatedAt: now() };
}

async function handle(req, store) {
  const url = new URL(req.url);
  const [resource, rawId] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  if (resource !== "builds") throw new HttpError(404, "Not found.");
  const method = req.method;

  if (!rawId && method === "GET") {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    const version = cur?.etag || "empty";
    if (url.searchParams.get("since") === version) return json(200, { unchanged: true, version });
    return json(200, { builds: Object.values(cur?.data?.builds || {}), version });
  }

  if (!rawId && method === "POST") {
    const body = await readBody(req, MAX_IMPORT);
    const incoming = (Array.isArray(body.builds) ? body.builds : []).filter((b) => b && typeof b === "object" && String(b.name || "").trim());
    if (!incoming.length) throw new HttpError(400, "No builds to import.");
    const doc = await update(store, (doc) => {
      const fresh = incoming.filter((b) => !(isId(b.id) && doc.builds[b.id])).length;
      roomFor(doc, fresh);
      for (const b of incoming) {
        const id = isId(b.id) ? b.id : randomUUID();
        doc.builds[id] = stamp(cleanBuild(b, id), doc.builds[id]);
      }
    });
    return json(200, { builds: Object.values(doc.builds), imported: incoming.length });
  }

  const id = checkId(rawId);
  if (method === "PUT") {
    const { build, baseRev, force } = await readBody(req, MAX_BODY);
    if (!build || typeof build !== "object") throw new HttpError(400, "Missing build.");
    const clean = cleanBuild(build, id);
    const doc = await update(store, (doc) => {
      const cur = doc.builds[id];
      if (cur && !force && (cur.sheetRev || 0) !== (Number(baseRev) || 0)) throw new HttpError(409, "Someone else changed this build.", { build: cur });
      if (!cur) roomFor(doc, 1);
      doc.builds[id] = stamp(clean, cur);
    });
    return json(200, { build: doc.builds[id] });
  }
  if (method === "DELETE") {
    await update(store, (doc) => { delete doc.builds[id]; });
    return json(200, { ok: true });
  }
  throw new HttpError(405, "Method not allowed.");
}

export default async (req) => {
  try {
    return await handle(req, getStore({ name: "race-class-builder", consistency: "strong" }));
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...(e.data || {}) });
    console.error(e);
    return json(500, { error: "Something went wrong on the server." });
  }
};

export const config = { path: "/api/*" };
