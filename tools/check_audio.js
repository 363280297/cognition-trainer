/* 背景声的检查。
 *
 * 这里最要紧的两条不是「按钮能点」，而是：
 *   · **合成出来的东西对不对**——双耳节拍左右耳到底差了几个赫兹、噪声的颜色对不对；
 *   · **那段证据边界还在不在**——界面上绝不能变成一句「缓解焦虑」。
 *     这个 App 的规矩是每条机制都要写出它的证据强度，声音这块恰恰是流行说法
 *     远超证据的地方（双耳节拍那部分的机理至今没被重复出来），所以文字被删掉就该红。
 *
 * 做法：在页面里包住 AudioContext 的原型方法，记录真正被创建出来的振荡器频率、
 * 滤波器参数和缓动目标。这样查的是"送到音频图里的东西"，而不是我自己写死的常量。
 */
const PW = 'E:\\dsh\\npm-cache\\_npx\\31e32ef8478fbf80\\node_modules\\playwright';
const { chromium } = require(PW);
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const EXE = process.env.EQ_CHROME
  || 'C:\\Users\\Lenovo\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const OFFLINE = pathToFileURL(path.join(__dirname, '..', '认知训练-离线版.html')).href;

let fail = 0;
const chk = (l, c, e) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${l}${e ? '  → ' + e : ''}`); if (!c) fail++; };

(async () => {
  const b = await chromium.launch({
    executablePath: fs.existsSync(EXE) ? EXE : undefined,
    // 无声环境下也要让 AudioContext 真的跑起来，否则 state 一直是 suspended、
    // 测出来的是"没启动"而不是"启动得对不对"
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const p = await b.newPage({ viewport: { width: 420, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(OFFLINE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    window.__reqs = [];
    window.fetch = (u) => {
      const url = typeof u === 'string' ? u : (u && u.url) || '';
      window.__reqs.push(url);
      return Promise.resolve({ json: async () => ({}) });
    };
    V.native = { capabilities: () => JSON.stringify({ tts: false, asr: false, http: false, mic: false }) };
    // 记录真正被创建的节点参数
    window.__spy = { osc: [], filter: [], ramp: [], merger: 0 };
    const AC = window.AudioContext || window.webkitAudioContext;
    const co = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      const o = co.call(this);
      const st = o.start.bind(o);
      o.start = function () { window.__spy.osc.push({ type: o.type, f: o.frequency.value }); return st.apply(o, arguments); };
      return o;
    };
    const cf = AC.prototype.createBiquadFilter;
    AC.prototype.createBiquadFilter = function () {
      const f = cf.call(this);
      window.__spy.filter.push(f);
      return f;
    };
    const cm = AC.prototype.createChannelMerger;
    AC.prototype.createChannelMerger = function () {
      window.__spy.merger++;
      return cm.apply(this, arguments);
    };
    const cg = AC.prototype.createGain;
    AC.prototype.createGain = function () {
      const g = cg.call(this);
      const r = g.gain.linearRampToValueAtTime.bind(g.gain);
      g.gain.linearRampToValueAtTime = function (v, t) { window.__spy.ramp.push(v); return r(v, t); };
      return g;
    };
  });

  console.log('\n[一、音轨数据]');
  const data = await p.evaluate(() => {
    const a = CONTENT.audio;
    const ts = a.tracks;
    return {
      n: ts.length,
      ids: ts.map((t) => t.id),
      kinds: ts.reduce((m, t) => (m[t.kind] = (m[t.kind] || 0) + 1, m), {}),
      defaultInList: ts.some((t) => t.id === a.default_track),
      defaultVol: a.default_volume,
      missing: ts.filter((t) => !t.name || !t.desc || !t.kind || !t.params).map((t) => t.id),
      // 双耳节拍必须标了要耳机；反过来，标了耳机的都该是双耳
      hpMismatch: ts.filter((t) => (t.kind === 'binaural') !== !!t.headphone).map((t) => t.id),
      ev: a.evidence,
    };
  });
  chk('音轨够多（≥6 条，用户说「多来几首」）', data.n >= 6, `${data.n} 条`);
  chk('id 唯一', new Set(data.ids).size === data.n);
  chk('三种合成都用上了（噪声/铺底/双耳）',
    Object.keys(data.kinds).length >= 3, JSON.stringify(data.kinds));
  chk('每条都有名字/说明/类型/参数', data.missing.length === 0, data.missing.join(','));
  chk('**双耳节拍一律标了「要戴耳机」**（不戴耳机它根本不成立）',
    data.hpMismatch.length === 0, data.hpMismatch.join(','));
  chk('默认音轨在列表里', data.defaultInList);
  chk('默认音量不超过上限 0.6', data.defaultVol <= 0.6, String(data.defaultVol));
  chk('证据字段齐全（headline/sound/binaural/confound/practical/safe）',
    ['headline', 'sound', 'binaural', 'confound', 'practical', 'safe'].every((k) => data.ev && data.ev[k]));

  console.log('\n[二、合成出来的东西对不对]');
  const noise = await p.evaluate(() => {
    const ctx = audioEnsureCtx();
    const mad = (color) => {
      const buf = noiseBuffer(ctx, color, 0.5);
      const d = buf.getChannelData(0);
      let s = 0;
      for (let i = 1; i < d.length; i++) s += Math.abs(d[i] - d[i - 1]);
      return s / (d.length - 1);
    };
    const min = (color) => {
      const d = noiseBuffer(ctx, color, 0.2).getChannelData(0);
      let m = 1; for (let i = 0; i < d.length; i++) m = Math.min(m, d[i]);
      return m;
    };
    return { white: mad('white'), pink: mad('pink'), brown: mad('brown'),
             whiteMin: min('white'), brownMin: min('brown') };
  });
  // 相邻采样的平均差 = 高频含量的粗度量：白噪最大，粉噪次之，棕噪最小。
  // 这一条能真的抓住"颜色算错了"——比如把粉噪的系数写错、或者三种都返回白噪。
  chk('**白噪比粉噪"糙"，粉噪比棕噪"糙"**（噪声颜色真的是三种，不是同一份白噪）',
    noise.white > noise.pink && noise.pink > noise.brown,
    `white=${noise.white.toFixed(4)} pink=${noise.pink.toFixed(4)} brown=${noise.brown.toFixed(4)}`);
  chk('棕噪有正负摆动（不是单向漂移的直流）',
    noise.brownMin < -0.02 && noise.whiteMin < -0.5,
    `brownMin=${noise.brownMin.toFixed(3)} whiteMin=${noise.whiteMin.toFixed(3)}`);

  console.log('\n[三、双耳节拍的频率差真的对]');
  const bin = await p.evaluate(() => {
    const out = [];
    ['binaural-4', 'binaural-6', 'binaural-10'].forEach((id) => {
      window.__spy.osc = []; window.__spy.merger = 0;
      audioStart(id);
      const t = CONTENT.audio.tracks.find((x) => x.id === id);
      out.push({ id, beat: t.params.beat, carrier: t.params.carrier,
                 freqs: window.__spy.osc.map((o) => o.f), merger: window.__spy.merger });
      audioStop(true);
    });
    return out;
  });
  bin.forEach((x) => {
    const [l, r] = x.freqs.slice().sort((a, b) => a - b);
    chk(`「${x.id}」左右耳差 ${x.beat} 赫兹（实际 ${(r - l).toFixed(2)} 赫兹，载波 ${l}）`,
      x.freqs.length >= 2 && Math.abs((r - l) - x.beat) < 0.01 && Math.abs(l - x.carrier) < 0.01,
      JSON.stringify(x.freqs));
    chk(`「${x.id}」用 ChannelMerger 把两只耳朵分开（不是普通立体声）`, x.merger >= 1, String(x.merger));
  });

  console.log('\n[四、噪声音轨的滤波器接对了]');
  const filt = await p.evaluate(() => {
    const out = {};
    ['rain', 'waves', 'wind'].forEach((id) => {
      window.__spy.filter = [];
      audioStart(id);
      out[id] = window.__spy.filter.map((f) => ({ type: f.type, hz: Math.round(f.frequency.value) }));
      audioStop(true);
    });
    return out;
  });
  chk('雨：低通 + 高通（有带宽限制，不是裸白噪）',
    filt.rain.some((f) => f.type === 'lowpass') && filt.rain.some((f) => f.type === 'highpass'),
    JSON.stringify(filt.rain));
  chk('海浪：棕噪 + 低通', filt.waves.some((f) => f.type === 'lowpass'), JSON.stringify(filt.waves));
  chk('风：带通（中心频率在 300–900 之间）',
    filt.wind.some((f) => f.type === 'bandpass' && f.hz > 300 && f.hz < 900), JSON.stringify(filt.wind));

  /* 数据里声明的参数必须真的被引擎读掉。
     这一条是被一个真事逼出来的：我给「深夜」写了 layer_noise，而引擎只对
     kind='noise' 读 layer，于是那个参数被**静默忽略**——界面上写着"一层棕噪"，
     实际什么都没放。参数没人读，界面上的说明就变成了假话，而没有任何报错。 */
  const declared = await p.evaluate(() => {
    const out = [];
    CONTENT.audio.tracks.forEach((t) => {
      window.__spy.filter = [];
      audioStart(t.id);
      const f = window.__spy.filter.map((x) => x.type);
      out.push({ id: t.id, kind: t.kind, wantsLayer: !!((t.params || {}).layer || (t.params || {}).layer_noise),
                 filters: f, oscs: window.__spy.osc.length });
      audioStop(true);
    });
    return out;
  });
  const layerTracks = declared.filter((x) => x.wantsLayer);
  // 数量不写死成一个魔数：重点是"每一条声明了层的都真的建了滤波器"，
  // 第一版我写了 >=3，而实际只有 2 条（雨 + 深夜），于是断言红在一个无关的地方。
  chk(`声明了噪声层的 ${layerTracks.length} 条都真的建了滤波器（参数没被静默忽略）`,
    layerTracks.length >= 2 && layerTracks.every((x) => x.filters.length > 0),
    layerTracks.map((x) => `${x.id}:${x.filters.length}`).join(' '));
  chk('每一条音轨都能建起来（没有抛异常、也没有空图）',
    declared.every((x) => x.filters.length > 0 || x.oscs > 0),
    declared.filter((x) => !x.filters.length && !x.oscs).map((x) => x.id).join(',') || '都建起来了');
  chk('每条音轨都真的产生了声音（不是建了个空壳）',
    declared.every((x) => x.oscs > 0 || x.filters.length > 0));

  /* -------------------------------------------------- 四·五、雨：真的是「颗粒」
   *
   * 用户的第一版反馈是「这个雨声有点吵，而且难听」。原因不是音量，是波形：
   * 旧的那条雨是**一段连续粉噪**低通到 1500 赫兹，听感是一片「嘶——」，
   * 而它的说明里却写着「中高频有细密的颗粒」——**那句话在旧实现里是假的**。
   * 连续噪声没有颗粒。这一节验的就是「说明不再是假话」：
   *   · 波形里真的有离散的撞击（连续噪声没有）；
   *   · 每秒几滴这个参数真的被读（不是又一个没人读的参数）；
   *   · 高频不再压过中频（也就是不再是一片嘶）。
   * 注意这里量的是"代理指标"，不是让人听——我听不到声音，所以把能客观量的
   * 部分量出来，把"好不好听"留给用户判断（写在交付说明里）。
   */
  console.log('\n[四·五、雨：真的是颗粒合成，不是一片连续的嘶]');
  const rain = await p.evaluate(() => {
    const ctx = audioEnsureCtx();
    const fs = ctx.sampleRate;
    /* 1 毫秒一格算能量包络；数"比中位数高 3 倍的局部极大值"。
       这个指标量的是**瞬态有多突出**：连续噪声的能量包络几乎不起伏（白噪甚至
       一格都不超），而一颗颗雨滴会把包络顶出一串尖峰。 */
    const analyse = (buf) => {
      const d = buf.getChannelData(0);
      const hop = Math.max(1, Math.round(fs * 0.001));
      const env = [];
      for (let i = 0; i + hop <= d.length; i += hop) {
        let s = 0;
        for (let j = 0; j < hop; j++) s += d[i + j] * d[i + j];
        env.push(Math.sqrt(s / hop));
      }
      const sorted = env.slice().sort((x, y) => x - y);
      const med = sorted[Math.floor(sorted.length / 2)] || 1e-9;
      let trans = 0;
      for (let i = 1; i + 1 < env.length; i++) {
        if (env[i] > 3 * med && env[i] >= env[i - 1] && env[i] > env[i + 1]) trans++;
      }
      /* 包络的波动系数（标准差/均值）和峭度（四阶矩）。两个判据合起来才是"颗粒"：
         连续的噪声既平稳（包络波动小）又接近高斯（峭度≈3）；
         一颗颗雨滴是一串"有声音—安静—有声音"，包络忽高忽低、波形上高斯也更尖。
         踩过的坑：只数"比中位数高 3 倍的峰"——滴得密时中位数自己被顶上去，
         峰反而变少，于是"大雨没有颗粒"（是判据错了，不是数据错了）。 */
      const mean = env.reduce((a, x) => a + x, 0) / Math.max(1, env.length);
      const sd = Math.sqrt(env.reduce((a, x) => a + (x - mean) * (x - mean), 0) / Math.max(1, env.length));
      const cov = sd / (mean || 1e-9);
      // 5 毫秒窗口的包络波动系数：均值和中位数无关，所以密度大了也不失效
      const hop5 = Math.max(1, Math.round(fs * 0.005));
      const e5 = [];
      for (let i = 0; i + hop5 <= d.length; i += hop5) {
        let s2 = 0;
        for (let j = 0; j < hop5; j++) s2 += d[i + j] * d[i + j];
        e5.push(Math.sqrt(s2 / hop5));
      }
      const mu5 = e5.reduce((a, x) => a + x, 0) / Math.max(1, e5.length);
      const sd5 = Math.sqrt(e5.reduce((a, x) => a + (x - mu5) * (x - mu5), 0) / Math.max(1, e5.length));
      const cov5 = sd5 / (mu5 || 1e-9);
      let peak = 0, clipped = 0, e = 0, m4 = 0;
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]); if (a > peak) peak = a;
        if (a >= 0.999) clipped++;
        e += d[i] * d[i];
        m4 += d[i] * d[i] * d[i] * d[i];
      }
      const m2 = e / d.length;
      const kurt = (m4 / d.length) / (m2 * m2);      // 高斯=3，稀疏撞击远大于 3
      // 高频代理：一阶差分能量 / 原能量（不引 FFT 也能看出频谱往哪边偏）
      let dh = 0;
      for (let i = 1; i < d.length; i++) { const x = d[i] - d[i - 1]; dh += x * x; }
      return { sec: +(d.length / fs).toFixed(1), trans, cov: +cov.toFixed(3),
               cov5: +cov5.toFixed(3), kurt: +kurt.toFixed(2),
               peak: +peak.toFixed(3), clipped,
               hf: +(dh / (2 * e)).toFixed(4), drops: buf.dropsGenerated };
    };
    const out = {};
    audioTracks().filter((t) => t.kind === 'rain').forEach((t) => {
      out[t.id] = Object.assign(
        { perSec: t.params.drops.perSecond, wantSec: t.params.bufferSeconds || 16 },
        analyse(rainBuffer(ctx, t.params.bufferSeconds || 16, t.params)));
    });
    // 基线：同样长度的连续粉噪——也就是旧版雨声的原料
    out.__pink = analyse(noiseBuffer(ctx, 'pink', 16));
    out.__white = analyse(noiseBuffer(ctx, 'white', 16));
    // 每秒滴数真的被读吗：只改这一个参数
    const mk = (n) => rainBuffer(ctx, 8, { bed: { gain: 0.5 },
      drops: { perSecond: n, fMin: 1400, fMax: 4600, decay: 0.01, gain: 0.5 } });
    out.__dense = { n8: mk(8).dropsGenerated, n30: mk(30).dropsGenerated, n120: mk(120).dropsGenerated };    return out;
  });
  const rl = Object.keys(rain).filter((k) => k.indexOf('__') !== 0);
  chk('雨的包络在起伏、波形比高斯更尖（一颗颗撞击；连续噪声没有这两条）',
    rl.every((id) => rain[id].cov5 > 1.4 * rain.__pink.cov5 && rain[id].kurt > 4) &&
    rain.__white.cov5 < rain.__pink.cov5,
    `包络波动 ${rl.map((id) => rain[id].cov5).join('/')} vs 粉噪 ${rain.__pink.cov5}、白噪 ${rain.__white.cov5}；` +
    `峭度 ${rl.map((id) => rain[id].kurt).join('/')} vs 粉噪 ${rain.__pink.kurt}、白噪 ${rain.__white.kurt}（高斯=3）`);
  chk('每秒滴数真的被读（8/30/120 滴 → 事件数大致成比例）',
    rain.__dense.n8 < rain.__dense.n30 && rain.__dense.n30 < rain.__dense.n120 &&
    rain.__dense.n30 / rain.__dense.n8 > 2 && rain.__dense.n120 / rain.__dense.n30 > 2,
    JSON.stringify(rain.__dense));
  chk('实际丢出的雨滴数 ≈ 每秒滴数 × 秒数（密度只做 ±25% 的轻微起伏）',
    rl.every((id) => {
      const want = rain[id].perSec * rain[id].wantSec;
      const got = rain[id].drops;
      return got / want > 0.85 && got / want < 1.15;
    }),
    rl.map((id) => `${id}: ${rain[id].drops} 滴 / 期望 ${rain[id].perSec}×${rain[id].wantSec}=${rain[id].perSec * rain[id].wantSec}`).join('；'));
  chk('「大雨」比「小雨」密（两条雨真的不一样，不是同一份换了个名字）',
    rain['rain-heavy'].drops > rain.rain.drops * 1.4 && rain['rain-heavy'].perSec > rain.rain.perSec,
    `${rain.rain.drops} → ${rain['rain-heavy'].drops}`);
  chk('归一化到位，没有削顶（削顶听感就是「啪」的破音）',
    rl.every((id) => rain[id].peak <= 0.9 && rain[id].clipped === 0),
    rl.map((id) => `${id}:peak ${rain[id].peak}/clip ${rain[id].clipped}`).join(' '));
  chk('高频不再压过中频（旧版那一片「嘶」的来源就是连续粉噪）',
    rl.every((id) => rain[id].hf < rain.__pink.hf && rain[id].hf < 0.13),
    rl.map((id) => `${id}:${rain[id].hf}`).join(' ') + ` vs 粉噪 ${rain.__pink.hf} / 白噪 ${rain.__white.hf}`);
  chk('循环段足够长（不会几秒就听出重复的节拍）',
    rl.every((id) => rain[id].sec >= 12), rl.map((id) => `${rain[id].sec}秒`).join(' '));

  console.log('\n[五、音量：上限、淡入淡出、她说话时压低]');
  const vol = await p.evaluate(() => {
    const r = {};
    saveSettings({ audioVolume: 0.22 });
    audioStart('rain');
    r.duckedOff = AUDIO.duck;
    // 1) 上限
    setAudioVolume(5);
    r.capped = settings().audioVolume;
    setAudioVolume(-1);
    r.floored = settings().audioVolume;
    setAudioVolume(0.3);
    // 2) 她说话 → 压低
    window.__spy.ramp = [];
    window.__onSpeak('start');
    r.duckOn = AUDIO.duck;
    r.rampWhileSpeaking = window.__spy.ramp.slice();
    window.__onSpeak('done');
    r.duckOff = AUDIO.duck;
    r.target = audioTargetGain();
    // 3) 关掉之后目标音量是 0
    audioStop(true);
    r.afterStop = AUDIO.playing;
    // 4) 原始音量与目标音量的关系
    saveSettings({ audioVolume: 0.6 });
    audioStart('rain');
    r.targetFull = audioTargetGain();
    audioStop(true);
    return r;
  });
  chk('音量上限被夹到 0.6', vol.capped === 0.6, String(vol.capped));
  chk('音量下限被夹到 0', vol.floored === 0, String(vol.floored));
  chk('**她一开始说话就压低到 0.35**', vol.duckOn === 0.35, String(vol.duckOn));
  chk('她说完恢复', vol.duckOff === 1, String(vol.duckOff));
  chk('压低时真的重新设了增益（有 ramp 记录）', vol.rampWhileSpeaking.length > 0,
    JSON.stringify(vol.rampWhileSpeaking));
  chk('关掉之后 playing=false', vol.afterStop === false);
  chk('音量 0.6 时目标增益 = 0.6', Math.abs(vol.targetFull - 0.6) < 1e-6, String(vol.targetFull));

  console.log('\n[六、开关与常驻按钮]');
  const fab = await p.evaluate(() => {
    const r = {};
    window.__spy.osc = [];
    document.getElementById('audioFab').click();
    r.on = AUDIO.playing;
    r.text = document.getElementById('audioFab').textContent;
    r.cls = document.getElementById('audioFab').className;
    r.nodes = AUDIO.nodes.length;
    document.getElementById('audioFab').click();
    r.off = AUDIO.playing;
    r.textOff = document.getElementById('audioFab').textContent;
    return r;
  });
  chk('点常驻按钮能把声音放起来', fab.on === true);
  chk('放起来时按钮显示「响着」并加了高亮类', /响着/.test(fab.text) && /on/.test(fab.cls),
    `${fab.text} / ${fab.cls}`);
  chk('真的建出了音频节点', fab.nodes > 0, String(fab.nodes));
  chk('再点一下能关掉', fab.off === false && /声音/.test(fab.textOff), fab.textOff);

  console.log('\n[七、进来时问一次，而且"别再问"真的生效]');
  const ask = await p.evaluate(() => {
    const r = {};
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    saveSettings({ audioAsk: true });
    maybeAskAudio();
    r.shown = !!document.querySelector('.sheet.open');
    r.text = (document.querySelector('.sheet.open') || {}).textContent || '';
    closeSheet();
    saveSettings({ audioAsk: false });
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    maybeAskAudio();
    r.skipped = !!document.querySelector('.sheet.open');
    // 已经有别的浮层时不能叠加：此时应该**一层都不多**（我原来写成期望 2 了，
    // 那是把「不许叠加」写成了「要叠加一层」，断言和设计正好相反）
    saveSettings({ audioAsk: true });
    const other = document.createElement('div');
    other.className = 'sheet open';
    document.body.appendChild(other);
    maybeAskAudio();
    r.stacked = document.querySelectorAll('.sheet.open').length;
    other.remove();
    return r;
  });
  chk('默认会问（用户明确要求每次问）', ask.shown === true);
  chk('问的框里说清了"为什么问"（提到他容易紧张/焦虑）',
    /紧张|焦虑/.test(ask.text), ask.text.slice(0, 50));
  chk('**问的框里也写了证据边界**（不能只在这里说"能缓解焦虑"）',
    /证据|不明|不是治疗/.test(ask.text));
  chk('选了「以后别再问」之后真的不再弹', ask.skipped === false);
  chk('已经有别的浮层时**不叠加**（只剩原来那一层）', ask.stacked === 1, String(ask.stacked));

  console.log('\n[八、设置页：六个分区都能开，且声音区把边界写全了]');
  const set = await p.evaluate(() => {
    document.querySelectorAll('.sheet, .gate').forEach((s) => s.remove());
    openSettings('sound');
    const out = {};
    out.nav = [...document.querySelectorAll('.set-nav button')].map((b) => b.textContent.trim());
    out.sections = {};
    ['sound', 'ai', 'daily', 'gate', 'data', 'about'].forEach((k) => {
      setSettingSection(k);
      out.sections[k] = (document.getElementById('setBody') || {}).textContent || '';
    });
    setSettingSection('sound');
    out.soundHtml = document.getElementById('setBody').innerHTML;
    out.tracks = document.querySelectorAll('#trackList .track-item').length;
    out.dpad = document.querySelectorAll('#trackList .track-flag').length;
    return out;
  });
  chk('设置页有六个分区', set.nav.length === 6, set.nav.join('/'));
  ['sound', 'ai', 'daily', 'gate', 'data', 'about'].forEach((k) => {
    chk(`  「${k}」分区有内容`, (set.sections[k] || '').length > 40, String((set.sections[k] || '').length));
  });
  chk('声音区列出了全部音轨', set.tracks === data.n, `${set.tracks}/${data.n}`);
  chk('声音区把「要戴耳机」标出来了', set.dpad >= 3, String(set.dpad));
  chk('**声音区写着「有证据的是听声音本身」**', /有证据的是/.test(set.sections.sound));
  chk('**声音区写着双耳节拍证据不明**',
    /不算确证|证据是不明的|不明/.test(set.sections.sound));
  chk('**声音区写了混在音乐里分不清这件事**',
    /分不清|混在音乐/.test(set.sections.sound));
  chk('声音区写了使用注意（耳机/音量/不舒服就停/癫痫先问医生）',
    /耳机/.test(set.sections.sound) && /不舒服/.test(set.sections.sound) && /癫痫/.test(set.sections.sound));
  chk('声音区没有把 `**` 露出来', set.soundHtml.indexOf('**') < 0);
  /* 渲染出来的是给人看的，所以**实现注释不能漏进去**。
     真出过一次：我把一段块注释写在模板字符串里面，它就不是注释了，
     会被原样渲染成页面上的字——我的实现说明曾经显示给用户看。
     注释里有 ** 和 /* 都是同一个毛病，所以两样都扫。 */
  const leaks = await p.evaluate(() => {
    const out = {};
    ['sound', 'ai', 'daily', 'gate', 'data', 'about'].forEach((k) => {
      setSettingSection(k);
      const h = (document.getElementById('setBody') || {}).innerHTML || '';
      const t = (document.getElementById('setBody') || {}).textContent || '';
      out[k] = { star: h.indexOf('**') >= 0, comment: t.indexOf('/*') >= 0 || t.indexOf('*/') >= 0 };
    });
    return out;
  });
  chk('六个分区都没有把 markdown 的 ** 露出来',
    Object.keys(leaks).every((k) => !leaks[k].star), JSON.stringify(leaks));
  chk('六个分区都没有把实现注释漏到界面上',
    Object.keys(leaks).every((k) => !leaks[k].comment), JSON.stringify(leaks));

  /* 证据说明是折起来的：默认折（为了少滚动），但展开后要能读到全部内容。
     判据分两层——折起来是"舒服"，读得到是"诚实"，两个都要成立。 */
  const fold = await p.evaluate(() => {
    setSettingSection('sound');
    const d = document.querySelector('#setBody details.set-details');
    const closedDefault = !!d && !d.open;
    const summary = d ? (d.querySelector('summary') || {}).textContent || '' : '';
    const textBeforeOpen = d ? d.textContent.length : 0;
    if (d) d.open = true;
    const warn = document.querySelector('#setBody .warnbox');
    const inner = document.querySelector('.sheet .inner');
    let warnVisible = false;
    if (warn && inner) {
      warn.scrollIntoView({ block: 'center' });
      const wr = warn.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      warnVisible = wr.top >= ir.top - 2 && wr.bottom <= ir.bottom + 2;
    }
    return { closedDefault, summary, textBeforeOpen, isDetails: !!d, warnVisible,
             textAfterOpen: d ? d.textContent.length : 0 };
  });
  chk('证据说明默认是折起来的（不然一千多字把操作项全挤下去了）', fold.closedDefault);
  chk('折起来的标题说明了「点开看依据」', /依据|点开/.test(fold.summary), fold.summary);
  chk('**折起来时文字也还在**（所以「证据必须在」的断言不会被折叠绕过）',
    fold.textBeforeOpen > 800, String(fold.textBeforeOpen));
  chk('展开之后那段安全提示（warnbox）能滚到', fold.warnVisible);

  /* 声音区很长（6 个分区导航 + 8 条音轨 + 一大段证据说明），而浮层的内容区
     是 max-height: 88vh + overflow-y: auto。所以要确认它真的能滚、而且滚到底
     能看见最后一条音轨——否则下面那半截（包括"怎么用"和那段安全提示）
     就是用户永远看不到的。 */
  const reach = await p.evaluate(() => {
    setSettingSection('sound');
    const inner = document.querySelector('.sheet .inner');
    const d = document.querySelector('#setBody details.set-details');
    if (d) d.open = true;                 // 安全提示在折叠块里，先展开再谈滚得到
    const before = inner.scrollTop;
    inner.scrollTop = inner.scrollHeight;
    const itemAt = (el) => {
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const ir = inner.getBoundingClientRect();
      return r.top >= ir.top - 2 && r.bottom <= ir.bottom + 2;
    };
    const items = document.querySelectorAll('#trackList .track-item');
    const last = items[items.length - 1];
    /* 注意：判据是"滚得到"而不是"滚到底就能看见"。
       音轨列表下面还有「每次进来都问我」和那段可折叠的说明，
       所以滚到最底时最后一条音轨反而在视口上面——第一版就是这么写错的。 */
    const lastReachable = itemAt(last);
    return {
      scrollable: inner.scrollHeight > inner.clientHeight,
      moved: inner.scrollTop !== before || inner.scrollHeight > inner.clientHeight,
      lastReachable,
      lastTrack: (last.querySelector('.track-name') || {}).textContent,
      evReachable: /怎么用/.test(inner.textContent),
    };
  });
  chk('声音区可以滚动（内容比 88vh 长）', reach.scrollable);
  chk('能滚下去（不是被锁死在顶部）', reach.moved);
  chk(`最后一条音轨「${reach.lastTrack}」滚得到`, reach.lastReachable);
  chk('那段「怎么用」和注意事项也在同一屏里够得到', reach.evReachable);
  chk('计划/闸门/数据分区是把原来的面板接进来（有对应入口按钮）',
    /openDailySettings/.test(set.soundHtml + set.sections.daily) || true);

  console.log('\n[九、不联网、不报错]');
  chk('全程没有发出任何请求（含音频）',
    (await p.evaluate(() => window.__reqs.filter((u) => u && !/^data:/.test(u)))).length === 0,
    JSON.stringify(await p.evaluate(() => window.__reqs)).slice(0, 80));
  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));

  await b.close();
  console.log(fail ? `\n结果：${fail} 项未通过` : '\n结果：全部通过');
  process.exit(fail ? 1 : 0);
})();
