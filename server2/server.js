// BlazeTV server: no dependencies, needs Node 18+.
// Run:  OWNER_TOKEN=your-secret TEST_MODE=1 node server.js
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const TEST_MODE = process.env.TEST_MODE === "1";        // lets the Get Access button grant access WITHOUT payment (testing only)
const TRUST_PROXY = process.env.TRUST_PROXY === "1";    // set only if you run behind a proxy/host that sets X-Forwarded-For
if (!OWNER_TOKEN) { console.error("Set OWNER_TOKEN first, e.g. OWNER_TOKEN=mysecret node server.js"); process.exit(1); }

const DATA = path.join(__dirname, "data"), VID = path.join(DATA, "videos"), DBF = path.join(DATA, "db.json");
fs.mkdirSync(VID, { recursive: true });
let db = { videos: [], access: {} };           // access: { "<ip>": [ {tier, exp} ] }  exp 0 = lifetime
try { db = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch (e) {}
db.requests = db.requests || []; db.users = db.users || {};   // users: { "<ip>": {name, at, last} }                 // "I've paid" requests waiting for the owner
const save = () => fs.writeFileSync(DBF, JSON.stringify(db));

const DUR = { day: 864e5, week: 6048e5, month: 2592e6, lifetime: 0 };

const clientIp = req => {
  let a = req.socket.remoteAddress || "";
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) a = String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return a.replace(/^::ffff:/, "");
};
const isOwner = (req, u) => {
  const t = Buffer.from(String(req.headers["x-owner-token"] || u.searchParams.get("t") || ""));
  const o = Buffer.from(OWNER_TOKEN);
  return t.length === o.length && crypto.timingSafeEqual(t, o);
};

// Highest tier among this IP's unexpired purchases (Diamond VIP includes VIP).
function access(ip) {
  const now = Date.now(); let tier = 0, exp = null;
  for (const g of db.access[ip] || []) {
    if (g.exp && g.exp < now) continue;
    if (g.tier > tier) { tier = g.tier; exp = g.exp; }
    else if (g.tier === tier && exp !== 0 && (g.exp === 0 || g.exp > exp)) exp = g.exp;
  }
  return { tier, exp };
}
function grant(ip, tier, dur) {
  const list = (db.access[ip] || []).filter(g => !g.exp || g.exp > Date.now());
  list.push({ tier, exp: DUR[dur] ? Date.now() + DUR[dur] : 0 });
  db.access[ip] = list; save();
}

const nameOf = ip => (db.users[ip] || {}).name || null;
function touch(ip) { const u = db.users[ip]; if (u && Date.now() - u.last > 6e4) { u.last = Date.now(); save(); } }
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readJson = req => new Promise(r => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch (e) { r({}); } });
});

