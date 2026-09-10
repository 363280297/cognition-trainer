# -*- coding: utf-8 -*-
"""补三处：漏掉的记账、提示文案的漏洞、两个测试写错的地方。

1. **漏掉了「练完一局记一笔」。**
   上一个脚本在改 app.js 时锚点没对上就退出了，而那段记账代码排在它后面——
   于是**根本没被写进去**。测试直接抓到了（state.scenes 是空的）。
   这就是「每处替换都断命中次数」的价值：它让脚本立刻停下，
   但如果我不看输出、或者测试没覆盖到，就会留下一个半成品。
   这次的教训是：**脚本中途失败时，要确认它到底写进去了哪几处。**
   所以我在这里加了一段自检，把「应该存在的改动」逐个断言一遍。

2. **慢的时候给的提示可能是废话。**
   原来不管当前是什么模型，都说「换成 deepseek-chat 一轮 1.6 秒」——
   可如果用户**已经在用** deepseek-chat 了（比如是他自己手填的名字），
   这句话就毫无意义，还会让人以为哪里坏了。改成：已经在用快的那个时，
   提示改说「可能不是模型的问题」，并指向网络/密钥/地址。

3. 两个测试写错：
   · 量耗时的路径在 `userSaid` 上，而我只调了 startSession（开局那一轮是
     本地拼的、不发请求，所以耗时本来就是 0）。这不是 bug，是测错了地方。
   · 「正常速度不瞎提示」那条比较的是同一段文本，等于永远通过。要先清空再比。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
TP = os.path.join(ROOT, 'tools', 'check_doubao.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    # ---------- 1) 补上漏掉的记账 ----------
    v = sub(v, """  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;""",
            """  /* 练完一局给这个情景记一笔。用途只有「今天就练这个」的轮换——
     没有它，那个推荐会一直推同一个，用户点两次就再也不看推荐了。
     只记现成情景：现造的场景每次 id 都不同，记下来就是一堆只出现一次的垃圾数据。
     V.ended 同时也是幂等开关：结束页会被反复渲染，但 endSession 只该记账一次。 */
  if (!V.ended && s.sc && !/^gen-/.test(s.sc.id)) {
    state.scenes = state.scenes || {};
    state.scenes[s.sc.id] = (state.scenes[s.sc.id] || 0) + 1;
    save();
  }
  // 结束之后绝不能再自动开麦——V.ended 是这条规则的唯一开关
  V.ended = true;""", tag='record')

    # ---------- 2) 提示文案：已经在用快模型时别说废话 ----------
    v = sub(v, """  const cur = settings().model;
  const box = document.getElementById('turnHint');
  const secs = (ms / 1000).toFixed(1);
  const msg = `刚才这一轮等了 ${secs} 秒。当前模型 ${cur} 大概是带推理的——`
    + `换成 ${MODEL_FAST} 一轮大约 1.6 秒，对话会顺得多。`;
  if (box) box.textContent = msg;
  toast(msg);""",
            """  const cur = settings().model;
  const box = document.getElementById('turnHint');
  const secs = (ms / 1000).toFixed(1);
  /* 已经在用快的那个时，不能还劝人家换它自己——那是句废话，还会让人以为坏了。
     这种情况把方向指向网络/密钥/地址，那才是真正剩下的可能。 */
  const msg = cur === MODEL_FAST
    ? `刚才这一轮等了 ${secs} 秒。模型本身是够快的，所以多半是网络或服务端慢，`
      + `也可能是接口地址被绕到了别处（设置页能看）。`
    : `刚才这一轮等了 ${secs} 秒。当前模型 ${cur} 大概是带推理的——`
      + `换成 ${MODEL_FAST} 一轮大约 1.6 秒，对话会顺得多。`;
  if (box) box.textContent = msg;
  toast(msg);""", tag='latencyMsg')

    io.open(VP, 'w', encoding='utf-8').write(v)

    # ---------- 3) 两个测试写错的地方 ----------
    t = io.open(TP, encoding='utf-8').read()

    t = sub(t, """      await startSession((CONTENT.scenarios.scenarios || [])[0]);
      return V.lastTurnMs;
    });
    chk('真的在量每一轮的耗时', timed >= 50, `${timed}ms`);""",
            """      await startSession((CONTENT.scenarios.scenarios || [])[0]);
      // 开局那一轮是本地拼的、不发请求，量它是 0 才对；
      // 真正要量的是「用户说了一句之后」那一轮。
      const opening = V.lastTurnMs;
      await userSaid('你到了有一会儿了吧？');
      return { opening, turn: V.lastTurnMs };
    });
    chk('开局那一轮不调模型，所以不记耗时', timed.opening === 0, `${timed.opening}ms`);
    chk('用户说话后的那一轮真的在量耗时', timed.turn >= 50, `${timed.turn}ms`);""",
            tag='timed')

    t = sub(t, """    const fast = await p.evaluate(() => {
      V.lastTurnMs = 1500; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      const before = el ? el.textContent : '';
      noteTurnLatency();
      return { before, after: el ? el.textContent : '' };
    });
    chk('正常速度（1.5 秒）不会瞎提示', fast.before === fast.after, `${fast.before} → ${fast.after}`);""",
            """    const fast = await p.evaluate(() => {
      V.lastTurnMs = 1500; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      if (el) el.textContent = '（清空过）';
      noteTurnLatency();
      return { after: el ? el.textContent : '', warned: V.latencyWarned };
    });
    // 先清空再比，否则「前后一样」是句废话（原来就是这么写的，等于永不失败）
    chk('正常速度（1.5 秒）不会瞎提示',
      fast.after === '（清空过）' && !fast.warned, `${fast.after} / warned=${fast.warned}`);

    // 已经在用快模型时，不能再劝他换它自己
    const selfAdvice = await p.evaluate(() => {
      V.lastTurnMs = 12000; V.latencyWarned = false;
      const el = document.getElementById('turnHint');
      if (el) el.textContent = '';
      saveSettings({ model: MODEL_FAST });
      noteTurnLatency();
      return { hint: el ? el.textContent : '', model: settings().model };
    });
    chk('已经在用最快模型时，提示不说「换成它自己」这种废话',
      !/换成 deepseek-chat/.test(selfAdvice.hint)
        && /网络|地址|服务端/.test(selfAdvice.hint),
      selfAdvice.hint.slice(0, 60));""",
            tag='fast')

    io.open(TP, 'w', encoding='utf-8').write(t)

    # ---------- 自检：确认该在的都在 ----------
    v2 = io.open(VP, encoding='utf-8').read()
    missing = [k for k in ['MODEL_FAST', 'migrateOldModel()', 'modelSwitchedNotice', 'chooseModel',
                           'noteTurnLatency', 'dailySceneCard', 'nextDailyScene',
                           'state.scenes[s.sc.id] = (state.scenes[s.sc.id] || 0) + 1',
                           'const opening = ' if False else 'V.lastTurnMs = Date.now() - t0;']
               if k not in v2]
    assert not missing, f'voice.js 还缺：{missing}'
    print('三处都补上了；并逐个核对了应该存在的改动')


if __name__ == '__main__':
    main()
