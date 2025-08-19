import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ------------------------------------------------------------
// Pragyan Rover – Playable Prototype (Single-file React)
// ------------------------------------------------------------
// Notes
// - TailwindCSS is available in the canvas preview.
// - This is a compact prototype capturing the *feel* of the full game:
//   countdown clock, power, map hazards/PSRs, objectives, APXS/LIBS minigames,
//   comms windows via Vikram, hibernation and wake attempt.
// - You can tweak MAP_SIZE, seed, objectives, and balancing constants below.
// ------------------------------------------------------------

// ---------- Constants ----------
const MAP_SIZE = 12; // 12x12 grid
const TOTAL_HOURS = 14 * 24; // 14 Earth days
const START_POWER = 100; // percentage
const MAX_DATA_BUFFER = 100; // MB
const COMM_WINDOW_HOURS = [
  // repeating windows each day (UTC-equivalent hours across 0..335)
  { start: 2, duration: 2 },
  { start: 10, duration: 2 },
  { start: 18, duration: 2 },
];

const TILE = {
  NORMAL: "NORMAL",
  SLOPE: "SLOPE",
  BOULDER: "BOULDER",
  PSR: "PSR", // Permanently Shadowed Region
  RIM: "RIM", // crater rim (good for science)
  CRATER: "CRATER",
  LANDER: "LANDER", // Vikram
};

const ELEMENTS = [
  { key: "O", name: "Oxygen" },
  { key: "Si", name: "Silicon" },
  { key: "Ca", name: "Calcium" },
  { key: "Fe", name: "Iron" },
  { key: "S", name: "Sulfur" },
  { key: "Mg", name: "Magnesium" },
];

// ---------- Utility ----------
function seededRandom(seed) {
  let x = Math.sin(seed) * 10000;
  return () => {
    x = Math.sin(x) * 10000;
    return x - Math.floor(x);
  };
}

function within(i, j) {
  return i >= 0 && j >= 0 && i < MAP_SIZE && j < MAP_SIZE;
}

function hourToDayHour(hour) {
  // hour 0..335 -> {day: 1..14, hod: 0..23}
  const day = Math.floor(hour / 24) + 1;
  const hod = hour % 24;
  return { day, hod };
}

function isCommWindow(hour) {
  // pattern repeats every 24 hours
  const hod = hour % 24;
  return COMM_WINDOW_HOURS.some(({ start, duration }) => hod >= start && hod < start + duration);
}

function solarIrradiancePercent(hour, tileType) {
  // Super-simplified: sinusoidal day curve across 14 Earth-day daylight span
  // PSR yields ~0
  if (tileType === TILE.PSR) return 0;
  // make power better mid-campaign to simulate Sun elevation near local noon
  const t = hour / TOTAL_HOURS; // 0..1
  const base = Math.sin(Math.PI * (t * 0.9 + 0.05)); // avoid zeros at ends; peaks mid
  return Math.max(0, Math.min(1, base)) * 100;
}

