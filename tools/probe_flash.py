# -*- coding: utf-8 -*-
"""补测 deepseek-flash，并把「一轮到底多慢」测准。

已经测出来的关键事实：
  deepseek-v4-pro   30.65s/轮   推理 5006 字   ← 这就是「不像豆包」的全部原因
  deepseek-chat      1.34s/轮   无推理
（注意 /models 只列了 deepseek-flash 和 deepseek-v4-pro，但 deepseek-chat 实测可用。）

flah 是官方列出来的快模型，所以要单独量一下，再决定默认用哪个。
每个模型跑两轮取平均，减少单个请求抖动的影响。
"""
import io
import json
import os
import statistics
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
SYS = ('你在演一个 26 岁的女生，第一次和用户单独见面，性格慢热。口语，短句，最多 40 字。'
       '只输出 JSON：{"reply":"你说的话","tone":"冷淡|不耐|平淡|温和|热情|委屈|紧张",'
       '"inner":"内心独白，40 字内","signal":"用户上句的信号，25 字内","rating":"妙|好|平|失误|漏着",'
       '"rating_why":"为什么，35 字内","temp":50,"temp_delta":0}')
LINES = ['（对话开始，你刚说完第一句话）', '你到了有一会儿了吧？我刚找停车位找了半天。']


def call(model, messages, max_tokens=3000):
    body = json.dumps({'model': model, 'messages': messages,
                       'response_format': {'type': 'json_object'},
                       'max_tokens': max_tokens, 'temperature': 0.9}).encode('utf-8')
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
        msg = ch.get('message') or {}
        c = msg.get('content') or ''
        ok_json = False
        o = None
        try:
            o = json.loads(c)
            ok_json = isinstance(o, dict)
        except Exception:
            pass
        need = ['reply', 'tone', 'inner', 'signal', 'rating', 'rating_why']
        return {'ok': True, 'sec': dt, 'json': ok_json, 'o': o,
                'missing': [k for k in need if not (o or {}).get(k)] if ok_json else ['不是 JSON'],
                'reasoning': len(msg.get('reasoning_content') or ''),
                'usage': (j.get('usage') or {}).get('completion_tokens'),
                'finish': ch.get('finish_reason')}
    except urllib.error.HTTPError as e:
        return {'ok': False, 'sec': time.time() - t0, 'status': e.code,
                'body': e.read().decode('utf-8', 'replace')[:200]}
    except Exception as e:
        return {'ok': False, 'err': str(e)[:160], 'sec': time.time() - t0}


def main():
    print('=' * 66)
    print('快模型对比：一轮要等多久（这决定了像不像对话）')
    print('=' * 66)
    if not KEY:
        print('没有密钥')
        return 1
    for m in ['deepseek-flash', 'deepseek-chat']:
        msgs = [{'role': 'system', 'content': SYS}]
        secs, bad = [], []
        for ln in LINES:
            msgs.append({'role': 'user', 'content': ln})
            r = call(m, msgs)
            if not r['ok']:
                print(f'  {m:18s} 失败 {r.get("status")} {(r.get("body") or r.get("err") or "")[:110]}')
                break
            secs.append(r['sec'])
            if not r['json'] or r['missing']:
                bad.append(r['missing'])
            msgs.append({'role': 'assistant', 'content': json.dumps(r['o'], ensure_ascii=False)})
        if secs:
            print(f'  {m:18s} {statistics.mean(secs):5.2f}s/轮（{", ".join(f"{x:.2f}" for x in secs)}）'
                  f'  JSON 合格={"全部合格" if not bad else bad}  出{ r["reasoning"]}字推理')
            if r.get('o'):
                print(f'      她第一句：「{r["o"].get("reply")}」 语气 {r["o"].get("tone")}')
    print('\n结论：优先用实测最快、且 JSON 稳定的那个当默认。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
