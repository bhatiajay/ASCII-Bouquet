// audio.js — generated music and night-time ambience for ASCII Bouquet, using the Web Audio API.
// No audio files are loaded: every sound is synthesized in code.
//
// Signal chain:
//   instruments -> musicBus ----> master gain -> compressor -> speakers
//   night sounds -> ambienceBus -^      ^
//            both  \-> reverb send -> reverb
//
// Used by bouquet.js through window.BouquetAudio:
//   start()       create/resume audio (browsers only allow this after a click or key press)
//   toggleMute()  fade all sound out or back in
//   bloom(i)      play a chime when a lily opens (i = palette index: 0 blue, 1 pink)
//   update(gust)  called every frame with the breeze strength (about 0.2..1)
//   isStarted()   whether start() has been called
(() => {
  'use strict';

  // ---------- Settings ----------
  const MASTER_VOLUME = 0.7;
  const BPM = 66;            // music-box tempo (beats per minute)
  const CHORD_SECONDS = 8;   // how long each pad chord lasts
  const LOOKAHEAD = 0.3;     // seconds of music scheduled ahead of time
  const TICK_MS = 100;       // how often the scheduler wakes up

  // MIDI note number -> frequency in Hz (69 = A4 = 440 Hz).
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // A dreamy progression: Fmaj7 -> Am7 -> Dm9 -> B♭maj7 (as MIDI notes).
  const CHORDS = [
    [53, 57, 60, 64],     // F A C E
    [57, 60, 64, 67],     // A C E G
    [50, 53, 57, 60, 64], // D F A C E
    [46, 50, 53, 57],     // B♭ D F A
  ];
  // F major pentatonic (F G A C D) across two octaves: every note fits every chord.
  const SCALE = [65, 67, 69, 72, 74, 77, 79, 81, 84, 86];
  const STEPS = [-2, -1, -1, 1, 1, 2]; // how the melody wanders up and down the scale

  // ---------- State ----------
  let ctx = null;
  let master, musicBus, ambienceBus, breezeGain;
  let muted = false;
  let nextNoteTime = 0, nextChordTime = 0, chordIndex = 0, melodyStep = 4;
  let nextCricketTime = 0, nextOwlTime = 0, lastBreezeUpdate = 0;
  const rnd = (a, b) => a + (b - a) * Math.random();

  // ---------- Setup ----------
  // Reverb from a generated "impulse response": stereo noise that fades out.
  function makeReverb(seconds, decay) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = buffer;
    return reverb;
  }

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(compressor);

    const reverb = makeReverb(4, 2.5);
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.6;
    reverbSend.connect(reverb);
    reverb.connect(master);

    musicBus = ctx.createGain();
    musicBus.connect(master);
    musicBus.connect(reverbSend);

    ambienceBus = ctx.createGain();
    ambienceBus.connect(master);
    const ambienceVerb = ctx.createGain(); // night sounds get a little reverb, for distance
    ambienceVerb.gain.value = 0.3;
    ambienceBus.connect(ambienceVerb);
    ambienceVerb.connect(reverbSend);
    startWater();
    startBreeze();

    master.gain.setTargetAtTime(MASTER_VOLUME, ctx.currentTime, 1.5); // gentle fade-in
    nextNoteTime = nextChordTime = ctx.currentTime + 0.1;
    nextCricketTime = ctx.currentTime + rnd(0.5, 2);
    nextOwlTime = ctx.currentTime + rnd(15, 30);
    setInterval(schedule, TICK_MS);

    // Pause the sound while the tab is hidden, and pick up again when it's visible.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend();
      else ctx.resume();
    });
  }

  // Optional left/right placement (older browsers without StereoPanner just play centred).
  function panned(destination, pan) {
    if (!ctx.createStereoPanner) return destination;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(destination);
    return p;
  }

  // ---------- Instruments ----------
  // Music box: a sine tone plus a quieter octave, with a sharp pluck and a long ring-out.
  function musicBox(freq, time, volume, ring = 2.5) {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(volume, time + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, time + ring);
    env.connect(panned(musicBus, Math.random() * 0.6 - 0.3));
    for (const [mult, level] of [[1, 1], [2, 0.3]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      g.gain.value = level;
      osc.connect(g);
      g.connect(env);
      osc.start(time);
      osc.stop(time + ring + 0.1);
    }
  }

  // Pad: soft detuned triangle waves through a low-pass filter. Each chord fades in
  // slowly and overlaps the next one, so the changes are smooth.
  function pad(notes, time, duration) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(0.035, time + 2.5);
    env.gain.setValueAtTime(0.035, time + duration - 0.5);
    env.gain.linearRampToValueAtTime(0, time + duration + 2.5);
    filter.connect(env);
    env.connect(musicBus);
    for (const n of notes) {
      for (const detune of [-7, 7]) { // two slightly out-of-tune copies give a warm chorus
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = mtof(n);
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start(time);
        osc.stop(time + duration + 2.6);
      }
    }
  }

  function melodyNote(time) {
    if (Math.random() < 0.25) return; // rests give the melody room to breathe
    const step = STEPS[Math.floor(Math.random() * STEPS.length)];
    melodyStep = Math.max(0, Math.min(SCALE.length - 1, melodyStep + step));
    musicBox(mtof(SCALE[melodyStep]), time, 0.12);
  }

  // ---------- Night ambience ----------
  // Two seconds of white noise, looped: the raw material for water and wind.
  function noiseSource() {
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  // A slow wobble (low-frequency oscillator) added onto an audio parameter.
  function lfo(param, rate, depth) {
    const osc = ctx.createOscillator();
    const amount = ctx.createGain();
    osc.frequency.value = rate;
    amount.gain.value = depth;
    osc.connect(amount);
    amount.connect(param);
    osc.start();
  }

  // Water lapping: deep, muffled noise that slowly swells and recedes.
  function startWater() {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    lfo(gain.gain, 0.17, 0.03);          // swell...
    lfo(filter.frequency, 0.23, 140);    // ...and brighten as each wave laps in
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ambienceBus);
    src.start();
  }

  // Breeze: airy band-passed noise. Its volume is set by update() to match the stems.
  function startBreeze() {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.6;
    lfo(filter.frequency, 0.11, 250); // the "whoosh" drifts in pitch
    breezeGain = ctx.createGain();
    breezeGain.gain.value = 0.02;
    src.connect(filter);
    filter.connect(breezeGain);
    breezeGain.connect(panned(ambienceBus, 0));
    src.start();
  }

  // Cricket: a quick train of 3–4 high chirps, somewhere to the left or right.
  function cricket(time) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.frequency.value = rnd(4200, 4900);
    env.gain.setValueAtTime(0, time);
    const chirps = 3 + Math.floor(Math.random() * 2);
    const volume = rnd(0.008, 0.02); // some crickets are nearer than others
    for (let i = 0; i < chirps; i++) {
      const t = time + i * 0.07;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(volume, t + 0.01);
      env.gain.linearRampToValueAtTime(0, t + 0.04);
    }
    osc.connect(env);
    env.connect(panned(ambienceBus, rnd(-0.9, 0.9)));
    osc.start(time);
    osc.stop(time + chirps * 0.07 + 0.1);
  }

  // Owl: two soft "hoo"s that sag slightly in pitch.
  function owl(time) {
    const pan = rnd(-0.7, 0.7);
    for (const [start, len, f0, f1] of [[0, 0.35, 390, 350], [0.6, 0.55, 370, 320]]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const t = time + start;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + len);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.05, t + 0.06);
      env.gain.linearRampToValueAtTime(0, t + len);
      osc.connect(env);
      env.connect(panned(ambienceBus, pan));
      osc.start(t);
      osc.stop(t + len + 0.05);
    }
  }

  // ---------- Scheduler ----------
  // Wakes every TICK_MS and queues any notes due in the next LOOKAHEAD seconds,
  // timed exactly on the audio clock (setInterval alone is too jittery for music).
  function schedule() {
    const now = ctx.currentTime;
    // If we fell behind (e.g. the tab was asleep), skip ahead instead of playing a pile-up.
    if (nextNoteTime < now) nextNoteTime = now + 0.05;
    if (nextChordTime < now - 1) nextChordTime = now + 0.05;
    if (nextCricketTime < now) nextCricketTime = now + 0.05;
    if (nextOwlTime < now) nextOwlTime = now + rnd(20, 50);
    const until = now + LOOKAHEAD;

    while (nextCricketTime < until) {
      cricket(nextCricketTime);
      nextCricketTime += rnd(0.4, 2.2);
    }
    if (nextOwlTime < until) {
      owl(nextOwlTime);
      nextOwlTime += rnd(25, 60); // owls are rare
    }

    while (nextChordTime < until) {
      pad(CHORDS[chordIndex], nextChordTime, CHORD_SECONDS);
      chordIndex = (chordIndex + 1) % CHORDS.length;
      nextChordTime += CHORD_SECONDS;
    }
    while (nextNoteTime < until) {
      melodyNote(nextNoteTime);
      const beat = 60 / BPM;
      nextNoteTime += Math.random() < 0.7 ? beat : beat / 2;
    }
  }

  // ---------- Public API ----------
  function start() {
    try {
      if (!ctx) init();
      else if (ctx.state === 'suspended') ctx.resume();
    } catch (err) {
      console.warn('Audio could not start:', err);
    }
  }

  function toggleMute() {
    if (!ctx) return;
    muted = !muted;
    master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, ctx.currentTime, 0.3);
  }

  // A little rising arpeggio: blue lilies chime higher, pink ones a bit lower.
  // Chimes closer together than this are skipped (e.g. resizing re-opens every lily at once).
  let lastBloom = -Infinity;
  function bloom(paletteIndex) {
    if (!ctx || muted) return;
    const t = ctx.currentTime + 0.02;
    if (t - lastBloom < 0.25) return;
    lastBloom = t;
    const notes = paletteIndex === 0 ? [81, 84, 88] : [77, 81, 84];
    notes.forEach((n, i) => musicBox(mtof(n), t + i * 0.09, 0.07, 3.5));
  }

  // The breeze gets louder as the animation's gusts get stronger. Called every
  // frame, but only passed to the audio engine about 5 times a second.
  function update(gust) {
    if (!ctx || !breezeGain) return;
    const now = ctx.currentTime;
    if (now - lastBreezeUpdate < 0.2) return;
    lastBreezeUpdate = now;
    breezeGain.gain.setTargetAtTime(0.004 + 0.05 * gust * gust, now, 0.4);
  }

  window.BouquetAudio = { start, toggleMute, bloom, update, isStarted: () => ctx !== null };
})();
