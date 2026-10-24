// The only place that knows where data comes from.
// VITE_API_URL  = the Function App URL when hosted separately.
// VITE_API_KEY  = the X-Api-Key secret (must match API_KEY env var on the Function App).
// VITE_USE_MOCK = "true" for local UI development without real hardware.
const BASE    = import.meta.env.VITE_API_URL || "";
const API_KEY = import.meta.env.VITE_API_KEY || "";
const MOCK    = import.meta.env.VITE_USE_MOCK === "true";
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

const events = [
  { id: 4, asset_id: 3, asset_name: "Dell Monitor CS-03", zone_id: "DEPT_CS2", event_type: "tamper",  is_anomaly: true,  created_at: ago(40) },
  { id: 3, asset_id: 1, asset_name: "Dell Laptop CS-01",  zone_id: "DEPT_CS1", event_type: "entry",   is_anomaly: false, created_at: ago(310) },
  { id: 2, asset_id: 1, asset_name: "Dell Laptop CS-01",  zone_id: "DEPT_CS1", event_type: "exit",    is_anomaly: true,  created_at: ago(900) },
  { id: 1, asset_id: 3, asset_name: "Dell Monitor CS-03", zone_id: "DEPT_CS2", event_type: "entry",   is_anomaly: false, created_at: ago(2400) },
];
const MOCK_DATA = {
  "/api/zones": [
    { zone_id: "DEPT_CS1", zone_name: "Computer Science Department 1", gateway_online: true, assets: [
      { asset_id: 1, asset_name: "Dell Laptop CS-01", status: "ok", checked_out: false, last_seen: ago(20), last_seen_passive: ago(15) } ] },
    { zone_id: "DEPT_CS2", zone_name: "Computer Science Department 2", gateway_online: true, assets: [
      { asset_id: 3, asset_name: "Dell Monitor CS-03", status: "alert", checked_out: false, last_seen: null, last_seen_passive: ago(40) } ] },
  ],
  "/api/events": events,
  "/api/alerts": events.filter((e) => e.is_anomaly),
};

function mockAsset(id) {
  const z = MOCK_DATA["/api/zones"].flatMap((x) => x.assets).find((a) => a.asset_id === id);
  return { asset: { ...z, home_zone_id: "DEPT_CS1", current_zone_id: "DEPT_CS1" },
           events: events.filter((e) => e.asset_id === id).map((e) => ({ ...e, battery_pct: 82, rssi: -67 })) };
}

// Returns { data, ms } so the UI can show round-trip latency.
export async function get(path, params = {}) {
  const t0 = performance.now();
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 80));
    const m = /^\/api\/assets\/(\d+)\/events$/.exec(path);
    const data = m ? mockAsset(Number(m[1])) : MOCK_DATA[path];
    return { data: params.limit && Array.isArray(data) ? data.slice(0, params.limit) : data, ms: Math.round(performance.now() - t0) };
  }
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""))
  ).toString();
  const headers = API_KEY ? { "X-Api-Key": API_KEY } : {};
  const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, { headers });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return { data: await res.json(), ms: Math.round(performance.now() - t0) };
}

// POST helper — used for checkout approve/revoke.
export async function post(path, body) {
  if (MOCK) { await new Promise((r) => setTimeout(r, 80)); return { data: { ok: true }, ms: 80 }; }
  const headers = { "Content-Type": "application/json", ...(API_KEY ? { "X-Api-Key": API_KEY } : {}) };
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `${path} returned ${res.status}`); }
  return { data: await res.json(), ms: 0 };
}
