import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ── Utility helpers ──
const rand = (min, max) => Math.random() * (max - min) + min;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n) => n.toFixed(1);

// ── Simulated weather / time model ──
function getSimEnv(tick) {
  const hourFloat = (tick % 1440) / 60; // 0-24
  const hour = Math.floor(hourFloat);
  const sunAngle = Math.max(0, Math.sin(((hourFloat - 6) / 12) * Math.PI));
  const cloudCover = 0.3 + 0.3 * Math.sin(tick * 0.007) + 0.1 * Math.sin(tick * 0.023);
  const effectiveSun = clamp(sunAngle * (1 - cloudCover * 0.7), 0, 1);
  const tempC = 18 + 10 * sunAngle - 3 * cloudCover + 2 * Math.sin(tick * 0.003);
  const windSpeed = 4 + 8 * Math.abs(Math.sin(tick * 0.005)) + rand(-1, 1);
  return { hourFloat, hour, sunAngle, cloudCover, effectiveSun, tempC, windSpeed };
}

// ── Solar generation model ──
function getSolarOutput(env, panelCapacityKw = 8.5) {
  const efficiency = 0.18 + 0.02 * Math.sin(env.tempC * 0.1);
  const output = panelCapacityKw * env.effectiveSun * efficiency * (4 + rand(-0.2, 0.2));
  return clamp(output, 0, panelCapacityKw);
}

// ── Household consumption model ──
function getConsumption(env) {
  const base = 0.8;
  const lighting = env.sunAngle < 0.2 ? 0.6 : 0.1;
  const hvac = env.tempC > 28 ? 1.8 : env.tempC < 15 ? 1.5 : 0.3;
  const cooking = (env.hour >= 7 && env.hour <= 9) || (env.hour >= 18 && env.hour <= 20) ? 1.5 : 0.2;
  const entertainment = env.hour >= 19 || env.hour <= 1 ? 0.8 : 0.3;
  return base + lighting + hvac + cooking + entertainment + rand(-0.15, 0.15);
}

// ── Grid stress algorithm ──
function calcGridStress(solarKw, consumptionKw, env) {
  const deficit = Math.max(0, consumptionKw - solarKw);
  const peakMultiplier = (env.hour >= 17 && env.hour <= 21) ? 1.6 : 1.0;
  const tempStress = env.tempC > 32 ? 0.2 : env.tempC < 5 ? 0.15 : 0;
  const stress = clamp((deficit / 4) * peakMultiplier + tempStress, 0, 1);
  return stress;
}

// ── Appliance scheduler ──
const APPLIANCES = [
  { id: "washer", name: "Washing Machine", kwh: 1.2, duration: 90, icon: "🫧" },
  { id: "dryer", name: "Tumble Dryer", kwh: 2.5, duration: 60, icon: "🌀" },
  { id: "dishwasher", name: "Dishwasher", kwh: 1.4, duration: 120, icon: "🍽️" },
  { id: "ev", name: "EV Charger", kwh: 7.2, duration: 240, icon: "⚡" },
  { id: "pool", name: "Pool Pump", kwh: 1.1, duration: 180, icon: "🏊" },
];

function getApplianceWindows(hourFloat) {
  return APPLIANCES.map((a) => {
    const solarPeak = 12;
    const optimalStart = clamp(solarPeak - a.duration / 120, 6, 18);
    const isGoodNow = hourFloat >= optimalStart && hourFloat <= optimalStart + a.duration / 60;
    const savingsPercent = isGoodNow ? Math.round(25 + rand(5, 20)) : Math.round(5 + rand(0, 10));
    return {
      ...a,
      optimalStart: `${Math.floor(optimalStart)}:${String(Math.round((optimalStart % 1) * 60)).padStart(2, "0")}`,
      isGoodNow,
      savingsPercent,
    };
  });
}

