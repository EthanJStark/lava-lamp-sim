(() => {
  "use strict";

  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d", { alpha: false });

  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d", { willReadFrequently: true });

  const heatSlider = document.getElementById("heat");
  const viscSlider = document.getElementById("viscosity");
  const countSlider = document.getElementById("count");
  const heatOut = document.getElementById("heatOut");
  const viscOut = document.getElementById("viscOut");
  const countOut = document.getElementById("countOut");
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
  // Hardware (cap, base) lives above/below that range. Proportions match a
  // classic Lava-brand lamp: ~8% cap, ~60% glass, ~32% base.
  const GLASS_TOP = 0.08;
  const GLASS_BOT = 0.68;
  let lamp = { x: 0, y: 0, w: 1, h: 1, aspect: 0.42 };
  let imageData = null;

  let blobs = [];
  let paused = false;
  let lastTime = performance.now();
  let fpsSmooth = 60;
  let frame = 0;

  // Classic Lava-brand teardrop glass: a straight-sided conical frustum.
  // Narrow at the top where it meets the cap, widening linearly to the foot
  // where it plugs into the base collar. y is [0,1] over the glass section.
  function lampHalfWidth(y) {
    const t = clamp(y, 0, 1);
    const topHw = 0.050;
    const botHw = 0.295;
    return lerp(topHw, botHw, t);
  }

  function insideLamp(x, y, radius = 0) {
    if (y < 0.02 + radius || y > 0.985 - radius) return false;
    return Math.abs(x - 0.5) <= lampHalfWidth(y) - radius * 0.55;
  }

  function constrainToLamp(b, dt) {
    const minY = 0.028 + b.r * 0.55;
    const maxY = 0.978 - b.r * 0.55;

    if (b.y < minY) {
      const push = minY - b.y;
      b.vy += push * 42 * dt;
      b.y = minY;
      b.vy *= -0.25;
      b.temp -= 0.012;
    }

    if (b.y > maxY) {
      const push = b.y - maxY;
      b.vy -= push * 48 * dt;
      b.y = maxY;
      b.vy *= -0.18;
      b.temp += 0.015;
    }

    const hw = lampHalfWidth(b.y);
    const pad = b.r * 0.58 + 0.006;
    const left = 0.5 - hw + pad;
    const right = 0.5 + hw - pad;

    if (b.x < left) {
      const push = left - b.x;
      b.vx += push * 54 * dt;
      b.x = left;
      b.vx *= -0.26;
    }

    if (b.x > right) {
      const push = b.x - right;
      b.vx -= push * 54 * dt;
      b.x = right;
      b.vx *= -0.26;
    }
  }

  function localFluidTemperature(x, y, t) {
    const bottomHeat = smoothstep(0.48, 1.0, y);
    const topCooling = 1 - smoothstep(0.0, 0.35, y);
    const convection =
      0.035 * Math.sin(8 * x + 4.2 * y + t * 0.0007) +
      0.018 * Math.sin(15 * (x - y) - t * 0.0011);

    const heater = Number(heatSlider.value);
    return clamp(0.18 + 0.55 * bottomHeat * heater - 0.09 * topCooling + convection, 0.08, 0.98);
  }

  function makeBlob(opts = {}) {
    const y = opts.y ?? rand(0.38, 0.96);
    const r = opts.r ?? rand(0.030, 0.067);
    const hw = lampHalfWidth(y);
    const x = opts.x ?? rand(0.5 - hw * 0.55, 0.5 + hw * 0.55);

    return {
      x,
      y,
      vx: opts.vx ?? rand(-0.015, 0.015),
      vy: opts.vy ?? rand(-0.015, 0.015),
      r,
      temp: opts.temp ?? clamp(localFluidTemperature(x, y, performance.now()) + rand(-0.12, 0.10), 0.12, 0.92),
      phase: rand(0, TAU),
      age: rand(0, 8),
      mergeLock: 0
    };
  }

  function resetBlobs() {
    const count = Number(countSlider.value);
    blobs = [];
    for (let i = 0; i < count; i++) blobs.push(makeBlob());
  }

  function resize() {
    DPR = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    W = Math.floor(window.innerWidth * DPR);
    H = Math.floor(window.innerHeight * DPR);

    canvas.width = W;
    canvas.height = H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // The full lamp box includes base and cap hardware. Reference proportions
    // from a classic Lava-brand 14.5" lamp: ~4:1 total height-to-base-width.
    const lampHeight = Math.min(H * 0.94, W * 2.6);
    const lampWidth = lampHeight * 0.30;
    lamp = {
      w: lampWidth,
      h: lampHeight,
      x: (W - lampWidth) / 2,
      y: (H - lampHeight) / 2 + H * 0.015,
      aspect: lampWidth / lampHeight
    };

    const glassH = lampHeight * (GLASS_BOT - GLASS_TOP);
    const offH = Math.round(clamp(glassH / 2.8, 240, 520));
    const offW = Math.round(offH * (lamp.aspect * (GLASS_BOT - GLASS_TOP) / (GLASS_BOT - GLASS_TOP)));
    off.width = offW;
    off.height = offH;
    imageData = offCtx.createImageData(offW, offH);
  }

  function physicsStep(dt, now) {
    const heater = Number(heatSlider.value);
    const viscosityControl = Number(viscSlider.value);
    const neutralTemp = 0.505;
    const buoyancy = 1.58;
    const baseDrag = 1.22 * viscosityControl;

    for (const b of blobs) {
      b.age += dt;
      b.mergeLock = Math.max(0, b.mergeLock - dt);

      const env = localFluidTemperature(b.x, b.y, now);
      const heatExchangeRate = (0.72 + 0.22 * heater) / (1 + b.r * 9.5);
      b.temp += (env - b.temp) * heatExchangeRate * dt;

      b.temp += heater * 0.29 * smoothstep(0.78, 1.0, b.y) * dt / (1 + b.r * 7.5);
      b.temp -= 0.20 * (1 - smoothstep(0.06, 0.25, b.y)) * dt / (1 + b.r * 7.5);
      b.temp = clamp(b.temp, 0.05, 1.05);

      const thermalBuoyancy = -buoyancy * (b.temp - neutralTemp);

      const hw = lampHalfWidth(b.y);
      const centerDistance = Math.abs(b.x - 0.5) / Math.max(0.001, hw);
      const centerUpdraft = 1 - smoothstep(0.18, 0.92, centerDistance);
      const wallDowndraft = smoothstep(0.55, 1.0, centerDistance);
      const circulationY = -0.16 * centerUpdraft * heater + 0.13 * wallDowndraft;
      const circulationX =
        0.055 * Math.sin(10 * b.y + b.phase + now * 0.00045) *
        (0.4 + 0.6 * smoothstep(0.20, 0.90, b.y));

      const coldDrag = lerp(1.75, 0.58, clamp(b.temp, 0, 1));
      const speed = Math.hypot(b.vx / Math.max(lamp.aspect, 0.01), b.vy);
      const quadraticDrag = 1 + speed * 8.5;

      b.vx += circulationX * dt;
      b.vy += (thermalBuoyancy + circulationY) * dt;

      b.vx -= b.vx * baseDrag * coldDrag * quadraticDrag * dt;
      b.vy -= b.vy * baseDrag * coldDrag * quadraticDrag * dt;

      const jitter = 0.0045 * (1.1 - clamp(b.r * 10, 0, 0.8));
      b.vx += Math.sin(now * 0.0017 + b.phase) * jitter * dt;
      b.vy += Math.cos(now * 0.0013 + b.phase * 1.7) * jitter * dt;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      constrainToLamp(b, dt);
    }

    for (let i = 0; i < blobs.length; i++) {
      const a = blobs[i];
      for (let j = i + 1; j < blobs.length; j++) {
        const b = blobs[j];
        const dx = (b.x - a.x) * lamp.aspect;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) + 1e-6;
        const minD = (a.r + b.r) * 0.72;

        const near = smoothstep((a.r + b.r) * 2.2, (a.r + b.r) * 0.6, d);
        if (near > 0) {
          const exchange = (b.temp - a.temp) * 0.055 * near * dt;
          a.temp += exchange;
          b.temp -= exchange;
        }

        if (d < minD) {
          const overlap = minD - d;
          const nx = dx / d;
          const ny = dy / d;

          const invAspect = 1 / Math.max(lamp.aspect, 0.01);
          const impulse = overlap * 0.78;
          a.x -= nx * impulse * 0.5 * invAspect;
          b.x += nx * impulse * 0.5 * invAspect;
          a.y -= ny * impulse * 0.5;
          b.y += ny * impulse * 0.5;

          const rvx = (b.vx - a.vx) * lamp.aspect;
          const rvy = b.vy - a.vy;
          const closing = rvx * nx + rvy * ny;
          if (closing < 0) {
            const bounce = -closing * 0.18;
            a.vx -= nx * bounce * invAspect;
            b.vx += nx * bounce * invAspect;
            a.vy -= ny * bounce;
            b.vy += ny * bounce;
          }

          constrainToLamp(a, dt);
          constrainToLamp(b, dt);
        }

        const canMerge =
          blobs.length > 9 &&
          a.mergeLock <= 0 &&
          b.mergeLock <= 0 &&
          d < (a.r + b.r) * 0.34 &&
          Math.abs(a.temp - b.temp) < 0.16 &&
          Math.hypot(a.vx - b.vx, a.vy - b.vy) < 0.11;

        if (canMerge) {
          const areaA = a.r * a.r;
          const areaB = b.r * b.r;
          const area = areaA + areaB;
          a.x = (a.x * areaA + b.x * areaB) / area;
          a.y = (a.y * areaA + b.y * areaB) / area;
          a.vx = (a.vx * areaA + b.vx * areaB) / area;
          a.vy = (a.vy * areaA + b.vy * areaB) / area;
          a.temp = (a.temp * areaA + b.temp * areaB) / area;
          a.r = Math.min(0.105, Math.sqrt(area) * 0.986);
          a.mergeLock = 1.25;
          blobs.splice(j, 1);
          j--;
        }
      }
    }

    for (let i = blobs.length - 1; i >= 0; i--) {
      const b = blobs[i];
      const atColdTop = b.y < 0.28 && b.temp < 0.43;
      const atHotBase = b.y > 0.82 && b.temp > 0.72;
      const unstable = b.r > 0.062 && (atColdTop || atHotBase);

      if (unstable && blobs.length < Number(countSlider.value) + 8 && Math.random() < dt * 0.58) {
        const keep = rand(0.48, 0.64);
        const r1 = b.r * Math.sqrt(keep);
        const r2 = b.r * Math.sqrt(1 - keep);
        const angle = rand(0, TAU);
        const sep = (r1 + r2) * 0.48;
        const nx = Math.cos(angle) / Math.max(lamp.aspect, 0.01);
        const ny = Math.sin(angle);

        b.r = r1;
        b.x -= nx * sep * 0.5;
        b.y -= ny * sep * 0.5;
        b.vx -= nx * 0.015;
        b.vy -= ny * 0.015;
        b.mergeLock = 1.1;

        const child = makeBlob({
          x: b.x + nx * sep,
          y: b.y + ny * sep,
          r: r2,
          vx: b.vx + nx * 0.035,
          vy: b.vy + ny * 0.035,
          temp: b.temp + rand(-0.025, 0.025)
        });
        child.mergeLock = 1.1;
        blobs.push(child);
        constrainToLamp(b, dt);
        constrainToLamp(child, dt);
      }
    }

    while (blobs.length < Math.max(7, Number(countSlider.value) - 5)) {
      blobs.push(makeBlob({
        y: rand(0.84, 0.96),
        r: rand(0.026, 0.042),
        temp: rand(0.66, 0.86),
        vy: rand(-0.045, -0.010)
      }));
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
    const aspect = lamp.aspect * (GLASS_BOT - GLASS_TOP);

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
          const d2 = dx * dx + dy * dy + 0.000055;
          const c = (b.r * b.r) / d2;
          field += c;
          tempWeighted += c * b.temp;
        }

        const lava = smoothstep(0.92, 1.52, field);
        if (lava <= 0.001) {
          data[p + 3] = 0;
          continue;
        }

        const temp = clamp(tempWeighted / Math.max(field, 1e-6), 0, 1);
        const core = smoothstep(1.40, 3.60, field);
        const glow = smoothstep(0.82, 1.15, field) * 0.45;

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
    const topConeH = lamp.h * 0.16;

    const waistH = lamp.h * 0.008;
    const waistR = topConeRBot * 0.92;

    const botConeRTop = waistR;
    const botConeRBot = glassBotHw * 1.18;
    const botConeH = lamp.h * 0.155;

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
      const substeps = rawDt > 0.025 ? 3 : 2;
      const dt = rawDt / substeps;
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

    const r = rand(0.028, 0.048);
    blobs.push(makeBlob({
      x: p.x,
      y: p.y,
      r,
      temp: clamp(localFluidTemperature(p.x, p.y, performance.now()) + 0.34, 0.48, 1.0),
      vx: rand(-0.045, 0.045),
      vy: rand(-0.18, -0.04)
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
    countOut.textContent = countSlider.value;
  }

  heatSlider.addEventListener("input", syncControls);
  viscSlider.addEventListener("input", syncControls);
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
