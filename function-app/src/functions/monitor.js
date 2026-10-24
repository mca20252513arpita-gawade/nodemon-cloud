import { app } from "@azure/functions";
import { pool } from "../lib/db.js";
import { cfg } from "../lib/config.js";
import { sendAlert } from "../lib/alerts.js";

// Runs every 30 s for fast online→offline detection.
// 1. A gateway whose last_heartbeat is NULL (never seen) or stale → flagged offline once.
// 2. An asset not reported for a while → flagged missing (skips checked-out and offline-gateway assets).
async function run(ctx) {
  // 1. Gateways. UPDATE ... RETURNING makes the flag-once behaviour atomic.
  //    NULL last_heartbeat means "never seen" → treat as offline too.
  const gws = await pool.query(
    `UPDATE zones SET gateway_online = false
     WHERE gateway_online
       AND (last_heartbeat IS NULL OR last_heartbeat < now() - make_interval(mins => $1))
     RETURNING zone_id, zone_name`, [cfg.gatewayOfflineMin]);
  for (const z of gws.rows) {
    await pool.query(
      "INSERT INTO events (asset_id, zone_id, event_type, is_anomaly) VALUES (NULL, $1, 'gateway_offline', true)", [z.zone_id]);
    await sendAlert({ assetName: `Gateway ${z.zone_id}`, zoneName: z.zone_name, eventType: "gateway_offline",
                      reason: `No heartbeat for ${cfg.gatewayOfflineMin}+ minutes`, timestamp: new Date().toISOString() })
      .catch((e) => ctx.error("sendAlert failed:", e));
  }

  // 2. Assets. Skip checked-out assets and assets whose gateway is offline (already one alert).
  const assets = await pool.query(
    `UPDATE assets a SET status = 'missing'
     WHERE a.status = 'ok' AND NOT a.checked_out AND a.last_seen IS NOT NULL
       AND a.last_seen < now() - make_interval(mins => $1)
       AND NOT EXISTS (SELECT 1 FROM zones z
                       WHERE z.zone_id = COALESCE(a.current_zone_id, a.home_zone_id) AND NOT z.gateway_online)
     RETURNING a.asset_id, a.asset_name, COALESCE(a.current_zone_id, a.home_zone_id) AS zone_id,
       (SELECT zone_name FROM zones z WHERE z.zone_id = COALESCE(a.current_zone_id, a.home_zone_id)) AS zone_name`,
    [cfg.assetSilentMin]);
  for (const a of assets.rows) {
    await pool.query(
      "INSERT INTO events (asset_id, zone_id, event_type, is_anomaly) VALUES ($1, $2, 'silent', true)", [a.asset_id, a.zone_id]);
    await sendAlert({ assetName: a.asset_name, zoneName: a.zone_name, eventType: "silent",
                      reason: `Not reported for ${cfg.assetSilentMin}+ minutes`, timestamp: new Date().toISOString() })
      .catch((e) => ctx.error("sendAlert failed:", e));
  }
  ctx.log(`monitor: ${gws.rowCount} gateway(s) offline, ${assets.rowCount} asset(s) silent`);
}

app.timer("monitor", {
  schedule: "*/30 * * * * *",   // every 30 s: fast online→offline detection (was 2 min)
  runOnStartup: false,
  handler: async (_timer, ctx) => {
    try { await run(ctx); } catch (err) { ctx.error("monitor failed (next run retries):", err.message); }
  },
});
