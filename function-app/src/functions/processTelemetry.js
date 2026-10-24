import { app } from "@azure/functions";
import { pool, isTransient } from "../lib/db.js";
import { cfg } from "../lib/config.js";
import { evaluate } from "../lib/rules.js";
import { sendAlert } from "../lib/alerts.js";

const TYPES = new Set(["entry", "exit", "tamper", "heartbeat"]);

function decode(raw) {
  if (raw instanceof Uint8Array) raw = Buffer.from(raw).toString("utf8");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function findZone(client, msg) {
  const byGw = await client.query("SELECT zone_id, zone_name FROM zones WHERE gateway_id = $1", [msg.gateway_id]);
  if (byGw.rows[0]) return byGw.rows[0];
  const byId = await client.query("SELECT zone_id, zone_name FROM zones WHERE zone_id = $1", [msg.zone_id]);
  return byId.rows[0];
}

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== "object" || !TYPES.has(msg.event_type)) {
    ctx.warn("Skipping malformed message:", JSON.stringify(msg));
    return;
  }
  const client = await pool.connect();
  let alert = null;
  try {
    await client.query("BEGIN");

    const zone = await findZone(client, msg);
    if (!zone) { ctx.warn(`No zone for gateway ${msg.gateway_id}`); await client.query("ROLLBACK"); return; }

    // Any message proves the gateway is alive.
    await client.query("UPDATE zones SET last_heartbeat = now(), gateway_online = true WHERE zone_id = $1", [zone.zone_id]);

    if (msg.event_type === "heartbeat") {
      const ids = Array.isArray(msg.tags_present) ? msg.tags_present.filter(Number.isInteger) : [];
      // last_seen_passive = "tag is in range but never had an entry event yet"
      // only update last_seen (movement) if the asset has already entered once.
      if (ids.length) {
        await client.query(
          `UPDATE assets SET last_seen_passive = now(),
             last_seen = CASE WHEN last_seen IS NOT NULL THEN now() ELSE last_seen END
           WHERE tag_id = ANY($1::int[])`, [ids]);
      }
      await client.query("COMMIT");
      ctx.log(`heartbeat ${msg.gateway_id} tags=[${ids}]`);
      return;
    }

    const asset = (await client.query("SELECT asset_id, asset_name FROM assets WHERE tag_id = $1", [msg.tag_id])).rows[0];
    if (!asset) { ctx.warn(`Unknown tag_id ${msg.tag_id}, skipping`); await client.query("COMMIT"); return; }

    const tamper = msg.tamper_flag === 1 || msg.tamper_flag === true || msg.event_type === "tamper";
    const hasCheckout = msg.event_type === "exit" && !tamper
      ? (await client.query(
          `SELECT 1 FROM authorized_checkouts
           WHERE asset_id = $1 AND now() BETWEEN valid_from AND valid_until LIMIT 1`, [asset.asset_id])).rowCount > 0
      : false;

    const verdict = evaluate({ eventType: msg.event_type, tamper, hasCheckout, now: new Date(), offHours: cfg.offHours });
    const isAnomaly = verdict !== null;
    const status = verdict ? verdict.status : "ok";

    await client.query(
      `INSERT INTO events (asset_id, zone_id, event_type, motion_flag, tamper_flag, is_anomaly, battery_pct, rssi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [asset.asset_id, zone.zone_id, msg.event_type, !!msg.motion_flag, tamper, isAnomaly, msg.battery_pct ?? null, msg.rssi ?? null]);

    if (msg.event_type === "entry") {
      await client.query(
        "UPDATE assets SET current_zone_id=$2, status=$3, checked_out=false, last_seen=now() WHERE asset_id=$1",
        [asset.asset_id, zone.zone_id, status]);
    } else if (msg.event_type === "exit") {
      await client.query(
        "UPDATE assets SET status=$2, checked_out=$3, last_seen=now() WHERE asset_id=$1",
        [asset.asset_id, status, hasCheckout]);
    } else {
      await client.query("UPDATE assets SET status=$2, last_seen=now() WHERE asset_id=$1", [asset.asset_id, status]);
    }

    await client.query("COMMIT");
    if (isAnomaly) {
      alert = { assetName: asset.asset_name, zoneName: zone.zone_name, eventType: msg.event_type,
                reason: verdict.reason, timestamp: msg.timestamp || new Date().toISOString() };
    }
    ctx.log(`${msg.event_type} asset=${asset.asset_id} zone=${zone.zone_id} anomaly=${isAnomaly}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // After commit, so a failed email can never lose the event.
  if (alert) await sendAlert(alert).catch((e) => ctx.error("sendAlert failed:", e));
}

app.eventHub("processTelemetry", {
  connection: "IOTHUB_CONNECTION",
  eventHubName: "%IOTHUB_EVENTHUB_NAME%",
  consumerGroup: "$Default",
  cardinality: "one", // one message per invocation: a retry never duplicates others
  retry: { strategy: "fixedDelay", maxRetryCount: 5, delayInterval: { seconds: 5 } },
  handler: async (raw, ctx) => {
    let msg;
    try { msg = decode(raw); } catch (err) { ctx.error("Unparseable message, dropped:", err); return; }
    try {
      await handleMessage(msg, ctx);
    } catch (err) {
      if (isTransient(err)) { ctx.error("DB unavailable, will retry:", err.message); throw err; }
      ctx.error("Failed to process message (not retrying):", err);
    }
  },
});
