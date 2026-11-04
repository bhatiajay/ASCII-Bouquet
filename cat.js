// cat.js — an orange tabby cat for ASCII Bouquet, drawn with Bézier curves.
//
// The cat is a small rig described by a "pose": a handful of named numbers for
// where its hips, shoulders, head, paws and tail are. Every frame:
//   1. What the cat is doing (sitting, walking, rolling, being held...) picks a target pose.
//   2. The pose eases towards that target, so every change of pose blends smoothly.
//   3. Procedural motion is layered on top: breathing, tail sway, walking, wriggling paws.
//   4. The pose becomes Bézier control points (back, chest, belly, legs, ears, tail),
//      painted onto the offscreen canvas like every other shape, so the ASCII pass
//      turns the cat into characters too.
//
// Used by bouquet.js through window.BouquetCat (positions are in world pixels):
//   step(dt, clock, world)       advance behaviour and physics (world is described in bouquet.js)
//   draw(ctx)                    paint the cat (before the water, so it can look submerged)
//   drawReflection(ctx, clock)   paint its reflection (while drawing the water)
//   drawSplash(ctx)              paint splash droplets and ripple rings (after the water)
//   hitScruff(x, y), hitBody(x, y)          hit tests
//   grab(x, y, time), drag(x, y, time), release(time), poke(), isHeld()
//   resize(oldW, newW)           keep the cat in place when the window changes size
//   setHover(on), showTag(s)     the pointer is over the cat / show its tag for s seconds (touch)
//   glow()                       how strongly to light up its outline right now (0..1)
//   tag()                        { text, x, y, alpha } for its name tag: x = over its body, y = its highest point
//   getName(), setName(name)     its name (saved in the browser)
//   stay(on)                     keep it sitting still (while you type its name)
//   setBehavior(name)            sit, walk, groom, roll, paw, stretch or nap right now (try it in the console)
//   setMood(name), info()        change its mood / { name, mood, behavior } (also for the console)
(() => {
  'use strict';

  // ---------- Settings ----------
  const GRAVITY = 140;        // U/s²: how fast a dropped cat falls
  const SPLASH_SPEED = 30;    // U/s: landing faster than this makes a splash
  const MAX_THROW = 160;      // U/s: the fastest you can fling the cat
  const WALK_SPEED = 5.5;     // U/s
  const SCRUFF_RADIUS = 3.2;  // U: how close to the back of the neck a press must be to grab it
  const SWAT_SECONDS = 0.95;  // one swipe at the flowers
  const MOOD_SECONDS = [120, 240]; // how long a mood lasts before a new one is picked
  const NAME_KEY = 'asciiBouquet.catName';
  const NAMES = ['Mango', 'Biscuit', 'Pumpkin', 'Marmalade', 'Clementine', 'Nacho', 'Ginger',
    'Saffron', 'Tangerine', 'Apricot', 'Butterscotch', 'Cheddar'];

  // Each mood multiplies how likely the cat is to pick each behaviour (missing = 1).
  // speed scales its walking pace; complain scales how often it meows while held.
  const MOODS = {
    content:      { face: '(-.-)~',   weights: {} },
    sleepy:       { face: '(-_-) zZ', weights: { nap: 4, sit: 1.5, stretch: 1.5, walk: 0.4, roll: 0.5, paw: 0.4 }, speed: 0.7, complain: 0.6 },
    playful:      { face: '(=^.^=)',  weights: { roll: 3, paw: 3, walk: 1.2, sit: 0.6, nap: 0.25 } },
    curious:      { face: '(o.o)?',   weights: { walk: 2.2, paw: 2, sit: 0.7, nap: 0.4 } },
    grumpy:       { face: '(>_<)',    weights: { sit: 2.2, groom: 1.6, walk: 0.7, paw: 0.4, roll: 0.25 }, complain: 1.8 },
    affectionate: { face: '(^-^)<3',  weights: { groom: 2.5, roll: 2, sit: 1.3, nap: 0.8 } },
    zoomies:      { face: '(@_@)!!',  weights: { walk: 4, paw: 1.5, sit: 0.3, groom: 0.3, nap: 0.05 }, speed: 2.2 },
  };

  const COLORS = {
    fur: '#ff8700',       // ANSI 256-colour 208
    furLight: '#ffaf00',  // ANSI 256-colour 214, for highlights
    furShade: '#e06f00',
    furDark: '#c86400',   // the legs on the far side
    stripe: '#b0500c',
    cream: '#ffd9a8',
    innerEar: '#ff9f8f',
    nose: '#ff8fa6',
    eye: '#d8f56a',       // eye-shine: cats' eyes catch the moonlight
    eyeClosed: '#8a420a',
    water: 'rgb(190, 225, 250)',
  };

  // ---------- Small helpers ----------
  const PI = Math.PI;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rnd = (a, b) => a + (b - a) * Math.random();
  const P = (x, y) => ({ x, y });
  const mix = (p, q, t) => P(lerp(p.x, q.x, t), lerp(p.y, q.y, t));
  const along = (p, v, s) => P(p.x + v.x * s, p.y + v.y * s);
  const dir = a => P(Math.cos(a), Math.sin(a));

  // Cubic Bézier B(t) = (1-t)³p0 + 3(1-t)²t·p1 + 3(1-t)t²·p2 + t³p3, and its derivative.
  function bezPoint(c, t) {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
    return P(a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y);
  }
  function bezTangent(c, t) {
    const u = 1 - t;
    return P(
      3 * u * u * (c[1].x - c[0].x) + 6 * u * t * (c[2].x - c[1].x) + 3 * t * t * (c[3].x - c[2].x),
      3 * u * u * (c[1].y - c[0].y) + 6 * u * t * (c[2].y - c[1].y) + 3 * t * t * (c[3].y - c[2].y),
    );
  }

  // ---------- Poses ----------
  // Cat units (1 = U), seen from the side with the cat facing +x. y = 0 is the
  // water surface under its paws and negative y is up. Angles use the canvas
  // convention: 0 = forward, PI = backward, 1.5·PI = straight up.
  const STAND = {
    hipX: -6.5, hipY: -9, shX: 5, shY: -9.4,  // spine: hip and shoulder
    T: 5.6, arch: 0.9, sag: 0.5,              // torso thickness, back arch, belly sag
    headX: 9.6, headY: -14.2, headR: 3.7, tilt: 0,
    flX: 5.8, flY: 0, frX: 7, frY: 0,         // front paws (near, far)
    hlX: -6.6, hlY: 0, hrX: -5.4, hrY: 0,     // hind paws (near, far)
    fKnee: 0.3, hKnee: 1.6, hHock: -1.4, haunch: 2.7,
    tailA: 1.12 * PI, tailB: 1.3 * PI, tailC: 1.62 * PI, tailLen: 11, tailFront: 0,
    earBack: 0, eyes: 1, rot: 0, pivotY: -7,
    // How much of each procedural layer to add.
    sway: 1, breath: 1, wiggle: 0, gait: 0, rock: 0, swat: 0, lick: 0,
  };
  const KEYS = Object.keys(STAND);
  const SIT = {
    ...STAND,
    hipX: -4.2, hipY: -3.8, shX: 3, shY: -10.4, T: 5.2, arch: 0.7,
    headX: 6.6, headY: -17.2,
    flX: 4.6, frX: 5.7, hlX: 1.2, hrX: 2.4, hKnee: 2.6, hHock: -0.3, haunch: 3.5,
    tailA: 0.95 * PI, tailB: 0.07 * PI, tailC: 0, tailLen: 13, tailFront: 1,
    sway: 0.5, pivotY: -6,
  };
  const POSES = {
    sit: SIT,
    walk: { ...STAND, gait: 1, headY: -14.2, tailA: 1.2 * PI, tailB: 1.42 * PI, tailC: 1.78 * PI },
    groom: {
      ...SIT, headX: 7, headY: -16.2, tilt: 0.4,
      flX: 8.4, flY: -12.8, fKnee: -1.4, eyes: 0.3, lick: 1, sway: 0.4,
    },
    loaf: { // napping, paws tucked under
      ...STAND,
      hipX: -5.6, hipY: -4, shX: 4.4, shY: -4.3, T: 5.8, arch: 1.3, sag: 0.8,
      headX: 7.6, headY: -7.8, tilt: 0.2,
      flX: 6.4, flY: -0.1, frX: 7.4, frY: -0.1, fKnee: 1.2,
      hlX: -3.6, hlY: -0.1, hrX: -2.6, hrY: -0.1, hKnee: 1.2, hHock: -0.6, haunch: 3,
      tailA: 0.95 * PI, tailB: 0.13 * PI, tailC: 0, tailLen: 11.5, tailFront: 1,
      eyes: 0, earBack: 0.15, breath: 1.8, sway: 0.25, pivotY: -4.5,
    },
    stretch: { // front legs forward, rump in the air
      ...STAND,
      hipX: -5.2, hipY: -11, shX: 5.6, shY: -5.4, T: 5.2, arch: -1.2, sag: 0.2,
      headX: 10.8, headY: -8.2, tilt: 0.25,
      flX: 12.4, frX: 13.4, fKnee: -0.4, hKnee: 1, hHock: -0.8,
      tailA: 1.25 * PI, tailB: 1.45 * PI, tailC: 1.72 * PI, eyes: 0.15, earBack: 0.35, sway: 0.6,
    },
    paw: { // up on its hind legs, batting at the flowers
      ...STAND,
      hipX: -2.4, hipY: -5.8, shX: 0.4, shY: -14.2, T: 5.4, arch: 0.4,
      headX: 2.9, headY: -18.8, tilt: -0.15,
      flX: 5.6, flY: -14.6, frX: 3.8, frY: -11.4, fKnee: -1.2,
      hlX: -2.6, hrX: -1.4, hKnee: 2.4, hHock: -1.2, haunch: 3.1,
      tailA: 0.92 * PI, tailB: 0.96 * PI, tailC: 1.08 * PI, swat: 1, sway: 1.4, pivotY: -8,
    },
    roll: { // on its back, paws in the air (rot flips the whole rig over)
      ...STAND,
      hipX: -6, hipY: -8.4, shX: 4.6, shY: -8.6, T: 5.8, arch: -0.5, sag: 0.2,
      headX: 9.4, headY: -7.6, tilt: 0.6,
      flX: 6.8, flY: -1.6, frX: 8.4, frY: -2.4, fKnee: 1.3,
      hlX: -4.8, hlY: -1.2, hrX: -3, hrY: -1.8, hKnee: 1.6, hHock: -0.5,
      tailA: 0.92 * PI, tailB: 0.95 * PI, tailC: 0.9 * PI, tailLen: 10,
      earBack: 1, eyes: 0.85, rot: PI, pivotY: -5.3, rock: 1, wiggle: 0.6, sway: 0.8,
    },
    fall: { // legs splayed, ears back
      ...STAND,
      hipX: -6.2, hipY: -9.6, shY: -10, T: 5.3, arch: 0.3, headX: 9.4, headY: -13.6,
      flX: 9.6, flY: -3.4, frX: 10.6, frY: -2.6, fKnee: -0.6,
      hlX: -9.8, hlY: -3.2, hrX: -8.6, hrY: -2.4, hKnee: 0.8, hHock: -0.6,
      tailA: 1.1 * PI, tailB: 1.35 * PI, tailC: 1.55 * PI, earBack: 0.8, wiggle: 0.25, sway: 2,
    },
    held: { // dangling from the scruff: body stretched down, legs hanging, paws wriggling
      ...STAND,
      hipX: -1.6, hipY: -1.2, shX: -0.4, shY: -13.6, T: 4.7, arch: 0.4, sag: 0.2,
      headX: 1.9, headY: -17.3, tilt: 0.1,
      flX: 2.8, flY: -6.8, frX: 3.8, frY: -7.6, fKnee: -0.5,
      hlX: 0.8, hlY: 4.4, hrX: 2, hrY: 3.8, hKnee: 1, hHock: -0.4, haunch: 2.4,
      tailA: 0.62 * PI, tailB: 0.53 * PI, tailC: 0.45 * PI, tailLen: 10.5,
      earBack: 1, wiggle: 1, sway: 2.5, breath: 0.6,
    },
    paddle: { // just splashed down: ears back, legs paddling
      ...STAND, hipY: -8.4, shY: -9.2, headX: 9.2, headY: -14.4, earBack: 0.6, gait: 1.6, sway: 1.4,
      tailA: 1.0 * PI, tailB: 1.02 * PI, tailC: 1.15 * PI,
    },
    shake: { ...STAND, headY: -13.2, earBack: 0.4, eyes: 0.4, sway: 2 },
  };

  // ---------- State ----------
  let world = null, U = 1;
  let rig = null;                   // this frame's control points, in cat units
  let mode = 'ground';              // 'ground' (standing on the water), 'held' or 'fall'
  const pos = P(0, 0), vel = P(0, 0);
  let anchorLocal = P(0, 0);        // the cat-space point placed at `pos`: a pivot above its
                                    // paws on the water, or its scruff when held or falling
  let face = 1, faceTarget = 1;     // 1 = facing right, -1 = left (passes through 0 as it turns)
  let rotNow = 0, swing = 0, swingV = 0, prevRot = 0;
  let sink = 0, sinkV = 0, drift = 0;   // bobbing in the water after landing
  let hold = null, samples = [], lastVx = 0, accX = 0, stretch = 0, meowTimer = 0;
  let behavior = null, target = POSES.sit;
  let gaitPhase = 0, swatX = 0, swatY = 0, shakeAmt = 0, nextBlink = 0, earTwitch = 0;
  const tailPhase = rnd(0, 2 * PI);
  const cur = { ...SIT }, shown = { ...SIT };
  const drops = [], rings = [];
  let moodName = pickMood(null), moodTimer = rnd(...MOOD_SECONDS);
  let hovered = false, tagTimer = 0, glowLevel = 0, clockNow = 0, staying = false;
  let name = loadName();

  // A random mood, different from the current one.
  function pickMood(current) {
    const options = Object.keys(MOODS).filter(m => m !== current);
    return options[Math.floor(Math.random() * options.length)];
  }
  const mood = () => MOODS[moodName];

  // The cat's name lives in localStorage, so it survives reloads. Some browsers block
  // storage for pages opened from disk; then the name just lasts for this visit.
  function loadName() {
    try {
      const saved = localStorage.getItem(NAME_KEY);
      if (saved) return saved;
    } catch {}
    const fresh = NAMES[Math.floor(Math.random() * NAMES.length)];
    saveName(fresh);
    return fresh;
  }
  function saveName(n) {
    try { localStorage.setItem(NAME_KEY, n); } catch {}
  }

  const faceScale = () => (face < 0 ? -1 : 1) * Math.max(0.08, Math.abs(face));
  const pan = () => clamp((pos.x / world.worldW) * 2 - 1, -1, 1) * 0.6;
  const meow = kind => window.BouquetAudio?.meow(kind);

  // Cat space -> world pixels. Matches the canvas transform in applyTransform().
  function toWorld(q) {
    const lx = (q.x - anchorLocal.x) * faceScale() * U, ly = (q.y - anchorLocal.y) * U;
    const c = Math.cos(rotNow), s = Math.sin(rotNow);
    return P(pos.x + lx * c - ly * s, pos.y + lx * s + ly * c);
  }
  function applyTransform(ctx) {
    ctx.translate(pos.x, pos.y);
    ctx.rotate(rotNow);
    ctx.scale(faceScale() * U, U);
    ctx.translate(-anchorLocal.x, -anchorLocal.y);
  }
  // Switch which cat-space point is pinned to `pos`, without moving the cat.
  function setAnchor(name) {
    const local = name === 'scruff' ? rig.scruff : P(0, shown.pivotY);
    const w = toWorld(local);
    anchorLocal = local;
    pos.x = w.x; pos.y = w.y;
  }

  // ---------- Rig: pose -> Bézier control points ----------
  function buildRig(p) {
    const H = P(p.hipX, p.hipY), S = P(p.shX, p.shY);
    const L = Math.hypot(S.x - H.x, S.y - H.y) || 1;
    const d = P((S.x - H.x) / L, (S.y - H.y) / L); // along the spine, towards the head
    const n = P(d.y, -d.x);                         // across the spine, towards the back
    const h = p.T / 2;
    // A point s of the way from hip to shoulder, then `up` towards the back and `fwd` towards the head.
    const at = (s, up, fwd = 0) => P(lerp(H.x, S.x, s) + n.x * up + d.x * fwd, lerp(H.y, S.y, s) + n.y * up + d.y * fwd);

    // Torso: four cubic curves (back, chest, belly, rump). `arch` lifts the back's control points.
    const rumpTop = at(0, h * 0.35, -h * 0.75), neckTop = at(1, h * 0.7, h * 0.55);
    const chestLow = at(1, -h * 0.85, h * 0.15), bellyRear = at(0, -h * 0.85);
    const torso = [
      [rumpTop, at(0.22, h + p.arch), at(0.72, h + p.arch * 0.8), neckTop],
      [neckTop, at(1, h * 0.3, h * 1.25), at(1, -h * 0.6, h), chestLow],
      [chestLow, at(0.72, -h - p.sag), at(0.25, -h - p.sag), bellyRear],
      [bellyRear, at(0, -h * 0.85, -h * 1.3), at(0, h * 0.35, -h * 1.5), rumpTop],
    ];

    // Legs: a cubic from shoulder or hip to paw, its middle control points pushed sideways
    // to bend the knee (and, for hind legs, the hock the other way).
    const leg = (J, px, py, knee, hock) => {
      const Pw = P(px, py);
      const len = Math.hypot(Pw.x - J.x, Pw.y - J.y) || 1;
      const side = P((Pw.y - J.y) / len, -(Pw.x - J.x) / len);
      return { c: [J, along(mix(J, Pw, 0.33), side, knee), along(mix(J, Pw, 0.7), side, hock), Pw], paw: Pw };
    };
    const shoulder = at(0.95, -h * 0.25), hip = at(0.04, -h * 0.1);
    const legs = {
      fl: leg(shoulder, p.flX, p.flY, p.fKnee, p.fKnee),
      fr: leg(shoulder, p.frX, p.frY, p.fKnee, p.fKnee),
      hl: leg(hip, p.hlX, p.hlY, p.hKnee, p.hHock),
      hr: leg(hip, p.hrX, p.hrY, p.hKnee, p.hHock),
    };

    // Tail: one cubic from the rump, aimed by three angles (first control, tip, tip heading).
    const base = at(0, h * 0.15, -h * 0.9);
    const tip = along(base, dir(p.tailB), p.tailLen * 0.78);
    const tail = [base, along(base, dir(p.tailA), p.tailLen * 0.42), along(tip, dir(p.tailC), -p.tailLen * 0.36), tip];

    const head = P(p.headX, p.headY), r = p.headR;
    const scruff = along(mix(neckTop, head, 0.35), n, 0.8); // the loose skin at the back of the neck
    const low = [legs.fl.paw, legs.fr.paw, legs.hl.paw, legs.hr.paw, chestLow, bellyRear, at(0, 0, -h * 1.4), P(head.x, head.y + r)];
    return { H, S, d, n, h, at, torso, legs, tail, head, r, scruff, low, neckBase: at(1, h * 0.1, h * 0.2) };
  }

  // ---------- Procedural motion ----------
  function animate(clock, dt) {
    for (const key of KEYS) shown[key] = cur[key];
    const p = shown;
    // Breathing: the chest and belly swell a little (slower and deeper when napping).
    const br = Math.sin(clock * lerp(1.9, 1.1, clamp(p.breath - 1, 0, 1)));
    p.T *= 1 + 0.035 * p.breath * br;
    p.sag += 0.2 * p.breath * br;
    // Tail sway: the tip lags behind the base, so it swishes like a whip.
    p.tailB += p.sway * 0.12 * Math.sin(clock * 1.3 + tailPhase);
    p.tailC += p.sway * 0.35 * Math.sin(clock * 1.3 + tailPhase - 0.9);
    // Walking or paddling: diagonal pairs of legs swing together and lift as they swing forward.
    if (p.gait > 0.01) {
      for (const [kx, ky, off] of [['flX', 'flY', 0], ['frX', 'frY', PI], ['hlX', 'hlY', PI], ['hrX', 'hrY', 0]]) {
        p[kx] += p.gait * 1.7 * Math.sin(gaitPhase + off);
        p[ky] -= p.gait * 1.1 * Math.max(0, Math.cos(gaitPhase + off));
      }
      const bob = p.gait * 0.3 * Math.abs(Math.sin(gaitPhase));
      p.hipY -= bob; p.shY -= bob; p.headY -= bob * 1.2;
    }
    // Wriggling paws: dangling from the scruff, or batting at the air on its back.
    if (p.wiggle > 0.01) {
      [['flX', 'flY'], ['frX', 'frY'], ['hlX', 'hlY'], ['hrX', 'hrY']].forEach(([kx, ky], i) => {
        p[kx] += p.wiggle * 0.55 * Math.sin(clock * 11 + i * 1.9);
        p[ky] += p.wiggle * 0.75 * Math.sin(clock * 8.5 + i * 2.6);
      });
    }
    // Licking a paw: head and paw bob together.
    if (p.lick > 0.01) {
      const l = Math.sin(clock * 9);
      p.headY += p.lick * 0.35 * l;
      p.flY += p.lick * 0.5 * Math.sin(clock * 9 + 0.8);
    }
    // Swiping at the flowers.
    if (behavior?.stage !== 'swat') { swatX *= Math.exp(-10 * dt); swatY *= Math.exp(-10 * dt); }
    p.flX += p.swat * swatX;
    p.flY += p.swat * swatY;
    // Yanked upwards by the scruff: the body stretches downwards.
    p.hipY += stretch; p.hlY += stretch * 1.3; p.hrY += stretch * 1.3; p.T *= 1 - 0.04 * stretch;
    // Rocking on its back, and shaking off water.
    p.rot += p.rock * 0.22 * Math.sin(clock * 2.4) + shakeAmt * 0.16 * Math.sin(clock * 50);
    // Blinks and ear twitches.
    if (clock > nextBlink + 0.15) nextBlink = clock + rnd(2, 6);
    if (clock > nextBlink) p.eyes *= 0.1;
    if (Math.random() < dt * 0.25) earTwitch = 1;
    earTwitch *= Math.exp(-9 * dt);
    p.earBack = clamp(p.earBack + earTwitch * 0.6, 0, 1);
  }

  // ---------- Behaviours (while standing on the water) ----------
  const BEHAVIORS = {
    sit:     { weight: 3,   dur: [3, 7],     pose: 'sit' },
    walk:    { weight: 3,   dur: [12, 12],   pose: 'walk', start: startWalk, update: updateWalk },
    groom:   { weight: 1.5, dur: [3, 5],     pose: 'groom' },
    roll:    { weight: 1.4, dur: [4.5, 7],   pose: 'roll', start: b => { b.over = Math.random() < 0.45; }, update: updateRoll },
    paw:     { weight: 1.6, dur: [28, 28],   pose: 'walk', start: startPaw, update: updatePaw, ok: () => world.grown },
    stretch: { weight: 1,   dur: [2.4, 3.2], pose: 'stretch' },
    nap:     { weight: 0.9, dur: [9, 16],    pose: 'loaf' },
    paddle:  { weight: 0,   dur: [1.3, 1.6], pose: 'paddle', update: (b, dt) => { gaitPhase += dt * 9; }, next: 'shake' },
    shake:   { weight: 0,   dur: [1, 1],     pose: 'shake', start: startShake, update: b => { shakeAmt = 1 - b.t / b.dur; } },
  };

  function startBehavior(name) {
    const def = BEHAVIORS[name];
    behavior = { name, def, t: 0, dur: rnd(def.dur[0], def.dur[1]) };
    target = POSES[def.pose];
    shakeAmt = 0;
    if (cur.rot > 1.5 * PI) { cur.rot -= 2 * PI; prevRot -= 2 * PI; } // a full roll-over ends upright
    def.start?.(behavior);
  }
  function updateBehavior(dt) {
    if (staying) { // sit still (someone is typing its name)
      if (behavior.name !== 'sit') startBehavior('sit');
      behavior.t = 0;
      return;
    }
    const b = behavior;
    b.t += dt;
    b.def.update?.(b, dt);
    if (b.done || b.t >= b.dur) startBehavior(b.def.next || pickNext());
  }
  // A weighted random choice, not repeating the last one (except walking somewhere else).
  // The cat's mood scales each weight.
  function pickNext() {
    const options = Object.keys(BEHAVIORS).filter(n => {
      const d = BEHAVIORS[n];
      return d.weight > 0 && (!d.ok || d.ok()) && (n !== behavior?.name || n === 'walk');
    });
    const weight = n => BEHAVIORS[n].weight * (mood().weights[n] ?? 1);
    let r = Math.random() * options.reduce((sum, n) => sum + weight(n), 0);
    for (const n of options) if ((r -= weight(n)) <= 0) return n;
    return 'sit';
  }

  // Turn to face tx, then walk there. Returns true on arrival.
  function walkTo(tx, dt) {
    tx = clamp(tx, 6 * U, world.worldW - 6 * U);
    const dx = tx - pos.x;
    if (Math.abs(dx) < U * 0.5) return true;
    faceTarget = dx > 0 ? 1 : -1;
    if (face * faceTarget > 0.7) { // finish turning around before setting off
      const stepPx = Math.min(Math.abs(dx), WALK_SPEED * (mood().speed ?? 1) * U * dt);
      pos.x += faceTarget * stepPx;
      gaitPhase += (stepPx / U) * 1.25;
    }
    return false;
  }
  function startWalk(b) {
    const lo = world.worldW * 0.07, hi = world.worldW * 0.93;
    b.tx = rnd(lo, hi);
    for (let i = 0; i < 5 && Math.abs(b.tx - pos.x) < 14 * U; i++) b.tx = rnd(lo, hi);
  }
  function updateWalk(b, dt) {
    if (walkTo(b.tx, dt)) b.done = true;
  }

  // Lie on its back and rock; sometimes carry on and roll right over.
  function updateRoll(b) {
    if (b.over && !b.flipped && b.t > b.dur - 1.2) {
      b.flipped = true;
      target = { ...POSES.roll, rot: 2 * PI, rock: 0, wiggle: 0 };
    }
  }

  // Walk up beside the bouquet, rear up and bat at the stems a few times.
  function startPaw(b) {
    b.side = pos.x < world.base.x ? -1 : 1; // which side of the bouquet the cat is on
    b.tx = world.base.x + b.side * 15 * U;
    b.stage = 'approach';
    b.swats = 3 + Math.floor(rnd(0, 3));
  }
  function updatePaw(b, dt) {
    if (b.stage === 'approach') {
      if (walkTo(b.tx, dt)) b.stage = 'turn';
      return;
    }
    faceTarget = -b.side; // face the flowers
    if (b.stage === 'turn') {
      if (face * faceTarget > 0.9) { b.stage = 'swat'; b.t0 = b.t; target = POSES.paw; }
      return;
    }
    const tt = b.t - b.t0 - 0.7; // rear up first
    if (tt < 0) return;
    const k = Math.floor(tt / SWAT_SECONDS), s = (tt / SWAT_SECONDS) % 1;
    if (k >= b.swats) { b.done = true; return; }
    const e = Math.sin(PI * s); // the paw rises, reaches out, then swipes down
    swatX = 3.6 * e;
    swatY = -3.2 * e * (1 - s) + 1.6 * e * s;
    if (s > 0.5 && b.hit !== k) { // the paw is at full reach: knock the stems
      b.hit = k;
      const paw = toWorld(rig.legs.fl.paw);
      world.pokeStems(paw.x, paw.y, faceTarget);
    }
  }

  function startShake() {
    const c = toWorld(mix(rig.H, rig.S, 0.5));
    for (let i = 0; i < 14; i++) {
      drops.push({ x: c.x + rnd(-5, 5) * U, y: c.y + rnd(-2, 2) * U, vx: rnd(-1, 1) * 26 * U, vy: -rnd(8, 22) * U, r: rnd(0.4, 0.7) * U });
    }
    if (Math.random() < 0.5) meow('grab'); // not impressed
  }

  // ---------- Physics ----------
  function placeOnWater() {
    pos.x = clamp(pos.x, 6 * U, world.worldW - 6 * U);
    pos.y = world.surfaceY(pos.x) + sink + shown.pivotY * U;
  }

  function stepGround(dt) {
    // Floating: a spring pulls the paws back up to the surface after a landing.
    // It is stiffer above the surface, so the cat doesn't leap out of the water.
    const k = sink < 0 ? 60 : 36, c = sink < 0 ? 10 : 4.5;
    sinkV += (-k * sink - c * sinkV) * dt;
    sink += sinkV * dt;
    pos.x += drift * dt;
    drift *= Math.exp(-2.5 * dt);
    swingV += (-30 * swing - 6 * swingV) * dt;
    swing += swingV * dt;
    stretch *= Math.exp(-6 * dt);
    if (behavior.flipped) pos.x += (cur.rot - prevRot) * 3.5 * U; // rolling over moves it along
    placeOnWater();
  }

  function stepHeld(dt) {
    // The scruff follows the pointer closely; the grab offset melts away so the cat
    // ends up hanging right from the pointer.
    hold.ox *= Math.exp(-8 * dt);
    hold.oy *= Math.exp(-8 * dt);
    const k = 1 - Math.exp(-30 * dt);
    const nx = lerp(pos.x, hold.x + hold.ox, k), ny = lerp(pos.y, hold.y + hold.oy, k);
    const vx = (nx - pos.x) / dt, vy = (ny - pos.y) / dt;
    accX += ((vx - lastVx) / dt - accX) * (1 - Math.exp(-15 * dt));
    lastVx = vx;
    pos.x = nx; pos.y = ny;
    // Pendulum: moving the scruff sideways makes the body swing the other way.
    const len = 11 * U, g = GRAVITY * U;
    const a = clamp(accX, -600 * U, 600 * U);
    swingV += ((a / len) * Math.cos(swing) - (g / len) * Math.sin(swing) - 2 * swingV) * dt;
    swing = clamp(swing + swingV * dt, -1.1, 1.1);
    // Lifting it quickly stretches the body downwards.
    const want = clamp((-vy / U) * 0.035, -0.6, 2.5);
    stretch += (want - stretch) * (1 - Math.exp(-8 * dt));
  }

  function stepFall(dt) {
    vel.y += GRAVITY * U * dt;
    vel.x *= Math.exp(-0.3 * dt);
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    const m = 4 * U; // bounce off the sides of the screen
    if (pos.x < m) { pos.x = m; vel.x = Math.abs(vel.x) * 0.5; }
    if (pos.x > world.worldW - m) { pos.x = world.worldW - m; vel.x = -Math.abs(vel.x) * 0.5; }
    if (pos.y < -world.worldH * 0.5) { pos.y = -world.worldH * 0.5; vel.y = Math.max(vel.y, 0); }
    // Cats twist to land on their feet: a spring turns it upright as it falls.
    swingV += (-30 * swing - 5 * swingV) * dt;
    swing += swingV * dt;
    stretch *= Math.exp(-6 * dt);
    rotNow = shown.rot + swing;
    if (vel.y >= 0 && depthBelowSurface() >= 0) land();
  }

  // How far the lowest part of the cat is below the water surface (negative = above it).
  function depthBelowSurface() {
    let deepest = -Infinity;
    for (const q of rig.low) {
      const w = toWorld(q);
      deepest = Math.max(deepest, w.y - world.surfaceY(w.x));
    }
    return deepest;
  }

  function land() {
    const speed = vel.y / U;
    mode = 'ground';
    setAnchor('pivot');
    sink = pos.y - world.surfaceY(pos.x) - shown.pivotY * U;
    sinkV = Math.min(vel.y * 0.35, 45 * U);
    drift = vel.x * 0.4;
    if (speed > SPLASH_SPEED) {
      const size = clamp((speed - SPLASH_SPEED) / 90, 0, 1);
      makeSplash(pos.x, size);
      window.BouquetAudio?.splash(size, pan());
      startBehavior('paddle');
    } else {
      startBehavior(pickNext());
    }
  }

  function makeSplash(x, size) {
    const sy = world.surfaceY(x);
    const n = Math.round(10 + size * 30);
    for (let i = 0; i < n && drops.length < 150; i++) {
      drops.push({
        x: x + rnd(-6, 6) * U, y: sy - U * 0.5,
        vx: rnd(-1, 1) * (10 + 22 * size) * U, vy: -rnd(16, 30 + 30 * size) * U,
        r: rnd(0.5, 0.95) * U,
      });
    }
    rings.push({ x, age: 0, life: 1.3, size: 7 + 10 * size }, { x, age: -0.2, life: 1.5, size: 4 + 7 * size });
  }

  function stepParticles(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.vy += GRAVITY * U * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const fellIn = d.vy > 0 && d.y > world.surfaceY(d.x);
      if (fellIn || d.x < -10 * U || d.x > world.worldW + 10 * U) {
        drops.splice(i, 1);
        if (fellIn && Math.random() < 0.35) rings.push({ x: d.x, age: 0, life: 0.8, size: 2.5 });
      }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      if ((rings[i].age += dt) > rings[i].life) rings.splice(i, 1);
    }
  }

  // ---------- Per-frame update ----------
  function init() {
    pos.x = world.worldW * 0.2;
    Object.assign(cur, SIT);
    startBehavior('sit');
    animate(0, 0);
    rig = buildRig(shown);
  }

  function step(dt, clock, w) {
    world = w;
    U = w.U;
    if (!rig) init();

    // 1. Decide what to do.
    if (mode === 'ground') {
      updateBehavior(dt);
    } else if (mode === 'held') {
      target = POSES.held;
      if ((meowTimer -= dt) <= 0) { // still complaining
        meow('grab');
        meowTimer = rnd(3, 5.5) / (mood().complain ?? 1);
      }
    } else {
      target = POSES.fall;
    }
    if ((moodTimer -= dt) <= 0) { // moods come and go
      moodName = pickMood(moodName);
      moodTimer = rnd(...MOOD_SECONDS);
    }
    // The hover glow fades in and out (about 0.15 s).
    clockNow = clock;
    tagTimer = Math.max(0, tagTimer - dt);
    const lit = hovered || mode === 'held' || tagTimer > 0 ? 1 : 0;
    glowLevel += (lit - glowLevel) * (1 - Math.exp(-7 * dt));

    // 2. Ease the pose towards the target, then 3. layer procedural motion on top.
    const k = 1 - Math.exp(-(mode === 'held' ? 11 : 6) * dt);
    for (const key of KEYS) cur[key] += (target[key] - cur[key]) * k;
    face += (faceTarget - face) * (1 - Math.exp(-10 * dt));
    animate(clock, dt);

    // 4. Control points and placement.
    rig = buildRig(shown);
    rotNow = shown.rot + swing;
    anchorLocal = mode === 'ground' ? P(0, shown.pivotY) : rig.scruff;
    if (dt > 0) {
      if (mode === 'ground') stepGround(dt);
      else if (mode === 'held') stepHeld(dt);
      else stepFall(dt);
      stepParticles(dt);
    } else if (mode === 'ground') {
      placeOnWater();
    }
    prevRot = cur.rot;
  }

  // ---------- Drawing ----------
  function torsoPath(ctx) {
    const t = rig.torso;
    ctx.beginPath();
    ctx.moveTo(t[0][0].x, t[0][0].y);
    for (const c of t) ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
    ctx.closePath();
  }

  function drawTorso(ctx, p) {
    const { at, h, d, H, S } = rig;
    const top = at(0.5, h + p.arch), bottom = at(0.5, -h);
    const g = ctx.createLinearGradient(top.x, top.y, bottom.x, bottom.y);
    g.addColorStop(0, COLORS.furLight);
    g.addColorStop(0.45, COLORS.fur);
    g.addColorStop(1, COLORS.furShade);
    torsoPath(ctx);
    ctx.fillStyle = g;
    ctx.fill();

    ctx.save();
    torsoPath(ctx);
    ctx.clip();
    const spineAngle = Math.atan2(d.y, d.x);
    const L = Math.hypot(S.x - H.x, S.y - H.y);
    ctx.fillStyle = COLORS.cream; // belly and chest
    const belly = at(0.62, -h * 0.75), chest = at(1, -h * 0.2, h * 0.6);
    ctx.beginPath(); ctx.ellipse(belly.x, belly.y, L * 0.34, h * 0.45, spineAngle, 0, 2 * PI); ctx.fill();
    ctx.beginPath(); ctx.ellipse(chest.x, chest.y, h * 0.6, h * 0.8, spineAngle, 0, 2 * PI); ctx.fill();
    ctx.strokeStyle = COLORS.stripe; // tabby stripes across the back
    ctx.lineWidth = 0.85;
    for (let i = 0; i < 4; i++) {
      const s = 0.14 + i * 0.2;
      const a = at(s, h + p.arch + 1), c = at(s - 0.03, h * 0.5), b = at(s + 0.06, -h * 0.1);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(c.x, c.y, b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawHaunch(ctx, p) {
    const c = rig.at(0.06, -rig.h * 0.05);
    const angle = Math.atan2(rig.d.y, rig.d.x);
    ctx.fillStyle = COLORS.fur;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, p.haunch, p.haunch * 0.88, angle, 0, 2 * PI); ctx.fill();
    ctx.strokeStyle = COLORS.stripe;
    ctx.lineWidth = 0.6;
    for (const k of [0.45, 0.75]) {
      ctx.beginPath(); ctx.arc(c.x, c.y, p.haunch * k, angle - 2.4, angle - 1.2); ctx.stroke();
    }
  }

  function drawLeg(ctx, leg, width, color, pawColor) {
    const c = leg.c;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    ctx.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
    ctx.stroke();
    ctx.fillStyle = pawColor;
    ctx.beginPath(); ctx.ellipse(c[3].x + 0.3, c[3].y - 0.4, 1.15, 0.75, 0, 0, 2 * PI); ctx.fill();
  }

  // The tail is filled as a tapering ribbon: sample B(t), step out along the normal on each side.
  function drawTail(ctx) {
    const c = rig.tail, N = 16, left = [], right = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, q = bezPoint(c, t), tn = bezTangent(c, t);
      const len = Math.hypot(tn.x, tn.y) || 1, w = lerp(0.95, 0.55, t);
      left.push(P(q.x - (tn.y / len) * w, q.y + (tn.x / len) * w));
      right.push(P(q.x + (tn.y / len) * w, q.y - (tn.x / len) * w));
    }
    ctx.fillStyle = COLORS.fur;
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (const q of left) ctx.lineTo(q.x, q.y);
    for (let i = N; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); ctx.arc(c[3].x, c[3].y, 0.55, 0, 2 * PI); ctx.fill();
    ctx.strokeStyle = COLORS.stripe; // rings
    ctx.lineWidth = 0.55;
    for (const t of [0.3, 0.5, 0.7, 0.88]) {
      const i = Math.round(t * N);
      ctx.beginPath(); ctx.moveTo(left[i].x, left[i].y); ctx.lineTo(right[i].x, right[i].y); ctx.stroke();
    }
  }

  // Ear geometry in head space (before tilt): base centre B, pointing along u, len long.
  // `back` (0..1) swings it backwards and flattens it.
  const EAR_ANGLES = { back: -2.05, front: -1.05 };
  function earGeom(ang, r, back) {
    return { B: P(Math.cos(ang) * r * 0.72, Math.sin(ang) * r * 0.72), u: dir(ang - back * 1.0), len: r * (1.2 - 0.45 * back) };
  }
  // An ear: two quadratic curves from the base on the head out to the tip.
  function drawEar(ctx, ang, r, back, color) {
    const { B, u, len } = earGeom(ang, r, back), bw = r * 0.44;
    const w = P(-Math.sin(ang), Math.cos(ang));
    const shape = (scale, fill) => {
      const tip = along(B, u, len * scale);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(B.x + w.x * bw * scale, B.y + w.y * bw * scale);
      ctx.quadraticCurveTo(B.x + (w.x * bw * 0.6 + u.x * len * 0.6) * scale, B.y + (w.y * bw * 0.6 + u.y * len * 0.6) * scale, tip.x, tip.y);
      ctx.quadraticCurveTo(B.x + (-w.x * bw * 0.4 + u.x * len * 0.5) * scale, B.y + (-w.y * bw * 0.4 + u.y * len * 0.5) * scale, B.x - w.x * bw * scale, B.y - w.y * bw * scale);
      ctx.closePath();
      ctx.fill();
    };
    shape(1, color);
    shape(0.55, COLORS.innerEar);
  }

  function drawHead(ctx, p) {
    const { head: c, r, neckBase } = rig;
    ctx.strokeStyle = COLORS.fur; // neck
    ctx.lineWidth = rig.h * 1.4;
    ctx.beginPath(); ctx.moveTo(neckBase.x, neckBase.y); ctx.lineTo(c.x, c.y); ctx.stroke();

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(p.tilt);
    drawEar(ctx, EAR_ANGLES.back, r, p.earBack, COLORS.furShade);
    const g = ctx.createRadialGradient(r * 0.1, -r * 0.5, r * 0.2, 0, 0, r * 1.1);
    g.addColorStop(0, COLORS.furLight);
    g.addColorStop(1, COLORS.fur);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.08, r * 0.94, 0, 0, 2 * PI); ctx.fill();
    drawEar(ctx, EAR_ANGLES.front, r, p.earBack, COLORS.fur);

    ctx.strokeStyle = COLORS.stripe; // forehead stripes
    ctx.lineWidth = 0.4;
    for (const [x0, x1] of [[-0.15, 0.05], [0.25, 0.3]]) {
      ctx.beginPath(); ctx.moveTo(r * x0, -r * 0.95); ctx.lineTo(r * x1, -r * 0.55); ctx.stroke();
    }
    ctx.fillStyle = COLORS.cream; // muzzle
    ctx.beginPath(); ctx.ellipse(r * 0.62, r * 0.38, r * 0.5, r * 0.34, 0, 0, 2 * PI); ctx.fill();
    ctx.fillStyle = COLORS.nose;
    ctx.beginPath(); ctx.ellipse(r * 1.02, r * 0.16, 0.45, 0.32, 0, 0, 2 * PI); ctx.fill();

    const open = clamp(p.eyes, 0, 1);
    for (const [ex, ey, s] of [[r * 0.4, -r * 0.12, 1], [r * 0.92, -r * 0.16, 0.8]]) {
      if (open > 0.25) {
        ctx.fillStyle = COLORS.eye;
        ctx.beginPath(); ctx.ellipse(ex, ey, 0.7 * s, 0.9 * s * open, 0, 0, 2 * PI); ctx.fill();
      } else { // closed: a sleepy curve
        ctx.strokeStyle = COLORS.eyeClosed;
        ctx.lineWidth = 0.35;
        ctx.beginPath(); ctx.moveTo(ex - 0.6 * s, ey); ctx.quadraticCurveTo(ex, ey + 0.5, ex + 0.6 * s, ey); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function draw(ctx) {
    if (!rig) return;
    const p = shown, legs = rig.legs;
    ctx.save();
    applyTransform(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    drawLeg(ctx, legs.hr, 1.75, COLORS.furDark, COLORS.furDark); // far side first
    drawLeg(ctx, legs.fr, 1.6, COLORS.furDark, COLORS.furDark);
    if (p.tailFront < 0.5) drawTail(ctx);
    drawTorso(ctx, p);
    drawHaunch(ctx, p);
    drawLeg(ctx, legs.hl, 1.85, COLORS.fur, COLORS.cream);
    if (p.tailFront >= 0.5) drawTail(ctx); // curled around in front when sitting
    drawHead(ctx, p);
    drawLeg(ctx, legs.fl, 1.7, COLORS.fur, COLORS.cream); // in front of the face when grooming
    ctx.restore();
  }

  // Orange dashes in the water under the cat, like the lilies' reflections.
  function drawReflection(ctx, clock) {
    if (!rig) return;
    const c = toWorld(mix(rig.H, rig.S, 0.5));
    const height = world.surfaceY(c.x) - c.y;
    const strength = clamp(1 - (height - 6 * U) / (30 * U), 0, 1); // fades as it's lifted away
    if (strength <= 0) return;
    const { waterTop, worldH, cellH } = world;
    const depth = worldH - waterTop;
    ctx.lineCap = 'round';
    ctx.lineWidth = cellH * 0.45;
    ctx.strokeStyle = COLORS.fur;
    for (let y = waterTop + cellH * 0.8; y < worldH; y += cellH) {
      const d = (y - waterTop) / depth;
      const half = U * 8 * (1 - d * 0.5);
      const wob = Math.sin(y * 0.3 + clock * 2 + c.x * 0.01) * U * 1.2;
      ctx.globalAlpha = 0.3 * strength * (1 - d * 0.7);
      ctx.beginPath(); ctx.moveTo(c.x - half + wob, y); ctx.lineTo(c.x + half + wob, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawSplash(ctx) {
    if (!world) return;
    ctx.strokeStyle = ctx.fillStyle = COLORS.water;
    ctx.lineWidth = U * 0.55;
    for (const ring of rings) {
      if (ring.age < 0) continue;
      const k = ring.age / ring.life, e = 1 - Math.pow(1 - k, 3);
      const rx = U * (1.5 + ring.size * e);
      ctx.globalAlpha = 0.75 * (1 - k);
      ctx.beginPath(); ctx.ellipse(ring.x, world.surfaceY(ring.x), rx, rx * 0.16, 0, 0, 2 * PI); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const d of drops) {
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 2 * PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Interaction ----------
  function hitScruff(x, y) {
    if (!rig || !world) return false;
    const s = toWorld(rig.scruff);
    return Math.hypot(x - s.x, y - s.y) < Math.max(SCRUFF_RADIUS * U, world.cellH * 1.6);
  }

  function hitBody(x, y) {
    if (!rig || !world) return false;
    const pad = world.cellH * 0.5;
    const a = toWorld(rig.H), b = toWorld(rig.S);
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    if (Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) < rig.h * U + pad) return true;
    const c = toWorld(rig.head);
    return Math.hypot(x - c.x, y - c.y) < rig.r * U * 1.2 + pad;
  }

  function grab(x, y, time) {
    if (!rig || !world) return;
    if (mode === 'ground') behavior.stage = null; // stop any swat
    setAnchor('scruff');
    mode = 'held';
    hold = { x, y, ox: pos.x - x, oy: pos.y - y };
    samples = [{ x, y, t: time }];
    lastVx = accX = 0;
    swatX = swatY = shakeAmt = 0;
    target = POSES.held;
    meowTimer = rnd(3, 5) / (mood().complain ?? 1);
    meow('grab');
  }

  function drag(x, y, time) {
    if (mode !== 'held') return;
    hold.x = x;
    hold.y = y;
    samples.push({ x, y, t: time });
    if (samples.length > 8) samples.shift();
  }

  // Let go: it keeps the pointer's velocity from the last tenth of a second, so it can be thrown.
  function release(time) {
    if (mode !== 'held') return;
    const last = samples[samples.length - 1];
    const first = samples.find(s => last.t - s.t <= 100) || last;
    const span = (last.t - first.t) / 1000;
    vel.x = vel.y = 0;
    if (span > 0.008 && time - last.t < 80) {
      vel.x = (last.x - first.x) / span;
      vel.y = (last.y - first.y) / span;
    }
    const speed = Math.hypot(vel.x, vel.y), max = MAX_THROW * U;
    if (speed > max) { vel.x *= max / speed; vel.y *= max / speed; }
    mode = 'fall';
    target = POSES.fall;
  }

  // A tap on its body: a startled little hop and a chirp.
  function poke() {
    if (mode !== 'ground' || !rig) return;
    meow('chirp');
    earTwitch = 1;
    behavior.stage = null;
    setAnchor('scruff');
    mode = 'fall';
    vel.x = 0;
    vel.y = -24 * U;
    target = POSES.fall;
  }

  function resize(oldW, newW) {
    if (!rig || !oldW) return;
    const k = newW / oldW;
    pos.x *= k;
    if (hold) { hold.x *= k; hold.ox = hold.oy = 0; }
    drops.length = rings.length = 0;
    if (mode === 'fall') { // land straight away at the new size
      mode = 'ground';
      sink = sinkV = swing = swingV = 0;
    }
    if (mode === 'ground') startBehavior('sit');
  }

  function setBehavior(name) {
    if (!BEHAVIORS[name] || mode !== 'ground') return false;
    if (name === 'paw' && !world.grown) return false;
    startBehavior(name);
    return true;
  }

  // ---------- Hover glow, name tag and mood ----------
  // The glow pulses very slightly while it's lit.
  const glow = () => glowLevel * (0.88 + 0.12 * Math.sin(clockNow * 3));

  // Where its name tag belongs: centred over the body, and the highest point of the cat
  // (ears, tail, paws in the air...), so the tag can go above it in any pose, even upside down.
  function tag() {
    if (!rig || !world) return null;
    const p = shown, { head, r } = rig;
    const c = Math.cos(p.tilt), s = Math.sin(p.tilt);
    const inHead = q => P(head.x + q.x * c - q.y * s, head.y + q.x * s + q.y * c);
    const earTip = ang => { const { B, u, len } = earGeom(ang, r, p.earBack); return inHead(along(B, u, len)); };
    const points = [...rig.low, rig.scruff, rig.tail[3], rig.at(0.5, rig.h + p.arch),
      inHead(P(0, -r * 0.94)), earTip(EAR_ANGLES.back), earTip(EAR_ANGLES.front)];
    let top = Infinity;
    for (const q of points) top = Math.min(top, toWorld(q).y);
    const centre = toWorld(mix(rig.H, rig.S, 0.5));
    return { text: `${name} · ${moodName} ${mood().face}`, x: centre.x, y: top, alpha: glowLevel };
  }

  function setName(n) {
    const clean = String(n).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!clean) return false; // keep the old name
    name = clean;
    saveName(name);
    return true;
  }

  function setMood(m) {
    if (!MOODS[m]) return false;
    moodName = m;
    moodTimer = rnd(...MOOD_SECONDS);
    return true;
  }

  window.BouquetCat = {
    step, draw, drawReflection, drawSplash,
    hitScruff, hitBody, grab, drag, release, poke, resize, setBehavior,
    isHeld: () => mode === 'held',
    setHover: on => { hovered = !!on; },
    showTag: seconds => { tagTimer = Math.max(tagTimer, seconds); },
    glow, tag, setName, setMood,
    getName: () => name,
    stay: on => { staying = !!on; },
    info: () => ({ name, mood: moodName, behavior: mode === 'ground' ? behavior?.name : mode }),
  };
})();
