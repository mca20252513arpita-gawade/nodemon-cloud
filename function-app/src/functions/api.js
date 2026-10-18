// Dashboard API, hosted on the same Function App as the processor.
// (Static Web Apps is not allowed by the student subscription's region policy.)
import { app } from "@azure/functions";
import { pool } from "../lib/db.js";

// Read-only public API. Set DASHBOARD_ORIGIN to the static site URL to restrict CORS; "*" otherwise.
const CORS = { "Access-Control-Allow-Origin": process.env.DASHBOARD_ORIGIN || "*" };
const json = (body, status = 200) => ({ status, jsonBody: body, headers: CORS });

const limitOf = (v, fallback, max = 200) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : fallback;
};
// Log real errors server-side, return a generic 500 (no DB details leak).
const safe = (fn) => async (request, context) => {
  try { return await fn(request, context); }
  catch (err) { context.error(`${request.method} ${request.url}:`, err); return json({ error: "Internal server error" }, 500); }
};
const get = (name, route, handler) =>
  app.http(name, { methods: ["GET"], authLevel: "anonymous", route, handler: safe(handler) });

// Gateway-level events have no asset, so label them by zone.
const EVENT_COLS = `e.id, e.asset_id, COALESCE(a.asset_name, 'Gateway ' || e.zone_id) AS asset_name,
  e.zone_id, e.event_type, e.is_anomaly, e.created_at`;
const EVENT_FROM = "FROM events e LEFT JOIN assets a ON a.asset_id = e.asset_id";

get("apiZones", "zones", async () => {
  const { rows } = await pool.query(`
    SELECT z.zone_id, z.zone_name, z.gateway_online,
      COALESCE(json_agg(json_build_object(
        'asset_id', a.asset_id, 'asset_name', a.asset_name, 'status', a.status,
        'checked_out', a.checked_out, 'last_seen', a.last_seen
      ) ORDER BY a.asset_id) FILTER (WHERE a.asset_id IS NOT NULL), '[]') AS assets
    FROM zones z
    LEFT JOIN assets a ON COALESCE(a.current_zone_id, a.home_zone_id) = z.zone_id
    GROUP BY z.zone_id, z.zone_name, z.gateway_online
    ORDER BY z.zone_id`);
  return json(rows);
});

get("apiEvents", "events", async (req) => {
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} ${EVENT_FROM} ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
    [limitOf(req.query.get("limit"), 50)]);
  return json(rows);
});

get("apiAlerts", "alerts", async (req) => {
  const { rows } = await pool.query(
    `SELECT ${EVENT_COLS} ${EVENT_FROM} WHERE e.is_anomaly ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
    [limitOf(req.query.get("limit"), 20)]);
  return json(rows);
});

get("apiAssetHistory", "assets/{id}/events", async (req) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return json({ error: "asset id must be an integer" }, 400);
  const asset = (await pool.query(
    `SELECT asset_id, asset_name, status, home_zone_id, current_zone_id, checked_out, last_seen
     FROM assets WHERE asset_id = $1`, [id])).rows[0];
  if (!asset) return json({ error: "asset not found" }, 404);
  const events = (await pool.query(
    `SELECT id, zone_id, event_type, is_anomaly, motion_flag, tamper_flag, battery_pct, rssi, created_at
     FROM events WHERE asset_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [id, limitOf(req.query.get("limit"), 100, 500)]));
  return json({ asset, events: events.rows });
});

get("apiHealth", "health", async () => {
  await pool.query("SELECT 1");
  return json({ ok: true });
});
