import { useEffect, useState, useCallback } from "react";
import { get, checkout } from "./api.js";

const POLL_MS = 5000;

const ICONS = {
  laptop:  "M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  router:  "M4 14h16v6H4zM8 17h.01M12 17h.01M8 14V8M16 14V8",
  box:     "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  check:   "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 12l3 3 5-6",
  alert:   "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  wifi:    "M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01",
  entry:   "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  exit:    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  shield:  "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM12 8v5M12 16h.01",
  clock:   "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  silent:  "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM4.9 4.9l14.2 14.2",
  x:       "M18 6 6 18M6 6l12 12",
  checkout:"M9 12l2 2 4-4m6 2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  revoke:  "M10 14l2-2m0 0 2-2m-2 2-2-2m2 2 2 2m7-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  filter:  "M3 4h18M7 8h10M11 12h6M13 16h2",
};
const Icon = ({ name, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name] || ICONS.box} /></svg>
);
const deviceIcon = (n = "") =>
  /laptop/i.test(n) ? "laptop" : /monitor|display/i.test(n) ? "monitor" : /router|switch/i.test(n) ? "router" : "box";

const STATUS = {
  ok:      { label: "In place",        tone: "ok" },
  alert:   { label: "Needs attention", tone: "bad" },
  missing: { label: "Missing",         tone: "warn" },
};
const EVENT = {
  entry:           { label: "entered",                   icon: "entry",  tone: "ok" },
  exit:            { label: "left",                      icon: "exit",   tone: "warn" },
  tamper:          { label: "tamper switch pressed in",  icon: "shield", tone: "bad" },
  silent:          { label: "stopped reporting in",      icon: "silent", tone: "warn" },
  gateway_offline: { label: "gateway went offline in",   icon: "wifi",   tone: "bad" },
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function ago(iso, now) {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// Show last-seen label: prefer movement time, fall back to passive heartbeat signal.
function lastSeenLabel(asset, now) {
  if (asset.checked_out) return "Checked out with approval";
  const mv = ago(asset.last_seen, now);
  if (mv) return `Last seen ${mv}`;
  const ps = ago(asset.last_seen_passive, now);
  if (ps) return `In range ${ps} (no movement yet)`;
  return "No signal yet";
}

function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <circle cx="17" cy="17" r="15.5" fill="none" stroke="#7fb0ff" strokeWidth="1.5" opacity=".55" />
      <circle cx="17" cy="17" r="9.5"  fill="none" stroke="#7fb0ff" strokeWidth="1.5" opacity=".8" />
      <circle cx="17" cy="17" r="4" fill="#fff" />
    </svg>
  );
}

function StatusBand({ zones, loaded }) {
  const assets  = zones.flatMap((z) => z.assets);
  const n       = { ok: 0, alert: 0, missing: 0 };
  assets.forEach((a) => { n[a.status] = (n[a.status] || 0) + 1; });
  const flagged = n.alert + n.missing;
  const offline = zones.filter((z) => !z.gateway_online).length;
  const total   = assets.length || 1;
  let headline  = "Checking your assets";
  if (loaded) headline = flagged || offline ? "Something needs your attention" : "All assets are where they should be";
  const parts = [
    `${assets.length} asset${assets.length === 1 ? "" : "s"} tracked in ${zones.length} department${zones.length === 1 ? "" : "s"}`,
    flagged ? `${flagged} flagged` : null,
    offline ? `${offline} gateway${offline > 1 ? "s" : ""} offline` : null,
  ].filter(Boolean);
  return (
    <section className={`band ${flagged || offline ? "band-bad" : ""}`} aria-live="polite">
      <div className="wrap">
        <h2>{headline}</h2>
        <p>{loaded ? parts.join(", ") : "Loading live data"}</p>
        <div className="bar" role="img" aria-label={`${n.ok} in place, ${n.alert} need attention, ${n.missing} missing`}>
          <span className="seg ok"   style={{ flex: n.ok / total }} />
          <span className="seg bad"  style={{ flex: n.alert / total }} />
          <span className="seg warn" style={{ flex: n.missing / total }} />
        </div>
        <ul className="legend">
          <li><i className="dot ok"   />{n.ok} in place</li>
          <li><i className="dot bad"  />{n.alert} need attention</li>
          <li><i className="dot warn" />{n.missing} missing</li>
        </ul>
      </div>
    </section>
  );
}

