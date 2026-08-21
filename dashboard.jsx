import { useState, useEffect, useMemo, useRef, useCallback } from "react";

/**
 * GreenGrid — residential solar + load monitoring dashboard.
 *
 * The live values on this screen come from a simulator, not from hardware.
 * The simulator is deterministic: every quantity is a pure function of the
 * simulation clock, so the same minute always produces the same reading and
 * the 24-hour forecast used by the scheduler agrees with what the gauges will
 * show when that minute arrives.
 *
 * Swapping in a real feed means replacing `sampleAt()` with a reading from the
 * inverter/meter API. Nothing else in the file reads the simulator directly.
 */

// ── System configuration ───────────────────────────────────────────────
const SYSTEM = {
  arrayKwp: 8.5, // DC nameplate at standard test conditions
  tempCoeff: -0.004, // Pmax temperature coefficient, per °C (mono-Si, typical)
  noctRise: 25, // cell temperature rise over ambient at full irradiance, °C
  derate: 0.86, // inverter, wiring, soiling and mismatch losses
  serviceLimitKw: 6.0, // grid connection capacity, used to normalise stress
  importPrice: 0.28, // €/kWh
  exportPrice: 0.09, // €/kWh
};

const SLOT_MIN = 15; // forecast resolution
const SLOTS_PER_DAY = 1440 / SLOT_MIN;
const MAX_HISTORY = 180;

// ── Helpers ────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (n, d = 1) => n.toFixed(d);

