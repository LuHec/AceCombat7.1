// 程序化音频：引擎、风、雨、锁定音、爆炸、雷声（WebAudio 合成，无外部素材）
// 原创「皇牌空战风」分层配乐：弦乐固定音型 + 定音鼓/太鼓 + 铜管 + 英雄主题
const MUS_BPM = 140;
// 8 小节和弦（midi）：Dm Bb F C | Dm Bb Gm A
const MUS_CHORDS = [
  [50, 53, 57], [46, 50, 53], [53, 57, 60], [48, 52, 55],
  [50, 53, 57], [46, 50, 53], [43, 46, 50], [45, 49, 52],
];
const MUS_BASS = [38, 34, 41, 36, 38, 34, 31, 33];   // D2 Bb1 F2 C2 D2 Bb1 G1 A1
const MUS_OST = [12, 0, 7, 12, 0, 12, 7, 0, 12, 0, 7, 12, 0, 12, 7, 0]; // 弦乐固定音型
// 英雄主题（原创）：[起始步, midi, 长度]，128 步 = 8 小节
const MUS_LEAD = [
  [0, 74, 6], [8, 69, 4], [12, 72, 4], [16, 74, 4], [20, 76, 4], [24, 77, 6], [30, 76, 2],
  [32, 74, 8], [40, 70, 4], [44, 72, 4], [48, 74, 10], [58, 74, 2], [60, 76, 2], [62, 77, 2],
  [64, 79, 8], [72, 77, 4], [76, 76, 4], [80, 77, 12], [92, 76, 4],
  [96, 74, 6], [104, 81, 6], [112, 79, 4], [116, 77, 4], [120, 76, 8],
];
const midi2f = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this._lockT = 0;
    this._alertT = 0;
    this._music = null;
    this._pendingLevel = 1;
  }

  init() {
    if (this.ready) return;
    try {
      const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const master = this.master = ctx.createGain();
      master.gain.value = 0.42;
      master.connect(ctx.destination);

      const noiseBuf = this.noiseBuf = this._makeNoise(2);

      // 引擎：双锯齿波 + 噪声 → 低通
      this.engGain = this._gain(0);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 1.2;
      lp.connect(this.engGain); this.engGain.connect(master);
      this.engLp = lp;
      this.engOsc1 = this._osc('sawtooth', 52, lp);
      this.engOsc2 = this._osc('sawtooth', 52.8, lp);
      const engNoise = ctx.createBufferSource();
      engNoise.buffer = noiseBuf; engNoise.loop = true;
      const engNoiseG = this._gain(0.15);
      engNoise.connect(engNoiseG); engNoiseG.connect(lp); engNoise.start();

      // 风噪
      this.windGain = this._gain(0);
      const wbp = ctx.createBiquadFilter();
      wbp.type = 'bandpass'; wbp.frequency.value = 600; wbp.Q.value = 0.6;
      const wn = ctx.createBufferSource(); wn.buffer = noiseBuf; wn.loop = true;
      wn.connect(wbp); wbp.connect(this.windGain); this.windGain.connect(master); wn.start();

      // 雨声
      this.rainGain = this._gain(0);
      const rbp = ctx.createBiquadFilter();
      rbp.type = 'bandpass'; rbp.frequency.value = 3200; rbp.Q.value = 0.4;
      const rn = ctx.createBufferSource(); rn.buffer = noiseBuf; rn.loop = true;
      rn.connect(rbp); rbp.connect(this.rainGain); this.rainGain.connect(master); rn.start();

      // 锁定音 / 告警音（增益由 update 调制）
      this.lockGain = this._gain(0);
      this.lockOsc = this._osc('square', 980, this.lockGain);
      this.lockGain.connect(master);
      this.alertGain = this._gain(0);
      this.alertOsc = this._osc('square', 560, this.alertGain);
      this.alertGain.connect(master);

      this.ready = true;
      this.startMusic();
    } catch (e) { /* 无音频环境时静默 */ }
  }

  // ============ 音乐 ============
  startMusic() {
    if (!this.ready || this._music) return;
    const ctx = this.ctx;
    const bus = this.musicBus = this._gain(0);
    bus.connect(this.master);
    bus.gain.setTargetAtTime(0.17, ctx.currentTime, 1.2);
    // 分层：pad 和声垫 / ost 弦乐音型 / perc 打击 / lead 铜管+主旋律
    const layers = {};
    for (const k of ['pad', 'ost', 'perc', 'lead']) {
      layers[k] = this._gain(0);
      layers[k].connect(bus);
    }
    this._music = {
      step: 0, nextT: ctx.currentTime + 0.1,
      level: this._pendingLevel, layers,
    };
    this._applyMusicLevel();
    this._musicTimer = setInterval(() => this._musicTick(), 40);
  }

  setMusicLevel(n) {
    this._pendingLevel = n;
    if (this._music) { this._music.level = n; this._applyMusicLevel(); }
  }

  _applyMusicLevel() {
    const m = this._music, t = this.ctx.currentTime;
    const lv = m.level;
    const set = (g, v) => g.gain.setTargetAtTime(v, t, 1.2);
    set(m.layers.pad, 0.9);
    set(m.layers.ost, lv >= 1 ? 0.8 : 0);
    set(m.layers.perc, lv >= 2 ? 0.9 : 0);
    set(m.layers.lead, lv >= 3 ? 0.9 : 0);
  }

  _musicTick() {
    const m = this._music;
    if (!m) return;
    const stepDur = (60 / MUS_BPM) / 4;      // 16 分音符
    // 页面休眠/卡顿后 nextT 会大幅落后：直接对齐当前时间，不补调度积压（否则瞬间创建数千节点卡死）
    if (m.nextT < this.ctx.currentTime - 0.3) m.nextT = this.ctx.currentTime;
    while (m.nextT < this.ctx.currentTime + 0.18) {
      this._scheduleStep(m.step, m.nextT, stepDur);
      m.nextT += stepDur;
      m.step = (m.step + 1) % 128;
    }
  }

  _scheduleStep(step, t, stepDur) {
    const bar = (step / 16) | 0;
    const s16 = step % 16;
    const chord = MUS_CHORDS[bar];
    const L = this._music.layers;
    const lv = this._music.level;

    // 和声垫（每小节）
    if (s16 === 0) {
      for (const n of chord) this._voice(midi2f(n + 12), t, stepDur * 16, 'sawtooth', 0.045, 700, L.pad, 0.6, 5);
      this._voice(midi2f(chord[0]), t, stepDur * 16, 'triangle', 0.05, 500, L.pad, 0.5);
    }
    // 贝斯（1、3 拍）
    if (s16 === 0 || s16 === 8) this._voice(midi2f(MUS_BASS[bar]), t, stepDur * 7, 'triangle', 0.14, 300, L.ost, 0.02);
    // 弦乐固定音型（16 分）
    this._voice(midi2f(chord[0] + 12 + MUS_OST[s16]), t, stepDur * 0.9, 'sawtooth', s16 % 4 === 0 ? 0.075 : 0.05, 1400, L.ost, 0.005, 6);
    // 打击
    if (s16 % 4 === 0) this._kick(t, 0.5);
    if (s16 === 4 || s16 === 12) this._snare(t, 0.22);
    if (s16 === 0) this._taiko(t, 0.5);
    if (s16 === 10 || s16 === 14) this._taiko(t, 0.28);
    if (s16 % 2 === 0) this._hat(t, s16 % 4 === 0 ? 0.09 : 0.05);
    // 决战加码：双踩 + 16 分踩镲 + 额外军鼓
    if (lv >= 4) {
      if (s16 === 2 || s16 === 10) this._kick(t, 0.32);
      if (s16 === 14) this._snare(t, 0.16);
      if (s16 % 2 === 1) this._hat(t, 0.045);
    }
    // 铜管重音（仅高强度）
    if (s16 === 0 || s16 === 6 || s16 === 10) {
      for (const n of chord) this._voice(midi2f(n + 12), t, stepDur * 2.2, 'sawtooth', 0.055, 1000, L.lead, 0.03, 8);
    }
    // 英雄主题（决战时高八度）
    for (const [st, midi, dur] of MUS_LEAD) {
      if (st === step) {
        const mm = lv >= 4 ? midi + 12 : midi;
        this._voice(midi2f(mm), t, stepDur * dur * 0.95, 'sawtooth', 0.085, 2400, L.lead, 0.05, 7);
        this._voice(midi2f(mm - 12), t, stepDur * dur * 0.95, 'square', 0.03, 1200, L.lead, 0.06, 4);
      }
    }
  }

  // 通用合成音色：双振荡微失谐 + 低通 + 包络
  _voice(freq, t, dur, type, vol, lpf, dest, attack = 0.01, detune = 0) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.18);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lpf; f.Q.value = 0.5;
    f.connect(g); g.connect(dest);
    const o1 = ctx.createOscillator();
    o1.type = type; o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = type; o2.frequency.value = freq;
    if (detune) { o1.detune.value = detune; o2.detune.value = -detune; }
    o1.connect(f); o2.connect(f);
    o1.start(t); o1.stop(t + dur + 0.4);
    o2.start(t); o2.stop(t + dur + 0.4);
  }

  _kick(t, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + 0.03, 0.05);
    o.connect(g); g.connect(this._music.layers.perc);
    o.start(t); o.stop(t + 0.35);
  }
  _taiko(t, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(85, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + 0.06, 0.1);
    o.connect(g); g.connect(this._music.layers.perc);
    o.start(t); o.stop(t + 0.7);
  }
  _snare(t, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + 0.02, 0.045);
    src.connect(f); f.connect(g); g.connect(this._music.layers.perc);
    src.start(t); src.stop(t + 0.25);
  }
  _hat(t, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + 0.008, 0.018);
    src.connect(f); f.connect(g); g.connect(this._music.layers.perc);
    src.start(t); src.stop(t + 0.08);
  }

  _makeNoise(sec) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // 轻度棕噪化，更柔和
      d[i] = (w * 0.55 + last * 2.2) * 0.6;
    }
    return buf;
  }
  _gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  _osc(type, freq, dest) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.connect(dest); o.start();
    return o;
  }
  _set(g, v, t = 0.08) { if (this.ready) g.gain.setTargetAtTime(v, this.ctx.currentTime, t); }

  // 每帧驱动连续音
  update(dt, s) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const thr = s.throttle ?? 0.6;
    const f = 46 + thr * 66 + (s.ab ? 40 : 0);
    this.engOsc1.frequency.setTargetAtTime(f, t, 0.1);
    this.engOsc2.frequency.setTargetAtTime(f * 1.013 + 1.5, t, 0.1);
    this.engLp.frequency.setTargetAtTime(320 + thr * 900 + (s.ab ? 1600 : 0), t, 0.1);
    this._set(this.engGain, s.muted ? 0 : 0.05 + thr * 0.075 + (s.ab ? 0.05 : 0));
    this._set(this.windGain, Math.min(0.22, (s.speed || 0) / 720 * 0.22));
    this._set(this.rainGain, (s.rain || 0) * 0.06);

    // 锁定蜂鸣：搜索中间歇、锁定后长鸣
    if (s.lock === 2) { this._set(this.lockGain, 0.045, 0.02); }
    else if (s.lock === 1) {
      this._lockT -= dt;
      if (this._lockT <= 0) { this._lockT = 0.22; this._pulse(this.lockGain, 0.05, 0.07); }
    } else this._set(this.lockGain, 0, 0.03);

    // 导弹来袭告警
    if (s.alert) {
      this._alertT -= dt;
      if (this._alertT <= 0) { this._alertT = 0.34; this._pulse(this.alertGain, 0.06, 0.12); }
    } else this._set(this.alertGain, 0, 0.03);
  }

  _pulse(gain, vol, dur) {
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.setTargetAtTime(0, t + dur, 0.03);
  }

  _burst(dur, filterType, f0, f1, vol, oscDrop) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.setTargetAtTime(0, t + dur * 0.25, dur * 0.22);
    src.connect(flt); flt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.4);
    if (oscDrop) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(oscDrop[0], t);
      o.frequency.exponentialRampToValueAtTime(oscDrop[1], t + dur);
      const og = ctx.createGain();
      og.gain.setValueAtTime(vol * 0.9, t);
      og.gain.setTargetAtTime(0, t + dur * 0.3, dur * 0.25);
      o.connect(og); og.connect(this.master);
      o.start(t); o.stop(t + dur + 0.4);
    }
  }

  missileFire() { this._burst(0.7, 'highpass', 3000, 500, 0.22); }
  gun() { this._burst(0.06, 'bandpass', 2400, 900, 0.16); }
  explosion(size = 1) { this._burst(0.9 * size, 'lowpass', 2600, 60, 0.5 * Math.min(1.6, size), [160, 34]); }
  hit() { this._burst(0.12, 'bandpass', 1500, 500, 0.2); }
  beam() { this._burst(1.1, 'highpass', 6000, 280, 0.4, [1900, 85]); }
  thunder(dist = 1000) {
    if (!this.ready) return;
    const delay = Math.min(6, dist / 340);
    setTimeout(() => this._burst(2.6, 'lowpass', 320, 40, Math.max(0.08, 0.5 - dist / 6000), [70, 28]), delay * 1000);
  }
}
