# -*- coding: utf-8 -*-
"""在快模型上验另外两个提示词的契约：建场景 和 复盘。

对话那一轮实测 deepseek-chat 1.59s/轮、JSON 稳定。但 App 里还有两次调用：
  · buildScenario —— 要一个 8 字段的场景对象（字段更多、更长）
  · makeDebrief   —— 要一个嵌套对象（fixes 是数组套对象）
这两个的形状比对话轮复杂得多，换模型必须先确认它们也能稳定吐合格 JSON，
否则「换快模型」会把另外两个功能换坏。

顺便量一下它们的耗时——建场景和复盘各算一次调用，也不能太慢。
"""
import io
import json
import os
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://api.deepseek.com'


def load_key():
    key = os.environ.get('DEEPSEEK_API_KEY')
    if key:
        return key
    for p in (os.path.join(ROOT, '.env'), os.path.join(os.path.dirname(ROOT), '.env')):
        if os.path.exists(p):
            for ln in io.open(p, encoding='utf-8'):
                if ln.startswith('DEEPSEEK_API_KEY='):
                    return ln.split('=', 1)[1].strip()
    return None


KEY = load_key()

SCENE_SYS = """你在给一个情商训练 App 建造「对话练习场景」。
用户会给你一句他想练的东西，你要把它变成一个具体的、可以马上开口的对话场景。
严格要求：
1. 场景必须**具体**：有确切的关系、场合、以及此刻正在发生的事。
2. 对方必须有**自己的立场和一个没说出口的期待**。
3. opening 是对方说的**第一句话**，口语、可直接说出口，不超过 40 字。
4. difficulty 是 1–3 的整数。
5. 全部用中文口语。
6. 不要写成教程，只描述场景本身。
7. her 里必须写清对方是谁、**是男是女**。
8. ta 是对方的第三人称代词，只填「他」或「她」，要和 her 一致。
只输出 JSON，字段固定为：
{"title":"场景标题，12字以内","stage":"关系阶段，4-6字","difficulty":2,"ta":"他或她",
 "her":"对方是谁","her_state":"对方此刻真实的感受","opening":"对方开口说的第一句话",
 "goal":"用户这一局的目标，一句","trap":"这一局最常见的错法，一句"}"""

DEBRIEF_SYS = """你在给一次「对话练习」做复盘。用户是成年男性，在练怎么把话说对。
他要的是**能用的东西**，不是鼓励。
硬性要求：
1. **必须基于记录里他真正说过的话**，并引用原话（加引号）。
2. **不要恭维。**
3. 每条改进必须是**一个具体动作**，并给出「下一次可以这么说」的原话示例。
4. 不要编造记录里没有的内容。
5. 中文口语。不要鸡汤腔。
只输出 JSON：
{"verdict":"整体评价，2-3 句","pattern":"反复出现的一个模式，一句话",
 "keeps":["下一局要保持的，0-3 条，每条 30 字以内"],
 "fixes":[{"act":"要改的动作，20 字以内","say":"下一次可以这么说","why":"为什么，40 字以内"}],
 "one":"下一局只盯这一件事，一句话"}"""

DEBRIEF_USER = """场景：周会上被同事当面否了方案
对方是谁：同组男同事，比你早来一年，能力强但话直
对方嘴上没说的：他不是针对你，是想让项目别翻车
他这一局的目标：把分歧留在事上，同时让他知道当众这样说你不舒服
这个场景最常见的错法：当场反驳他，把技术分歧变成谁对谁错

对话记录：
第 0 轮（开局，还没轮到他说）
他开口：「这个方案我觉得有问题，你改完再说吧。」

第 1 轮
他说：「你担心的是哪一块？我想先听这个。」
他回：「性能。上次那版上线崩了两次。」
他心里的想法：他倒是没急着辩解，我先听听。
给他的分：好——没有当场顶回去

最后对方的温度：54（起点 50，越低越疏远）
他这一局提了 1 个问题，其中 1 个是追问。"""


def call(model, sys, user, max_tokens=3000, temperature=0.8):
    body = json.dumps({'model': model,
                       'messages': [{'role': 'system', 'content': sys},
                                    {'role': 'user', 'content': user}],
                       'response_format': {'type': 'json_object'},
                       'max_tokens': max_tokens, 'temperature': temperature}).encode('utf-8')
    req = urllib.request.Request(BASE + '/chat/completions', data=body,
                                 headers={'Content-Type': 'application/json',
                                          'Authorization': 'Bearer ' + (KEY or '')})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            raw = r.read().decode('utf-8', 'replace')
        dt = time.time() - t0
        j = json.loads(raw)
        ch = (j.get('choices') or [{}])[0]
        c = ((ch.get('message') or {}).get('content') or '')
        o = None
        try:
            o = json.loads(c)
        except Exception:
            pass
        return {'ok': True, 'sec': dt, 'o': o, 'raw': c, 'finish': ch.get('finish_reason')}
    except urllib.error.HTTPError as e:
        return {'ok': False, 'sec': time.time() - t0, 'status': e.code,
                'body': e.read().decode('utf-8', 'replace')[:200]}
    except Exception as e:
        return {'ok': False, 'err': str(e)[:160], 'sec': time.time() - t0}


def main():
    print('=' * 66)
    print('快模型能不能扛住另外两个提示词的形状')
    print('=' * 66)
    if not KEY:
        print('没有密钥')
        return 1
    for model in ['deepseek-chat']:
        # ---- 建场景 ----
        r = call(model, SCENE_SYS, '我想练：同事在群里当着大家的面否了我的方案，我想练一句不软不硬的回应')
        need = ['title', 'stage', 'difficulty', 'ta', 'her', 'her_state', 'opening', 'goal', 'trap']
        if not r['ok']:
            print(f'  [{model}] 建场景 失败 {r.get("status")} {(r.get("body") or r.get("err") or "")[:140]}')
        else:
            o = r['o'] or {}
            miss = [k for k in need if o.get(k) in (None, '')]
            print(f'  [{model}] 建场景 {r["sec"]:5.2f}s  finish={r["finish"]}  '
                  f'{"字段齐全" if not miss else "缺：" + str(miss)}')
            if not miss:
                print(f'      「{o.get("title")}」 ta={o.get("ta")} 难度={o.get("difficulty")}')
                print(f'      her：{str(o.get("her"))[:56]}')
                print(f'      opening：「{o.get("opening")}」')
            else:
                print(f'      原始返回：{r["raw"][:200]}')

        # ---- 复盘 ----
        r2 = call(model, DEBRIEF_SYS, DEBRIEF_USER, temperature=0.7)
        if not r2['ok']:
            print(f'  [{model}] 复盘 失败 {r2.get("status")} {(r2.get("body") or r2.get("err") or "")[:140]}')
        else:
            o = r2['o'] or {}
            miss = [k for k in ['verdict', 'pattern', 'keeps', 'fixes', 'one'] if not o.get(k)]
            fix_ok = isinstance(o.get('fixes'), list) and o['fixes'] and all(
                isinstance(x, dict) and x.get('act') and x.get('say') for x in o['fixes'])
            print(f'  [{model}] 复盘   {r2["sec"]:5.2f}s  finish={r2["finish"]}  '
                  f'{"字段齐全" if not miss else "缺：" + str(miss)}  fixes 形状={"对" if fix_ok else "错"}')
            if not miss:
                print(f'      verdict：{str(o.get("verdict"))[:80]}')
                print(f'      one：{o.get("one")}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