function stream(req, res, file, type) {
  const size = fs.statSync(file).size, r = req.headers.range;
  if (r) {
    const m = /bytes=(\d*)-(\d*)/.exec(r) || [];
    const s = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${size}`, "Accept-Ranges": "bytes", "Content-Length": e - s + 1, "Content-Type": type });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": size, "Content-Type": type, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, ip = clientIp(req), owner = isOwner(req, u);
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
    }
    if (p === "/api/me") { const a = access(ip); touch(ip); return send(res, 200, { tier: owner ? 2 : a.tier, exp: a.exp, owner, name: nameOf(ip), pending: db.requests.filter(r => r.ip === ip && r.status === "pending").length }); }

    if (p === "/api/videos" && req.method === "GET")
      return send(res, 200, db.videos.map(({ id, title, cat }) => ({ id, title, cat })));

    if (p.startsWith("/video/")) {                        // the file is only sent if this IP has the tier
      const v = db.videos.find(x => x.id === p.slice(7));
      if (!v) return send(res, 404, { error: "not found" });
      if (!owner && access(ip).tier < v.cat) return send(res, 403, { error: "no access" });
      return stream(req, res, path.join(VID, v.id), v.type);
    }

    if (p === "/api/upload" && req.method === "POST") {
      if (!owner) return send(res, 403, { error: "owner only" });
      const cat = +req.headers["x-cat"];
      if (![0, 1, 2].includes(cat)) return send(res, 400, { error: "category required" });
      const id = crypto.randomBytes(8).toString("hex"), out = fs.createWriteStream(path.join(VID, id));
      req.pipe(out);
      out.on("finish", () => {
        db.videos.unshift({ id, title: decodeURIComponent(req.headers["x-title"] || "Untitled"), cat, type: req.headers["content-type"] || "video/mp4" });
        save(); send(res, 200, { id });
      });
      return;
    }

    if (req.method === "DELETE" && p.startsWith("/api/videos/")) {
      if (!owner) return send(res, 403, { error: "owner only" });
      const id = p.slice(12), i = db.videos.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: "not found" });
      db.videos.splice(i, 1); save(); fs.unlink(path.join(VID, id), () => {});
      return send(res, 200, { ok: true });
    }

    // Username: attached to the visitor's IP. Names are unique (not case sensitive).
    if (p === "/api/login" && req.method === "POST") {
      const n = String((await readJson(req)).name || "").trim();
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(n)) return send(res, 400, { error: "Use 3-20 letters, numbers, . _ or -" });
      if (Object.entries(db.users).some(([k, u]) => k !== ip && u.name.toLowerCase() === n.toLowerCase())) return send(res, 409, { error: "That username is taken" });
      db.users[ip] = { name: n, at: (db.users[ip] || {}).at || Date.now(), last: Date.now() };
      save(); return send(res, 200, { name: n });
    }

    // Owner dashboard data
    if (p === "/api/admin" && req.method === "GET") {
      if (!owner) return send(res, 403, { error: "owner only" });
      const live = Object.keys(db.access).map(k => access(k).tier);
      return send(res, 200, {
        videos: [0, 1, 2].map(c => db.videos.filter(v => v.cat === c).length),
        users: Object.entries(db.users).map(([k, u]) => ({ ip: k, name: u.name, at: u.at, last: u.last, ...access(k) })),
        members: [live.filter(t => t === 1).length, live.filter(t => t === 2).length],
        requests: db.requests.slice(0, 20)
      });
    }
    if (req.method === "POST" && p.startsWith("/api/admin/")) {      // /api/admin/remove/<ip> or /api/admin/revoke/<ip>
      if (!owner) return send(res, 403, { error: "owner only" });
      const [, , , act, rawIp] = p.split("/"), target = decodeURIComponent(rawIp || "");
      if (act === "remove") delete db.users[target]; else if (act === "revoke") delete db.access[target]; else return send(res, 404, { error: "not found" });
      save(); return send(res, 200, { ok: true });
    }

    // Buyer pressed "I've paid": saved as pending. The owner checks Keepz, then approves it.
    if (p === "/api/request" && req.method === "POST") {
      const b = await readJson(req);
      if (![1, 2].includes(b.tier) || !(b.dur in DUR)) return send(res, 400, { error: "bad request" });
      if (db.requests.filter(r => r.ip === ip && r.status === "pending").length >= 5) return send(res, 429, { error: "too many pending" });
      if (!nameOf(ip)) return send(res, 401, { error: "username required" });
      db.requests.unshift({ id: crypto.randomBytes(6).toString("hex"), ip, name: nameOf(ip), tier: b.tier, dur: b.dur, note: String(b.note || "").slice(0, 80), at: Date.now(), status: "pending" });
      save(); return send(res, 200, { ok: true });
    }
    if (p === "/api/requests" && req.method === "GET") {
      if (!owner) return send(res, 403, { error: "owner only" });
      return send(res, 200, db.requests.filter(r => r.status === "pending"));
    }
    if (req.method === "POST" && p.startsWith("/api/requests/")) {   // /api/requests/<id>/approve|reject
      if (!owner) return send(res, 403, { error: "owner only" });
      const [, , , id, act] = p.split("/");
      const r = db.requests.find(x => x.id === id && x.status === "pending");
      if (!r) return send(res, 404, { error: "not found" });
      if (act === "approve") { grant(r.ip, r.tier, r.dur); r.status = "approved"; } else r.status = "rejected";
      save(); return send(res, 200, { ok: true });
    }

    // Test-only purchase: grants the caller's IP. Disabled unless TEST_MODE=1.
    if (p === "/api/purchase" && req.method === "POST") {
      if (!TEST_MODE) return send(res, 501, { error: "payments not connected" });
      const b = await readJson(req);
      if (![1, 2].includes(b.tier) || !(b.dur in DUR)) return send(res, 400, { error: "bad request" });
      grant(ip, b.tier, b.dur); return send(res, 200, access(ip));
    }

    // Real purchases: your payment provider's webhook (after verifying payment) calls this with the buyer's IP.
    if (p === "/api/grant" && req.method === "POST") {
      if (!owner) return send(res, 403, { error: "owner only" });
      const b = await readJson(req);
      if (!b.ip || ![1, 2].includes(b.tier) || !(b.dur in DUR)) return send(res, 400, { error: "bad request" });
      grant(b.ip, b.tier, b.dur); return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: "server error" }); }
}).listen(PORT, () => console.log("BlazeTV running on http://localhost:" + PORT));
