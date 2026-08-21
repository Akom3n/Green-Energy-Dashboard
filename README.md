# Green-Energy-Dashboard

A single-file React component that models a residential solar installation and
renders it as a monitoring dashboard: generation against household load, the
resulting import or export, and a grid stress index derived from both. It also
schedules appliances against a 24-hour solar forecast and raises alerts when the
connection approaches its limit.

All readings come from a built-in simulator. Nothing here talks to hardware.

## What it does

- **Solar and load gauges** driven by a physical model of an 8.5 kWp array on a
  6 kW connection.
- **Grid stress index** — how close the connection is to its limit, scaled up
  during the evening peak and nudged by temperature extremes that drive
  correlated HVAC demand.
- **Appliance scheduler** — builds a 24-hour surplus forecast at 15-minute
  resolution, slides each appliance's run window across all 96 slots, and picks
  the start time that covers the most of that cycle from surplus solar. Expanding
  a row compares the best window against running right now and prices the gap.
- **Session totals** — energy is integrated over elapsed simulated time, split
  into imported, exported and self-consumed, then costed at €0.28/kWh import and
  €0.09/kWh export.
- **Mock data toggle** — turns the simulator off. The clock stops, gauges blank
  out, and an empty state points at the single function a real feed would replace.
  Session counters reset when the source restarts.
- **Alerts** for critical grid stress and large solar surplus, throttled on the
  simulation clock so the feed reads the same at 1× and 30×.

## How the model works

Solar output follows a PVWatts-style derate chain: nameplate capacity ×
irradiance fraction × temperature correction × system losses. Clear-sky
irradiance is a half-sine between 06:00 and 18:00, attenuated by cloud cover.
Cell temperature is approximated as ambient plus a rise proportional to
irradiance, and output falls at −0.4%/°C above 25°C — the typical Pmax
coefficient for mono-Si. A 0.86 factor covers inverter, wiring, soiling and
mismatch losses.

Household load is an always-on baseline plus four occupancy-driven bands:
lighting, HVAC, cooking and plug loads.

**The simulator is deterministic.** Every quantity is a pure function of the
simulation clock, with unmodelled variation supplied by a hash of the current
minute rather than `Math.random()`. This is deliberate: it means the forecast the
scheduler reads is guaranteed to match what the gauges will show when that minute
arrives, and the same minute always reproduces the same reading.

## Running it

Drop `GreenGridDashboard.jsx` into any React 18+ project and render it. It takes
no props.

```jsx
import GreenGridDashboard from "./GreenGridDashboard";

export default function App() {
  return <GreenGridDashboard />;
}
```

The only package import is `react` — no charting or UI libraries; the gauges and
sparklines are hand-written SVG. The component does request JetBrains Mono from
Google Fonts at runtime and falls back to the system monospace stack if that
request fails.

## Connecting a real source

`sampleAt(minute)` is the only function that reads the simulator. It returns
`{ env, solarKw, loadKw, netKw, importKw, exportKw, stress }`. Replacing it with a
reading from an inverter or meter API is the whole integration; nothing else in
the file touches the model.

## Known simplifications

- Appliance run windows that cross midnight wrap back into the same day's
  forecast profile. A production version would forecast a rolling 48-hour horizon.
- There is no battery, no export curtailment, and no time-of-use tariff — import
  and export are each priced at a flat rate.
- Weather is generated, not fetched. Real irradiance forecasting would need an
  external provider.
