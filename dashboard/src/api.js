// The only place that knows where data comes from.
// VITE_API_URL = the Function App URL when the site is hosted separately (storage static website).
const BASE = import.meta.env.VITE_API_URL || "";
const MOCK = import.meta.env.VITE_USE_MOCK === "true";
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

const events = [
  { id: 9, asset_id: 2, asset_name: "HP Laptop CS-02", zone_id: "DEPT_CS1", event_type: "tamper", is_anomaly: true, created_at: ago(12) },
  { id: 8, asset_id: 3, asset_name: "Dell Monitor CS-03", zone_id: "DEPT_CS2", event_type: "entry", is_anomaly: false, created_at: ago(95) },
  { id: 7, asset_id: 5, asset_name: "Lenovo Laptop CS-05", zone_id: "DEPT_CS3", event_type: "exit", is_anomaly: true, created_at: ago(240) },
  { id: 6, asset_id: null, asset_name: "Gateway DEPT_CS3", zone_id: "DEPT_CS3", event_type: "gateway_offline", is_anomaly: true, created_at: ago(900) },
];
const MOCK_DATA = {
  "/api/zones": [
    { zone_id: "DEPT_CS1", zone_name: "Computer Science Department1", gateway_online: true, assets: [
      { asset_id: 1, asset_name: "Dell Laptop CS-01", status: "ok", checked_out: false, last_seen: ago(20) },
      { asset_id: 2, asset_name: "HP Laptop CS-02", status: "alert", checked_out: false, last_seen: ago(12) } ] },
    { zone_id: "DEPT_CS2", zone_name: "Computer Science Department2", gateway_online: true, assets: [
      { asset_id: 3, asset_name: "Dell Monitor CS-03", status: "ok", checked_out: false, last_seen: ago(95) },
      { asset_id: 4, asset_name: "HP Monitor CS-04", status: "ok", checked_out: true, last_seen: ago(3000) } ] },
    { zone_id: "DEPT_CS3", zone_name: "Computer Science Department3", gateway_online: false, assets: [
      { asset_id: 5, asset_name: "Lenovo Laptop CS-05", status: "missing", checked_out: false, last_seen: ago(240) },
      { asset_id: 6, asset_name: "Network Router CS-06", status: "ok", checked_out: false, last_seen: ago(700) } ] },
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
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return { data: await res.json(), ms: Math.round(performance.now() - t0) };
}
