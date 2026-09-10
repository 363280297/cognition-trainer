"""把 App 打成单文件离线版：HTML + CSS + JS + 全部内容内联，零外部请求。

给手机用的场景：没连同一个 WiFi、或电脑没开的时候，四个离线模块照样能用。
AI 那几个模块都走前端（原生桥 / 代理），需要用户自己填一次密钥（密钥绝不会写进这个文件）。
"""
import base64
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).parent
PUB = ROOT / "public"
DATA = ROOT / "data"
OUT = ROOT / "认知训练-离线版.html"

html = (PUB / "index.html").read_text(encoding="utf-8")
css = (PUB / "style.css").read_text(encoding="utf-8")
voice = (PUB / "voice.js").read_text(encoding="utf-8")
js = (PUB / "app.js").read_text(encoding="utf-8")
icon = (PUB / "icon.svg").read_text(encoding="utf-8")

content = {}
# 自动发现 data/ 下的每一个 .json，不要把文件名列在这里。
# 这个坑踩过三次了（CONTENT 键白名单、javac 源文件列表，现在是这里）：
# 加了一个数据文件、忘了往清单里补，结果是界面上「内容还没加载」而没有任何报错。
# progress.json 不是内容，是存档，排除。
for path_ in sorted(DATA.glob("*.json")):
    if path_.name == "progress.json":
        continue
    content[path_.stem] = json.loads(path_.read_text(encoding="utf-8"))
print(f"  内容文件: {', '.join(sorted(content))}")

# 内联时不能出现会提前闭合标签的字面量
for label, blob in (("css", css), ("voice.js", voice), ("app.js", js)):
    if "</style" in blob.lower() or "</script" in blob.lower():
        sys.exit(f"{label} 里含有会截断内联的结束标签，需要转义后再打包")

icon_uri = "data:image/svg+xml;base64," + base64.b64encode(icon.encode("utf-8")).decode("ascii")

SHIM = """
<script>
/* ===== 离线单文件版的运行时适配层 =====
   App 原本通过 /api/* 和本机 server.py 通信。离线版把内容直接内联，
   并用下面这层拦住所有 /api/* 请求，所以可以完全脱离电脑使用。 */
(function () {
  window.__EQ_OFFLINE__ = true;

  /* 有些浏览器在 file:// 下会禁用 localStorage，这里退化成内存存储，
     保证 App 不崩——代价只是关掉页面后进度不保留。 */
  try {
    window.localStorage.setItem('__t', '1');
    window.localStorage.removeItem('__t');
  } catch (e) {
    var mem = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; },
        clear: function () { mem = {}; },
        key: function (i) { return Object.keys(mem)[i] || null; },
        get length() { return Object.keys(mem).length; }
      }
    });
  }

  var EMBEDDED = __EMBEDDED__;
  /* 兜底文案：只有在请求一个**这个版本不认识的** /api/ 地址时才会看到。
     AI 功能本身不再经过 /api/ai/*（那些提示词已经搬到前端，走原生桥或代理），
     所以这句话不再代表「AI 不可用」——它代表「这个接口离线版没有」。 */
  var OFFLINE_AI_MSG =
    '这个接口在离线单文件版里没有（它原本对应电脑上的 server.py）。' +
    'AI 功能（场景对话 / 表达体检 / 真实复盘）走的是另一条路，' +
    '只要在设置里填一次你自己的 API 密钥就能用。';

  function fakeJSON(obj, status) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) {
      return realFetch ? realFetch(input, init) : Promise.reject(new Error('离线版不支持外部请求'));
    }
    if (url === '/api/content') return fakeJSON(Object.assign({ ok: true }, EMBEDDED));
    if (url === '/api/progress') {
      if (init && init.method === 'POST') return fakeJSON({ ok: true });
      var saved = {};
      try { saved = JSON.parse(window.localStorage.getItem('eq-state-v2') || '{}'); } catch (e) {}
      return fakeJSON({ ok: true, progress: saved });
    }
    if (url === '/api/health') return fakeJSON({ ok: true, model: 'offline', has_key: false });
    return fakeJSON({ ok: false, error: OFFLINE_AI_MSG }, 503);
  };
})();
</script>
""".replace("__EMBEDDED__", json.dumps(content, ensure_ascii=False))