function randomPick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// ---------- Map Generation ----------
function generateMap(seed = 42) {
  const rand = seededRandom(seed);
  const grid = Array.from({ length: MAP_SIZE }, () =>
    Array.from({ length: MAP_SIZE }, () => ({ type: TILE.NORMAL, seen: false, science: 0 }))
  );

  // Place Vikram lander roughly center
  const lander = { i: Math.floor(MAP_SIZE / 2), j: Math.floor(MAP_SIZE / 2) };
  grid[lander.i][lander.j].type = TILE.LANDER;
  grid[lander.i][lander.j].science = 1;

  // Scatter craters and rims
  const craterCount = 3 + Math.floor(rand() * 3);
  for (let c = 0; c < craterCount; c++) {
    const ci = Math.floor(rand() * MAP_SIZE);
    const cj = Math.floor(rand() * MAP_SIZE);
    const r = 1 + Math.floor(rand() * 2);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        if (!within(i, j)) continue;
        const d = Math.hypot(i - ci, j - cj);
        if (d <= r - 0.5) grid[i][j].type = TILE.CRATER;
        else if (d <= r + 0.5 && grid[i][j].type !== TILE.LANDER) grid[i][j].type = TILE.RIM;
      }
    }
  }

  // Scatter PSRs near corners/edges, higher chance in lower-left and upper-right
  const psrCount = 18 + Math.floor(rand() * 8);
  for (let k = 0; k < psrCount; k++) {
    let i = Math.floor(rand() * MAP_SIZE);
    let j = Math.floor(rand() * MAP_SIZE);
    if (rand() < 0.4) i = Math.floor(rand() * (MAP_SIZE / 3));
    if (rand() < 0.4) j = MAP_SIZE - 1 - Math.floor(rand() * (MAP_SIZE / 3));
    if (grid[i][j].type === TILE.LANDER) continue;
    grid[i][j].type = TILE.PSR;
  }

  // Slopes and boulders
  const roughCount = 40;
  for (let k = 0; k < roughCount; k++) {
    const i = Math.floor(rand() * MAP_SIZE);
    const j = Math.floor(rand() * MAP_SIZE);
    if (grid[i][j].type === TILE.NORMAL) grid[i][j].type = randomPick(rand, [TILE.SLOPE, TILE.BOULDER]);
  }

  // Science richness: rims and PSR edges are juicy
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let i = 0; i < MAP_SIZE; i++) {
    for (let j = 0; j < MAP_SIZE; j++) {
      let s = 0;
      if (grid[i][j].type === TILE.RIM) s += 2;
      if (grid[i][j].type === TILE.CRATER) s += 1;
      // edge of PSR
      if (grid[i][j].type !== TILE.PSR) {
        for (const [di, dj] of dirs) {
          const ni = i + di,
            nj = j + dj;
          if (within(ni, nj) && grid[ni][nj].type === TILE.PSR) s += 2;
        }
      }
      grid[i][j].science += s; // 0..~6
    }
  }

  return { grid, lander };
}

// ---------- Minigames ----------
function generateSpectrum(scienceLevel = 1) {
  // Return fake peaks to identify – higher scienceLevel -> more peaks
  const base = ["O", "Si", "Ca", "Fe", "S", "Mg"]; // real-ish elements for APXS/LIBS
  const count = Math.min(3 + Math.floor(scienceLevel), base.length);
  const shuffled = base.sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, count);
  // Peaks: numbers 0..100 for simple bar chart
  const peaks = chosen.map((k) => ({ x: Math.floor(Math.random() * 100), e: k }));
  peaks.sort((a, b) => a.x - b.x);
  return { peaks, elements: chosen };
}

