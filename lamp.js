(() => {
  "use strict";

  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d", { alpha: false });

  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d", { willReadFrequently: true });

  const heatSlider = document.getElementById("heat");
  const viscSlider = document.getElementById("viscosity");
  const countSlider = document.getElementById("count");
  const speedSlider = document.getElementById("speed");
  const launchSlider = document.getElementById("launch");
  const heatOut = document.getElementById("heatOut");
  const viscOut = document.getElementById("viscOut");
  const countOut = document.getElementById("countOut");
  const speedOut = document.getElementById("speedOut");
  const launchOut = document.getElementById("launchOut");
  const pauseButton = document.getElementById("pause");
  const resetButton = document.getElementById("reset");

  const statTemp = document.getElementById("statTemp");
  const statFPS = document.getElementById("statFPS");
  const statBlob = document.getElementById("statBlob");
  const statEnergy = document.getElementById("statEnergy");

  const TAU = Math.PI * 2;
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  let W = 1;
  let H = 1;
  let DPR = 1;
  // The glass spans y in [GLASS_TOP, GLASS_BOT] inside the lamp box.
  // Hardware (cap, base) lives above/below that range. The base is
  // intentionally compressed so the glass dominates the viewport: ~8% cap,
  // ~73% glass, ~19% base.
  const GLASS_TOP = 0.08;
  const GLASS_BOT = 0.81;
  let lamp = { x: 0, y: 0, w: 1, h: 1, aspect: 0.42 };
  let imageData = null;

  let blobs = [];
  let paused = false;
  let lastTime = performance.now();
  let fpsSmooth = 60;
  let frame = 0;
  let launchAccumulator = 0;

  // Classic Lava-brand teardrop glass: a straight-sided conical frustum.
  // Narrow at the top where it meets the cap, widening linearly to the foot
  // where it plugs into the base collar. y is [0,1] over the glass section.
  function lampHalfWidth(y) {
    const t = clamp(y, 0, 1);
    const topHw = 0.050;
    const botHw = 0.295;
    return lerp(topHw, botHw, t);
  }

  function glassAspect() {
    // Blob coordinates are normalized over the GLASS section, not over the
    // entire metal fixture.  This must be width / glass-height, otherwise
    // the metaball field over-fuses horizontally into one central mass.
    return lamp.aspect / Math.max(0.001, GLASS_BOT - GLASS_TOP);
  }

  function insideLamp(x, y, radius = 0) {
    if (y < 0.02 + radius || y > 0.985 - radius) return false;
    return Math.abs(x - 0.5) <= lampHalfWidth(y) - radius * 0.55;
  }

  function constrainToLamp(b, dt) {
    const minY = 0.026 + b.r * 0.48;
    const maxY = 0.980 - b.r * 0.55;

    if (b.y < minY) {
      // No rubber-ball rebound at the cap.  The cooling zone in physicsStep
      // should already be turning the blob around; this is just a soft guard
      // rail for the rare case where it reaches the glass boundary.
      const overshoot = minY - b.y;
      b.y = minY + overshoot * 0.08;
      b.vy = Math.max(0.006 + overshoot * 5.5 * dt, b.vy * 0.12);
      b.vx *= 0.82;
      b.temp -= 0.020;
      b.topDwell = (b.topDwell || 0) + dt * 0.65;
    }

    if (b.y > maxY) {
      const push = b.y - maxY;
      b.y = maxY;
      b.vy = Math.min(b.vy, 0) * 0.22 - push * 9.0 * dt;
      b.vx *= 0.86;
      b.temp += 0.012;
      b.bottomDwell = (b.bottomDwell || 0) + dt * 0.55;
    }

    const hw = lampHalfWidth(b.y);
    const pad = Math.min(b.r * 0.62 + 0.005, hw * 0.84);
    const left = 0.5 - hw + pad;
    const right = 0.5 + hw - pad;

    if (b.x < left) {
      const push = left - b.x;
      b.vx += push * 40 * dt;
      b.x = left;
      b.vx *= -0.12;
    }

    if (b.x > right) {
      const push = b.x - right;
      b.vx -= push * 40 * dt;
      b.x = right;
      b.vx *= -0.12;
    }
  }

  function localFluidTemperature(x, y, t) {
    // Normalized oil temperature.  Heat is concentrated at the plate and in
    // a slow center plume; the neck is deliberately cooler for smooth turnarounds.
    const heater = Number(heatSlider.value);
    const hw = lampHalfWidth(y);
    const centerDistance = Math.abs(x - 0.5) / Math.max(0.001, hw);

    const heaterPlate = smoothstep(0.82, 1.0, y);
    const lowerBath = smoothstep(0.62, 1.0, y);
    const plumeCore =
      (1 - smoothstep(0.08, 0.64, centerDistance)) *
      smoothstep(0.14, 0.86, y) *
      (1 - smoothstep(0.88, 1.0, y));
    const coldNeck = 1 - smoothstep(0.05, 0.30, y);
    const coolWalls = smoothstep(0.70, 1.0, centerDistance) * (1 - smoothstep(0.72, 1.0, y));

    const convection =
      0.018 * Math.sin(9.5 * x + 5.0 * y + t * 0.00055) +
      0.010 * Math.sin(15.0 * (x - 0.45 * y) - t * 0.00085);

    return clamp(
      0.125 +
      0.66 * heaterPlate * heater +
      0.15 * lowerBath * heater +
      0.23 * plumeCore * heater -
      0.22 * coldNeck -
      0.065 * coolWalls +
      convection,
      0.025,
      1.08
    );
  }

  function makeBlob(opts = {}) {
    let y = opts.y;
    let temp = opts.temp;
    let vy = opts.vy;
    let role = opts.role;

    if (y == null) {
      const mode = Math.random();
      if (mode < 0.38) {
        role = role ?? "riser";
        y = rand(0.70, 0.94);
        temp = temp ?? rand(0.68, 0.98);
        vy = vy ?? rand(-0.26, -0.10);
      } else if (mode < 0.64) {
        role = role ?? "sinker";
        y = rand(0.08, 0.46);
        temp = temp ?? rand(0.07, 0.30);
        vy = vy ?? rand(0.07, 0.20);
      } else if (mode < 0.88) {
        role = role ?? "free";
        y = rand(0.28, 0.76);
        temp = temp ?? rand(0.25, 0.64);
        vy = vy ?? rand(-0.10, 0.11);
      } else {
        role = role ?? "reservoir";
        y = rand(0.88, 0.97);
        temp = temp ?? rand(0.48, 0.76);
        vy = vy ?? rand(-0.018, 0.012);
      }
    }

    if (vy == null) vy = rand(-0.030, 0.030);
    if (temp == null) temp = localFluidTemperature(opts.x ?? 0.5, y, performance.now());

    const desiredR = opts.r ?? (
      role === "reservoir" ? rand(0.052, 0.074) :
      role === "riser" ? rand(0.040, 0.060) :
      rand(0.034, 0.056)
    );
    const maxRForNeck = Math.max(0.022, lampHalfWidth(y) * 0.72);
    const r = clamp(desiredR, 0.026, Math.min(0.082, maxRForNeck));
    const hw = lampHalfWidth(y);
    const available = Math.max(0.002, hw - r * 0.92 - 0.006);
    const x = opts.x ?? rand(0.5 - available, 0.5 + available);

    return {
      x,
      y,
      vx: opts.vx ?? rand(-0.024, 0.024),
      vy,
      r,
      temp: clamp(temp, 0.025, 1.08),
      heatCapacity: opts.heatCapacity ?? rand(0.85, 1.55),
      launchTemp: opts.launchTemp ?? rand(0.50, 0.66),
      sinkTemp: opts.sinkTemp ?? rand(0.22, 0.36),
      bottomDwell: opts.bottomDwell ?? rand(0, 0.7),
      topDwell: opts.topDwell ?? 0,
      role: role ?? opts.role ?? "free",
      phase: rand(0, TAU),
      age: opts.age ?? rand(0, 8),
      mergeLock: 0,
      justLaunched: opts.justLaunched ?? 0,
      birthAge: opts.birthAge ?? null,
      birthDuration: opts.birthDuration ?? 1.15,
      birthScaleStart: opts.birthScaleStart ?? 0.50,
      emitCooldown: opts.emitCooldown ?? rand(0, 0.8)
    };
  }

  function resetBlobs() {
    const count = Number(countSlider.value);
    blobs = [];
    launchAccumulator = 0.35;

    // Start with a small warm base reservoir, then seed a few already-detached
    // risers/sinkers so the lamp does not spend its first minute as one pool.
    const reservoirCount = Math.max(1, Math.min(3, Math.round(count * 0.18)));
    for (let i = 0; i < reservoirCount; i++) {
      blobs.push(makeBlob({
        role: "reservoir",
        y: rand(0.88, 0.97),
        r: rand(0.058, 0.078),
        temp: rand(0.50, 0.78),
        vy: rand(-0.018, 0.010),
        bottomDwell: rand(0.2, 1.0)
      }));
    }

    while (blobs.length < count) {
      const mode = blobs.length % 3;
      blobs.push(makeBlob({
        role: mode === 0 ? "riser" : mode === 1 ? "sinker" : "free"
      }));
    }
  }

  function resize() {
    DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    W = Math.floor(window.innerWidth * DPR);
    H = Math.floor(window.innerHeight * DPR);

    canvas.width = W;
    canvas.height = H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Wider aspect than a real lamp — this page is about watching the lava,
    // so the glass takes priority over silhouette fidelity.
    const lampHeight = Math.min(H * 0.94, W * 2.0);
    const lampWidth = lampHeight * 0.39;
    lamp = {
      w: lampWidth,
      h: lampHeight,
      x: (W - lampWidth) / 2,
      y: (H - lampHeight) / 2 + H * 0.015,
      aspect: lampWidth / lampHeight
    };

    const glassH = lampHeight * (GLASS_BOT - GLASS_TOP);
    const offH = Math.round(clamp(glassH / 2.8, 240, 520));
    const offW = Math.round(offH * glassAspect());
    off.width = offW;
    off.height = offH;
    imageData = offCtx.createImageData(offW, offH);
  }

  function growReservoirFromHeat(strength = 1) {
    // Only the base reservoir may gain a little wax from the unseen wax pool at
    // the heater.  Visible risers must be born by mass transfer from a parent.
    const candidates = blobs.filter((b) => b.y > 0.80 && b.role === "reservoir");
    const target = candidates.length
      ? candidates.reduce((best, b) => (b.r > best.r ? b : best), candidates[0])
      : null;

    if (target) {
      target.r = Math.min(0.086, Math.sqrt(target.r * target.r + 0.00018 * strength));
      target.temp = clamp(target.temp + 0.055 * strength, 0.36, 1.04);
      target.bottomDwell += 0.18 * strength;
      return target;
    }

    const y = rand(0.90, 0.97);
    const hw = lampHalfWidth(y);
    const r = rand(0.046, 0.060);
    const parent = makeBlob({
      x: clamp(0.5 + rand(-0.20, 0.20) * hw, 0.5 - hw + r, 0.5 + hw - r),
      y,
      r,
      vx: rand(-0.010, 0.010),
      vy: rand(-0.012, 0.004),
      temp: rand(0.48, 0.72),
      role: "reservoir",
      bottomDwell: rand(0.4, 1.2),
      birthAge: 0,
      birthDuration: 1.6,
      birthScaleStart: 0.30
    });
    blobs.push(parent);
    return parent;
  }

  function choosePinchParent(candidates = []) {
    const pool = candidates.length
      ? candidates
      : blobs.filter((b) => b.y > 0.72 && b.r > 0.047 && b.emitCooldown <= 0);
    if (!pool.length) return growReservoirFromHeat(0.8);

    let total = 0;
    const weights = pool.map((b) => {
      const hot = smoothstep(0.48, 0.92, b.temp);
      const low = smoothstep(0.68, 1.0, b.y);
      const big = smoothstep(0.042, 0.082, b.r);
      const reservoirBonus = b.role === "reservoir" ? 1.28 : 1.0;
      const w = Math.max(0.02, (0.30 + hot * 1.60 + low * 0.80 + big * 0.80) * reservoirBonus);
      total += w;
      return w;
    });

    let pick = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      pick -= weights[i];
      if (pick <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function spawnRisingDrop(parent, strength = 1) {
    if (!parent || parent.r < 0.043) return false;

    const aspect = glassAspect();
    const area = parent.r * parent.r;
    const reservoir = parent.role === "reservoir";
    const minParentR = reservoir ? 0.046 : 0.032;
    const maxChildByArea = Math.sqrt(Math.max(0.00035, area - minParentR * minParentR)) * 0.88;
    const targetChildR = parent.r * rand(reservoir ? 0.46 : 0.38, reservoir ? 0.64 : 0.58);
    const childR = clamp(Math.min(targetChildR, maxChildByArea), 0.030, 0.058);

    if (childR < 0.0305) {
      parent.r = Math.min(0.086, parent.r + 0.0035);
      parent.temp = clamp(parent.temp + 0.035 * strength, 0.36, 1.04);
      parent.bottomDwell += 0.22 * strength;
      return false;
    }

    // Daughter blob starts attached to the upper surface, not already clear of
    // it.  Rendering grows it from a small radius, so the eye sees a neck form.
    const side = rand(-1, 1);
    const xOffset = side * rand(0.04, 0.19) * childR / Math.max(aspect, 0.01);
    const yOffset = (parent.r + childR) * rand(0.62, 0.86);
    const sourceY = clamp(parent.y - yOffset, 0.08, 0.88);
    const hw = lampHalfWidth(sourceY);
    const childX = clamp(parent.x + xOffset, 0.5 - hw + childR * 0.8, 0.5 + hw - childR * 0.8);
    const childY = sourceY;

    // Approximately conserve visible wax area: the child borrows area from the
    // parent, with a small correction because overlapping metaballs still show
    // as one connected volume during birth.
    const borrowedArea = childR * childR * 0.92;
    parent.r = Math.max(minParentR, Math.sqrt(Math.max(minParentR * minParentR, area - borrowedArea)));
    parent.temp = clamp(parent.temp - 0.050 * strength, 0.30, 1.02);
    parent.vy = Math.max(parent.vy, 0.015);
    parent.bottomDwell = 0;
    parent.emitCooldown = rand(0.75, 1.45) / Math.max(0.6, Number(launchSlider?.value ?? 1));
    parent.launchTemp = rand(0.50, 0.66);

    const child = makeBlob({
      x: childX,
      y: childY,
      r: childR,
      vx: parent.vx + rand(-0.020, 0.020) + xOffset * 0.16 * aspect,
      vy: -rand(0.22, 0.36) * strength,
      temp: clamp(parent.temp + rand(0.20, 0.35), 0.62, 1.06),
      role: "riser",
      heatCapacity: rand(0.74, 1.18),
      launchTemp: rand(0.48, 0.62),
      justLaunched: 1.45,
      birthAge: 0,
      birthDuration: rand(0.85, 1.30),
      birthScaleStart: rand(0.38, 0.56),
      emitCooldown: rand(0.60, 1.15)
    });
    child.mergeLock = 1.55;
    blobs.push(child);
    constrainToLamp(parent, 0.016);
    constrainToLamp(child, 0.016);
    return true;
  }


  function physicsStep(dt, now) {
    const heater = Number(heatSlider.value);
    const viscosityControl = Number(viscSlider.value);
    const desiredCount = Number(countSlider.value);
    const launchControl = Number(launchSlider.value);
    const aspect = glassAspect();

    // Lower accelerations and stronger drag give a more lava-lamp-like time
    // scale.  The speed slider changes dt, not these forces, so slow motion
    // remains physically consistent.
    const neutralTemp = 0.50;
    const gravity = 0.34;
    const lift = 1.18 + 0.14 * heater;
    const baseDrag = 1.18 * viscosityControl;

    let freeAboveBase = 0;
    const hotBaseCandidates = [];

    for (const b of blobs) {
      b.age += dt;
      if (b.birthAge != null) b.birthAge += dt;
      b.mergeLock = Math.max(0, b.mergeLock - dt);
      b.justLaunched = Math.max(0, (b.justLaunched || 0) - dt);
      b.emitCooldown = Math.max(0, (b.emitCooldown || 0) - dt);

      const env = localFluidTemperature(b.x, b.y, now);
      const heatExchangeRate = (0.48 + 0.16 * heater) / (b.heatCapacity * (1 + b.r * 10.5));
      b.temp += (env - b.temp) * heatExchangeRate * dt;

      const bottomContact = smoothstep(0.74, 1.0, b.y);
      const topZone = 1 - smoothstep(0.055, 0.24, b.y);

      // Base wax warms slowly, dwells, then detaches.  This produces fewer,
      // larger rising blobs instead of many fast specks.
      if (bottomContact > 0.02) {
        b.bottomDwell += dt * bottomContact;
        b.temp += heater * (0.36 + 0.28 * bottomContact + Math.min(0.22, b.bottomDwell * 0.08)) * bottomContact * dt / b.heatCapacity;
        if (b.temp < b.launchTemp && b.vy > -0.016) {
          b.vy *= 0.32;
          b.vx *= 0.86;
          b.role = b.role === "sinker" ? "free" : b.role;
        }
        if (b.temp > b.launchTemp && b.bottomDwell > 0.24) {
          b.vy = Math.min(b.vy, -rand(0.18, 0.32) * (0.85 + 0.25 * heater));
          b.vx += rand(-0.026, 0.026);
          b.role = "riser";
          b.bottomDwell = 0;
          b.launchTemp = rand(0.50, 0.66);
        }
        if (b.temp > 0.56 && b.r > 0.048 && b.emitCooldown <= 0) hotBaseCandidates.push(b);
      } else {
        b.bottomDwell = Math.max(0, b.bottomDwell - dt * 0.42);
      }

      // Smooth top transition: cool and decelerate upward motion before a blob
      // reaches the cap, then gently bias it outward/downward.  This replaces
      // the old hard bounce with a rounded turn.
      if (topZone > 0.001) {
        b.topDwell += dt * topZone;
        b.temp -= (0.25 + 0.25 * topZone + Math.min(0.16, b.topDwell * 0.08)) * topZone * dt / b.heatCapacity;
        if (b.vy < 0) b.vy *= 1 - clamp(topZone * 2.6 * dt, 0, 0.16);
        b.vy += (0.030 + 0.13 * topZone) * topZone * dt;
        b.vx += (b.x < 0.5 ? -1 : 1) * 0.020 * topZone * dt;
        if (b.temp < b.sinkTemp && b.vy < 0.055) {
          b.vy += rand(0.010, 0.035);
          b.sinkTemp = rand(0.22, 0.38);
        }
      } else {
        b.topDwell = Math.max(0, b.topDwell - dt * 0.40);
      }

      b.temp = clamp(b.temp, 0.025, 1.06);

      const hw = lampHalfWidth(b.y);
      const centerDistance = Math.abs(b.x - 0.5) / Math.max(0.001, hw);
      const hotness = clamp((b.temp - 0.10) / 0.86, 0, 1);
      const coldness = 1 - hotness;

      const centerUpdraft = (1 - smoothstep(0.14, 0.86, centerDistance)) * smoothstep(0.18, 0.92, b.y);
      const wallDowndraft = smoothstep(0.58, 1.0, centerDistance) * (1 - smoothstep(0.82, 1.0, b.y));
      let ay =
        gravity - lift * b.temp -
        0.095 * heater * centerUpdraft * (0.45 + hotness) +
        0.125 * wallDowndraft * (0.70 + 0.65 * coldness) +
        0.040 * topZone;

      if (b.justLaunched > 0) {
        ay -= (0.42 + 0.18 * heater) * smoothstep(0, 1.25, b.justLaunched);
      }

      const towardCenter = b.x < 0.5 ? 1 : -1;
      const awayFromCenter = -towardCenter;
      const bottomInflow = towardCenter * 0.045 * smoothstep(0.66, 1.0, b.y) * heater;
      const topOutflow = awayFromCenter * 0.038 * topZone * (0.6 + coldness);
      const swirl =
        0.024 * Math.sin(10.8 * b.y + b.phase + now * 0.00044) +
        0.012 * Math.sin(6.5 * b.x - now * 0.00031 + b.phase * 1.7);

      b.vx += (bottomInflow + topOutflow + swirl) * dt;
      b.vy += ay * dt;

      const speed = Math.hypot(b.vx / Math.max(aspect, 0.01), b.vy);
      const thermalDrag = lerp(1.38, 0.56, hotness);
      const sizeDrag = lerp(1.10, 0.88, clamp((b.r - 0.026) / 0.060, 0, 1));
      const launchSlip = b.justLaunched > 0 ? 0.46 : 1.0;
      const quadraticDrag = 1 + speed * 2.35;
      b.vx -= b.vx * baseDrag * thermalDrag * sizeDrag * quadraticDrag * launchSlip * dt;
      b.vy -= b.vy * baseDrag * thermalDrag * sizeDrag * quadraticDrag * launchSlip * dt;

      const jitter = 0.0028 * (1.15 - clamp(b.r * 10, 0, 0.9));
      b.vx += Math.sin(now * 0.0013 + b.phase) * jitter * dt;
      b.vy += Math.cos(now * 0.0010 + b.phase * 1.7) * jitter * dt;

      b.vx = clamp(b.vx, -0.28, 0.28);
      b.vy = clamp(b.vy, -0.56, 0.42);

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      constrainToLamp(b, dt);
      if (b.y < 0.74 && b.role !== "reservoir") freeAboveBase++;
    }

    // Soft parcel interaction.  Blobs are independent bodies; the metaball
    // renderer alone handles visual joining.  Permanent physical merging is
    // intentionally disabled because it recreates a single lower mass.
    for (let i = 0; i < blobs.length; i++) {
      const a = blobs[i];
      for (let j = i + 1; j < blobs.length; j++) {
        const b = blobs[j];
        const dx = (b.x - a.x) * aspect;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) + 1e-6;
        const launchPair = (a.justLaunched > 0 || b.justLaunched > 0) && (a.y > 0.68 || b.y > 0.68);
        const targetD = (a.r + b.r) * (launchPair ? 1.05 : 0.58);

        const near = smoothstep((a.r + b.r) * 2.0, (a.r + b.r) * 0.70, d);
        if (near > 0) {
          const exchange = (b.temp - a.temp) * 0.026 * near * dt;
          a.temp += exchange;
          b.temp -= exchange;
        }

        if (d < targetD) {
          const overlap = targetD - d;
          const nx = dx / d;
          const ny = dy / d;
          const invAspect = 1 / Math.max(aspect, 0.01);
          const impulse = overlap * (launchPair ? 0.82 : 0.42);

          a.x -= nx * impulse * 0.5 * invAspect;
          b.x += nx * impulse * 0.5 * invAspect;
          a.y -= ny * impulse * 0.5;
          b.y += ny * impulse * 0.5;

          const rvx = (b.vx - a.vx) * aspect;
          const rvy = b.vy - a.vy;
          const closing = rvx * nx + rvy * ny;
          if (closing < 0) {
            const bounce = -closing * (launchPair ? 0.090 : 0.040);
            a.vx -= nx * bounce * invAspect;
            b.vx += nx * bounce * invAspect;
            a.vy -= ny * bounce;
            b.vy += ny * bounce;
          }

          constrainToLamp(a, dt);
          constrainToLamp(b, dt);
        }
      }
    }

    // Explicit nucleation: if too few blobs are visibly detached from the base,
    // a hot lower blob sheds a full-size droplet from its upper surface.
    const needLaunch = freeAboveBase < Math.max(3, Math.floor(desiredCount * 0.34));

    // Deterministic heater nucleation now uses mass-conserving pinch-off from
    // an existing lower wax parent.  This keeps launches reliable without
    // making hot droplets materialize ex nihilo near the base.
    launchAccumulator += dt * heater * launchControl * (needLaunch ? 0.78 : 0.20);
    if (launchAccumulator >= 1 && blobs.length < desiredCount + 7) {
      const parent = choosePinchParent(hotBaseCandidates);
      const launched = spawnRisingDrop(parent, needLaunch ? 1.16 : 0.94);
      if (!launched) growReservoirFromHeat(needLaunch ? 1.0 : 0.55);
      launchAccumulator = rand(-0.25, 0.20);
    }

    if (hotBaseCandidates.length && blobs.length < desiredCount + 7) {
      const chance = needLaunch ? 1.0 : 0.38;
      if (Math.random() < dt * launchControl * (0.95 + 1.15 * heater) * chance) {
        const parent = choosePinchParent(hotBaseCandidates);
        spawnRisingDrop(parent, needLaunch ? 1.12 : 0.90);
      }
    }

    // Occasional thermal pinch-off. The child blobs are large enough to read
    // as wax drops, but the renderer keeps base reservoirs visually quieter.
    for (let i = blobs.length - 1; i >= 0; i--) {
      const b = blobs[i];
      const hotBase = b.y > 0.76 && b.temp > Math.max(0.60, b.launchTemp - 0.02);
      const coolTop = b.y < 0.22 && b.temp < 0.39;

      if (hotBase && b.r > 0.052 && b.emitCooldown <= 0 && blobs.length < desiredCount + 7 && Math.random() < dt * launchControl * 0.46) {
        spawnRisingDrop(b, 0.88);
      }

      if (coolTop && b.r > 0.054 && blobs.length < desiredCount + 6 && Math.random() < dt * 0.20) {
        const keep = rand(0.58, 0.72);
        const r1 = b.r * Math.sqrt(keep);
        const r2 = clamp(b.r * Math.sqrt(1 - keep), 0.026, 0.048);
        const angle = Math.PI / 2 + rand(-0.80, 0.80);
        const sep = (r1 + r2) * 0.52;
        const nx = Math.cos(angle) / Math.max(aspect, 0.01);
        const ny = Math.sin(angle);

        b.r = Math.max(0.030, r1);
        b.x -= nx * sep * 0.25;
        b.y -= ny * sep * 0.25;
        b.vx -= nx * 0.010;
        b.vy -= ny * 0.010;
        b.mergeLock = 1.1;

        const child = makeBlob({
          x: b.x + nx * sep,
          y: b.y + ny * sep,
          r: r2,
          vx: b.vx + nx * 0.016,
          vy: Math.max(0.035, b.vy + rand(0.030, 0.085)),
          temp: clamp(b.temp - rand(0.02, 0.08), 0.025, 0.48),
          role: "sinker",
          heatCapacity: rand(0.90, 1.45)
        });
        child.mergeLock = 1.1;
        blobs.push(child);
        constrainToLamp(b, dt);
        constrainToLamp(child, dt);
      }
    }

    while (blobs.length < desiredCount) {
      // Replenish only the lower reservoir, not already-detached risers.
      // Otherwise the count-maintenance loop looks like wax popping into being.
      const parent = growReservoirFromHeat(0.7);
      if (!parent || blobs.length < desiredCount) {
        const y = rand(0.89, 0.97);
        const hw = lampHalfWidth(y);
        const r = rand(0.040, 0.056);
        blobs.push(makeBlob({
          x: clamp(0.5 + rand(-0.24, 0.24) * hw, 0.5 - hw + r, 0.5 + hw - r),
          y,
          r,
          temp: rand(0.42, 0.70),
          vy: rand(-0.016, 0.006),
          role: "reservoir",
          bottomDwell: rand(0.2, 0.9),
          birthAge: 0,
          birthDuration: 1.8,
          birthScaleStart: 0.24
        }));
      }
    }

    while (blobs.length > desiredCount + 7) {
      let best = 0;
      let score = Infinity;
      for (let i = 0; i < blobs.length; i++) {
        const b = blobs[i];
        const s =
          b.r * b.r * 4 +
          b.temp * 0.008 +
          (b.y > 0.70 ? 0.000 : 0.004) +
          (b.justLaunched > 0 ? 0.025 : 0) +
          (b.role === "reservoir" ? -0.004 : 0);
        if (s < score) {
          score = s;
          best = i;
        }
      }
      blobs.splice(best, 1);
    }
  }

  // The glass is rendered in lamp-local space, where the lamp bounding box
  // covers the full fixture. Blobs live in [0,1] over the glass section.
  function glassPxY(y) {
    return lamp.y + (GLASS_TOP + y * (GLASS_BOT - GLASS_TOP)) * lamp.h;
  }

  function drawGlassPath(context) {
    const samples = 56;
    context.beginPath();

    for (let i = 0; i <= samples; i++) {
      const y = i / samples;
      const x = 0.5 - lampHalfWidth(y);
      const px = lamp.x + x * lamp.w;
      const py = glassPxY(y);
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }

    for (let i = samples; i >= 0; i--) {
      const y = i / samples;
      const x = 0.5 + lampHalfWidth(y);
      context.lineTo(lamp.x + x * lamp.w, glassPxY(y));
    }

    context.closePath();
  }

  function renderMetaballs() {
    const w = off.width;
    const h = off.height;
    const data = imageData.data;
    const aspect = glassAspect();

    let p = 0;
    for (let j = 0; j < h; j++) {
      const y = (j + 0.5) / h;
      const hw = lampHalfWidth(y);

      for (let i = 0; i < w; i++, p += 4) {
        const x = (i + 0.5) / w;

        if (Math.abs(x - 0.5) > hw || y < 0.01 || y > 0.99) {
          data[p + 3] = 0;
          continue;
        }

        let field = 0;
        let tempWeighted = 0;

        for (const b of blobs) {
          const dx = (x - b.x) * aspect;
          const dy = y - b.y;
          const d2 = dx * dx + dy * dy + 0.000060;
          const reservoirFade = b.role === "reservoir" && b.y > 0.74 ? 0.70 : 1.0;
          const launchedBoost = b.justLaunched > 0 ? 1.04 : 1.0;
          const birthT = b.birthAge == null ? 1 : smoothstep(0, b.birthDuration || 1, b.birthAge);
          const birthScale = b.birthAge == null ? 1 : lerp(b.birthScaleStart || 0.5, 1, birthT);
          const effectiveR = b.r * reservoirFade * launchedBoost * birthScale * lerp(1.04, 1.17, clamp(b.temp, 0, 1));
          const c = (effectiveR * effectiveR) / d2;
          field += c;
          tempWeighted += c * b.temp;
        }

        const lava = smoothstep(1.08, 1.72, field);
        if (lava <= 0.001) {
          data[p + 3] = 0;
          continue;
        }

        const temp = clamp(tempWeighted / Math.max(field, 1e-6), 0, 1);
        const core = smoothstep(1.62, 4.05, field);
        const glow = smoothstep(0.98, 1.26, field) * 0.40;

        const red = lerp(150, 255, smoothstep(0.10, 0.82, temp));
        const green = lerp(25, 185, Math.pow(clamp(temp, 0, 1), 1.55));
        const blue = lerp(18, 44, 1 - smoothstep(0.35, 1.0, temp));

        data[p] = clamp(red + core * 20 + glow * 18, 0, 255);
        data[p + 1] = clamp(green + core * 25 + glow * 8, 0, 255);
        data[p + 2] = clamp(blue, 0, 255);
        data[p + 3] = clamp((lava * 230 + core * 25), 0, 255);
      }
    }

    offCtx.putImageData(imageData, 0, 0);
  }

  function drawBackground(now) {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.58, 0, W * 0.5, H * 0.58, Math.max(W, H) * 0.75);
    g.addColorStop(0, "#19101f");
    g.addColorStop(0.55, "#080813");
    g.addColorStop(1, "#030305");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const baseGlowY = lamp.y + lamp.h * 0.96;
    const baseGlow = ctx.createRadialGradient(W * 0.5, baseGlowY, 0, W * 0.5, baseGlowY, lamp.w * 1.6);
    baseGlow.addColorStop(0, "rgba(255, 126, 32, 0.32)");
    baseGlow.addColorStop(0.55, "rgba(255, 98, 18, 0.09)");
    baseGlow.addColorStop(1, "rgba(255, 98, 18, 0)");
    ctx.fillStyle = baseGlow;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < 45; i++) {
      const x = (Math.sin(i * 91.3) * 0.5 + 0.5) * W;
      const y = ((Math.cos(i * 37.1 + now * 0.00003) * 0.5 + 0.5) * H);
      const s = (Math.sin(i * 19.7) * 0.5 + 0.8) * DPR;
      ctx.fillStyle = "rgba(255, 209, 127, 0.7)";
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  // Tapered cylinder: draws a trapezoidal silhouette between two radii.
  function taperPath(context, cx, yTop, yBot, rTop, rBot) {
    context.beginPath();
    context.moveTo(cx - rTop, yTop);
    context.lineTo(cx + rTop, yTop);
    context.lineTo(cx + rBot, yBot);
    context.lineTo(cx - rBot, yBot);
    context.closePath();
  }

  function brushedMetal(context, cx, w, warm = false) {
    const g = context.createLinearGradient(cx - w * 0.5, 0, cx + w * 0.5, 0);
    if (warm) {
      g.addColorStop(0, "#1a1410");
      g.addColorStop(0.18, "#503524");
      g.addColorStop(0.36, "#b87a3c");
      g.addColorStop(0.50, "#f6c078");
      g.addColorStop(0.64, "#b0723a");
      g.addColorStop(0.82, "#452e1f");
      g.addColorStop(1, "#110c09");
    } else {
      g.addColorStop(0, "#111015");
      g.addColorStop(0.18, "#3a3540");
      g.addColorStop(0.38, "#807a86");
      g.addColorStop(0.50, "#b6afba");
      g.addColorStop(0.62, "#7c7682");
      g.addColorStop(0.82, "#37323c");
      g.addColorStop(1, "#0e0d12");
    }
    return g;
  }

  function drawCap(cx) {
    // Silver truncated cone sitting on the glass shoulder — a short, narrow
    // frustum that tapers inward toward the top.
    const glassTopY = glassPxY(0);
    const glassTopHw = lampHalfWidth(0) * lamp.w;

    // Short silver cap — just a stubby frustum above the glass lip.
    const capH = lamp.h * 0.055;
    const capTop = glassTopY - capH;
    const capBot = glassTopY + lamp.h * 0.004;  // slight overlap with glass
    const rTop = glassTopHw * 0.85;
    const rBot = glassTopHw * 1.22;

    ctx.fillStyle = brushedMetal(ctx, cx, rBot * 2.3, false);
    taperPath(ctx, cx, capTop, capBot, rTop, rBot);
    ctx.fill();

    // Subtle top ellipse to suggest a rolled rim.
    ctx.beginPath();
    ctx.ellipse(cx, capTop, rTop, rTop * 0.18, 0, 0, TAU);
    ctx.fillStyle = "rgba(210, 210, 220, 0.85)";
    ctx.fill();

    // Vertical specular stripe on the cap's left side.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, 1.2 * DPR);
    ctx.beginPath();
    ctx.moveTo(cx - rTop * 0.55, capTop + rTop * 0.25);
    ctx.lineTo(cx - rBot * 0.55, capBot - rTop * 0.15);
    ctx.stroke();
    ctx.restore();

    // Dark seam where the cap meets the glass.
    ctx.beginPath();
    ctx.moveTo(cx - rBot, capBot);
    ctx.lineTo(cx + rBot, capBot);
    ctx.strokeStyle = "rgba(30, 30, 38, 0.55)";
    ctx.lineWidth = Math.max(1, 1 * DPR);
    ctx.stroke();
  }

  function drawBase(cx) {
    // Two stacked silver cones with a pinched waist between them — the classic
    // hourglass lava-lamp pedestal. Upper cone tapers DOWN (wider at the glass,
    // narrower at the waist). Lower cone tapers UP from the waist to a broad foot.
    const glassBotY = glassPxY(1);
    const glassBotHw = lampHalfWidth(1) * lamp.w;

    const topConeRTop = glassBotHw * 1.12;
    const topConeRBot = glassBotHw * 0.58;
    const topConeH = lamp.h * 0.096;

    const waistH = lamp.h * 0.005;
    const waistR = topConeRBot * 0.92;

    const botConeRTop = waistR;
    const botConeRBot = glassBotHw * 1.18;
    const botConeH = lamp.h * 0.093;

    const topConeY0 = glassBotY;
    const waistY0 = topConeY0 + topConeH;
    const botConeY0 = waistY0 + waistH;
    const botConeY1 = botConeY0 + botConeH;

    // Upper cone.
    ctx.fillStyle = brushedMetal(ctx, cx, topConeRTop * 2.3, false);
    taperPath(ctx, cx, topConeY0, waistY0, topConeRTop, topConeRBot);
    ctx.fill();

    // Waist band (tiny cylinder).
    ctx.fillStyle = brushedMetal(ctx, cx, waistR * 2.3, false);
    taperPath(ctx, cx, waistY0, botConeY0, topConeRBot, waistR);
    ctx.fill();

    // Lower cone.
    ctx.fillStyle = brushedMetal(ctx, cx, botConeRBot * 2.3, false);
    taperPath(ctx, cx, botConeY0, botConeY1, botConeRTop, botConeRBot);
    ctx.fill();

    // Seam line between upper cone and waist for crispness.
    ctx.strokeStyle = "rgba(30, 30, 38, 0.55)";
    ctx.lineWidth = Math.max(1, 1 * DPR);
    ctx.beginPath();
    ctx.moveTo(cx - topConeRBot, waistY0);
    ctx.lineTo(cx + topConeRBot, waistY0);
    ctx.moveTo(cx - waistR, botConeY0);
    ctx.lineTo(cx + waistR, botConeY0);
    ctx.stroke();

    // Seam where the glass meets the top cone.
    ctx.beginPath();
    ctx.moveTo(cx - topConeRTop, topConeY0);
    ctx.lineTo(cx + topConeRTop, topConeY0);
    ctx.strokeStyle = "rgba(30, 30, 38, 0.65)";
    ctx.stroke();

    // Specular highlight running down the left of both cones.
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = Math.max(1, 1.2 * DPR);
    ctx.beginPath();
    ctx.moveTo(cx - topConeRTop * 0.55, topConeY0 + topConeH * 0.15);
    ctx.lineTo(cx - topConeRBot * 0.55, waistY0 - topConeH * 0.05);
    ctx.moveTo(cx - waistR * 0.55, botConeY0 + botConeH * 0.08);
    ctx.lineTo(cx - botConeRBot * 0.55, botConeY1 - botConeH * 0.12);
    ctx.stroke();
    ctx.restore();

    // Cast shadow under the base.
    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(cx, botConeY1 + lamp.h * 0.008, botConeRBot * 1.15, lamp.h * 0.012, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawLamp(now) {
    const cx = lamp.x + lamp.w * 0.5;

    drawBase(cx);

    ctx.save();
    drawGlassPath(ctx);

    const glass = ctx.createLinearGradient(lamp.x, 0, lamp.x + lamp.w, 0);
    glass.addColorStop(0, "rgba(255,255,255,0.05)");
    glass.addColorStop(0.13, "rgba(255,255,255,0.22)");
    glass.addColorStop(0.22, "rgba(255,255,255,0.03)");
    glass.addColorStop(0.80, "rgba(255,255,255,0.04)");
    glass.addColorStop(0.91, "rgba(255,255,255,0.20)");
    glass.addColorStop(1, "rgba(255,255,255,0.03)");

    ctx.fillStyle = "rgba(36, 20, 55, 0.30)";
    ctx.fill();

    ctx.save();
    ctx.clip();

    const glassTop = glassPxY(0);
    const glassHeight = glassPxY(1) - glassTop;
    const oil = ctx.createLinearGradient(0, glassTop, 0, glassTop + glassHeight);
    oil.addColorStop(0, "rgba(46, 32, 88, 0.64)");
    oil.addColorStop(0.58, "rgba(28, 20, 48, 0.54)");
    oil.addColorStop(1, "rgba(89, 38, 26, 0.72)");
    ctx.fillStyle = oil;
    ctx.fillRect(lamp.x, glassTop, lamp.w, glassHeight);

    renderMetaballs();
    ctx.imageSmoothingEnabled = true;

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.55;
    ctx.filter = `blur(${Math.max(9, 12 * DPR)}px)`;
    ctx.drawImage(off, lamp.x, glassTop, lamp.w, glassHeight);

    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.drawImage(off, lamp.x, glassTop, lamp.w, glassHeight);
    ctx.globalCompositeOperation = "source-over";

    const heatPower = Number(heatSlider.value);
    const heater = ctx.createRadialGradient(
      cx, glassTop + glassHeight * 0.98, 0,
      cx, glassTop + glassHeight * 0.98, lamp.w * (0.26 + 0.10 * heatPower)
    );
    heater.addColorStop(0, `rgba(255, 220, 90, ${0.30 + 0.16 * heatPower})`);
    heater.addColorStop(0.45, `rgba(255, 105, 32, ${0.24 + 0.12 * heatPower})`);
    heater.addColorStop(1, "rgba(255, 105, 32, 0)");
    ctx.fillStyle = heater;
    ctx.fillRect(lamp.x, glassTop + glassHeight * 0.68, lamp.w, glassHeight * 0.36);

    ctx.restore();

    drawGlassPath(ctx);
    ctx.fillStyle = glass;
    ctx.fill();

    drawGlassPath(ctx);
    ctx.strokeStyle = "rgba(255, 231, 176, 0.22)";
    ctx.lineWidth = Math.max(1, 1.25 * DPR);
    ctx.stroke();

    // Left-side specular streak that follows the curvature.
    ctx.beginPath();
    const streakSamples = 24;
    for (let i = 0; i <= streakSamples; i++) {
      const y = i / streakSamples;
      const hw = lampHalfWidth(y);
      const px = lamp.x + (0.5 - hw * 0.78) * lamp.w;
      const py = glassPxY(y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = Math.max(1, 1.6 * DPR);
    ctx.stroke();

    ctx.restore();

    drawCap(cx);
  }

  function updateStats(dt) {
    if (frame % 9 !== 0) return;

    let avgTemp = 0;
    let energy = 0;
    for (const b of blobs) {
      avgTemp += b.temp;
      energy += 0.5 * (b.vx * b.vx + b.vy * b.vy) * b.r * b.r * 1000;
    }
    avgTemp /= Math.max(1, blobs.length);

    statTemp.textContent = `temp: ${avgTemp.toFixed(3)}`;
    statFPS.textContent = `fps: ${fpsSmooth.toFixed(0)}`;
    statBlob.textContent = `blobs: ${blobs.length}`;
    statEnergy.textContent = `energy: ${energy.toFixed(3)}`;
  }

  function animate(now) {
    const rawDt = clamp((now - lastTime) / 1000, 0.001, 0.045);
    lastTime = now;
    fpsSmooth = lerp(fpsSmooth, 1 / rawDt, 0.06);

    if (!paused) {
      const timeScale = Number(speedSlider.value);
      const scaledDt = rawDt * timeScale;
      const substeps = clamp(Math.ceil(scaledDt / 0.010), 2, 18);
      const dt = scaledDt / substeps;
      for (let i = 0; i < substeps; i++) physicsStep(dt, now + i * dt * 1000);
    }

    drawBackground(now);
    drawLamp(now);
    updateStats(rawDt);
    frame++;

    requestAnimationFrame(animate);
  }

  function pointerToGlass(event) {
    const rect = canvas.getBoundingClientRect();
    const clientX = event.clientX ?? event.touches?.[0]?.clientX;
    const clientY = event.clientY ?? event.touches?.[0]?.clientY;
    const px = (clientX - rect.left) * DPR;
    const py = (clientY - rect.top) * DPR;
    const glassTop = glassPxY(0);
    const glassHeight = glassPxY(1) - glassTop;
    return {
      x: (px - lamp.x) / lamp.w,
      y: (py - glassTop) / glassHeight
    };
  }

  function injectBlob(event) {
    const p = pointerToGlass(event);
    if (!insideLamp(p.x, p.y, 0.035)) return;

    const r = rand(0.038, 0.062);
    blobs.push(makeBlob({
      x: p.x,
      y: p.y,
      r,
      temp: clamp(localFluidTemperature(p.x, p.y, performance.now()) + 0.34, 0.48, 1.0),
      vx: rand(-0.028, 0.028),
      vy: rand(-0.11, -0.035)
    }));

    const max = Number(countSlider.value) + 12;
    if (blobs.length > max) {
      let best = 0;
      let score = Infinity;
      for (let i = 0; i < blobs.length; i++) {
        const s = blobs[i].r * blobs[i].r + blobs[i].temp * 0.002;
        if (s < score) {
          score = s;
          best = i;
        }
      }
      blobs.splice(best, 1);
    }
  }

  function syncControls() {
    heatOut.textContent = `${Number(heatSlider.value).toFixed(2)}×`;
    viscOut.textContent = `${Number(viscSlider.value).toFixed(2)}×`;
    speedOut.textContent = `${Number(speedSlider.value).toFixed(2)}×`;
    launchOut.textContent = `${Number(launchSlider.value).toFixed(2)}×`;
    countOut.textContent = countSlider.value;
  }

  heatSlider.addEventListener("input", syncControls);
  viscSlider.addEventListener("input", syncControls);
  speedSlider.addEventListener("input", syncControls);
  launchSlider.addEventListener("input", syncControls);
  countSlider.addEventListener("input", syncControls);
  countSlider.addEventListener("change", resetBlobs);

  pauseButton.addEventListener("click", () => {
    paused = !paused;
    pauseButton.textContent = paused ? "Resume" : "Pause";
  });

  resetButton.addEventListener("click", resetBlobs);
  canvas.addEventListener("pointerdown", injectBlob);

  window.addEventListener("resize", resize, { passive: true });

  resize();
  syncControls();
  resetBlobs();
  requestAnimationFrame((t) => {
    lastTime = t;
    requestAnimationFrame(animate);
  });
})();