// ── Sparkline Component ──
function Sparkline({ data, width = 200, height = 48, color = "#0f0", areaColor }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 0.01);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {areaColor && <path d={area} fill={areaColor} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ── Gauge Component ──
function Gauge({ value, label, color, max = 1 }) {
  const pct = clamp(value / max, 0, 1);
  const angle = -135 + pct * 270;
  const r = 38;
  const cx = 50, cy = 50;
  const startAngle = -135;
  const endAngle = startAngle + pct * 270;
  const toRad = (d) => (d * Math.PI) / 180;
  const arcPath = (start, end) => {
    const s = { x: cx + r * Math.cos(toRad(start)), y: cy + r * Math.sin(toRad(start)) };
    const e = { x: cx + r * Math.cos(toRad(end)), y: cy + r * Math.sin(toRad(end)) };
    const large = end - start > 180 ? 1 : 0;
    return `M${s.x},${s.y} A${r},${r} 0 ${large} 1 ${e.x},${e.y}`;
  };
  return (
    <div style={{ textAlign: "center" }}>
      <svg width="100" height="80" viewBox="0 0 100 80">
        <path d={arcPath(-135, 135)} fill="none" stroke="#1a2a1a" strokeWidth="6" strokeLinecap="round" />
        {pct > 0.005 && (
          <path d={arcPath(-135, endAngle)} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        )}
        <text x="50" y="52" textAnchor="middle" fill="#e0e0e0" fontSize="14" fontFamily="'JetBrains Mono', monospace" fontWeight="700">
          {typeof value === "number" ? (value < 10 ? value.toFixed(2) : value.toFixed(1)) : value}
        </text>
      </svg>
      <div style={{ fontSize: 10, color: "#8a9a8a", marginTop: -6, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
    </div>
  );
}

// ── Live Clock ──
function LiveClock({ hourFloat }) {
  const h = Math.floor(hourFloat);
  const m = Math.floor((hourFloat % 1) * 60);
  const s = Math.floor((((hourFloat * 60) % 1) * 60));
  const pad = (n) => String(n).padStart(2, "0");
  return (
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, color: "#00ff88", letterSpacing: 2, textShadow: "0 0 10px #00ff8866" }}>
      {pad(h)}:{pad(m)}:{pad(s)}
    </span>
  );
}

// ── Grid Stress Bar ──
function StressBar({ stress }) {
  const color = stress < 0.3 ? "#00ff88" : stress < 0.6 ? "#ffc107" : stress < 0.85 ? "#ff6b35" : "#ff1744";
  const label = stress < 0.3 ? "LOW" : stress < 0.6 ? "MODERATE" : stress < 0.85 ? "HIGH" : "CRITICAL";
  return (
    <div style={{ background: "#0a1a0a", borderRadius: 6, padding: "10px 14px", border: "1px solid #1a2a1a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "#5a6a5a", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: 1.5 }}>Grid Stress Index</span>
        <span style={{ fontSize: 11, color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: 1 }}>{label}</span>
      </div>
      <div style={{ height: 8, background: "#0d1f0d", borderRadius: 4, overflow: "hidden", position: "relative" }}>
        <div style={{
          width: `${stress * 100}%`, height: "100%", borderRadius: 4,
          background: `linear-gradient(90deg, #00ff88, ${color})`,
          boxShadow: `0 0 12px ${color}66`,
          transition: "width 0.8s cubic-bezier(.4,0,.2,1)"
        }} />
        {[0.3, 0.6, 0.85].map((t) => (
          <div key={t} style={{ position: "absolute", left: `${t * 100}%`, top: 0, bottom: 0, width: 1, background: "#2a3a2a" }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3 }}>
        {["0%", "30%", "60%", "85%", "100%"].map((l) => (
          <span key={l} style={{ fontSize: 8, color: "#3a4a3a", fontFamily: "'JetBrains Mono', monospace" }}>{l}</span>
        ))}
      </div>
    </div>
  );
}

// ── Main Dashboard ──
export default function GreenGridDashboard() {
  const [tick, setTick] = useState(480); // start at 8:00
  const [speed, setSpeed] = useState(4);
  const [solarHistory, setSolarHistory] = useState([]);
  const [consumeHistory, setConsumeHistory] = useState([]);
  const [stressHistory, setStressHistory] = useState([]);
  const [netHistory, setNetHistory] = useState([]);
  const [totalSolar, setTotalSolar] = useState(0);
  const [totalConsume, setTotalConsume] = useState(0);
  const [totalSaved, setTotalSaved] = useState(0);
  const [alerts, setAlerts] = useState([]);
  const [selectedAppliance, setSelectedAppliance] = useState(null);
  const alertIdRef = useRef(0);

  const env = useMemo(() => getSimEnv(tick), [tick]);
  const solarKw = useMemo(() => getSolarOutput(env), [env]);
  const consumeKw = useMemo(() => getConsumption(env), [env]);
  const gridStress = useMemo(() => calcGridStress(solarKw, consumeKw, env), [solarKw, consumeKw, env]);
  const netEnergy = solarKw - consumeKw;
  const appliances = useMemo(() => getApplianceWindows(env.hourFloat), [env.hourFloat]);

  useEffect(() => {
    const iv = setInterval(() => {
      setTick((t) => t + speed);
    }, 100);
    return () => clearInterval(iv);
  }, [speed]);

  useEffect(() => {
    const MAX_HIST = 120;
    setSolarHistory((h) => [...h.slice(-(MAX_HIST - 1)), solarKw]);
    setConsumeHistory((h) => [...h.slice(-(MAX_HIST - 1)), consumeKw]);
    setStressHistory((h) => [...h.slice(-(MAX_HIST - 1)), gridStress]);
    setNetHistory((h) => [...h.slice(-(MAX_HIST - 1)), netEnergy]);
    setTotalSolar((s) => s + solarKw * 0.002);
    setTotalConsume((s) => s + consumeKw * 0.002);
    setTotalSaved((s) => s + Math.max(0, netEnergy) * 0.002 * 0.12);

    if (gridStress > 0.85) {
      setAlerts((a) => {
        const now = Date.now();
        if (a.length > 0 && now - a[a.length - 1].ts < 3000) return a;
        alertIdRef.current++;
        return [...a.slice(-4), { id: alertIdRef.current, msg: `⚠ Grid stress CRITICAL at ${fmt(gridStress * 100)}% — defer high-load appliances`, ts: now }];
      });
    }
    if (netEnergy > 3 && solarHistory.length > 5) {
      setAlerts((a) => {
        const now = Date.now();
        if (a.length > 0 && now - a[a.length - 1].ts < 5000) return a;
        alertIdRef.current++;
        return [...a.slice(-4), { id: alertIdRef.current, msg: `☀ Solar surplus ${fmt(netEnergy)} kW — optimal time for heavy appliances!`, ts: now }];
      });
    }
  }, [tick]);

  const panelStyle = {
    background: "linear-gradient(145deg, #0a120a 0%, #0d1a0d 100%)",
    border: "1px solid #162016",
    borderRadius: 10,
    padding: 16,
    position: "relative",
    overflow: "hidden",
  };

  const glowDot = (color) => ({
    width: 6, height: 6, borderRadius: "50%", background: color,
    boxShadow: `0 0 6px ${color}`, display: "inline-block", marginRight: 6,
  });

  return (
    <div style={{
      minHeight: "100vh", background: "#050d05", color: "#c0d0c0",
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      padding: "16px 20px", maxWidth: 900, margin: "0 auto",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, borderBottom: "1px solid #1a2a1a", paddingBottom: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#00ff88", boxShadow: "0 0 10px #00ff8888, 0 0 20px #00ff8844", animation: "pulse 2s infinite" }} />
            <span style={{ fontSize: 18, fontWeight: 700, color: "#00ff88", letterSpacing: 3, textTransform: "uppercase" }}>
              GreenGrid
            </span>
            <span style={{ fontSize: 10, color: "#3a5a3a", letterSpacing: 2, marginLeft: 4 }}>SMART ENERGY v2.1</span>
          </div>
          <div style={{ fontSize: 9, color: "#2a4a2a", marginTop: 4, letterSpacing: 1.5 }}>REAL-TIME ENERGY MONITORING & OPTIMIZATION</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <LiveClock hourFloat={env.hourFloat} />
          <div style={{ fontSize: 9, color: "#3a5a3a", marginTop: 2, letterSpacing: 1 }}>SIM TIME</div>
        </div>
      </div>

      {/* Speed Controls */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "#3a5a3a", letterSpacing: 1, marginRight: 4 }}>SPEED</span>
        {[1, 4, 10, 30].map((s) => (
          <button key={s} onClick={() => setSpeed(s)} style={{
            background: speed === s ? "#00ff8822" : "#0a150a",
            border: `1px solid ${speed === s ? "#00ff88" : "#1a2a1a"}`,
            color: speed === s ? "#00ff88" : "#4a5a4a",
            borderRadius: 4, padding: "3px 10px", fontSize: 10, cursor: "pointer",
            fontFamily: "inherit", letterSpacing: 1,
          }}>{s}x</button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 9, color: "#3a5a3a" }}>
          {fmt(env.tempC)}°C &nbsp; ☁ {fmt(env.cloudCover * 100)}% &nbsp; 💨 {fmt(env.windSpeed)} m/s
        </div>
      </div>

      {/* Main Metrics Row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div style={panelStyle}>
          <Gauge value={solarKw} label="Solar kW" color="#00ff88" max={8.5} />
        </div>
        <div style={panelStyle}>
          <Gauge value={consumeKw} label="Load kW" color="#ff6b35" max={6} />
        </div>
        <div style={panelStyle}>
          <Gauge value={Math.abs(netEnergy)} label={netEnergy >= 0 ? "Surplus kW" : "Deficit kW"} color={netEnergy >= 0 ? "#00e5ff" : "#ff1744"} max={6} />
        </div>
        <div style={panelStyle}>
          <Gauge value={gridStress} label="Stress Idx" color={gridStress < 0.3 ? "#00ff88" : gridStress < 0.6 ? "#ffc107" : "#ff1744"} max={1} />
        </div>
      </div>

      {/* Sparkline Charts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div style={panelStyle}>
          <div style={{ fontSize: 9, color: "#5a6a5a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>
            <span style={glowDot("#00ff88")} />Solar vs <span style={glowDot("#ff6b35")} />Consumption
          </div>
          <div style={{ position: "relative" }}>
            <Sparkline data={solarHistory} width={380} height={60} color="#00ff88" areaColor="#00ff8815" />
            <div style={{ position: "absolute", top: 0, left: 0 }}>
              <Sparkline data={consumeHistory} width={380} height={60} color="#ff6b35" areaColor="#ff6b3510" />
            </div>
          </div>
        </div>
        <div style={panelStyle}>
          <div style={{ fontSize: 9, color: "#5a6a5a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>
            <span style={glowDot("#00e5ff")} />Net Energy Flow
          </div>
          <Sparkline data={netHistory} width={380} height={60} color="#00e5ff" areaColor="#00e5ff12" />
        </div>
      </div>

      {/* Grid Stress Bar */}
      <div style={{ marginBottom: 14 }}>
        <StressBar stress={gridStress} />
      </div>

      {/* Appliance Scheduler + Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 10, marginBottom: 14 }}>
        {/* Appliance Scheduler */}
        <div style={panelStyle}>
          <div style={{ fontSize: 10, color: "#5a6a5a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 10 }}>
            Smart Appliance Scheduler
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {appliances.map((a) => (
              <div key={a.id} onClick={() => setSelectedAppliance(selectedAppliance === a.id ? null : a.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                  background: selectedAppliance === a.id ? "#0a200a" : "#060e06",
                  border: `1px solid ${a.isGoodNow ? "#00ff8844" : "#1a2a1a"}`,
                  borderRadius: 6, cursor: "pointer", transition: "all 0.3s",
                }}>
                <span style={{ fontSize: 18 }}>{a.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: "#b0c0b0", fontWeight: 500 }}>{a.name}</div>
                  <div style={{ fontSize: 9, color: "#4a5a4a" }}>{a.kwh} kWh · {a.duration} min</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{
                    fontSize: 10, fontWeight: 700,
                    color: a.isGoodNow ? "#00ff88" : "#5a6a5a",
                  }}>
                    {a.isGoodNow ? "▶ RUN NOW" : `Best: ${a.optimalStart}`}
                  </div>
                  <div style={{ fontSize: 9, color: a.isGoodNow ? "#00cc66" : "#3a4a3a" }}>
                    Save ~{a.savingsPercent}%
                  </div>
                </div>
              </div>
            ))}
          </div>
          {selectedAppliance && (
            <div style={{ marginTop: 8, padding: "8px 10px", background: "#061006", borderRadius: 6, border: "1px solid #0a200a", fontSize: 10, color: "#6a8a6a", lineHeight: 1.6 }}>
              💡 Running {appliances.find(a => a.id === selectedAppliance)?.name} during peak solar hours reduces grid dependency by up to {appliances.find(a => a.id === selectedAppliance)?.savingsPercent}% and lowers your carbon footprint.
            </div>
          )}
        </div>

        {/* Session Stats */}
        <div style={panelStyle}>
          <div style={{ fontSize: 10, color: "#5a6a5a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 12 }}>
            Session Totals
          </div>
          {[
            { label: "Solar Generated", value: `${fmt(totalSolar)} kWh`, color: "#00ff88" },
            { label: "Energy Consumed", value: `${fmt(totalConsume)} kWh`, color: "#ff6b35" },
            { label: "Grid Offset", value: `${fmt(Math.max(0, totalSolar - totalConsume))} kWh`, color: "#00e5ff" },
            { label: "Est. Savings", value: `€${fmt(totalSaved)}`, color: "#ffc107" },
            { label: "Self-Sufficiency", value: `${totalConsume > 0 ? fmt((totalSolar / totalConsume) * 100) : 0}%`, color: "#ba68c8" },
          ].map((s, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: i < 4 ? "1px solid #0d1a0d" : "none" }}>
              <span style={{ fontSize: 10, color: "#5a6a5a" }}>{s.label}</span>
              <span style={{ fontSize: 12, color: s.color, fontWeight: 700 }}>{s.value}</span>
            </div>
          ))}

          {/* Mini stress history */}
          <div style={{ marginTop: 12, fontSize: 9, color: "#3a5a3a", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
            Stress History
          </div>
          <Sparkline data={stressHistory} width={240} height={36}
            color={gridStress < 0.3 ? "#00ff88" : gridStress < 0.6 ? "#ffc107" : "#ff1744"}
            areaColor={gridStress < 0.3 ? "#00ff8812" : gridStress < 0.6 ? "#ffc10712" : "#ff174412"} />
        </div>
      </div>

      {/* Alert Feed */}
      {alerts.length > 0 && (
        <div style={panelStyle}>
          <div style={{ fontSize: 10, color: "#5a6a5a", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>
            System Alerts
          </div>
          <div style={{ maxHeight: 80, overflowY: "auto" }}>
            {alerts.slice(-5).reverse().map((a) => (
              <div key={a.id} style={{
                fontSize: 10, color: a.msg.startsWith("⚠") ? "#ff6b35" : "#00cc66",
                padding: "3px 0", borderBottom: "1px solid #0a150a", lineHeight: 1.5,
              }}>
                {a.msg}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ textAlign: "center", marginTop: 20, paddingTop: 12, borderTop: "1px solid #0d1a0d" }}>
        <span style={{ fontSize: 8, color: "#1a2a1a", letterSpacing: 2, textTransform: "uppercase" }}>
          GreenGrid Smart Energy Platform · Domain-Driven Design · SignalR-Ready Architecture · © 2026
        </span>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #050d05; }
        ::-webkit-scrollbar-thumb { background: #1a2a1a; border-radius: 2px; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}