function SpectrumChart({ peaks, guesses, onGuess, title }) {
  // Minimalist spectrum visualization with clickable bins
  const bins = 20;
  const width = 280;
  const height = 80;
  const barW = width / bins;
  const peakBins = peaks.map((p) => Math.max(0, Math.min(bins - 1, Math.floor((p.x / 100) * bins))));
  return (
    <div className="w-full">
      <div className="text-sm mb-1 text-white/80">{title}</div>
      <div className="relative rounded-xl bg-slate-900/70 border border-white/10 p-2">
        <svg width={width} height={height} className="block mx-auto">
          {[...Array(bins)].map((_, b) => {
            const isPeak = peakBins.includes(b);
            const level = isPeak ? 60 : 10 + (b % 3) * 6;
            return (
              <rect key={b} x={b * barW} y={height - level} width={barW - 1} height={level} rx={2}></rect>
            );
          })}
        </svg>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {ELEMENTS.map((el) => (
            <button
              key={el.key}
              onClick={() => onGuess(el.key)}
              className={`text-xs rounded-lg px-2 py-1 border bg-slate-800/80 hover:bg-slate-700 transition ${
                guesses.includes(el.key) ? "opacity-50" : ""
              }`}
            >
              {el.key} — {el.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Main Component ----------
export default function PragyanRoverGame() {
  const [seed] = useState(1337);
  const { grid: initialGrid, lander } = useMemo(() => generateMap(seed), [seed]);

  const [grid, setGrid] = useState(initialGrid);
  const [pos, setPos] = useState({ i: lander.i, j: lander.j });
  const [hour, setHour] = useState(0); // 0..335
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(4); // game ticks per second
  const [power, setPower] = useState(START_POWER);
  const [buffer, setBuffer] = useState(0); // MB
  const [resourcePotential, setResourcePotential] = useState(0); // 0..100
  const [objectives, setObjectives] = useState([
    { id: "SULFUR", label: "Confirm presence of Sulfur in regolith", done: false },
    { id: "MAP100", label: "Map elemental distribution within 100m radius", done: false },
    { id: "CRATER", label: "Characterize soil near small crater", done: false },
    { id: "PSR_EDGE", label: "Investigate PSR edge composition", done: false },
  ]);

  const [log, setLog] = useState(["Mission start. Systems nominal. Pragyan deployed near Vikram."]);
  const [mode, setMode] = useState("NAV"); // NAV | APXS | LIBS | COMMS | HIBERNATE | WAKE
  const [path, setPath] = useState([]); // queued path
  const [modal, setModal] = useState(null); // spectrum mini-games and alerts

  const tickRef = useRef(null);

  // Reveal tile when visited
  useEffect(() => {
    setGrid((g) => {
      const ng = g.map((row) => row.map((t) => ({ ...t })));
      ng[pos.i][pos.j].seen = true;
      return ng;
    });
  }, [pos]);

  // Game clock and passive power dynamics
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setHour((h) => Math.min(TOTAL_HOURS, h + 1));
    }, 1000 / speed);
    return () => clearInterval(interval);
  }, [running, speed]);

  // End of mission daytime -> force hibernation
  useEffect(() => {
    if (hour >= TOTAL_HOURS && mode !== "HIBERNATE" && mode !== "WAKE") {
      setLog((l) => ["Lunar night imminent. Initiating emergency hibernation.", ...l]);
      setMode("HIBERNATE");
      setModal({ type: "HIBERNATE" });
      setRunning(false);
    }
  }, [hour, mode]);

  // Passive solar charging every hour tick
  useEffect(() => {
    const currentTile = grid[pos.i][pos.j];
    const solar = solarIrradiancePercent(hour, currentTile.type); // 0..100
    const charge = (solar / 100) * 2; // up to +2% per hour
    setPower((p) => Math.min(100, p + charge));

    // idle drain
    setPower((p) => Math.max(0, p - 0.15));

    // Data buffer slow decay risk during night? (not implemented)
  }, [hour]);

  // ---------- Controls ----------
  function move(di, dj) {
    const ni = pos.i + di;
    const nj = pos.j + dj;
    if (!within(ni, nj)) return;
    const t = grid[ni][nj];
    const moveCost = 1 + (t.type === TILE.SLOPE ? 1 : 0) + (t.type === TILE.BOULDER ? 0.5 : 0);
    const shadowPenalty = t.type === TILE.PSR ? 3 : 0;
    const totalCost = moveCost + shadowPenalty;
    if (power < totalCost + 1) {
      setLog((l) => ["Not enough power to move.", ...l]);
      return;
    }
    setPower((p) => Math.max(0, p - totalCost));
    setPos({ i: ni, j: nj });

    // Hazards: small chance of wheel slip on slope/boulder
    if (t.type === TILE.SLOPE || t.type === TILE.BOULDER) {
      if (Math.random() < 0.15) {
        setLog((l) => ["Wheel slip detected. Recovery takes extra time and power.", ...l]);
        setHour((h) => Math.min(TOTAL_HOURS, h + 2));
        setPower((p) => Math.max(0, p - 2));
      }
    }
  }

  function enqueuePath(i, j) {
    // naive straight-line path
    const steps = [];
    let ci = pos.i,
      cj = pos.j;
    while (ci !== i || cj !== j) {
      if (ci < i) ci++;
      else if (ci > i) ci--;
      else if (cj < j) cj++;
      else if (cj > j) cj--;
      steps.push({ i: ci, j: cj });
    }
    setPath(steps);
    setLog((l) => [`Path queued: ${steps.length} steps`, ...l]);
  }

  useEffect(() => {
    if (!running) return;
    if (path.length === 0) return;
    const step = path[0];
    const timer = setTimeout(() => {
      move(step.i - pos.i, step.j - pos.j);
      setPath((p) => p.slice(1));
    }, 220);
    return () => clearTimeout(timer);
  }, [path, pos, running]);

  function useInstrument(kind) {
    const tile = grid[pos.i][pos.j];
    const baseCost = kind === "APXS" ? 3 : 4;
    const timeCost = kind === "APXS" ? 2 : 3; // hours
    if (power < baseCost + 1) {
      setLog((l) => ["Insufficient power for instrument.", ...l]);
      return;
    }
    setPower((p) => Math.max(0, p - baseCost));
    setHour((h) => Math.min(TOTAL_HOURS, h + timeCost));

    const spectrum = generateSpectrum(Math.max(1, tile.science));
    setModal({ type: kind, spectrum, guesses: [], tile });
  }

  function handleSpectrumGuess(elKey) {
    if (!modal || !modal.spectrum) return;
    const { elements, peaks } = modal.spectrum;
    const was = modal.guesses || [];
    if (was.includes(elKey)) return;
    const correct = elements.includes(elKey);
    const ng = [...was, elKey];

    if (correct) {
      // award science
      const scienceGain = 5 + Math.floor(Math.random() * 6); // 5..10
      setBuffer((b) => Math.min(MAX_DATA_BUFFER, b + scienceGain));
      setResourcePotential((r) => Math.min(100, r + (modal.tile.type === TILE.PSR || nearPSR(pos, grid) ? 6 : 2)));

      // Objective checks
      if (elKey === "S") markObjective("SULFUR");
      if (modal.tile.type === TILE.RIM || modal.tile.type === TILE.CRATER) markObjective("CRATER");
      if (nearPSR(pos, grid)) markObjective("PSR_EDGE");
      if (buffer >= 60) markObjective("MAP100");

      setLog((l) => [`${modal.type}: ${elKey} identified. Data +${scienceGain}MB`, ...l]);
    } else {
      setLog((l) => [`${modal.type}: ${elKey} not significant.`, ...l]);
    }

    const allTried = ELEMENTS.filter((e) => elements.includes(e.key)).every((e) => ng.includes(e.key));
    setModal((m) => ({ ...m, guesses: ng, solved: allTried }));

    if (allTried) {
      setTimeout(() => setModal(null), 800);
    }
  }

  function nearPSR(p, g) {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    return dirs.some(([di, dj]) => {
      const ni = p.i + di,
        nj = p.j + dj;
      return within(ni, nj) && g[ni][nj].type === TILE.PSR;
    });
  }

  function markObjective(id) {
    setObjectives((os) => os.map((o) => (o.id === id ? { ...o, done: true } : o)));
  }

  function transmitData() {
    if (!isCommWindow(hour)) {
      setLog((l) => ["No link to Vikram right now. Wait for comm window.", ...l]);
      return;
    }
    if (buffer <= 0) {
      setLog((l) => ["Nothing to transmit.", ...l]);
      return;
    }
    const powerCost = Math.min(5, Math.ceil(buffer / 20));
    if (power < powerCost + 1) {
      setLog((l) => ["Insufficient power for transmission.", ...l]);
      return;
    }

    setPower((p) => Math.max(0, p - powerCost));
    const timeCost = 1 + Math.floor(buffer / 40);
    setHour((h) => Math.min(TOTAL_HOURS, h + timeCost));

    setLog((l) => [`Transmitting ${buffer}MB via Vikram...`, ...l]);
    setBuffer(0);
  }

  function startHibernation() {
    setMode("HIBERNATE");
    setRunning(false);
    setModal({ type: "HIBERNATE" });
  }

  function doWakeAttempt(skill) {
    // simple bar timing: higher skill -> higher chance
    const flatTile = grid[pos.i][pos.j].type !== TILE.SLOPE && grid[pos.i][pos.j].type !== TILE.BOULDER && grid[pos.i][pos.j].type !== TILE.CRATER && grid[pos.i][pos.j].type !== TILE.PSR;
    const base = flatTile ? 0.35 : 0.15;
    const chance = Math.min(0.85, base + skill * 0.5);
    const ok = Math.random() < chance;
    setModal(null);
    setMode("WAKE");
    setLog((l) => [ok ? "Pragyan responded after lunar night! Limited operations possible." : "No response. Mission concluded.", ...l]);
  }

  // ---------- Render helpers ----------
  const { day, hod } = hourToDayHour(hour);
  const comm = isCommWindow(hour);

  function tileColor(t) {
    switch (t.type) {
      case TILE.LANDER:
        return "bg-amber-400";
      case TILE.PSR:
        return "bg-slate-900";
      case TILE.SLOPE:
        return "bg-slate-700";
      case TILE.BOULDER:
        return "bg-slate-600";
      case TILE.RIM:
        return "bg-cyan-700";
      case TILE.CRATER:
        return "bg-cyan-900";
      default:
        return "bg-slate-800";
    }
  }

  function tileLabel(t) {
    switch (t.type) {
      case TILE.LANDER:
        return "V";
      case TILE.PSR:
        return "PSR";
      case TILE.SLOPE:
        return "∠";
      case TILE.BOULDER:
        return "●";
      case TILE.RIM:
        return "rim";
      case TILE.CRATER:
        return "cr";
      default:
        return "";
    }
  }

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 to-black text-white">
      <header className="p-4 flex items-center justify-between border-b border-white/10">
        <div>
          <h1 className="text-2xl font-bold">Pragyan Rover – Lunar Day Ops</h1>
          <p className="text-white/60 text-sm">Maximize science within 14 Earth days at the lunar south pole.</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-center">
            <div className="text-xs text-white/60">Day</div>
            <div className="text-lg font-semibold">{day}/14</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-white/60">Hour</div>
            <div className="text-lg font-semibold">{hod.toString().padStart(2, "0")}:00</div>
          </div>
          <div className={`px-3 py-1 rounded-full text-sm ${comm ? "bg-emerald-600/80" : "bg-slate-700/80"}`}>
            {comm ? "Comm Window: OPEN" : "Comm Window: Closed"}
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-white/60">Speed</label>
            <input
              type="range"
              min={1}
              max={10}
              value={speed}
              onChange={(e) => setSpeed(parseInt(e.target.value))}
            />
          </div>
          <button
            className="px-3 py-1 rounded-xl bg-slate-800 border border-white/10 hover:bg-slate-700"
            onClick={() => setRunning((r) => !r)}
          >
            {running ? "Pause" : "Resume"}
          </button>
        </div>
      </header>

      <main className="p-4 grid grid-cols-12 gap-4">
        {/* Map & Rover */}
        <section className="col-span-7">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm text-white/70">Map – Lunar South Pole Sector</div>
            <div className="text-sm text-white/70">Solar: {Math.round(solarIrradiancePercent(hour, grid[pos.i][pos.j].type))}%</div>
          </div>
          <div
            className="grid rounded-2xl overflow-hidden border border-white/10"
            style={{ gridTemplateColumns: `repeat(${MAP_SIZE}, minmax(0, 1fr))` }}
          >
            {grid.map((row, i) =>
              row.map((t, j) => {
                const here = pos.i === i && pos.j === j;
                const seen = t.seen || here || (Math.abs(pos.i - i) + Math.abs(pos.j - j) <= 2);
                return (
                  <div
                    key={`${i}-${j}`}
                    onClick={() => enqueuePath(i, j)}
                    className={`relative aspect-square ${tileColor(t)} ${
                      seen ? "opacity-100" : "opacity-40"
                    } border border-black/30 flex items-center justify-center select-none cursor-pointer`}
                  >
                    {here ? (
                      <motion.div
                        layoutId="rover"
                        className="w-5 h-5 rounded-[6px] bg-amber-300 shadow-lg shadow-amber-500/30 border border-amber-900"
                        animate={{ rotate: [0, -5, 0, 5, 0] }}
                        transition={{ repeat: Infinity, duration: 3 }}
                        title="Pragyan"
                      />
                    ) : (
                      <span className="text-[10px] text-white/70">{tileLabel(t)}</span>
                    )}

                    {/* Science glint */}
                    {t.science > 0 && !here && (
                      <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-cyan-300 rounded-full animate-ping" />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Movement Controls */}
          <div className="mt-3 grid grid-cols-3 gap-2 w-56">
            <div></div>
            <button className="btn" onClick={() => move(-1, 0)}>
              ↑
            </button>
            <div></div>
            <button className="btn" onClick={() => move(0, -1)}>
              ←
            </button>
            <button className="btn" onClick={() => {}} disabled>
              •
            </button>
            <button className="btn" onClick={() => move(0, 1)}>
              →
            </button>
            <div></div>
            <button className="btn" onClick={() => move(1, 0)}>
              ↓
            </button>
            <div></div>
          </div>
        </section>

        {/* Right Panel */}
        <section className="col-span-5 space-y-4">
          {/* Status cards */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Power" value={`${Math.round(power)}%`} bar={power} />
            <Stat label="Data Buffer" value={`${buffer}MB / ${MAX_DATA_BUFFER}`} bar={(buffer / MAX_DATA_BUFFER) * 100} />
            <Stat label="Resource Potential" value={`${resourcePotential}%`} bar={resourcePotential} />
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-3">
            <ActionCard
              title="APXS"
              desc="Identify elemental peaks from X-ray spectrum"
              onClick={() => useInstrument("APXS")}
              disabled={power < 5}
            />
            <ActionCard
              title="LIBS"
              desc="Identify emission lines from laser plasma"
              onClick={() => useInstrument("LIBS")}
              disabled={power < 6}
            />
            <ActionCard
              title="Transmit"
              desc={comm ? "Send data via Vikram (window open)" : "Wait for window to open"}
              onClick={transmitData}
              disabled={buffer <= 0}
            />
            <ActionCard title="Hibernation" desc="Park & prep for lunar night" onClick={startHibernation} />
          </div>

          {/* Objectives */}
          <div className="rounded-2xl p-3 bg-slate-900/70 border border-white/10">
            <div className="font-semibold mb-2">Science Objectives</div>
            <div className="space-y-2">
              {objectives.map((o) => (
                <div key={o.id} className="flex items-center gap-2 text-sm">
                  <div className={`w-3 h-3 rounded-full ${o.done ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <span className={o.done ? "line-through text-white/50" : ""}>{o.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Log */}
          <div className="rounded-2xl p-3 bg-slate-900/70 border border-white/10 h-44 overflow-auto">
            <div className="font-semibold mb-2">Mission Log</div>
            <ul className="space-y-1 text-xs text-white/80">
              {log.map((line, idx) => (
                <li key={idx}>• {line}</li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      {/* Modals */}
      <AnimatePresence>
        {modal?.type === "APXS" || modal?.type === "LIBS" ? (
          <Modal onClose={() => setModal(null)}>
            <div className="space-y-3">
              <div className="text-lg font-semibold">{modal.type} – Data Analysis</div>
              <SpectrumChart
                title={modal.type === "APXS" ? "APXS Spectrum (counts vs. energy)" : "LIBS Emission Spectrum"}
                peaks={modal.spectrum.peaks}
                guesses={modal.guesses}
                onGuess={handleSpectrumGuess}
              />
              <div className="text-xs text-white/60">
                Tip: Click the element buttons that you believe correspond to peaks/lines.
              </div>
              {modal.solved && (
                <div className="p-2 rounded-lg bg-emerald-700/30 border border-emerald-500/30 text-sm">
                  Analysis complete. Composition updated & objectives checked.
                </div>
              )}
            </div>
          </Modal>
        ) : null}

        {modal?.type === "HIBERNATE" ? (
          <Modal onClose={() => setModal(null)}>
            <div className="space-y-3">
              <div className="text-lg font-semibold">Hibernation Protocol</div>
              <div className="text-sm text-white/80">
                Choose the right moment to cut power. Stop the slider within the green band to optimize panel angle and
                battery conservation.
              </div>
              <TimingBar onResult={(skill) => doWakeAttempt(skill)} />
            </div>
          </Modal>
        ) : null}
      </AnimatePresence>

      <footer className="p-4 text-center text-white/50 text-xs">
        Built as an educational prototype. Inspired by APXS & LIBS operations, PSR exploration, and Pragyan–Vikram relay.
      </footer>

      <style>{`
        .btn { @apply rounded-xl border border-white/10 bg-slate-800 hover:bg-slate-700 py-2 text-sm; }
      `}</style>
    </div>
  );
}

function Stat({ label, value, bar }) {
  return (
    <div className="rounded-2xl p-3 bg-slate-900/70 border border-white/10">
      <div className="text-xs text-white/60">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      <div className="mt-1 h-2 rounded-full bg-slate-700 overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
      </div>
    </div>
  );
}

function ActionCard({ title, desc, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left rounded-2xl p-3 border transition ${
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-slate-800"
      } bg-slate-900/70 border-white/10`}
    >
      <div className="font-semibold">{title}</div>
      <div className="text-xs text-white/70">{desc}</div>
    </button>
  );
}

function Modal({ children, onClose }) {
  return (
    <motion.div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-lg rounded-2xl bg-slate-950 border border-white/10 p-4"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
        <div className="mt-3 text-right">
          <button onClick={onClose} className="px-3 py-1 rounded-xl bg-slate-800 border border-white/10 hover:bg-slate-700">
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function TimingBar({ onResult }) {
  const [x, setX] = useState(0);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setX((v) => (v + 2) % 100), 20);
    return () => clearInterval(id);
  }, [running]);

  const inGreen = x > 45 && x < 65;
  return (
    <div className="space-y-2">
      <div className="h-6 rounded-full bg-slate-800 border border-white/10 relative overflow-hidden">
        <div className="absolute left-[45%] top-0 h-full w-[20%] bg-emerald-600/60" />
        <div className="absolute left-0 top-0 h-full w-1 bg-white/40" style={{ transform: `translateX(${x}%)` }} />
      </div>
      <div className="text-xs text-white/60">Stop near the center for a better wake chance.</div>
      <div className="flex gap-2">
        <button
          className="px-3 py-1 rounded-xl bg-slate-800 border border-white/10 hover:bg-slate-700"
          onClick={() => {
            setRunning(false);
            const skill = Math.max(0, 1 - Math.abs(x - 55) / 55); // 0..1
            onResult(skill);
          }}
        >
          Commit
        </button>
        <button className="px-3 py-1 rounded-xl bg-slate-800 border border-white/10" onClick={() => setX(Math.floor(Math.random() * 100))}>
          Nudge
        </button>
      </div>
    </div>
  );
}
