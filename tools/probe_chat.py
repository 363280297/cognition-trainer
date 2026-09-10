# -*- coding: utf-8 -*-
"""实测「AI 对话能不能像豆包那样来回聊」。

用户的验收标准是「像豆包一样交流」。这句里最关键的不是能不能通，而是**快不快**：
豆包的体感是说完一秒内就有回应，而如果每轮要等五秒，无论内容多好都不像对话。

所以这个脚本量三件事，全部用真实请求：
  1. 这一局的每一轮要等多久（分模型量）
  2. 多轮下来历史会不会把请求撑大（每轮都要重发全部历史）
  3. 一轮的返回是不是稳定的 JSON（对话引擎要求字段齐全）

密钥只从 .env 读，不写进任何文件、也不打印。
"""
import io
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


BASE = 'https://api.deepseek.com'
KEY = load_key()

# 和 App 里 llmSystem 同形状的一段系统提示（截取，够用即可）
SYS = """你在做一个「情景对话陪练」：你扮演下面这个角色，用户在练习和他/她对话。
【你的角色（性别、年龄、身份都在这里面，照它演）】
26 岁，做设计的，性格偏慢热。你们是朋友介绍认识的，微信聊了两周，今天是第一次单独见面。
【你们的关系阶段】认识试探
【怎么说话——很重要】
· 口语，短句。一次说 1-2 句，最多 40 字。真人说话不会一口气讲一大段。
· 不要每次都顺着用户。用户说得不好时，你会更冷、更短、更敷衍。
【每一轮你返回一个 JSON 对象】
{"reply":"你说出口的话（口语，1-2 句）","tone":"冷淡|不耐|平淡|温和|热情|委屈|紧张 里选一个",
 "inner":"你的内心独白，40 字以内","signal":"用户上一句实际发出的信号，25 字以内",
 "rating":"妙|好|平|失误|漏着","rating_why":"为什么给这个分，35 字以内",
 "temp":0-100 的整数,"temp_delta":这一轮的增减}
只输出 JSON。"""

USER_TURNS = [
    '（对话开始，你刚说完第一句话）',
    '你到了有一会儿了吧？我刚在楼下找停车位找了半天。',
    '我看你朋友圈发过几张照片，是在那个新开的展拍的吗？',
    '对了，你刚才说堵车，是走的东边那条路吗？',
]


def call(model, messages, max_tokens=3000, temperature=0.9):
    body = json.dumps({
        'model': model, 'messages': messages,
        'response_format': {'type': 'json_object'},
        'max_tokens': max_tokens, 'temperature': temperature,
    }).encode('utf-8')
    req = urllib.request.Request(
        BASE + '/chat/completions', data=body,
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + (KEY or '')})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read().decode('utf-8', 'replace')
        dt = time.time() - t0
        j = json.loads(raw)
        ch = (j.get('choices') or [{}])[0]
        msg = ch.get('message') or {}
        return {
            'ok': True, 'sec': dt, 'content': msg.get('content') or '',
            'finish': ch.get('finish_reason'),
            'usage': j.get('usage') or {},
            'reasoning_chars': len(msg.get('reasoning_content') or ''),
        }
    except urllib.error.HTTPError as e:
        return {'ok': False, 'sec': time.time() - t0, 'status': e.code,
                'body': e.read().decode('utf-8', 'replace')[:300]}
    except Exception as e:
        return {'ok': False, 'sec': time.time() - t0, 'err': str(e)[:200]}


def main():
    print('=' * 62)
    print('AI 对话实测：能不能像豆包那样来回聊')
    print('=' * 62)
    if not KEY:
        print('!! 没有读到密钥，无法实测。')
        return 1
    print(f'端点 {BASE}   密钥已读到（{len(KEY)} 字符，不打印）\n')

    # ---------- 0) 先看有哪些模型可用 ----------
    print('[0] 可用模型')
    try:
        req = urllib.request.Request(BASE + '/models',
                                     headers={'Authorization': 'Bearer ' + KEY})
        with urllib.request.urlopen(req, timeout=60) as r:
            j = json.loads(r.read().decode('utf-8', 'replace'))
        ids = [m.get('id') for m in (j.get('data') or [])]
        print('    ' + ', '.join(ids))
    except Exception as e:
        ids = []
        print(f'    列不出来（{str(e)[:80]}）——有些服务不开放这个接口，不影响下面的测试')

    # ---------- 1) 单轮延迟 ----------
    targets = ['deepseek-v4-pro', 'deepseek-chat']
    if 'deepseek-reasoner' in ids:
        targets.append('deepseek-reasoner')
    results = {}
    print('\n[1] 单轮延迟（问一句话，等它回一句 JSON）')
    for m in targets:
        msgs = [{'role': 'system', 'content': SYS},
                {'role': 'user', 'content': '（对话开始，你刚说完第一句话）'}]
        r = call(m, msgs)
        if not r['ok']:
            print(f'    {m:20s} 失败 {r.get("status") or ""} {(r.get("body") or r.get("err") or "")[:90]}')
            continue
        results[m] = r
        print(f'    {m:20s} {r["sec"]:6.2f}s   finish={r["finish"]}   '
              f'推理{ r["reasoning_chars"]}字  出{len(r["content"])}字  用量{r["usage"].get("completion_tokens")}')
    if not results:
        print('\n!! 所有模型都调不通，无法评估对话体感。')
        return 1

    # ---------- 2) 多轮：延迟会不会累积、历史会不会撑大 ----------
    print('\n[2] 连着聊 4 轮（模拟一局真实对话）')
    best = min(results, key=lambda k: results[k]['sec'])
    print(f'    用最快的「{best}」跑')
    msgs = [{'role': 'system', 'content': SYS}]
    tot = 0.0
    for i, u in enumerate(USER_TURNS):
        msgs.append({'role': 'user', 'content': u})
        r = call(best, msgs)
        if not r['ok']:
            print(f'    第 {i + 1} 轮失败：{r.get("status")} {(r.get("body") or "")[:120]}')
            break
        tot += r['sec']
        try:
            o = json.loads(r['content'])
        except Exception:
            o = None
        need = ['reply', 'tone', 'inner', 'signal', 'rating', 'rating_why']
        missing = [k for k in need if not o or not o.get(k)] if o else ['整段不是 JSON']
        print(f'    第 {i + 1} 轮 {r["sec"]:5.2f}s  她说「{(o or {}).get("reply", "?")}」'
              f'  语气{(o or {}).get("tone", "?")}  {缺少 if False else ""}')
        if missing:
            print(f'         !! 缺字段：{missing}')
        msgs.append({'role': 'assistant', 'content': r['content']})
    print(f'    四轮累计 {tot:.1f}s，平均 {tot / max(len(USER_TURNS), 1):.2f}s/轮')
    print(f'    最后一轮请求大小：{len(json.dumps(msgs, ensure_ascii=False))} 字符'
          f'（每轮都要重发全部历史）')

    return 0


if __name__ == '__main__':
    sys.exit(main())