# 顶部那条「离线单文件版 · 离线模块全部可用 · AI 只要在设置里填一次自己的密钥」
# 已经在 2.32 删掉了。用户的原话：
# 「最上面那一个提示离线单文件版，离线模块全部可用，什么密钥那个直接删掉，不需要提示了。」
# 理由也站得住：那是**给第一次拿到这个文件的人看的说明**，而他是天天用的人——
# 每天开 App 先看一句"离线可用"没有信息量，还占掉最上面那一条。
# 那条横幅当初是我加在离线构建里的（不是页面的一部分），所以删在这里。
#

# ---- 组装 ----
html = html.replace('<link rel="stylesheet" href="/style.css">', f"<style>{css}</style>")
html = html.replace('<link rel="manifest" href="/manifest.webmanifest">', "")   # file:// 无法安装 PWA
html = re.sub(r'<link rel="(icon|apple-touch-icon)" href="/icon\.svg"[^>]*>',
              f'<link rel="icon" href="{icon_uri}">', html)
html = html.replace('<script src="/voice.js"></script>', "")
html = html.replace('<script src="/app.js"></script>',
                    f"{SHIM}<script>{voice}</script>\n<script>{js}</script>")
html = html.replace("<title>认知训练 · 读懂言外之意</title>",
                    "<title>认知训练 · 离线版</title>")
html = html.replace('<span class="dot" id="aiDot" title="AI 陪练状态"></span>',
                    '<span class="dot off" id="aiDot" title="离线版：AI 模块需在电脑上运行 server.py"></span>')

OUT.write_text(html, encoding="utf-8")

# ---- 输入指纹 ----
# 为什么需要它：构建链上原本只有「APK == 离线版.html」这一环被校验过
# （build_apk.py 逐字节比对），而**离线版.html == 源码**这一环没人管。
# 后果实际发生过一次：public/app.js 和 data/curriculum.json 被改过之后没有重建，
# 于是 HTML 停在旧内容，而 APK 照常构建、日志一切正常、校验也通过——
# 因为 APK 确实等于那份**旧的** HTML。等于说这套校验只能保证"没打错包"，
# 不能保证"打的是现在的代码"。
# 所以这里把全部输入算一个指纹写进边车文件，verify_offline.js 会重算并比对。
# 用的不是 <script> 里的内容（那会被 minify/替换），而是**原始输入文件**，
# 这样校验的是"这份 HTML 是不是由这批源码生成的"，与 HTML 内部怎么组装无关。
import hashlib

_SRC_FILES = [PUB / "index.html", PUB / "style.css", PUB / "voice.js", PUB / "app.js",
              PUB / "icon.svg"] + sorted(DATA.glob("*.json"))
_fp = hashlib.sha256()
for _p in _SRC_FILES:
    if _p.name == "progress.json":      # 存档不是输入，它每答一题都变
        continue
    _fp.update(_p.name.encode("utf-8"))
    _fp.update(_p.read_bytes())
SRC_STAMP = ROOT / "认知训练-离线版.src.txt"
# newline="\n" 是必须的：Windows 上 write_text 默认把 \n 翻成 \r\n，
# 读回来的每一行都会多一个 \r，校验时拼出来的路径全部不存在——
# 校验会因为「读法的虫子」而永远失败，而不是因为源码真的变了。
SRC_STAMP.write_text(
    f"{_fp.hexdigest()}\n{OUT.name}\n" + "".join(
        f"{p.relative_to(ROOT).as_posix()}\n" for p in _SRC_FILES if p.name != "progress.json"
    ), encoding="utf-8", newline="\n")

size = OUT.stat().st_size
print(f"已生成 {OUT.name}")
print(f"  体积: {size/1024:.0f} KB（单文件，零外部请求）")
print(f"  输入指纹: {_fp.hexdigest()[:16]}…（{len(_SRC_FILES) - 1} 个文件，见 {SRC_STAMP.name}）")
print(f"  内容: 卡片 {len(content['cards']['cards'])} / 校准 {len(content['calibration']['phrases'])} / "
      f"微课 {len(content['curriculum']['lessons'])} / 恢复 {len(content['recovery']['modes'])} / "
      f"场景 {len(content['scenarios']['scenarios'])} / "
      f"阶段 {len(content['stages']['stages'])}")
for token in ("/style.css", "/app.js", "/voice.js", "/manifest.webmanifest", '"icon.svg"'):
    assert token not in html, f"还有没内联的引用: {token}"
print("  外部引用检查: 通过（无残留 /style.css、/app.js、/voice.js、manifest、外部 icon）")
