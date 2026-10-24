// Dashboard API, hosted on the same Function App as the processor.
import { app } from "@azure/functions";
import { pool } from "../lib/db.js";

// ---- CORS & auth ----
const CORS_ORIGIN = process.env.DASHBOARD_ORIGIN || "*";
const API_KEY     = process.env.API_KEY || "";   // empty = disabled (local dev)

const corsHeaders = () => ({
  "Access-Control-Allow-Origin":  CORS_ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
});

const json = (body, status = 200) =>
  ({ status, jsonBody: body, headers: corsHeaders() });

// Auth: key sent as ?key= query param (avoids Azure header-stripping on CORS).
function authorized(req) {
  if (!API_KEY) return true;
  return req.query.get("key") === API_KEY;
}

const limitOf = (v, fallback, max = 200) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
};

const safe = (fn) => async (request, context) => {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  try { return await fn(request, context); }
  catch (err) { context.error(`${request.method} ${request.url}:`, err); return json({ error: "Internal server error" }, 500); }
};

const get  = (name, route, handler) =>
  app.http(name, { methods: ["GET"], authLevel: "anonymous", route, handler: safe(handler) });

// Gateway-level events have no asset, so label them by zone.
const EVENT_COLS = `e.id, e.asset_id, COALESCE(a.asset_name, 'Gateway ' || e.zone_id) AS asset_name,
  e.zone_id, e.event_type, e.is_anomaly, e.created_at`;
const EVENT_FROM = "FROM events e LEFT JOIN assets a ON a.asset_id = e.asset_id";

// ---- GET /api/zones ----
get("apiZones", "zones", async () => {
  const { rows } = await pool.query(`
    SELECT z.zone_id, z.zone_name, z.gateway_online,
      COALESCE(json_agg(json_build_object(
        'asset_id', a.asset_id, 'asset_name', a.asset_name, 'status', a.status,
        'checked_out', a.checked_out, 'last_seen', a.last_seen, 'last_seen_passive', a.last_seen_passive
      ) ORDER BY a.asset_id) FILTER (WHERE a.asset_id IS NOT NULL), '[]') AS assets
    FROM zones z
    LEFT JOIN assets a ON COALESCE(a.current_zone_id, a.home_zone_id) = z.zone_id
    GROUP BY z.zone_id, z.zone_name, z.gateway_online
    ORDER BY z.zone_id`);
  return json(rows);
});

// ---- GET /api/events?limit=50&from=ISO&to=ISO ----
get("apiEvents", "events", async (req) => {
  const limit = limitOf(req.query.get("limit"), 50);
  const from  = req.query.get("from");
  const to    = req.query.get("to");
  const conditions = [];
  const params = [];
  if (from) { params.push(from); conditions.push(`e.created_at >= $${params.length}`); }
  if (to)   { params.push(to);   conditions.push(`e.created_at <= $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} ${EVENT_FROM} ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`,
    params);
  return json(rows);
});

// ---- GET /api/alerts?limit=20 ----
get("apiAlerts", "alerts", async (req) => {
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} ${EVENT_FROM} WHERE e.is_anomaly ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
    [limitOf(req.query.get("limit"), 20)]);
  return json(rows);
});

// ---- GET /api/assets/{id}/events?limit=100&from=ISO&to=ISO ----
get("apiAssetHistory", "assets/{id}/events", async (req) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return json({ error: "asset id must be an integer" }, 400);
  const asset = (await pool.query(
    `SELECT asset_id, asset_name, status, home_zone_id, current_zone_id, checked_out, last_seen, last_seen_passive
     FROM assets WHERE asset_id = $1`, [id])).rows[0];
  if (!asset) return json({ error: "asset not found" }, 404);

  const limit = limitOf(req.query.get("limit"), 100, 500);
  const from  = req.query.get("from");
  const to    = req.query.get("to");
  const conditions = ["asset_id = $1"];
  const params = [id];
  if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
  if (to)   { params.push(to);   conditions.push(`created_at <= $${params.length}`); }
  params.push(limit);
  const events = await pool.query(
    `SELECT id, zone_id, event_type, is_anomaly, motion_flag, tamper_flag, battery_pct, rssi, created_at
     FROM events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params);
  return json({ asset, events: events.rows });
});

// ---- GET /api/checkout/{id}?action=approve|revoke&hours=8 ----
// Using GET avoids CORS preflight entirely (no OPTIONS needed for simple requests).
get("apiCheckout", "checkout/{id}", async (req) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return json({ error: "asset id must be an integer" }, 400);

  const action = req.query.get("action");
  if (action !== "approve" && action !== "revoke")
    return json({ error: "action must be 'approve' or 'revoke'" }, 400);

  const asset = (await pool.query(
    "SELECT asset_id, asset_name FROM assets WHERE asset_id = $1", [id])).rows[0];
  if (!asset) return json({ error: "asset not found" }, 404);

  if (action === "revoke") {
    await pool.query("DELETE FROM authorized_checkouts WHERE asset_id = $1 AND valid_until > now()", [id]);
    await pool.query("UPDATE assets SET checked_out = false WHERE asset_id = $1", [id]);
    return json({ ok: true, message: `Checkout revoked for ${asset.asset_name}` });
  }

  const hours = Math.min(Math.max(Number(req.query.get("hours")) || 8, 1), 72);
  await pool.query(
    `INSERT INTO authorized_checkouts (asset_id, valid_from, valid_until)
     VALUES ($1, now(), now() + make_interval(hours => $2))`, [id, hours]);
  await pool.query("UPDATE assets SET checked_out = true WHERE asset_id = $1", [id]);
  return json({ ok: true, message: `Checkout approved for ${asset.asset_name} (${hours}h)` });
});

// ---- GET /api/health ----
get("apiHealth", "health", async () => {
  await pool.query("SELECT 1");
  return json({ ok: true });
});
