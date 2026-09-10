# -*- coding: utf-8 -*-
"""收尾：把离线版那两句已经不准确的话改掉，并删掉刚变成死代码的 post()。

「表达体检」「真实复盘」搬到前端之后，三处文案变成了假话：
  · build_offline.py 顶部的注释
  · OFFLINE_AI_MSG（那句「要用表达体检和真实复盘：在电脑上运行 py -3 server.py」）
  · 页面上的横幅「AI 那两个需要电脑上的 server.py」

现在两个模块在手机上直接可用，所以：
  · 横幅改成实话：离线模块全可用 + AI 要填一次自己的密钥
  · OFFLINE_AI_MSG 改成一个通用的「这个接口在离线版里没有」——
    它现在只为真正未知的 /api/* 兜底，不再代表「AI 不可用」

另外 `post()` 这个助手随着最后两个调用者被搬走，已经没有任何调用者了。
按这个项目自己的教训（死代码会让功能悄悄消失，见 voices()）删掉，
并留一句注释说明曾经有它、以及为什么不再需要，免得下一个人重新发明一遍。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    # ---------------- build_offline.py ----------------
    BP = os.path.join(ROOT, 'build_offline.py')
    b = io.open(BP, encoding='utf-8').read()

    b = sub(b, """AI 那两个模块需要本机 server.py，离线版里会明确提示（密钥绝不会写进这个文件）。""",
            """AI 那几个模块都走前端（原生桥 / 代理），需要用户自己填一次密钥（密钥绝不会写进这个文件）。""",
            tag='header')

    b = sub(b, """  var OFFLINE_AI_MSG =
    '这是离线单文件版，不含 AI 功能（密钥不能写在文件里）。' +
    '要用「表达体检」和「真实复盘」：在电脑上运行 py -3 server.py，' +
    '然后手机连同一个 WiFi，打开终端里显示的那个局域网地址。' +
    '其余模块（每日卡片 / 语境校准 / 心理学 / 脑雾恢复）离线版全部可用。';""",
            """  /* 兜底文案：只有在请求一个**这个版本不认识的** /api/ 地址时才会看到。
     AI 功能本身不再经过 /api/ai/*（那些提示词已经搬到前端，走原生桥或代理），
     所以这句话不再代表「AI 不可用」——它代表「这个接口离线版没有」。 */
  var OFFLINE_AI_MSG =
    '这个接口在离线单文件版里没有（它原本对应电脑上的 server.py）。' +
    'AI 功能（场景对话 / 表达体检 / 真实复盘）走的是另一条路，' +
    '只要在设置里填一次你自己的 API 密钥就能用。';""",
            tag='msg')

    b = sub(b, """  离线单文件版 · 四个离线模块全部可用 · AI 那两个需要电脑上的 server.py""",
            """  离线单文件版 · 离线模块全部可用 · AI 只要在设置里填一次自己的密钥""",
            tag='banner')
    io.open(BP, 'w', encoding='utf-8').write(b)

    # ---------------- app.js：删掉死掉的 post() ----------------
    AP = os.path.join(ROOT, 'public', 'app.js')
    a = io.open(AP, encoding='utf-8').read()
    a = sub(a, """async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `请求失败 (${r.status})`);
  return j;
}

""", """/* 这里原来有个 post(url, body) 助手，用来调 /api/ai/* 那三个服务端接口。
   那三个接口已经删掉了——提示词搬到前端、统一走 llmCall——所以它没有调用者了，
   就删掉。**不要再照着它写新的 AI 调用**：AI 一律走 llmCall（见 voice.js），
   它已经处理好了手机上的原生桥、电脑上的代理、404 回退和截断重试。 */

""", tag='delpost')
    io.open(AP, 'w', encoding='utf-8').write(a)

    # 自检
    a2 = io.open(AP, encoding='utf-8').read()
    assert 'async function post(' not in a2
    b2 = io.open(BP, encoding='utf-8').read()
    assert '需要电脑上的 server.py' not in b2
    print('离线版文案改成实话；死掉的 post() 已删')


if __name__ == '__main__':
    main()
