# -*- coding: utf-8 -*-
"""补上没应用成功的那两处（state 初始化和 CSS）。

上一步 voice.js 那一半已经写进去了（锚点都对上），app.js 的那个锚点我写成了
`state = Object.assign({`，而真实的写法是 `DEFAULT_STATE` 风格的对象字面量
（`srs: {}`、`cal: {}` 一节一节的注释）。锚点没对上就整个脚本退出了——
**这就是为什么每一处替换都要断命中次数**：写错锚点会立刻停下，
而不是安静地少改一处。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = os.path.join(ROOT, 'public', 'app.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    a = io.open(AP, encoding='utf-8').read()
    a = sub(a, """  stats: { answered: 0, correct: 0, wrongIds: [] },
  fog: [],            // 脑雾记录：[{ ts, trigger, mode, feeling }]""",
            """  stats: { answered: 0, correct: 0, wrongIds: [] },
  // 每个现成情景练过几次。只用来做「今天就练这个」的轮换——
  // 少了它，那个推荐会一直推同一个，用户点两次就再也不想看推荐了。
  scenes: {},
  fog: [],            // 脑雾记录：[{ ts, trigger, mode, feeling }]""", tag='scenes')
    io.open(AP, 'w', encoding='utf-8').write(a)

    c = io.open(os.path.join(ROOT, 'public', 'style.css'), encoding='utf-8').read()
    if '.daily-scene' not in c:
        c += """
/* ---------- 今天就练这个 ---------- */
.daily-scene { border: 1px solid #3a4a6a; background: linear-gradient(180deg, #1d2331, #1b1d27); }
.daily-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.daily-meta .tag {
  font-size: .72rem; color: var(--dim);
  background: var(--panel2); border: 1px solid var(--line);
  border-radius: 999px; padding: 3px 9px;
}
.daily-meta .tag-good { color: #8fd8a8; border-color: #2f5340; background: #1d3226; }
"""
    io.open(os.path.join(ROOT, 'public', 'style.css'), 'w', encoding='utf-8').write(c)

    # 确认 voice.js 那一半确实都在
    v = io.open(os.path.join(ROOT, 'public', 'voice.js'), encoding='utf-8').read()
    for k in ['MODEL_FAST', 'migrateOldModel()', 'modelSwitchedNotice', 'chooseModel',
              'noteTurnLatency', 'dailySceneCard', 'nextDailyScene', 'state.scenes']:
        assert k in v, f'voice.js 缺 {k}'
    print('state.scenes + CSS 补上了；voice.js 的九处改动都在')


if __name__ == '__main__':
    main()
