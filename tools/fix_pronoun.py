# -*- coding: utf-8 -*-
"""把「她」从界面里去掉，改成跟着场景走。

起因是一个测试失败：我改 makeDebrief 时把「他心里的想法」写成了「她心里的想法」。
顺着查下去，发现这是**同一类问题的第三处**：

  1. llmSystem 里写死「你扮演一位中国女性」——已经改成由 her 决定
  2. buildScenario 造的随机场景可能是男同事、男上级——已经要求写清是谁
  3. 但界面上一整排字还是写死的她：「她的温度」「她的内心」「她的语气」
     「她在想怎么回你」「打断她」……

于是随机到男上级那一局，屏幕上会出现「她的内心」底下写着男上级的内心。
这不是吹毛求疵：用户特意要了**随机**场景，随机到男性角色是必然会发生的，
而一处对不上的界面会让人觉得整个功能是拼凑的、没做完。

做法：场景对象加一个 `ta`（他/她），由生成场景时一起产出；6 个老场景不带这个字段，
默认「她」（它们都是女性，行为完全不变）。界面文案统一走 `ta()`。

为什么不用「TA」或者干脆去掉人称：中文里没有中性的第三人称，
「TA」在正经界面里很怪，去掉人称会让「她的温度」变成「温度」，
而温度计本身就是理解成本——它需要一个明确的所属者。所以按场景给代词最自然。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
SCT = os.path.join(ROOT, 'tools', 'check_scene_talk.js')
VT = os.path.join(ROOT, 'tools', 'check_voice_talk.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    # ---------- ta() 的唯一定义 ----------
    v = sub(v, """function slug(s) { return String(s || '').replace(/[^\\u4e00-\\u9fa5a-z]/gi, '') || 'mid'; }""",
            """function slug(s) { return String(s || '').replace(/[^\\u4e00-\\u9fa5a-z]/gi, '') || 'mid'; }

/* 对方的人称。中文没有中性的第三人称，所以由场景自己带一个 `ta`。
   6 个老场景都是女性、不带这个字段，默认「她」，行为完全不变；
   随机造的场景可能是个男同事或男上级，那时界面上如果是「她的内心」就对不上了。
   界面文案只从这里取人称——**一处定义**，避免又出现「有的地方改了她有的没改」。 */
function ta() { return (V.sess && V.sess.sc && V.sess.sc.ta) || '她'; }""", tag='ta()')

    # ---------- 会话界面 ----------
    v = sub(v, """          <span>她的温度</span>""", """          <span>${ta()}的温度</span>""", tag='temp')
    v = sub(v, """      <div class="her-tone">她的语气：${esc(o.tone || '—')}</div>""",
            """      <div class="her-tone">${ta()}的语气：${esc(o.tone || '—')}</div>""", tag='tone')
    v = sub(v, """        <div class="mono-h">她的内心</div>""",
            """        <div class="mono-h">${ta()}的内心</div>""", tag='inner')
    v = sub(v, """  if (V.phase === 'thinking') return '她在想怎么回你…';
  if (V.phase === 'speaking') return '她在说';
  if (V.phase === 'listening') return '在听你说';""",
            """  if (V.phase === 'thinking') return ta() + '在想怎么回你…';
  if (V.phase === 'speaking') return ta() + '在说';
  if (V.phase === 'listening') return '在听你说';""", tag='phaseLabel')
    v = sub(v, """  if (V.phase === 'thinking') return '她在想…';
  if (V.phase === 'speaking') return '打断她';""",
            """  if (V.phase === 'thinking') return ta() + '在想…';
  if (V.phase === 'speaking') return '打断' + ta();""", tag='micLabel')
    v = sub(v, """  if (h) h.textContent = on ? '她在想怎么回你…' : '';""",
            """  if (h) h.textContent = on ? (ta() + '在想怎么回你…') : '';""", tag='thinking')
    v = sub(v, """        <div class="mk" style="font-size:.72rem;color:#b98ce8;font-weight:600">${esc(sc.title)}</div>""",
            """        <div class="mk" style="font-size:.72rem;color:#b98ce8;font-weight:600">${esc(sc.title)}</div>""")
    v = sub(v, """      <div class="mono"><div class="mono-h">她那句的内心</div><div>${esc(worst.inner || '')}</div></div>""",
            """      <div class="mono"><div class="mono-h">${ta()}那句的内心</div><div>${esc(worst.inner || '')}</div></div>""",
            tag='worst')
    v = sub(v, """        <div><b>${s.temp}</b><span>她的温度</span></div>""",
            """        <div><b>${s.temp}</b><span>对方的温度</span></div>""", tag='scoreTemp')

    # ---------- 复盘的数据（交给模型的那份也要一致）----------
    v = sub(v, """    `她开口：「${sc0.opening || ''}」`,""", """    `${ta()}开口：「${sc0.opening || ''}」`,""", tag='opening')
    v = sub(v, """      `她回：「${o.reply || ''}」`,
      `她心里的想法：${o.inner || '（没给）'}`,""",
            """      `${ta()}回：「${o.reply || ''}」`,
      `${ta()}心里的想法：${o.inner || '（没给）'}`,""", tag='transcript')

    # ---------- 生成场景时一起产出 ta ----------
    v = sub(v, """7. her 里必须写清对方是谁、**是男是女**（年龄/身份/性格/你们的关系）。
   扮演者会照 her 来演，写不清就会演错人。""",
            """7. her 里必须写清对方是谁、**是男是女**（年龄/身份/性格/你们的关系）。
   扮演者会照 her 来演，写不清就会演错人。