function Zone({ zone, now, onPick, onCheckout }) {
  const flagged = zone.assets.filter((a) => a.status !== "ok").length;
  return (
    <section className="zone" aria-label={zone.zone_name}>
      <header>
        <div>
          <h3>{zone.zone_name}</h3>
          <p className="sub">{flagged ? `${flagged} of ${zone.assets.length} need attention` : zone.assets.length ? "Everything in place" : "No assets assigned"}</p>
        </div>
        <span className={`pill ${zone.gateway_online ? "ok" : "bad"}`}>
          <Icon name="wifi" size={15} />{zone.gateway_online ? "Gateway online" : "Gateway offline"}
        </span>
      </header>
      <ul>
        {zone.assets.map((a) => {
          const st = STATUS[a.status] || STATUS.ok;
          return (
            <li key={a.asset_id}>
              <button className="asset" onClick={() => onPick(a.asset_id)}>
                <span className={`tile ${st.tone}`}><Icon name={deviceIcon(a.asset_name)} /></span>
                <span className="meta">
                  <strong>{a.asset_name}</strong>
                  <span>{lastSeenLabel(a, now)}</span>
                </span>
                <span className={`badge ${st.tone}`}>{st.label}</span>
              </button>
              {/* Checkout action row */}
              <div className="checkout-row">
                {a.checked_out ? (
                  <button className="co-btn revoke" onClick={() => onCheckout(a.asset_id, "revoke", a.asset_name)}
                          title="Revoke checkout authorisation">
                    <Icon name="revoke" size={14} /> Revoke checkout
                  </button>
                ) : (
                  <button className="co-btn approve" onClick={() => onCheckout(a.asset_id, "approve", a.asset_name)}
                          title="Approve asset checkout for 8 hours">
                    <Icon name="checkout" size={14} /> Approve checkout
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {!zone.assets.length && <li className="empty">Assign an asset to this department to start tracking.</li>}
      </ul>
    </section>
  );
}

function Feed({ items, now, names, empty }) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return (
    <ol className="feed">
      {items.map((e) => {
        const ev = EVENT[e.event_type] || { label: e.event_type, icon: "box", tone: "warn" };
        return (
          <li key={e.id}>
            <span className={`ico ${e.is_anomaly ? "bad" : ev.tone === "bad" ? "bad" : "ok"}`}>
              <Icon name={ev.icon} size={17} />
            </span>
            <div>
              <strong>{e.asset_name}</strong>
              <span>{ev.label} {names[e.zone_id] || e.zone_id}
                {e.is_anomaly && e.event_type !== "tamper" && e.event_type !== "gateway_offline" && e.event_type !== "silent"
                  ? " without approval" : ""}
              </span>
            </div>
            <time dateTime={e.created_at} title={new Date(e.created_at).toLocaleString()}>
              {ago(e.created_at, now)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}

// Date range picker used inside the history drawer.
function DateFilter({ from, to, onChange }) {
  return (
    <div className="date-filter">
      <Icon name="filter" size={15} />
      <label>
        From
        <input type="date" value={from} max={to || undefined}
               onChange={(e) => onChange(e.target.value, to)} />
      </label>
      <label>
        To
        <input type="date" value={to} min={from || undefined}
               onChange={(e) => onChange(from, e.target.value)} />
      </label>
      {(from || to) && (
        <button className="co-btn" onClick={() => onChange("", "")} title="Clear filter">Clear</button>
      )}
    </div>
  );
}

function History({ id, now, names, onClose }) {
  const [h, setH]       = useState(null);
  const [err, setErr]   = useState(null);
  const [from, setFrom] = useState("");
  const [to, setTo]     = useState("");

  const load = useCallback(() => {
    let live = true;
    setH(null); setErr(null);
    const params = { limit: 100, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to + "T23:59:59").toISOString() } : {}) };
    get(`/api/assets/${id}/events`, params)
      .then((r) => live && setH(r.data))
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [id, from, to]);

  useEffect(load, [load]);

  const handleDateChange = (f, t) => { setFrom(f); setTo(t); };

  const st       = h && (STATUS[h.asset.status] || STATUS.ok);
  const incidents = h ? h.events.filter((e) => e.is_anomaly).length : 0;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Asset history">
        <button className="close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        {err && <p className="empty">Could not load history ({err}). Close and try again.</p>}
        {!h && !err && <p className="empty">Loading history…</p>}
        {h && (<>
          <div className="dhead">
            <span className={`tile big ${st.tone}`}><Icon name={deviceIcon(h.asset.asset_name)} size={26} /></span>
            <div><h3>{h.asset.asset_name}</h3><span className={`badge ${st.tone}`}>{st.label}</span></div>
          </div>
          <dl className="facts">
            <div><dt>Home department</dt><dd>{names[h.asset.home_zone_id] || h.asset.home_zone_id}</dd></div>
            <div><dt>Incidents</dt><dd>{incidents}</dd></div>
            <div><dt>Last movement</dt><dd>{ago(h.asset.last_seen, now) || "—"}</dd></div>
            <div><dt>Last in range</dt>
              <dd title="Updated on every heartbeat even without movement">
                {ago(h.asset.last_seen_passive, now) || ago(h.asset.last_seen, now) || "—"}
              </dd>
            </div>
            <div><dt>Tag battery</dt><dd>{h.events[0]?.battery_pct != null ? `${h.events[0].battery_pct}%` : "unknown"}</dd></div>
            <div><dt>Checked out</dt><dd>{h.asset.checked_out ? "Yes" : "No"}</dd></div>
          </dl>

          <h4>Filter history</h4>
          <DateFilter from={from} to={to} onChange={handleDateChange} />

          <h4 style={{ marginTop: "16px" }}>
            Movement history {(from || to) && <span className="muted-badge">filtered</span>}
          </h4>
          <Feed
            items={h.events.map((e) => ({ ...e, asset_name: new Date(e.created_at).toLocaleString() }))}
            now={now} names={names}
            empty={from || to ? "No events in this date range." : "No movement recorded yet."}
          />
        </>)}
      </aside>
    </>
  );
}

// Toast notification for checkout actions.
function Toast({ msg, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return <div className="toast" role="status">{msg}</div>;
}

export default function App() {
  const [zones,   setZones]   = useState([]);
  const [events,  setEvents]  = useState([]);
  const [alerts,  setAlerts]  = useState([]);
  const [lastOk,  setLastOk]  = useState(null);
  const [latency, setLatency] = useState(null);
  const [error,   setError]   = useState(null);
  const [loaded,  setLoaded]  = useState(false);
  const [picked,  setPicked]  = useState(null);
  const [toast,   setToast]   = useState(null);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const [z, e, a] = await Promise.all([
        get("/api/zones"),
        get("/api/events", { limit: 50 }),
        get("/api/alerts",  { limit: 20 }),
      ]);
      setZones(z.data); setEvents(e.data); setAlerts(a.data);
      setLatency(Math.max(z.ms, e.ms, a.ms)); setLastOk(Date.now()); setError(null);
    } catch (err) { setError(err.message); } finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Handle checkout approve / revoke from the zone card.
  const handleCheckout = useCallback(async (assetId, action, assetName) => {
    const label = action === "approve" ? "approved" : "revoked";
    try {
      await checkout(assetId, action);
      setToast(`Checkout ${label} for ${assetName}`);
      refresh();
    } catch (err) {
      setToast(`Failed: ${err.message}`);
    }
  }, [refresh]);

  const names = Object.fromEntries(zones.map((z) => [z.zone_id, z.zone_name]));

  return (
    <div className="app">
      <header className="top">
        <div className="wrap row">
          <div className="brand">
            <Logo />
            <div><h1>Nodemon</h1><p>Asset tracking and theft detection</p></div>
          </div>
          <div className={`live ${error ? "down" : ""}`} role="status">
            <span className="pulse" aria-hidden="true" />
            {error ? "Connection lost" : lastOk ? `Live, updated ${Math.round((now - lastOk) / 1000)}s ago` : "Connecting"}
            {!error && latency != null && <span className="ms">{latency} ms</span>}
          </div>
        </div>
      </header>

      <StatusBand zones={zones} loaded={loaded} />

      <main className="wrap">
        {error && (
          <div className="banner">
            <Icon name="alert" size={18} />
            Cannot reach the server ({error}). Showing last data, retrying every {POLL_MS / 1000}s.
          </div>
        )}

        <h2 className="sec">Departments</h2>
        <div className="zones">
          {zones.map((z) => (
            <Zone key={z.zone_id} zone={z} now={now} onPick={setPicked} onCheckout={handleCheckout} />
          ))}
          {loaded && !zones.length && <p className="empty">No departments found. Check that the database is seeded.</p>}
        </div>

        <div className="panels">
          <section className="panel">
            <h2 className="sec">Recent activity</h2>
            <Feed items={events} now={now} names={names}
                  empty="No movement yet. Carry a tag past a gateway to see it here." />
          </section>
          <section className="panel">
            <h2 className="sec">Alerts</h2>
            <Feed items={alerts} now={now} names={names}
                  empty="No alerts. Unapproved exits, tampering and silent devices appear here." />
          </section>
        </div>
        <footer className="foot">
          Data refreshes every {POLL_MS / 1000} seconds. Select an asset to see its full history.
        </footer>
      </main>

      {picked && <History id={picked} now={now} names={names} onClose={() => setPicked(null)} />}
      {toast  && <Toast msg={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
