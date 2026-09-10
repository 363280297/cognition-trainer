"""先问端点：它到底认哪几个模型名。

这一步是为了把「模型名对不对」和「请求形状对不对」分开——
原来一上来就猜是额度问题，方向可能一开始就错了。
密钥只从环境变量或 .env 读，不打印、不落盘。
"""
import io
import json
import os
import urllib.request
import urllib.error

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


KEY = load_key()
BASE = os.environ.get('EQ_BASE', 'https://api.deepseek.com')
print('端点:', BASE)
print('密钥:', '读到了（不打印）' if KEY else '没读到')

try:
    req = urllib.request.Request(BASE + '/models', headers={'Authorization': 'Bearer ' + KEY})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.loads(r.read().decode('utf-8'))
    ids = [m.get('id') for m in (j.get('data') or [])]
    print('端点报告的模型（%d 个）：' % len(ids))
    for i in ids:
        print('   ', i)
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read().decode('utf-8', 'replace')[:300])
except Exception as e:
    print('失败：', type(e).__name__, e)
