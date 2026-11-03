// ASCII Bouquet — a procedural, blooming flower bouquet rendered as ASCII art.
//
// Rendering pipeline:
//   1. Draw vector shapes (Bézier stems, leaves, petals) onto a small offscreen canvas.
//   2. Read the pixels back and average them per character cell.
//   3. Map each cell's brightness to a character from a density ramp.
//   4. Draw that character in the cell's colour, over a soft blurred glow.
(() => {
  'use strict';

  // ---------- Settings ----------
  const RAMP = ' .:-=+*cxoaX#%&@'; // dark -> bright character density ramp
  const WATER_RAMP = ' .,-~~≈';     // a softer, wavier ramp used below the waterline
  const FONT_SIZE = 10;              // px size of each glyph
  const SUPERSAMPLE = 2;             // offscreen pixels per cell, per axis (smoother edges)
  const LOOP_SECONDS = 30;           // auto-replant after this many seconds
  const FADE_SECONDS = 1.5;          // fade-out before an automatic replant
  const GOLDEN_ANGLE = 2.39996;      // phyllotaxis angle used to spiral the leaves

  const COLORS = {
    bg: '#0d0b12',
    stems: ['#5c9a58', '#4e8b4f', '#6aa862'],
    leaves: ['#6dbb6f', '#5aa35f', '#86c97f'],
    leafBack: '#477f4b',
    leafVein: '#3d7443',
    sepal: '#5e9e57',
    center: '#2a1820',
    centerRing: '#6b3f52',
    stamen: '#f4e4a6',
    breath: '#f7eef3',
    breathStem: '#7a9f6a',
    eucalyptus: '#9cc5a1',
    eucStem: '#6f9a7a',
    ribbon: '#f3b3c9',
    ribbonKnot: '#f9d3df',
    anther: '#c8743c',
    pistil: '#cfe3a6',
    stars: ['#ffffff', '#dfe9ff', '#ffe3ee', '#fff4d6'],
    moon: '#fbf6dc',
    moonShade: '#e9e0b8',
    moonCrater: '#d6cca2',
    moonHalo: 'rgba(251, 246, 220, 0.2)',
    waterTop: 'rgba(58, 96, 140, 0.7)',
    waterDeep: 'rgba(20, 36, 62, 0.9)',
    ripple: [150, 200, 235],
    flowers: [
      // baby blue lilies with a pink blush at the tips
      { base: '#7fbfe6', mid: '#a7d8f0', tip: '#e3f3fc', blush: '#f7c6d9', edge: '#6aa9d4', vein: '#5a92c8', spot: '#3d5f8f' },
      // baby pink lilies with a soft peach blush
      { base: '#ee9dbd', mid: '#f8bbd0', tip: '#fff0f5', blush: '#ffe0d2', edge: '#e48bb0', vein: '#d86e98', spot: '#8f3a5e' },
    ],
  };

  // ---------- Small helpers ----------
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const invEaseOut = g => 1 - Math.cbrt(1 - g); // time fraction at which easeOut reaches g
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Seeded random numbers, so each bouquet is reproducible from its seed.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rand = Math.random;
  const rr = (a, b) => a + (b - a) * rand();
  const pick = arr => arr[Math.floor(rand() * arr.length)];

  // Blend two hex colours, e.g. to tint a closed bud green.
  const rgbCache = {};
  function hexToRgb(hex) {
    if (!rgbCache[hex]) {
      const n = parseInt(hex.slice(1), 16);
      rgbCache[hex] = [n >> 16, (n >> 8) & 255, n & 255];
    }
    return rgbCache[hex];
  }
  function mixColor(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
  }

  // Cubic Bézier helpers. A curve is an array of 4 points [p0, p1, p2, p3].
  function bezPoint(c, t) {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    return {
      x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
      y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
    };
  }
  function bezTangent(c, t) {
    const u = 1 - t;
    return {
      x: 3 * u * u * (c[1].x - c[0].x) + 6 * u * t * (c[2].x - c[1].x) + 3 * t * t * (c[3].x - c[2].x),
      y: 3 * u * u * (c[1].y - c[0].y) + 6 * u * t * (c[2].y - c[1].y) + 3 * t * t * (c[3].y - c[2].y),
    };
  }
  // De Casteljau split: the part of the curve from 0 to t (used to "grow" a stem).
  function bezSplit(c, t) {
    const l = (p, q) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) });
    const a = l(c[0], c[1]), b = l(c[1], c[2]), d = l(c[2], c[3]);
    const e = l(a, b), f = l(b, d);
    return [c[0], a, e, l(e, f)];
  }

  // ---------- Canvas setup ----------
  const screen = document.getElementById('screen');
  const sctx = screen.getContext('2d');
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', { willReadFrequently: true });
  const FONT = `${FONT_SIZE}px ui-monospace, Menlo, Consolas, monospace`;

  let viewW, viewH, cols, rows, cellW, cellH, gridX, gridY, worldW, worldH, U, waterTop;
  let stars = [];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    screen.width = Math.floor(viewW * dpr);
    screen.height = Math.floor(viewH * dpr);
    screen.style.width = viewW + 'px';
    screen.style.height = viewH + 'px';
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.font = FONT;
    cellW = sctx.measureText('M').width;
    cellH = Math.round(FONT_SIZE * 1.2);
    cols = Math.floor(viewW / cellW);
    rows = Math.floor(viewH / cellH);
    worldW = cols * cellW; // "world" = the drawing space in screen pixels
    worldH = rows * cellH;
    gridX = (viewW - worldW) / 2;
    gridY = (viewH - worldH) / 2;
    off.width = cols * SUPERSAMPLE;
    off.height = rows * SUPERSAMPLE;
    U = Math.min(worldH / 112, worldW / 125); // one "unit" scales the whole scene
    waterTop = worldH - U * 10;
    makeStars();
  }

  // ---------- Night sky ----------
  // Stars use their own fixed seed, so the sky stays the same when you replant.
  function makeStars() {
    const r = mulberry32(20261102);
    const skyRows = Math.max(1, Math.floor(waterTop / cellH) - 1);
    const count = Math.floor(cols * skyRows * 0.012);
    const moon = moonGeom();
    stars = [];
    for (let i = 0; i < count; i++) {
      const bright = r() < 0.1;
      const col = Math.floor(r() * cols), row = Math.floor(r() * skyRows);
      // No stars inside the moon or its halo.
      if (Math.hypot((col + 0.5) * cellW - moon.x, (row + 0.5) * cellH - moon.y) < moon.r * 2.4) continue;
      stars.push({
        col,
        row,
        level: bright ? 0.4 + r() * 0.2 : 0.07 + r() * 0.2,
        speed: 0.5 + r() * 1.5,
        phase: r() * Math.PI * 2,
        color: COLORS.stars[Math.floor(r() * COLORS.stars.length)],
      });
    }
  }

  // Each star fills exactly one character cell; its twinkle changes the glyph.
  function drawStars(ctx, clock) {
    for (const s of stars) {
      ctx.globalAlpha = s.level * (0.55 + 0.45 * Math.sin(clock * s.speed + s.phase));
      ctx.fillStyle = s.color;
      ctx.fillRect(s.col * cellW, s.row * cellH, cellW, cellH);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Moon ----------
  function moonGeom() {
    return { x: worldW - U * 14, y: U * 14, r: U * 6 };
  }
  // Craters sit on the lit (left) side of the crescent.
  const MOON_CRATERS = [
    { x: -0.6, y: -0.15, r: 0.14 },
    { x: -0.45, y: 0.4, r: 0.12 },
    { x: -0.2, y: 0.7, r: 0.08 },
  ];
  // The circle "bitten out" of the moon to make the crescent shape.
  const MOON_SHADOW = { x: 0.45, y: -0.2, r: 0.9 };

  // A crescent moon in the top-right corner, with craters and a softly pulsing halo.
  function drawMoon(ctx, clock) {
    const m = moonGeom();
    const halo = ctx.createRadialGradient(m.x, m.y, m.r * 0.9, m.x, m.y, m.r * 2.2);
    halo.addColorStop(0, COLORS.moonHalo);
    halo.addColorStop(1, 'rgba(251, 246, 220, 0)');
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin(clock * 0.5);
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.r * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    const disc = ctx.createRadialGradient(m.x - m.r * 0.6, m.y, 0, m.x, m.y, m.r);
    disc.addColorStop(0, COLORS.moon);
    disc.addColorStop(1, COLORS.moonShade);
    ctx.fillStyle = disc;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = COLORS.moonCrater;
    for (const c of MOON_CRATERS) {
      ctx.beginPath(); ctx.arc(m.x + c.x * m.r, m.y + c.y * m.r, c.r * m.r, 0, Math.PI * 2); ctx.fill();
    }

    // Cover an offset circle in the night-sky colour to leave a crescent. It hides
    // the disc and the halo behind it, so the dark side blends into the sky.
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.arc(m.x + MOON_SHADOW.x * m.r, m.y + MOON_SHADOW.y * m.r, MOON_SHADOW.r * m.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- Breeze ----------
  // A few layered sine waves plus a slow gust envelope feel organic.
  function breeze(t, phase) {
    const gust = 0.65 + 0.35 * Math.sin(t * 0.13 + 1.3);
    return gust * (Math.sin(t * 0.9 + phase) * 0.6 +
                   Math.sin(t * 0.37 + phase * 1.7) * 0.3 +
                   Math.sin(t * 2.3 + phase * 0.6) * 0.1);
  }

  // The stem's curve this frame: its rest shape plus a sideways sway that grows
  // towards the tip (taller stems have a bigger swayAmp).
  function curveAt(st, p0, t) {
    const dx = breeze(t, st.phase) * st.swayAmp;
    const [o1, o2, o3] = st.off;
    return [
      p0,
      { x: p0.x + o1.x + dx * 0.12, y: p0.y + o1.y },
      { x: p0.x + o2.x + dx * 0.55, y: p0.y + o2.y + Math.abs(dx) * 0.05 },
      { x: p0.x + o3.x + dx,        y: p0.y + o3.y + Math.abs(dx) * 0.15 },
    ];
  }

  // ---------- Bouquet generation ----------
  let flowerCounter = 0;

  // A lily: six tepals (3 outer + 3 inner), six stamens and a central pistil.
  function makeFlower(R) {
    const spots = []; // freckles near the throat of each petal
    for (let i = 0; i < 4; i++) spots.push({ s: rr(0.15, 0.4), o: rr(-0.35, 0.35) });
    const stamens = []; // one between each pair of petals
    for (let i = 0; i < 6; i++) stamens.push({ a: (i / 6) * Math.PI * 2 - Math.PI + rr(-0.12, 0.12), l: rr(0.5, 0.62) });
    return {
      radius: R,
      pal: COLORS.flowers[flowerCounter++ % COLORS.flowers.length],
      rot: rr(-0.3, 0.3),
      budDur: rr(1.5, 2.2),  // the bud grows and swells
      holdDur: rr(0.6, 1.2), // ...stays closed for a moment...
      openDur: rr(3.5, 4.5), // ...then the petals unfurl
      spots,
      stamens,
    };
  }

  function makeStem(a, h, delay, opts) {
    const dir = { x: Math.sin(a), y: -Math.cos(a) };
    const perp = { x: -dir.y, y: dir.x };
    const bend = rr(-1, 1) * h * 0.08;
    const kind = opts.kind;
    const st = {
      kind,
      off: [
        { x: dir.x * h * 0.33 + perp.x * bend * 0.3, y: dir.y * h * 0.33 + perp.y * bend * 0.3 },
        { x: dir.x * h * 0.7 + perp.x * bend,        y: dir.y * h * 0.7 + perp.y * bend },
        { x: dir.x * h,                              y: dir.y * h },
      ],
      delay,
      grow: rr(2.2, 3.2) * (opts.main ? 1 : 0.7),
      phase: rr(0, Math.PI * 2),
      swayAmp: U * 5 * Math.pow(h / (75 * U), 2),
      width: kind === 'flower' ? U * rr(0.9, 1.2) * (opts.main ? 1 : 0.7) : U * 0.4,
      color: kind === 'euc' ? COLORS.eucStem : kind === 'breath' ? COLORS.breathStem : pick(COLORS.stems),
      leaves: [], sprigs: [], children: [], flower: null,
    };
    const bornAt = s => st.delay + st.grow * invEaseOut(s);

    if (kind === 'flower') {
      // Leaves spiral up the stem using the golden angle.
      const count = opts.main ? 2 + Math.floor(rand() * 3) : 1;
      const scale = opts.main ? 1 : 0.7;
      for (let j = 0; j < count; j++) {
        const s = 0.2 + (j + rr(0.1, 0.6)) * (0.55 / count);
        st.leaves.push({
          s, born: bornAt(s),
          phi: j * GOLDEN_ANGLE + rr(0, 1),
          len: U * rr(7, 11) * scale,
          wid: U * rr(1.8, 2.6) * scale,
          tilt: rr(0.55, 0.95),
          color: pick(COLORS.leaves),
        });
      }
      st.flower = makeFlower(opts.main ? U * rr(11, 13) : U * rr(6.5, 8));
      // Sometimes branch off a smaller side stem with its own flower.
      if (opts.main && rand() < 0.65) {
        const s = rr(0.45, 0.65);
        const side = rand() < 0.5 ? -1 : 1;
        const child = makeStem(a + side * rr(0.35, 0.6), h * rr(0.3, 0.42), bornAt(s), { kind: 'flower', main: false });
        st.children.push({ s, stem: child });
      }
    } else if (kind === 'euc') {
      // Eucalyptus-style filler: pairs of round leaves along the stem.
      for (let s = 0.12; s < 0.97; s += rr(0.09, 0.13)) {
        for (const side of [-1, 1]) st.leaves.push({ s, side, born: bornAt(s), r: U * rr(1.5, 2.2) * (1 - 0.4 * s) });
      }
    } else {
      // Baby's breath filler: little twigs ending in clusters of tiny dots.
      const count = 7 + Math.floor(rand() * 4);
      const addSprig = (s, ang, len) => {
        const dots = [];
        const nd = 3 + Math.floor(rand() * 3);
        for (let i = 0; i < nd; i++) dots.push({ x: rr(-1.4, 1.4) * U, y: rr(-1.4, 1.4) * U });
        st.sprigs.push({ s, born: bornAt(s), ang, len, dots });
      };
      for (let i = 0; i < count; i++) addSprig(rr(0.4, 0.97), (rand() < 0.5 ? -1 : 1) * rr(0.4, 1.1), U * rr(2.5, 6));
      addSprig(0.999, 0, U);
    }
    return st;
  }

  function buildBouquet(seed) {
    rand = mulberry32(seed);
    flowerCounter = Math.floor(rand() * 2);
    const base = { x: worldW / 2, y: waterTop - U * 3 }; // the tie sits just above the water
    const stems = [], fillers = [], cuts = [];

    // Fewer, wider-spread stems so the big lilies have room.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const k = i / (N - 1) - 0.5;
      const a = k * 1.5 + rr(-0.06, 0.06);
      const h = U * (76 - Math.abs(k) * 48 + rr(-4, 4));
      const st = makeStem(a, h, rr(0.2, 2.2), { kind: 'flower', main: true });
      stems.push(st);
      // The stems cross at the tie, so their cut ends poke out the other side.
      const len = U * rr(6, 9);
      cuts.push({ x: base.x - Math.sin(a) * len, y: base.y + Math.cos(a) * len, color: st.color, width: st.width });
    }
    for (let i = 0; i < 5; i++) fillers.push(makeStem(rr(-1, 1), U * rr(50, 72), rr(0.5, 3), { kind: 'breath' }));
    for (let i = 0; i < 4; i++) fillers.push(makeStem(rr(-1.1, 1.1), U * rr(32, 52), rr(0, 1.5), { kind: 'euc' }));
    return { base, stems, fillers, cuts };
  }

  // ---------- Vector drawing ----------
  const flowerQueue = []; // flowers are drawn last so stems never cover them

  // A leaf/petal-like shape pointing along +x from the origin.
  function leafPath(ctx, L, w) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(L * 0.25, -w, L * 0.7, -w * 0.85, L, 0);
    ctx.bezierCurveTo(L * 0.7, w * 0.85, L * 0.25, w, 0, 0);
    ctx.closePath();
  }

  function drawLeaf(ctx, c, lf, t, st) {
    const grow = easeOut(clamp01((t - lf.born) / 1.3));
    if (grow <= 0) return;
    const p = bezPoint(c, lf.s), tan = bezTangent(c, lf.s);
    // phi = rotation around the stem; cos(phi) is how much the leaf faces sideways.
    const phi = lf.phi + breeze(t * 1.4, st.phase + lf.s * 4) * 0.4;
    const facing = Math.cos(phi);
    const side = facing >= 0 ? 1 : -1;
    const L = lf.len * grow * (0.4 + 0.6 * Math.abs(facing)); // foreshortened when pointing at us
    const w = lf.wid * grow;
    const ang = Math.atan2(tan.y, tan.x) + side * lf.tilt * (0.8 + 0.2 * grow);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(ang);
    leafPath(ctx, L, w);
    ctx.fillStyle = Math.sin(phi) > 0 ? lf.color : COLORS.leafBack;
    ctx.fill();
    ctx.strokeStyle = COLORS.leafVein;
    ctx.lineWidth = U * 0.3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(L * 0.5, -w * 0.1 * side, L * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawRoundLeaf(ctx, c, lf, t) {
    const grow = easeOut(clamp01((t - lf.born) / 1.2));
    if (grow <= 0) return;
    const p = bezPoint(c, lf.s), tan = bezTangent(c, lf.s);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = (-tan.y / len) * lf.side, ny = (tan.x / len) * lf.side;
    const r = lf.r * grow;
    ctx.fillStyle = COLORS.eucalyptus;
    ctx.beginPath();
    ctx.ellipse(p.x + nx * r * 0.9, p.y + ny * r * 0.9, r, r * 0.8, Math.atan2(ny, nx), 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSprig(ctx, c, sp, t, st) {
    const grow = easeOut(clamp01((t - sp.born) / 1.5));
    if (grow <= 0) return;
    const p = bezPoint(c, sp.s), tan = bezTangent(c, sp.s);
    const ang = Math.atan2(tan.y, tan.x) + sp.ang;
    const end = { x: p.x + Math.cos(ang) * sp.len * grow, y: p.y + Math.sin(ang) * sp.len * grow };
    ctx.strokeStyle = st.color;
    ctx.lineWidth = U * 0.25;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.fillStyle = COLORS.breath;
    for (const d of sp.dots) {
      ctx.beginPath();
      ctx.arc(end.x + d.x * grow, end.y + d.y * grow, U * 0.55 * grow, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawStem(ctx, st, p0, t) {
    const c = curveAt(st, p0, t);
    const g = easeOut(clamp01((t - st.delay) / st.grow));
    if (g <= 0) return;
    const part = bezSplit(c, g); // only the grown portion
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(part[0].x, part[0].y);
    ctx.bezierCurveTo(part[1].x, part[1].y, part[2].x, part[2].y, part[3].x, part[3].y);
    ctx.stroke();

    for (const lf of st.leaves) {
      if (g > lf.s) (st.kind === 'euc' ? drawRoundLeaf : drawLeaf)(ctx, c, lf, t, st);
    }
    for (const sp of st.sprigs) if (g > sp.s) drawSprig(ctx, c, sp, t, st);
    for (const ch of st.children) if (g > ch.s) drawStem(ctx, ch.stem, bezPoint(c, ch.s), t);
    if (st.flower && g >= 1) flowerQueue.push({ c, st });
  }

  // One lily tepal (petal), drawn pointing along +x from the flower's centre.
  function drawTepal(ctx, f, L, w, curl, open, inner) {
    const pal = f.pal;
    const g = ctx.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, mixColor(COLORS.sepal, pal.base, 0.35 + 0.65 * open)); // buds are green at the base
    g.addColorStop(0.4, pal.mid);
    g.addColorStop(0.8, inner ? pal.blush : pal.tip);
    g.addColorStop(1, pal.blush);

    // Long lance shape: narrow base, widest near 40%, sharp pointed tip.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(L * 0.3, -w, L * 0.75, -w * 0.7, L, curl);
    ctx.bezierCurveTo(L * 0.75, w * 0.7, L * 0.3, w, 0, 0);
    ctx.fillStyle = g;
    ctx.fill();
    // Outline the bud's seams; fade the outline as the petals separate.
    ctx.globalAlpha = 1 - 0.7 * open;
    ctx.strokeStyle = pal.edge;
    ctx.lineWidth = U * 0.3;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Lily markings fade in as it opens: a midrib, two side veins, freckles near the throat.
    if (open <= 0.05) return;
    ctx.globalAlpha = open;
    ctx.strokeStyle = pal.vein;
    ctx.lineWidth = U * 0.45;
    ctx.beginPath();
    ctx.moveTo(L * 0.06, 0);
    ctx.quadraticCurveTo(L * 0.5, curl * 0.3, L * 0.9, curl * 0.85);
    ctx.stroke();
    ctx.lineWidth = U * 0.25;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(L * 0.1, s * w * 0.12);
      ctx.quadraticCurveTo(L * 0.4, s * w * 0.6, L * 0.75, s * w * 0.25 + curl * 0.6);
      ctx.stroke();
    }
    ctx.fillStyle = pal.spot;
    for (const sp of f.spots) {
      ctx.beginPath();
      ctx.arc(L * sp.s, w * sp.o, U * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Lily timeline at the stem tip:
  //   slender closed bud grows -> holds closed -> six tepals unfurl into a star -> stamens appear.
  // Returns how open the flower is (0..1), used for its reflection in the water.
  function drawFlower(ctx, c, st, t) {
    const f = st.flower;
    const C = c[3];
    const tan = bezTangent(c, 1);
    const heading = Math.atan2(tan.y, tan.x);
    const tb = t - (st.delay + st.grow);
    const bud = easeOut(clamp01(tb / f.budDur));
    if (bud <= 0) return 0;
    const open = easeInOut(clamp01((tb - f.budDur - f.holdDur) / f.openDur));
    const R = f.radius;
    const L = R * lerp(0.75, 1, open) * (0.35 + 0.65 * bud);

    // Outer three tepals first, then the inner three on top of them.
    for (const inner of [false, true]) {
      for (let k = 0; k < 3; k++) {
        const idx = inner ? k * 2 + 1 : k * 2; // position 0..5 around the flower
        const frac = (idx + 0.5) / 6 - 0.5;
        // Closed: all tepals bunched along the stem direction (a long bud).
        // Open: spread evenly into a six-pointed star.
        const closedA = heading + frac * 0.35;
        const openA = heading + f.rot + frac * Math.PI * 2;
        const a = lerp(closedA, openA, open);
        const w = R * lerp(0.08, inner ? 0.19 : 0.17, open) * (0.6 + 0.4 * bud);
        const curl = (k % 2 ? 1 : -1) * R * 0.08 * open; // tips flick sideways as they recurve
        ctx.save();
        ctx.translate(C.x, C.y);
        ctx.rotate(a);
        drawTepal(ctx, f, L * (inner ? 0.94 : 1), w, curl, open, inner);
        ctx.restore();
      }
    }

    // Dark throat once the petals part.
    if (open > 0.2) {
      const dr = R * 0.14 * clamp01((open - 0.2) / 0.5);
      const g = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, dr);
      g.addColorStop(0, COLORS.center);
      g.addColorStop(1, COLORS.centerRing);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(C.x, C.y, dr, 0, Math.PI * 2); ctx.fill();
    }

    // Long stamens with rust-coloured anthers, and a pistil, once it's mostly open.
    const sOpen = clamp01((open - 0.45) / 0.55);
    if (sOpen > 0) {
      ctx.lineCap = 'round';
      for (const s of f.stamens) {
        const a = heading + f.rot + s.a;
        const len = R * s.l * sOpen;
        const ex = C.x + Math.cos(a) * len, ey = C.y + Math.sin(a) * len;
        ctx.strokeStyle = COLORS.stamen;
        ctx.lineWidth = U * 0.3;
        ctx.beginPath();
        ctx.moveTo(C.x, C.y);
        ctx.quadraticCurveTo(C.x + Math.cos(a + 0.25) * len * 0.5, C.y + Math.sin(a + 0.25) * len * 0.5, ex, ey);
        ctx.stroke();
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillStyle = COLORS.anther;
        ctx.beginPath(); ctx.ellipse(0, 0, U * 1.3 * sOpen, U * 0.55 * sOpen, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      const pa = heading + f.rot + 0.2;
      const px = C.x + Math.cos(pa) * R * 0.62 * sOpen, py = C.y + Math.sin(pa) * R * 0.62 * sOpen;
      ctx.strokeStyle = COLORS.pistil;
      ctx.lineWidth = U * 0.4;
      ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(px, py); ctx.stroke();
      ctx.fillStyle = COLORS.pistil;
      ctx.beginPath(); ctx.arc(px, py, U * 0.8 * sOpen, 0, Math.PI * 2); ctx.fill();
    }
    return open;
  }

  // ---------- Water ----------
  function waveY(x, clock) {
    return Math.sin(x * 0.02 + clock * 1.2) * U * 0.5 + Math.sin(x * 0.051 - clock * 0.8) * U * 0.3;
  }

  // A translucent body of water (so the stem ends look submerged), soft pastel
  // reflections of the open lilies, and ripple lines that drift and break apart.
  function drawWater(ctx, clock) {
    const depth = worldH - waterTop;
    const body = ctx.createLinearGradient(0, waterTop, 0, worldH);
    body.addColorStop(0, COLORS.waterTop);
    body.addColorStop(1, COLORS.waterDeep);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(0, worldH);
    for (let x = 0; x <= worldW + cellW; x += cellW) ctx.lineTo(x, waterTop + waveY(x, clock));
    ctx.lineTo(worldW, worldH);
    ctx.closePath();
    ctx.fill();

    ctx.lineCap = 'round';
    ctx.lineWidth = cellH * 0.45;
    for (const q of flowerQueue) {
      if (!(q.open > 0.1)) continue;
      const f = q.st.flower, x0 = q.c[3].x;
      ctx.strokeStyle = f.pal.mid;
      for (let y = waterTop + cellH * 0.8; y < worldH; y += cellH) {
        const d = (y - waterTop) / depth;
        const half = f.radius * 0.6 * (1 - d * 0.6);
        const wob = Math.sin(y * 0.3 + clock * 2 + x0) * U * 1.5;
        ctx.globalAlpha = 0.35 * q.open * (1 - d * 0.7);
        ctx.beginPath(); ctx.moveTo(x0 - half + wob, y); ctx.lineTo(x0 + half + wob, y); ctx.stroke();
      }
    }
    // The moon's reflection: a column of pale, shimmering dashes.
    const m = moonGeom();
    ctx.strokeStyle = COLORS.moon;
    for (let y = waterTop + cellH * 0.8; y < worldH; y += cellH) {
      const d = (y - waterTop) / depth;
      const half = m.r * (0.55 - d * 0.3) * (0.6 + 0.4 * Math.sin(y * 0.7 + clock * 3));
      const wob = Math.sin(y * 0.25 + clock * 1.6) * U;
      ctx.globalAlpha = 0.5 * (1 - d * 0.6);
      const mx = m.x - m.r * 0.45; // under the lit side of the crescent
      ctx.beginPath(); ctx.moveTo(mx - half + wob, y); ctx.lineTo(mx + half + wob, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const [cr, cg, cb] = COLORS.ripple;
    const lines = Math.max(2, Math.floor(depth / (cellH * 1.5)));
    ctx.lineWidth = cellH * 0.35;
    for (let i = 0; i < lines; i++) {
      const y0 = waterTop + ((i + 0.4) * depth) / lines;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.75 - (0.4 * i) / lines})`;
      ctx.beginPath();
      let pen = false;
      for (let x = 0; x <= worldW; x += cellW) {
        const on = Math.sin(x * 0.011 + i * 1.7 - clock * (0.5 + i * 0.2)) + Math.sin(x * 0.037 + i) * 0.5 > 0.35;
        const y = y0 + waveY(x + i * 40, clock) * 0.5;
        if (on && pen) ctx.lineTo(x, y);
        else if (on) { ctx.moveTo(x, y); pen = true; }
        else pen = false;
      }
      ctx.stroke();
    }
  }

  function drawRibbon(ctx, b) {
    ctx.fillStyle = COLORS.ribbon;
    ctx.strokeStyle = COLORS.ribbon;
    for (const s of [-1, 1]) {
      ctx.beginPath(); // bow loop
      ctx.moveTo(b.x, b.y);
      ctx.bezierCurveTo(b.x + s * U * 7, b.y - U * 5, b.x + s * U * 8, b.y + U * 3, b.x, b.y);
      ctx.fill();
      ctx.lineWidth = U * 1.2; // trailing tail
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.bezierCurveTo(b.x + s * U * 2, b.y + U * 4, b.x + s * U * 3, b.y + U * 6, b.x + s * U * 4.5, b.y + U * 9);
      ctx.stroke();
    }
    ctx.fillStyle = COLORS.ribbonKnot;
    ctx.beginPath(); ctx.ellipse(b.x, b.y, U * 1.6, U * 1.3, 0, 0, Math.PI * 2); ctx.fill();
  }

  // t = seconds since this bouquet was planted; clock = seconds since the page loaded.
  function drawScene(t, clock) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    // Map world (screen-pixel) coordinates onto the tiny offscreen canvas.
    octx.setTransform(SUPERSAMPLE / cellW, 0, 0, SUPERSAMPLE / cellH, 0, 0);
    flowerQueue.length = 0;
    const { base, stems, fillers, cuts } = bouquet;

    drawStars(octx, clock);
    drawMoon(octx, clock);
    for (const f of fillers) drawStem(octx, f, base, t);
    if (t > 0.2) {
      for (const cut of cuts) {
        octx.strokeStyle = cut.color; octx.lineWidth = cut.width; octx.lineCap = 'round';
        octx.beginPath(); octx.moveTo(base.x, base.y); octx.lineTo(cut.x, cut.y); octx.stroke();
      }
    }
    for (const st of stems) drawStem(octx, st, base, t);
    drawRibbon(octx, base);
    for (const q of flowerQueue) {
      q.open = drawFlower(octx, q.c, q.st, t);
      const f = q.st.flower;
      if (!f.chimed && q.open > 0.3) { // chime once as each lily opens
        f.chimed = true;
        window.BouquetAudio?.bloom(COLORS.flowers.indexOf(f.pal));
      }
    }
    drawWater(octx, clock);
  }

  // ---------- Pixels -> ASCII ----------
  function renderAscii(fade) {
    sctx.globalAlpha = 1;
    sctx.fillStyle = COLORS.bg;
    sctx.fillRect(0, 0, viewW, viewH);

    // Subtle background glow: the low-res image, blurred and stretched behind the text.
    sctx.save();
    sctx.globalAlpha = 0.4 * fade;
    sctx.filter = `blur(${Math.round(cellH * 0.9)}px)`;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(off, gridX, gridY, worldW, worldH);
    sctx.restore();

    sctx.globalAlpha = fade;
    sctx.font = FONT;
    sctx.textBaseline = 'top';
    const data = octx.getImageData(0, 0, off.width, off.height).data;
    const ow = off.width, samples = SUPERSAMPLE * SUPERSAMPLE;

    for (let y = 0; y < rows; y++) {
      const ramp = (y + 0.5) * cellH >= waterTop ? WATER_RAMP : RAMP;
      const last = ramp.length - 1;
      for (let x = 0; x < cols; x++) {
        // Average the supersampled pixels in this cell (colour weighted by alpha).
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          let i = ((y * SUPERSAMPLE + sy) * ow + x * SUPERSAMPLE) * 4;
          for (let sx = 0; sx < SUPERSAMPLE; sx++, i += 4) {
            const al = data[i + 3];
            r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
          }
        }
        if (a < 8 * samples) continue;
        r /= a; g /= a; b /= a;
        const alpha = a / (255 * samples);
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const v = Math.pow(alpha * (0.3 + 0.7 * lum), 1.1);
        const idx = Math.min(last, Math.round(v * last));
        if (idx <= 0) continue;
        sctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
        sctx.fillText(ramp[idx], gridX + x * cellW, gridY + y * cellH);
      }
    }
    sctx.globalAlpha = 1;
  }

  // ---------- Main loop & interaction ----------
  let seed, start, bouquet;

  function restart() {
    seed = (Math.random() * 2 ** 32) >>> 0;
    start = performance.now();
    bouquet = buildBouquet(seed);
  }

  function frame(now) {
    let t = (now - start) / 1000;
    if (t > LOOP_SECONDS) { restart(); t = 0; }
    const fade = clamp01((LOOP_SECONDS - t) / FADE_SECONDS);
    drawScene(t, now / 1000);
    renderAscii(fade);
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { resize(); bouquet = buildBouquet(seed); });
  // Browsers only allow sound after a click or key press, so the first one starts the music.
  window.addEventListener('pointerdown', () => {
    window.BouquetAudio?.start();
    restart();
  });
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
    e.preventDefault();
    const audio = window.BouquetAudio;
    if (e.key === 'm' || e.key === 'M') { // M toggles sound without replanting
      if (audio) audio.isStarted() ? audio.toggleMute() : audio.start();
      return;
    }
    audio?.start();
    restart();
  });

  resize();
  restart();
  requestAnimationFrame(frame);
})();
