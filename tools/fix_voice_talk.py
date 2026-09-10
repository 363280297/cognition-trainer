# -*- coding: utf-8 -*-
"""修 check_voice_talk 第一次跑出来的四个问题。三个是我的代码，一个是断言写错了。

1. **「免提：开/关」的文案不会跟着变**（真 bug）
   那段文案只在 renderPractice() 里写了一次，而 renderTalkBar() 没管它。
   于是「连续几次没听到声音 → 自动关掉免提」之后，按钮上还写着「免提：开」——
   界面在说谎。用户唯一的判断依据就是这几个字，写错了比不写更糟。

2. **权限错误没写进设置**（真 bug）
   pauseHandsFree(msg) 少传了 persist。结果：每次进入新的会话都会白开一次麦克风、
   失败一次、再关掉。要写进设置，因为「没有麦克风权限」重试一万次也是一样的。

3. **不变式断言写错了**（测试的问题，不是代码的问题）
   原来断言「speak 之后、stopSpeak 之前不许出现 listen」——但「她说完」
   是靠 __onSpeak('done') 通知的，不是靠 stopSpeak，所以正常流程也会被判违规。
   改成**直接验两件真正危险的事**：
     · 调用 listen() 的那一刻，V.speaking 必须是 false（否则录到她自己）
     · 调用 speak() 的那一刻，麦克风必须是关着的（否则她边说边录）
   桩里维护一个 __micOpen，每个事件都记下当时这两个状态。这比猜事件顺序准。

4. **「最该回头看的一句」没渲染**——那是我的测试数据里所有回合都是「好」，
   本来就不该有这一块。给它加一个「漏着」的回合，顺便真的验证一下
   加复盘卡没有把别的卡挤掉。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
TP = os.path.join(ROOT, 'tools', 'check_voice_talk.js')


def sub(path, s, old, new, n=1):
    assert s.count(old) == n, f'{os.path.basename(path)}：期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    # ==================== 1) 免提文案的唯一来源 ====================
    v = io.open(VP, encoding='utf-8').read()

    v = sub(VP, v, """  const t = document.getElementById('phaseText');
  const d = document.getElementById('phaseDot');
  const l = document.getElementById('micLabel');
  const b = document.getElementById('micBtn');""", """  const t = document.getElementById('phaseText');
  const d = document.getElementById('phaseDot');
  const l = document.getElementById('micLabel');
  const b = document.getElementById('micBtn');
  // 开关的文案必须在这里更新，而且**只在这里**。
  // 原来它只在 renderPractice 里写了一次，于是「连续空结果自动关掉免提」之后
  // 按钮上还写着「免提：开」——状态变了、字没变，界面就在说谎，
  // 而用户判断麦克风开没开全靠这几个字。
  const hb = document.getElementById('hfBtn');
  if (hb) hb.textContent = V.hf ? '免提：开' : '免提：关';""")

    # renderPractice 里那份删掉，避免两处各写一次（这类「一个状态两处维护」正是出过错的地方）
    v = sub(VP, v, """  const hb = document.getElementById('hfBtn');
  if (hb) hb.textContent = V.hf ? '免提：开' : '免提：关';
  renderTalkBar();
  if (V.hf) maybeAutoListen();""", """  renderTalkBar();
  if (V.hf) maybeAutoListen();""")

    # ==================== 2) 权限错误要写进设置 ====================
    v = sub(VP, v, """      // 权限、引擎忙、网络：这些重试没用，说清楚并停手（别让麦克风一直开着）
      setPhase('idle');
      renderTurnHint(msg);
      pauseHandsFree(msg);""", """      // 权限、引擎忙、网络：这些重试没用，说清楚并停手（别让麦克风一直开着）。
      // persist=true：这类原因下次进来还是一样的，不记住就会每次白开一次麦克风。
      setPhase('idle');
      pauseHandsFree(msg, true);""")

    io.open(VP, 'w', encoding='utf-8').write(v)

    # ==================== 3) 不变式改成直接量两件危险的事 ====================
    t = io.open(TP, encoding='utf-8').read()

    t = sub(TP, t, """    window.__ev = [];
    const stub = {
      capabilities: () => JSON.stringify({ tts: true, asr: true, http: true, mic: true }),
      listen: () => { window.__ev.push('listen'); },
      stopListening: () => { window.__ev.push('stopListening'); },
      speak: (t) => { window.__ev.push('speak'); },
      stopSpeak: () => { window.__ev.push('stopSpeak'); },
    };""", """    /* 每个事件都记下「当时」这两件事的状态，而不是事后去猜事件顺序：
     *   speak 的那一刻麦克风关着吗   —— 否则她边说边录自己
     *   listen 的那一刻她在出声吗    —— 否则她的声音被当成用户说的
     * 这是这套状态机仅有的两个真危险，直接用当时的真实状态量，不靠推断。 */
    window.__ev = [];
    window.__micOpen = false;
    const rec = (name) => window.__ev.push({
      name, speaking: V.speaking, micOpen: window.__micOpen, phase: V.phase,
    });
    const stub = {
      capabilities: () => JSON.stringify({ tts: true, asr: true, http: true, mic: true }),
      listen: () => { rec('listen'); window.__micOpen = true; },
      stopListening: () => { rec('stopListening'); window.__micOpen = false; },
      speak: () => { rec('speak'); },
      stopSpeak: () => { rec('stopSpeak'); },
    };""")

    t = sub(TP, t, """  const st = () => p.evaluate(() => ({
    phase: V.phase, hf: V.hf, speaking: V.speaking, noSpeech: V.noSpeech,
    mic: (document.getElementById('micLabel') || {}).textContent,
    dot: (document.getElementById('phaseDot') || {}).className,
    hint: (document.getElementById('turnHint') || {}).textContent,
    hfBtn: (document.getElementById('hfBtn') || {}).textContent,
    ev: window.__ev.slice(),
  }));""", """  const st = () => p.evaluate(() => ({
    phase: V.phase, hf: V.hf, speaking: V.speaking, noSpeech: V.noSpeech,
    mic: (document.getElementById('micLabel') || {}).textContent,
    dot: (document.getElementById('phaseDot') || {}).className,
    hint: (document.getElementById('turnHint') || {}).textContent,
    hfBtn: (document.getElementById('hfBtn') || {}).textContent,
    ev: window.__ev.map((e) => e.name),
    events: window.__ev.slice(),
  }));

  /* 两个危险各查一次。注意「她说完」是靠 __onSpeak('done') 通知的，
     不是靠 stopSpeak——所以不能拿「speak 到 stopSpeak 之间」当判据。 */
  const hazards = () => p.evaluate(() => {
    const bad1 = window.__ev.filter((e) => e.name === 'listen' && e.speaking)
      .map((e) => `listen@speaking(phase=${e.phase})`);
    const bad2 = window.__ev.filter((e) => e.name === 'speak' && e.micOpen)
      .map((e) => `speak@micOpen(phase=${e.phase})`);
    return { bad1, bad2 };
  });""")

    t = sub(TP, t, """  chk('她说话时**没有**在收音（否则她会把自己录进去）',
    !a.ev.includes('listen'), a.ev.join('>'));""", """  chk('她说话时**没有**在收音（否则她会把自己录进去）',
    !a.ev.includes('listen'), a.ev.join('>'));""")

    t = sub(TP, t, """  // 不变式：出声之后、done 之前，不许有 listen
  const inv = await p.evaluate(() => {
    const ev = window.__ev;
    let bad = null;
    for (let i = 0; i < ev.length; i++) {
      if (ev[i] !== 'speak') continue;
      for (let j = i + 1; j < ev.length; j++) {
        if (ev[j] === 'stopSpeak') break;
        if (ev[j] === 'listen') { bad = ev.join('>'); break; }
      }
      if (bad) break;
    }
    return bad;
  });
  chk('不变式：她出声期间一次都没开麦', !inv, String(inv));""", """  // 两个危险各查一次（走完一整轮之后才查，样本才是真的）
  let hz = await hazards();
  chk('危险一：开麦的那一刻她没在出声', hz.bad1.length === 0, hz.bad1.join(' | '));
  chk('危险二：她出声的那一刻麦克风是关着的', hz.bad2.length === 0, hz.bad2.join(' | '));""")

    t = sub(TP, t, """  chk('打断之后还能继续说话', a.mic === '说完了，发出', String(a.mic));""",
            """  chk('打断之后还能继续说话', a.mic === '说完了，发出', String(a.mic));
  hz = await hazards();
  chk('走过打断这条路之后，两个危险仍然都没有发生',
    hz.bad1.length === 0 && hz.bad2.length === 0,
    [...hz.bad1, ...hz.bad2].join(' | '));""")

    # ==================== 4) 复盘那一组：补一个「漏着」的回合 ====================
    t = sub(TP, t, """    await startSession(args.good);
    await userSaid('你担心的是哪一块？我想先听这个。');
  }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
  await p.evaluate(() => endSession());""", """    await startSession(args.good);
    await userSaid('你担心的是哪一块？我想先听这个。');
    // 补一个「漏着」的回合：这样「最该回头看的一句」那张卡才会渲染，
    // 才能验证加了复盘卡之后别的卡没被挤掉（我第一版的数据里全是「好」，白测了这一条）
    V.sess.log[0].rating = '漏着';
    V.sess.log[0].rating_why = '只顾着解释方案，没接住他的担心';
  }, { good: GOOD, turn: TURN, debrief: DEBRIEF });
  await p.evaluate(() => endSession());""")

    # ==================== 5) DEBRIEF 没传进页面 ====================
    t = sub(TP, t, """  const psys = await p.evaluate(async () => {
    let cap = null;
    const saved = window.llmCall;
    window.llmCall = async (m) => { cap = m; return DEBRIEF; };
    await makeDebrief(V.sess);
    window.llmCall = saved;
    return { sys: cap[0].content, user: cap[1].content };
  });""", """  const psys = await p.evaluate(async (DEBRIEF) => {
    let cap = null;
    const saved = window.llmCall;
    window.llmCall = async (m) => { cap = m; return DEBRIEF; };
    await makeDebrief(V.sess);
    window.llmCall = saved;
    return { sys: cap[0].content, user: cap[1].content };
  }, DEBRIEF);""")

    io.open(TP, 'w', encoding='utf-8').write(t)
    print('已修：免提文案单一来源、权限错误落设置、不变式改直测、复盘测试补漏着回合')


if __name__ == '__main__':
    main()