const clockLabel = (minuteOfDay) => {
  const h = Math.floor(minuteOfDay / 60) % 24;
  const m = Math.floor(minuteOfDay % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

/**
 * Deterministic value-noise in [-1, 1]. Stands in for the small unmodelled
 * variation a real meter shows. Keyed on the clock, so it is reproducible.
 */
function noise(minute, salt) {
  const x = Math.sin(minute * 0.31 + salt * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// ── Environment ────────────────────────────────────────────────────────
function environmentAt(minute) {
  const hourFloat = (minute % 1440) / 60;

  // Clear-sky irradiance as a half-sine between 06:00 and 18:00.
  const clearSky = Math.max(0, Math.sin(((hourFloat - 6) / 12) * Math.PI));

  // Slow synoptic cloud variation plus faster cumulus scatter.
  const cloudCover = clamp(
    0.35 + 0.28 * Math.sin(minute * 0.0011) + 0.12 * noise(minute, 3),
    0,
    1
  );

  // Cloud transmits some diffuse light rather than blocking outright.
  const irradiance = clamp(clearSky * (1 - 0.75 * cloudCover), 0, 1);

  const airTempC =
    16 + 11 * clearSky - 4 * cloudCover + 2.5 * Math.sin(minute * 0.0007);
  const windMs = clamp(3 + 7 * Math.abs(Math.sin(minute * 0.0009)) + noise(minute, 7), 0, 25);

  return { minute, hourFloat, cloudCover, irradiance, airTempC, windMs };
}

// ── Solar model ────────────────────────────────────────────────────────
/**
 * PVWatts-style derate chain: nameplate × irradiance fraction × temperature
 * correction × system losses. Cell temperature is approximated as ambient
 * plus a rise proportional to irradiance; output falls as the cell heats.
 */
function solarKwAt(env) {
  if (env.irradiance <= 0) return 0;
  const cellTempC = env.airTempC + SYSTEM.noctRise * env.irradiance;
  const tempFactor = 1 + SYSTEM.tempCoeff * (cellTempC - 25);
  const kw =
    SYSTEM.arrayKwp * env.irradiance * clamp(tempFactor, 0.6, 1.1) * SYSTEM.derate;
  return clamp(kw, 0, SYSTEM.arrayKwp);
}

// ── Load model ─────────────────────────────────────────────────────────
/** Always-on plus four occupancy-driven bands. Deterministic per minute. */
function loadKwAt(env) {
  const hour = Math.floor(env.hourFloat);
  const alwaysOn = 0.35; // fridge, router, standby
  const lighting = env.irradiance < 0.15 && (hour >= 6 || hour < 1) ? 0.45 : 0.05;
  const hvac =
    env.airTempC > 27 ? 1.6 : env.airTempC < 14 ? 1.4 : env.airTempC < 18 ? 0.5 : 0.15;
  const cooking =
    (hour >= 7 && hour < 9) || (hour >= 18 && hour < 20) ? 1.4 : 0.05;
  const plugLoads = hour >= 19 || hour < 1 ? 0.65 : 0.2;
  return Math.max(
    0.2,
    alwaysOn + lighting + hvac + cooking + plugLoads + 0.12 * noise(env.minute, 11)
  );
}

// ── Grid stress ────────────────────────────────────────────────────────
/**
 * Stress is how close the connection is to its limit, scaled up during the
 * evening peak (when the wider network is also constrained) and nudged by
 * temperature extremes that drive correlated HVAC demand across the feeder.
 */
function gridStressAt(importKw, env) {
  const hour = Math.floor(env.hourFloat);
  const utilisation = importKw / SYSTEM.serviceLimitKw;
  const peakFactor = hour >= 17 && hour < 21 ? 1.5 : 1.0;
  const thermal = env.airTempC > 30 ? 0.18 : env.airTempC < 4 ? 0.14 : 0;
  return clamp(utilisation * peakFactor + thermal, 0, 1);
}

// ── Single sample ──────────────────────────────────────────────────────
function sampleAt(minute) {
  const env = environmentAt(minute);
  const solarKw = solarKwAt(env);
  const loadKw = loadKwAt(env);
  const netKw = solarKw - loadKw;
  const importKw = Math.max(0, -netKw);
  const exportKw = Math.max(0, netKw);
  return {
    env,
    solarKw,
    loadKw,
    netKw,
    importKw,
    exportKw,
    stress: gridStressAt(importKw, env),
  };
}

// ── Appliances ─────────────────────────────────────────────────────────
/** `kw` is the draw while running; energy is derived from the run length. */
const APPLIANCES = [
  { id: "washer", name: "Washing machine", kw: 1.2, duration: 90, icon: "🫧" },
  { id: "dryer", name: "Tumble dryer", kw: 2.5, duration: 60, icon: "🌀" },
  { id: "dishwasher", name: "Dishwasher", kw: 1.4, duration: 120, icon: "🍽️" },
  { id: "ev", name: "EV charger", kw: 7.2, duration: 240, icon: "⚡" },
  { id: "pool", name: "Pool pump", kw: 1.1, duration: 180, icon: "🏊" },
];

/** 24 hours of surplus at 15-minute resolution, from the start of a sim day. */
function buildForecast(dayIndex) {
  const dayStart = dayIndex * 1440;
  const slots = [];
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const s = sampleAt(dayStart + i * SLOT_MIN);
    slots.push({ minuteOfDay: i * SLOT_MIN, surplusKw: s.exportKw });
  }
  return slots;
}

/**
 * Slides the run window across the forecast day and picks the start with the
 * highest share of the appliance's energy met by solar surplus. Windows that
 * run past midnight wrap into the same day's profile, which is a reasonable
 * approximation while the forecast horizon is a single day.
 */
function scheduleAppliance(appliance, forecast) {
  const slots = Math.max(1, Math.round(appliance.duration / SLOT_MIN));
  const hours = SLOT_MIN / 60;
  const totalKwh = appliance.kw * slots * hours;

  const coverageFrom = (startIdx) => {
    let covered = 0;
    for (let i = 0; i < slots; i++) {
      const slot = forecast[(startIdx + i) % SLOTS_PER_DAY];
      covered += Math.min(appliance.kw, slot.surplusKw) * hours;
    }
    return totalKwh > 0 ? covered / totalKwh : 0;
  };

  let bestIdx = 0;
  let bestCoverage = -1;
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const c = coverageFrom(i);
    if (c > bestCoverage) {
      bestCoverage = c;
      bestIdx = i;
    }
  }

  return {
    ...appliance,
    energyKwh: totalKwh,
    bestStartMinute: bestIdx * SLOT_MIN,
    bestCoverage,
    coverageFrom,
  };
}

// ── Sparkline ──────────────────────────────────────────────────────────
const VB_W = 300;

/**
 * Scales to its container. Pass an explicit domain when two series need to be
 * read against each other — independent auto-scaling would make them
 * look comparable when they are not.
 */
function Sparkline({ data, height = 60, color, fill, domain, baseline }) {
  if (!data || data.length < 2) return null;

  const lo = domain ? domain[0] : Math.min(...data);
  const hi = domain ? domain[1] : Math.max(...data);
  const range = hi - lo || 1;
  const y = (v) => height - ((clamp(v, lo, hi) - lo) / range) * (height - 4) - 2;

  const pts = data.map((v, i) => `${(i / (data.length - 1)) * VB_W},${y(v)}`);
  const line = `M${pts.join(" L")}`;
  const floorY = baseline !== undefined ? y(baseline) : height;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden="true"
    >
      {fill && <path d={`${line} L${VB_W},${floorY} L0,${floorY} Z`} fill={fill} />}
      {baseline !== undefined && (
        <line
          x1="0"
          x2={VB_W}
          y1={floorY}
          y2={floorY}
          stroke="#1e3220"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ── Gauge ──────────────────────────────────────────────────────────────
function Gauge({ value, label, unit, color, max }) {
  const r = 38;
  const cx = 50;
  const cy = 50;
  const toRad = (d) => (d * Math.PI) / 180;
  const arc = (start, end) => {
    const s = { x: cx + r * Math.cos(toRad(start)), y: cy + r * Math.sin(toRad(start)) };
    const e = { x: cx + r * Math.cos(toRad(end)), y: cy + r * Math.sin(toRad(end)) };
    return `M${s.x},${s.y} A${r},${r} 0 ${end - start > 180 ? 1 : 0} 1 ${e.x},${e.y}`;
  };

  const hasValue = typeof value === "number" && Number.isFinite(value);
  const pct = hasValue ? clamp(value / max, 0, 1) : 0;
  const text = hasValue ? (value < 10 ? value.toFixed(2) : value.toFixed(1)) : "—";

  return (
    <div style={{ textAlign: "center" }}>
      <svg width="100%" height="78" viewBox="0 0 100 78" role="img"
        aria-label={`${label}: ${hasValue ? `${text} ${unit}` : "no data"}`}>
        <path d={arc(-135, 135)} fill="none" stroke="#152315" strokeWidth="6" strokeLinecap="round" />
        {pct > 0.005 && (
          <path
            d={arc(-135, -135 + pct * 270)}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${color})` }}
          />
        )}
        <text x="50" y="52" textAnchor="middle" fill={hasValue ? "#e2e8e2" : "#3a4a3a"}
          fontSize="14" fontWeight="700" fontFamily="inherit">
          {text}
        </text>
      </svg>
      <div className="gg-caption" style={{ marginTop: -4 }}>
        {label} <span style={{ color: "#3a4a3a" }}>{unit}</span>
      </div>
    </div>
  );
}

// ── Stress bar ─────────────────────────────────────────────────────────
const stressColor = (s) =>
  s === null ? "#2a3a2a" : s < 0.3 ? "#00ff88" : s < 0.6 ? "#ffc107" : s < 0.85 ? "#ff6b35" : "#ff1744";
const stressLabel = (s) =>
  s === null ? "NO DATA" : s < 0.3 ? "LOW" : s < 0.6 ? "MODERATE" : s < 0.85 ? "HIGH" : "CRITICAL";

function StressBar({ stress }) {
  const color = stressColor(stress);
  return (
    <div className="gg-panel" style={{ padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span className="gg-caption">Grid stress index</span>
        <span style={{ fontSize: 11, color, fontWeight: 700, letterSpacing: 1 }}>
          {stressLabel(stress)}
        </span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={stress === null ? undefined : Math.round(stress * 100)}
        aria-label="Grid stress index"
        style={{ height: 8, background: "#0d1f0d", borderRadius: 4, overflow: "hidden", position: "relative" }}
      >
        <div
          style={{
            width: `${(stress ?? 0) * 100}%`,
            height: "100%",
            borderRadius: 4,
            background: `linear-gradient(90deg, #00ff88, ${color})`,
            boxShadow: `0 0 12px ${color}66`,
            transition: "width 0.6s cubic-bezier(.4,0,.2,1)",
          }}
        />
        {[0.3, 0.6, 0.85].map((t) => (
          <div key={t} style={{ position: "absolute", left: `${t * 100}%`, top: 0, bottom: 0, width: 1, background: "#22331f" }} />
        ))}
      </div>
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────
export default function GreenGridDashboard() {
  const [connected, setConnected] = useState(true);
  const [minute, setMinute] = useState(480); // 08:00
  const [speed, setSpeed] = useState(4); // sim minutes advanced per real tick
  const [history, setHistory] = useState({ solar: [], load: [], net: [], stress: [] });
  const [totals, setTotals] = useState({
    solarKwh: 0,
    loadKwh: 0,
    selfUsedKwh: 0,
    importKwh: 0,
    exportKwh: 0,
    elapsedH: 0,
  });
  const [alerts, setAlerts] = useState([]);
  const [openAppliance, setOpenAppliance] = useState(null);

  const prevMinute = useRef(minute);
  const lastAlertMinute = useRef({});

  const sample = useMemo(() => sampleAt(minute), [minute]);

  const forecast = useMemo(() => buildForecast(Math.floor(minute / 1440)), [
    Math.floor(minute / 1440),
  ]);

  const schedule = useMemo(
    () => APPLIANCES.map((a) => scheduleAppliance(a, forecast)),
    [forecast]
  );

  const nowSlot = Math.floor((minute % 1440) / SLOT_MIN);

  // Advance the clock.
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => setMinute((m) => m + speed), 100);
    return () => clearInterval(id);
  }, [connected, speed]);

  // Integrate energy and append history using the real elapsed sim interval,
  // so totals stay correct when the playback speed changes.
  useEffect(() => {
    if (!connected) return;
    const dtH = Math.max(0, minute - prevMinute.current) / 60;
    prevMinute.current = minute;
    if (dtH === 0) return;

    const { solarKw, loadKw, netKw, importKw, exportKw, stress } = sample;
    const selfUsedKw = Math.min(solarKw, loadKw);

    setTotals((t) => ({
      solarKwh: t.solarKwh + solarKw * dtH,
      loadKwh: t.loadKwh + loadKw * dtH,
      selfUsedKwh: t.selfUsedKwh + selfUsedKw * dtH,
      importKwh: t.importKwh + importKw * dtH,
      exportKwh: t.exportKwh + exportKw * dtH,
      elapsedH: t.elapsedH + dtH,
    }));

    setHistory((h) => {
      const push = (arr, v) => [...arr.slice(-(MAX_HISTORY - 1)), v];
      return {
        solar: push(h.solar, solarKw),
        load: push(h.load, loadKw),
        net: push(h.net, netKw),
        stress: push(h.stress, stress),
      };
    });

    // Throttle each alert kind on the simulation clock, not wall time, so the
    // feed reads the same at 1× and 30×.
    const raise = (key, message, cooldownMin) => {
      const last = lastAlertMinute.current[key];
      if (last !== undefined && minute - last < cooldownMin) return;
      lastAlertMinute.current[key] = minute;
      setAlerts((a) => [
        ...a.slice(-4),
        { id: `${key}-${minute}`, key, message, at: clockLabel(minute % 1440) },
      ]);
    };

    if (stress > 0.85) {
      raise("stress", `Grid stress critical at ${fmt(stress * 100, 0)}% — defer heavy loads`, 180);
    }
    if (netKw > 2.5) {
      raise("surplus", `Solar surplus ${fmt(netKw)} kW — good window for heavy loads`, 240);
    }
  }, [connected, minute, sample]);

  const disconnect = useCallback(() => {
    setConnected(false);
  }, []);

  const reconnect = useCallback(() => {
    prevMinute.current = minute;
    lastAlertMinute.current = {};
    setHistory({ solar: [], load: [], net: [], stress: [] });
    setTotals({ solarKwh: 0, loadKwh: 0, selfUsedKwh: 0, importKwh: 0, exportKwh: 0, elapsedH: 0 });
    setAlerts([]);
    setConnected(true);
  }, [minute]);

  const live = connected ? sample : null;
  const savings = totals.selfUsedKwh * SYSTEM.importPrice + totals.exportKwh * SYSTEM.exportPrice;
  const selfSufficiency =
    totals.loadKwh > 0 ? clamp((totals.selfUsedKwh / totals.loadKwh) * 100, 0, 100) : 0;

  // Shared domain so the two overlaid series can be read against each other.
  const powerDomain = useMemo(() => {
    const all = [...history.solar, ...history.load];
    return [0, Math.max(1, ...all) * 1.05];
  }, [history.solar, history.load]);

  const netDomain = useMemo(() => {
    const m = Math.max(1, ...history.net.map(Math.abs)) * 1.05;
    return [-m, m];
  }, [history.net]);

  const stats = [
    { label: "Solar generated", value: `${fmt(totals.solarKwh)} kWh`, color: "#00ff88" },
    { label: "Household load", value: `${fmt(totals.loadKwh)} kWh`, color: "#ff6b35" },
    { label: "Imported", value: `${fmt(totals.importKwh)} kWh`, color: "#ff1744" },
    { label: "Exported", value: `${fmt(totals.exportKwh)} kWh`, color: "#00e5ff" },
    { label: "Self-sufficiency", value: `${fmt(selfSufficiency)}%`, color: "#ba68c8" },
    { label: "Bill benefit", value: `€${fmt(savings, 2)}`, color: "#ffc107" },
  ];

  return (
    <div className="gg-root">
      <link
        href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap"
        rel="stylesheet"
      />

      <header className="gg-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              className={connected ? "gg-status-dot gg-status-dot--live" : "gg-status-dot"}
              aria-hidden="true"
            />
            <span className="gg-wordmark">GreenGrid</span>
            <span className="gg-caption">Energy monitor</span>
          </div>
          <p className="gg-subhead">
            {connected
              ? "Source: built-in simulator — values are modelled, not metered"
              : "No data source connected"}
          </p>
        </div>

        <div style={{ textAlign: "right" }}>
          <div className="gg-clock">{connected ? clockLabel(minute % 1440) : "--:--"}</div>
          <div className="gg-caption">{connected ? "Simulated clock" : "Clock stopped"}</div>
        </div>
      </header>

      <div className="gg-toolbar">
        <button
          type="button"
          className="gg-btn gg-btn--primary"
          onClick={connected ? disconnect : reconnect}
          aria-pressed={connected}
        >
          {connected ? "Turn off mock data" : "Turn on mock data"}
        </button>

        <div className="gg-speed" role="group" aria-label="Playback speed">
          <span className="gg-caption">Speed</span>
          {[1, 4, 10, 30].map((s) => (
            <button
              key={s}
              type="button"
              className={`gg-btn${speed === s ? " gg-btn--on" : ""}`}
              onClick={() => setSpeed(s)}
              disabled={!connected}
              aria-pressed={speed === s}
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="gg-caption gg-weather">
          {connected
            ? `${fmt(live.env.airTempC)}°C · cloud ${fmt(live.env.cloudCover * 100, 0)}% · wind ${fmt(live.env.windMs)} m/s`
            : "Weather feed idle"}
        </div>
      </div>

      {!connected && (
        <div className="gg-empty">
          <strong>Mock data is off.</strong>
          <span>
            Turn it back on to resume the simulator, or point <code>sampleAt()</code> at a live
            inverter feed. Session counters reset when the source restarts.
          </span>
        </div>
      )}

      <div className="gg-grid gg-grid--4">
        <div className="gg-panel">
          <Gauge value={live?.solarKw ?? null} label="Solar" unit="kW" color="#00ff88" max={SYSTEM.arrayKwp} />
        </div>
        <div className="gg-panel">
          <Gauge value={live?.loadKw ?? null} label="Load" unit="kW" color="#ff6b35" max={SYSTEM.serviceLimitKw} />
        </div>
        <div className="gg-panel">
          <Gauge
            value={live ? Math.abs(live.netKw) : null}
            label={live && live.netKw >= 0 ? "Export" : "Import"}
            unit="kW"
            color={live && live.netKw >= 0 ? "#00e5ff" : "#ff1744"}
            max={SYSTEM.serviceLimitKw}
          />
        </div>
        <div className="gg-panel">
          <Gauge
            value={live?.stress ?? null}
            label="Stress"
            unit="idx"
            color={stressColor(live?.stress ?? null)}
            max={1}
          />
        </div>
      </div>

      <div className="gg-grid gg-grid--2">
        <div className="gg-panel">
          <div className="gg-caption gg-panel-title">
            <span className="gg-key" style={{ background: "#00ff88" }} />Solar
            <span className="gg-key" style={{ background: "#ff6b35" }} />Load
            <span className="gg-scale">
              0–{fmt(powerDomain[1])} kW
            </span>
          </div>
          <div style={{ position: "relative", height: 60 }}>
            <div style={{ position: "absolute", inset: 0 }}>
              <Sparkline data={history.solar} domain={powerDomain} color="#00ff88" fill="#00ff8815" />
            </div>
            <div style={{ position: "absolute", inset: 0 }}>
              <Sparkline data={history.load} domain={powerDomain} color="#ff6b35" />
            </div>
          </div>
        </div>

        <div className="gg-panel">
          <div className="gg-caption gg-panel-title">
            <span className="gg-key" style={{ background: "#00e5ff" }} />Net flow
            <span className="gg-scale">
              ±{fmt(netDomain[1])} kW · above the line is export
            </span>
          </div>
          <div style={{ height: 60 }}>
            <Sparkline data={history.net} domain={netDomain} baseline={0} color="#00e5ff" fill="#00e5ff12" />
          </div>
        </div>
      </div>

      <StressBar stress={live?.stress ?? null} />

      <div className="gg-grid gg-grid--split">
        <div className="gg-panel">
          <div className="gg-caption gg-panel-title">Appliance scheduler</div>
          <ul className="gg-list">
            {schedule.map((a) => {
              const nowCoverage = a.coverageFrom(nowSlot);
              const runNow = connected && a.bestCoverage - nowCoverage < 0.05;
              const isOpen = openAppliance === a.id;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    className={`gg-row${runNow ? " gg-row--good" : ""}${isOpen ? " gg-row--open" : ""}`}
                    onClick={() => setOpenAppliance(isOpen ? null : a.id)}
                    aria-expanded={isOpen}
                  >
                    <span className="gg-icon" aria-hidden="true">{a.icon}</span>
                    <span className="gg-row-main">
                      <span className="gg-row-name">{a.name}</span>
                      <span className="gg-caption">
                        {a.kw} kW · {a.duration} min · {fmt(a.energyKwh)} kWh
                      </span>
                    </span>
                    <span className="gg-row-meta">
                      <span style={{ color: runNow ? "#00ff88" : "#7d8f7d", fontWeight: 700, fontSize: 10 }}>
                        {runNow ? "Run now" : `Best ${clockLabel(a.bestStartMinute)}`}
                      </span>
                      <span className="gg-caption">
                        {fmt(a.bestCoverage * 100, 0)}% solar
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <p className="gg-detail">
                      Starting at {clockLabel(a.bestStartMinute)} covers {fmt(a.bestCoverage * 100, 0)}% of
                      this cycle from surplus solar. Starting now covers {fmt(nowCoverage * 100, 0)}%.
                      The gap is roughly{" "}
                      {fmt(Math.max(0, a.bestCoverage - nowCoverage) * a.energyKwh * SYSTEM.importPrice, 2)}
                      {" "}€ of avoided import.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="gg-panel">
          <div className="gg-caption gg-panel-title">
            Session totals
            <span className="gg-scale">{fmt(totals.elapsedH)} h simulated</span>
          </div>
          {stats.map((s) => (
            <div key={s.label} className="gg-stat">
              <span className="gg-caption">{s.label}</span>
              <span style={{ fontSize: 12, color: s.color, fontWeight: 700 }}>{s.value}</span>
            </div>
          ))}
          <div className="gg-caption gg-panel-title" style={{ marginTop: 14 }}>
            Stress history
          </div>
          <Sparkline
            data={history.stress}
            height={36}
            domain={[0, 1]}
            color={stressColor(live?.stress ?? 0)}
            fill="#00ff8810"
          />
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="gg-panel">
          <div className="gg-caption gg-panel-title">Alerts</div>
          <ul className="gg-alerts" aria-live="polite">
            {alerts
              .slice()
              .reverse()
              .map((a) => (
                <li key={a.id} style={{ color: a.key === "stress" ? "#ff6b35" : "#00cc66" }}>
                  <span className="gg-alert-time">{a.at}</span>
                  {a.message}
                </li>
              ))}
          </ul>
        </div>
      )}

      <footer className="gg-footer">
        Readings are produced by a deterministic model of an {SYSTEM.arrayKwp} kWp array on a{" "}
        {SYSTEM.serviceLimitKw} kW connection. Prices assume €{SYSTEM.importPrice.toFixed(2)}/kWh
        import and €{SYSTEM.exportPrice.toFixed(2)}/kWh export.
      </footer>

      <style>{`
        .gg-root {
          --bg: #050d05;
          --panel-a: #0a120a;
          --panel-b: #0d1a0d;
          --line: #162016;
          --dim: #5a6a5a;
          --accent: #00ff88;
          min-height: 100vh;
          background: var(--bg);
          color: #c0d0c0;
          font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
          padding: 16px;
          max-width: 900px;
          margin: 0 auto;
          box-sizing: border-box;
        }
        .gg-root *, .gg-root *::before, .gg-root *::after { box-sizing: border-box; }

        .gg-caption {
          font-size: 10px;
          color: var(--dim);
          letter-spacing: 1.2px;
          text-transform: uppercase;
        }
        .gg-panel {
          background: linear-gradient(145deg, var(--panel-a) 0%, var(--panel-b) 100%);
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 14px;
          margin-bottom: 12px;
        }
        .gg-grid > .gg-panel { margin-bottom: 0; }
        .gg-panel-title {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 10px;
          flex-wrap: wrap;
        }
        .gg-scale {
          margin-left: auto;
          font-size: 9px;
          color: #3a4a3a;
          text-transform: none;
          letter-spacing: 0.5px;
        }
        .gg-key {
          width: 6px; height: 6px; border-radius: 50%;
          display: inline-block; margin-left: 4px;
        }
        .gg-key:first-child { margin-left: 0; }

        .gg-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          flex-wrap: wrap;
          border-bottom: 1px solid #1a2a1a;
          padding-bottom: 14px;
          margin-bottom: 14px;
        }
        .gg-wordmark {
          font-size: 18px; font-weight: 700; color: var(--accent);
          letter-spacing: 3px; text-transform: uppercase;
        }
        .gg-subhead { font-size: 10px; color: #4a6a4a; margin: 6px 0 0; letter-spacing: 0.5px; }
        .gg-clock { font-size: 22px; color: var(--accent); letter-spacing: 2px; }
        .gg-status-dot {
          width: 10px; height: 10px; border-radius: 50%;
          background: #2a3a2a; display: inline-block;
        }
        .gg-status-dot--live {
          background: var(--accent);
          box-shadow: 0 0 10px #00ff8888;
          animation: gg-pulse 2s infinite;
        }

        .gg-toolbar {
          display: flex; align-items: center; gap: 8px;
          flex-wrap: wrap; margin-bottom: 12px;
        }
        .gg-speed { display: flex; align-items: center; gap: 6px; }
        .gg-weather { margin-left: auto; text-transform: none; letter-spacing: 0.5px; }
        .gg-btn {
          background: #0a150a; border: 1px solid #1a2a1a; color: #7d8f7d;
          border-radius: 4px; padding: 4px 10px; font: inherit; font-size: 10px;
          letter-spacing: 1px; cursor: pointer; transition: color .2s, border-color .2s;
        }
        .gg-btn:hover:not(:disabled) { color: #b8ccb8; border-color: #2a3a2a; }
        .gg-btn:disabled { opacity: .4; cursor: not-allowed; }
        .gg-btn--on, .gg-btn--primary {
          background: #00ff8815; border-color: var(--accent); color: var(--accent);
        }
        .gg-btn--primary { padding: 5px 14px; }
        .gg-root :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

        .gg-empty {
          display: flex; flex-direction: column; gap: 4px;
          border: 1px dashed #2a3a2a; border-radius: 8px;
          padding: 12px 14px; margin-bottom: 12px;
          font-size: 11px; color: #7d8f7d; line-height: 1.6;
        }
        .gg-empty strong { color: #b8ccb8; font-weight: 700; }
        .gg-empty code { color: var(--accent); }

        .gg-grid { display: grid; gap: 10px; margin-bottom: 12px; }
        .gg-grid--4 { grid-template-columns: repeat(4, 1fr); }
        .gg-grid--2 { grid-template-columns: 1fr 1fr; }
        .gg-grid--split { grid-template-columns: 1.5fr 1fr; }

        .gg-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
        .gg-row {
          width: 100%; display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; background: #060e06; border: 1px solid #1a2a1a;
          border-radius: 6px; cursor: pointer; text-align: left;
          font: inherit; color: inherit; transition: border-color .2s, background .2s;
        }
        .gg-row:hover { background: #081508; }
        .gg-row--good { border-color: #00ff8844; }
        .gg-row--open { background: #0a200a; }
        .gg-icon { font-size: 18px; line-height: 1; }
        .gg-row-main { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .gg-row-name { font-size: 11px; color: #b0c0b0; font-weight: 500; }
        .gg-row-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
        .gg-detail {
          margin: 6px 0 0; padding: 8px 10px; background: #061006;
          border: 1px solid #0f2410; border-radius: 6px;
          font-size: 10px; color: #7d8f7d; line-height: 1.7;
        }

        .gg-stat {
          display: flex; justify-content: space-between; align-items: baseline;
          gap: 8px; padding: 6px 0; border-bottom: 1px solid #0d1a0d;
        }
        .gg-stat:last-of-type { border-bottom: none; }

        .gg-alerts { list-style: none; margin: 0; padding: 0; max-height: 92px; overflow-y: auto; }
        .gg-alerts li {
          font-size: 10px; padding: 4px 0; line-height: 1.5;
          border-bottom: 1px solid #0a150a;
        }
        .gg-alert-time { color: #3a4a3a; margin-right: 8px; }

        .gg-footer {
          margin-top: 18px; padding-top: 12px; border-top: 1px solid #0d1a0d;
          font-size: 9px; color: #33443a; line-height: 1.7; text-align: center;
        }

        @keyframes gg-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

        .gg-root ::-webkit-scrollbar { width: 4px; }
        .gg-root ::-webkit-scrollbar-track { background: var(--bg); }
        .gg-root ::-webkit-scrollbar-thumb { background: #1a2a1a; border-radius: 2px; }

        @media (max-width: 760px) {
          .gg-grid--4 { grid-template-columns: 1fr 1fr; }
          .gg-grid--2, .gg-grid--split { grid-template-columns: 1fr; }
          .gg-weather { margin-left: 0; width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .gg-root *, .gg-root *::before { animation: none !important; transition: none !important; }
        }
      `}</style>
    </div>
  );
}