8. ta 是对方的第三人称代词，只填「他」或「她」，要和 her 一致（界面文案用它）。""",
            tag='prompt8')
    v = sub(v, """{"title":"场景标题，12字以内","stage":"关系阶段，4-6字","difficulty":2,""",
            """{"title":"场景标题，12字以内","stage":"关系阶段，4-6字","difficulty":2,"ta":"他或她",""",
            tag='schema')
    v = sub(v, """    her: String(out.her || ''),""",
            """    ta: out.ta === '他' ? '他' : '她',
    her: String(out.her || ''),""", tag='taField')

    io.open(VP, 'w', encoding='utf-8').write(v)

    # ---------- 测试：跟着新的页面结构走 ----------
    t = io.open(SCT, encoding='utf-8').read()
    # 设置页多了一组「现成的场景」。示例提示词现在要排除掉它们，
    # 否则点第 3 个会把 preset 点开、页面切走，后面所有断言都在 null 上崩。
    t = sub(t, """    const seeds = [...document.querySelectorAll('.seed')];""",
            """    const seeds = [...document.querySelectorAll('.seed:not(.preset)')];""", tag='sct-seeds')
    t = sub(t, """    document.querySelectorAll('.seed')[2].click();""",
            """    document.querySelectorAll('.seed:not(.preset)')[2].click();""", tag='sct-click')
    t = sub(t, """      seedTexts: seeds.map((x) => x.textContent.trim()),""",
            """      seedTexts: seeds.map((x) => x.textContent.trim()),
      // 现成场景是另一组按钮：它们点了应该直接开局，不是填提示词
      presetCount: document.querySelectorAll('.seed.preset').length,""", tag='sct-presetcount')
    t = sub(t, """  chk('示例提示词不是空的', ui.seedCount >= 5, `${ui.seedCount} 条`);""",
            """  chk('示例提示词不是空的', ui.seedCount >= 5, `${ui.seedCount} 条`);
  chk('现成场景是单独一组（不是混在示例里）', ui.presetCount >= 6, `${ui.presetCount} 个`);""",
            tag='sct-presetassert')
    io.open(SCT, 'w', encoding='utf-8').write(t)

    w = io.open(VT, encoding='utf-8').read()
    w = sub(w, """  chk('复盘真的把用户的原话和她的内心一起送进去了',
    psys.user.includes('你担心的是哪一块') && psys.user.includes('他心里的想法'),
    '');""", """  chk('复盘真的把用户的原话和对方的内心一起送进去了',
    psys.user.includes('你担心的是哪一块') && /心里的想法/.test(psys.user),
    '');""", tag='vt-inner')
    # 人称：场景带 ta 时界面要跟着变
    w = sub(w, """  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));""",
            """  // 人称：随机到男性角色时界面不能还写「她」
  console.log('\\n[人称：跟着场景走]');
  const pron = await p.evaluate(async (args) => {
    V.sess = null; V.ended = false;
    window.llmCall = async () => args.turn;
    await startSession(Object.assign({}, args.good, { ta: '他' }));
    const t = document.getElementById('view').textContent;
    const before = {
      temp: /他的温度/.test(t), inner: /他的内心/.test(t), tone: /他的语气/.test(t),
      noShe: !/她的温度|她的内心|她的语气/.test(t),
    };
    V.sess = null;
    await startSession(args.good);            // 老场景没有 ta → 默认「她」
    const t2 = document.getElementById('view').textContent;
    return { before, fallback: /她的温度/.test(t2) && /她的内心/.test(t2) };
  }, { good: GOOD, turn: TURN });
  chk('男性角色时界面用「他」', pron.before.temp && pron.before.inner && pron.before.tone,
    JSON.stringify(pron.before));
  chk('男性角色时界面上没有残留的「她」', pron.before.noShe);
  chk('老场景（没有 ta 字段）仍然默认「她」', pron.fallback);

  chk('全程没有 JS 报错', errs.length === 0, errs.slice(0, 3).join(' | '));""",
            tag='vt-pron')
    io.open(VT, 'w', encoding='utf-8').write(w)
    print('人称改成跟着场景走；两个测试跟着新结构更新')


if __name__ == '__main__':
    main()
