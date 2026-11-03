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
  const FONT_SIZE = 13;              // px size of each glyph
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
    flowers: [
      // baby blue petals with a pink blush at the tips
      { base: '#7fbfe6', mid: '#a7d8f0', tip: '#e3f3fc', blush: '#f7c6d9', edge: '#6aa9d4' },
      // baby pink petals with a soft peach blush
      { base: '#ee9dbd', mid: '#f8bbd0', tip: '#fff0f5', blush: '#ffe0d2', edge: '#e48bb0' },
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

  let viewW, viewH, cols, rows, cellW, cellH, gridX, gridY, worldW, worldH, U;

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

  function makeFlower(R) {
    const n = 5 + Math.floor(rand() * 3);
    const stamens = [];
    const m = 10 + Math.floor(rand() * 5);
    for (let i = 0; i < m; i++) stamens.push({ a: (i / m) * Math.PI * 2 + rr(-0.15, 0.15), l: rr(0.6, 1) });
    return {
      radius: R,
      pal: COLORS.flowers[flowerCounter++ % COLORS.flowers.length],
      outer: n, inner: n,
      rot: rr(-0.4, 0.4),
      budDur: rr(1.2, 2.0),
      openDur: rr(2.5, 3.5),
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
      st.flower = makeFlower(opts.main ? U * rr(8, 10.5) : U * rr(4.5, 6));
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
    U = Math.min(worldH / 110, worldW / 100); // one "unit" scales the whole bouquet
    const base = { x: worldW / 2, y: worldH - U * 13 };
    const stems = [], fillers = [], cuts = [];

    const N = 7;
    for (let i = 0; i < N; i++) {
      const k = i / (N - 1) - 0.5;
      const a = k * 1.2 + rr(-0.07, 0.07);
      const h = U * (74 - Math.abs(k) * 28 + rr(-5, 5));
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

  function drawPetalLayer(ctx, C, heading, n, open, bud, R, pal, rot, inner) {
    const L = R * (0.38 + 0.62 * open) * (0.3 + 0.7 * bud);
    const w = R * (0.13 + 0.25 * open) * (0.6 + 0.4 * bud);
    if (L < 0.1) return;
    const g = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, L);
    if (inner) {
      g.addColorStop(0, pal.base); g.addColorStop(0.5, pal.mid); g.addColorStop(1, pal.blush);
    } else {
      g.addColorStop(0, pal.base); g.addColorStop(0.45, pal.mid); g.addColorStop(0.85, pal.tip); g.addColorStop(1, pal.blush);
    }
    ctx.fillStyle = g;
    ctx.strokeStyle = pal.edge;
    ctx.lineWidth = U * 0.25;
    for (let k = 0; k < n; k++) {
      // Petals start bunched together (a closed bud) and fan out to a full circle.
      const frac = (k + 0.5) / n;
      const closedA = heading + (frac - 0.5) * 0.55;
      const openA = heading + rot + (frac - 0.5) * Math.PI * 2;
      const a = lerp(closedA, openA, open);
      const dx = Math.cos(a), dy = Math.sin(a), px = -dy, py = dx;
      ctx.beginPath();
      ctx.moveTo(C.x, C.y);
      ctx.bezierCurveTo(
        C.x + dx * L * 0.3 + px * w,         C.y + dy * L * 0.3 + py * w,
        C.x + dx * L * 0.95 + px * w * 0.85, C.y + dy * L * 0.95 + py * w * 0.85,
        C.x + dx * L,                        C.y + dy * L);
      ctx.bezierCurveTo(
        C.x + dx * L * 0.95 - px * w * 0.85, C.y + dy * L * 0.95 - py * w * 0.85,
        C.x + dx * L * 0.3 - px * w,         C.y + dy * L * 0.3 - py * w,
        C.x, C.y);
      ctx.fill();
      ctx.stroke();
    }
  }

  // Growth timeline at the stem tip: swelling bud -> unfolding petals -> stamens.
  function drawFlower(ctx, c, st, t) {
    const f = st.flower;
    const C = c[3];
    const tan = bezTangent(c, 1);
    const heading = Math.atan2(tan.y, tan.x);
    const tb = t - (st.delay + st.grow);
    const bud = easeOut(clamp01(tb / f.budDur));
    if (bud <= 0) return;
    const open = easeInOut(clamp01((tb - f.budDur * 0.7) / f.openDur));
    const R = f.radius;

    // Green sepals cup the bud, then spread back as it opens.
    ctx.fillStyle = COLORS.sepal;
    for (let k = -1; k <= 1; k++) {
      ctx.save();
      ctx.translate(C.x, C.y);
      ctx.rotate(heading + k * lerp(0.35, 1.3, open));
      leafPath(ctx, R * (0.3 + 0.2 * bud), R * 0.1 * (0.6 + 0.4 * bud));
      ctx.fill();
      ctx.restore();
    }

    drawPetalLayer(ctx, C, heading, f.outer, open, bud, R, f.pal, f.rot, false);
    const open2 = clamp01((open - 0.15) / 0.85);
    drawPetalLayer(ctx, C, heading, f.inner, open2, bud, R * 0.62, f.pal, f.rot + Math.PI / f.inner, true);

    // Dark centre with stamens once the flower is mostly open.
    const cOpen = clamp01((open - 0.35) / 0.65);
    if (cOpen > 0) {
      const sr = R * 0.36 * cOpen;
      const tips = f.stamens.map(s => ({
        x: C.x + Math.cos(s.a + f.rot) * sr * s.l,
        y: C.y + Math.sin(s.a + f.rot) * sr * s.l,
      }));
      ctx.strokeStyle = COLORS.stamen;
      ctx.lineWidth = U * 0.22;
      for (const p of tips) {
        ctx.beginPath(); ctx.moveTo(C.x, C.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      const dr = R * 0.16 * (0.5 + 0.5 * cOpen);
      const g = ctx.createRadialGradient(C.x, C.y, 0, C.x, C.y, dr);
      g.addColorStop(0, COLORS.center);
      g.addColorStop(1, COLORS.centerRing);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(C.x, C.y, dr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.stamen;
      for (const p of tips) {
        ctx.beginPath(); ctx.arc(p.x, p.y, U * 0.55 * cOpen, 0, Math.PI * 2); ctx.fill();
      }
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

  function drawScene(t) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, off.width, off.height);
    // Map world (screen-pixel) coordinates onto the tiny offscreen canvas.
    octx.setTransform(SUPERSAMPLE / cellW, 0, 0, SUPERSAMPLE / cellH, 0, 0);
    flowerQueue.length = 0;
    const { base, stems, fillers, cuts } = bouquet;

    for (const f of fillers) drawStem(octx, f, base, t);
    if (t > 0.2) {
      for (const cut of cuts) {
        octx.strokeStyle = cut.color; octx.lineWidth = cut.width; octx.lineCap = 'round';
        octx.beginPath(); octx.moveTo(base.x, base.y); octx.lineTo(cut.x, cut.y); octx.stroke();
      }
    }
    for (const st of stems) drawStem(octx, st, base, t);
    drawRibbon(octx, base);
    for (const q of flowerQueue) drawFlower(octx, q.c, q.st, t);
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
    const ow = off.width, samples = SUPERSAMPLE * SUPERSAMPLE, last = RAMP.length - 1;

    for (let y = 0; y < rows; y++) {
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
        sctx.fillText(RAMP[idx], gridX + x * cellW, gridY + y * cellH);
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
    drawScene(t);
    renderAscii(fade);
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', () => { resize(); bouquet = buildBouquet(seed); });
  window.addEventListener('pointerdown', restart);
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
    e.preventDefault();
    restart();
  });

  resize();
  restart();
  requestAnimationFrame(frame);
})();
