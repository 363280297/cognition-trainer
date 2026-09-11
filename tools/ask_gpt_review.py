"""把项目的**技术+产品摘要**发给另一个模型，要一份批评性的改进意见。

这不是 App 的一部分，是一个"拿去问别人"的辅助脚本，所以单独放、不进构建。

两个通道（`--provider`）：
  · `ailink`（默认）——GPT 中转站。配置来自 skill `gpt56-vision-relay-audit`：
    路由 `POST https://ai.ailink1.com/v1/chat/completions`，模型 `gpt-5.6-sol`，
    密钥从环境变量 `OPENAI_API_KEY` 或 `~/.zcode/secrets/ailink_gpt56.key` 读。
  · `deepseek` —— 用用户自己的 DeepSeek key（`../.env` 里的 `DEEPSEEK_API_KEY`），
    模型 `deepseek-v4-pro`。

**踩过的坑（2026-09-11，用户纠正了我一次）：网关会拦默认的 Python User-Agent。**
我用 `urllib` 直接请求，所有 `chat/completions` 一律返回 `error code: 502`，
而同一把钥匙、同一个路由、同一个模型用 `curl` 却 200。我当时的结论是
「上游故障，不是配置问题」——**这个结论是错的**，用户看了之后说「中转站没有挂，
是你自己使用方法错了」。逐个隔离下来原因是：
  · `User-Agent: Python-urllib/3.12`（urllib 的默认值）→ **502**
  · `User-Agent: curl/8.4.0` → **200**
所以 502 是网关把这个 UA 当成爬虫挡掉了，跟模型、路由、`max_tokens` 都无关
（`max_tokens` 20/200/8000 三种都试过，加上 UA 之后全是 200）。
**教训**：`/v1/models` 能通只说明密钥和网络没问题，不代表业务路由也没问题；
遇到 502 要先怀疑自己的客户端，别急着宣布对方挂了——「对方挂了」这个结论
会让我直接放弃一条本来能用的路。修法是给请求加一个正常的 `User-Agent`。

另外记一个用量上的事实：这条中转站**会在服务端注入一大段上下文**，
一句 "say OK" 的 `prompt_tokens` 就是 **4388**。所以每一次调用的起步成本不低。

两个通道都**不打印、不落盘**密钥。发出去的是项目摘要（架构/内容/工程约束/测试），
不含密钥、不含真实聊天记录、不含任何身份信息。

用法：py -3 tools/ask_gpt_review.py                    # 默认走中转站
      py -3 tools/ask_gpt_review.py --provider deepseek
      py -3 tools/ask_gpt_review.py --probe            # 只探活
"""
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT.parent / ".env"


def _read_env(name):
    if not ENV.exists():
        return ""
    for line in ENV.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


PROVIDERS = {
    "ailink": {
        "base": (os.environ.get("OPENAI_BASE_URL") or "https://ai.ailink1.com").rstrip("/"),
        "path": "/v1/chat/completions",
        "model": "gpt-5.6-sol",
        "key": lambda: (os.environ.get("OPENAI_API_KEY") or "").strip()
        or open(r"C:\Users\Lenovo\.zcode\secrets\ailink_gpt56.key",
                encoding="utf-8", errors="replace").read().strip(),
    },
    "deepseek": {
        "base": "https://api.deepseek.com",
        "path": "/chat/completions",
        "model": "deepseek-v4-pro",
        "key": lambda: _read_env("DEEPSEEK_API_KEY") or _read_env("DEEPSEEK_KEY"),
    },
}


def ask(p, key, messages, max_tokens=4000, timeout=300):
    body = json.dumps({"model": p["model"], "messages": messages,
                       "max_tokens": max_tokens}, ensure_ascii=False).encode("utf-8")
    # User-Agent 不是可有可无的：ai.ailink1.com 会把 Python-urllib 的默认 UA
    # 当成爬虫返回 502（同一个请求换成 curl 的 UA 就是 200）。见文件头的说明。
    headers = {"Content-Type": "application/json",
               "Authorization": "Bearer " + key,
               "Accept": "*/*",
               "User-Agent": "curl/8.4.0"}
    req = urllib.request.Request(p["base"] + p["path"], data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


PROFILE = """\
项目：一个中文 Android App「认知训练」，单用户自用（不发布、不上架）。用户的目标是
「成为一个高情商、有经验、负责任的好男人」。他自述的特征：敏感、神经容易紧绷；
爱宅在家打游戏；脑子有时不清醒、不爱思考、容易直接下结论；容易手淫；缺乏自主性，
总在"过度为他人着想"和"过度利己"之间摇摆；担心这担心那；自认为幽默、外向、话多，
但常分不清场合。

形态：一个 WebView + 单个离线单文件 HTML（约 950 KB）。不用 Gradle，用
aapt2/javac/d8/apksigner 手工构建，APK 0.51 MB、6 个权限、不含任何 native 库。

离线内容（不联网、零权限）：84 张判断卡（读局：先判"这是什么局"再选动作）、
19 条语境校准、37 条微课、6 个阶段评估、4 个脑雾恢复模式、17 个场景、
「信号场」用信号检测论 d′ 记分（而不是答对几道）、每日计划 + 一个"护城河"闸门
（在达标前拦住游戏：无障碍服务 + 悬浮窗，卸载即消失、不写任何系统级状态）。

联网 AI 模块（用他自己的 DeepSeek key，密钥只存在手机本地、永不进包）：
语音陪练（AI 演对方 + 每轮反馈）、表达体检（给一句话打分 + 具体改法）、
真实复盘（贴/拍一段真实聊天记录 → 不直接给答案，先出题让他自己判断 → 答完才揭晓，
并给"现在该怎么回"和"如果对方下一步这么说"的分支应对）、接话提示、情景库。

工程约束：① 不许任何系统级持久状态（卸载必须干净，防止变成流氓软件）；
② 密钥绝不进包/进仓库；③ 离线模块零网络。
测试：27 个检查脚本（含离线版 39 条断言、静态扫 Java 源码的"桥的交叉检查"、
打包产物新鲜度断言、设计变量自检），外加一个自检脚本专门查"只写不读的状态、
定义了没人调用的函数、版本号三处不一致"。

刚做完的一版：复盘支持上传聊天截图 → 视觉模型 OCR 成文字（实测一张中文聊天截图
2.4 秒、逐句准确），并修了两个静默 bug：原生桥回传的 JSON 被网页当对象用（
`typeof` 是 string，于是每次都走"没有数据"的兜底分支、不报错）；
以及"构建时可能把旧的网页内容打进包"（现在指纹对不上直接拒绝构建）。

设计上刻意的选择：不给他下人格定义、不做诊断、不承诺疗效、引用研究时标证据强弱、
不写"可以背的话术"（要求给"情境→动作"而不是台词）。
"""

QUESTIONS = """\
请你以"怀疑一切的资深产品+工程评审"的身份读这份项目摘要，然后回答下面 5 个问题。
要求：具体、可执行、敢说难听话；不要复述摘要、不要泛泛的鼓励、不要列一堆"可以考虑"。

1) 这套设计里，哪一块最可能"看起来有用、实际没用"（自我安慰型功能）？为什么？
2) 内容与交互上，最该**砍掉**的是什么？最该**补**的是什么？
3) 工程与架构上，最该先修的风险是什么？（注意它是单文件 HTML + WebView + 手工构建）
4) 如果只允许再做 3 件事，是哪三件？按优先级排，并说明每件事的验收标准。
5) 你认为这个项目在什么地方在自欺？

最后请单独用一段回答：以这个用户的自述特征来看，"每天用这个 App"这件事本身
最可能在哪一步崩掉？
"""


def main():
    name = "ailink"
    for i, a in enumerate(sys.argv):
        if a == "--provider" and i + 1 < len(sys.argv):
            name = sys.argv[i + 1]
    if name not in PROVIDERS:
        sys.exit(f"未知通道 {name}，可选：{', '.join(PROVIDERS)}")
    p = PROVIDERS[name]
    try:
        key = p["key"]()
    except Exception as e:
        sys.exit(f"读不到 {name} 的密钥：{e}")
    if not key:
        sys.exit(f"读不到 {name} 的密钥")
    only_probe = "--probe" in sys.argv

    print("=" * 70)
    print(f"1) 探活：{name}  POST {p['base']}{p['path']}  model={p['model']}")
    print("=" * 70)
    st, raw = ask(p, key, [{"role": "user", "content": "OK"}], max_tokens=40, timeout=120)
    print(f"   HTTP {st}")
    if st != 200:
        print("   返回：" + raw[:300])
        print("   （不是 200 就别往下走了：路由或模型名不对）")
        sys.exit(1)
    try:
        msg = json.loads(raw)["choices"][0]["message"]
        print(f"   回复：{(msg.get('content') or '(空，推理把额度吃完了)').strip()[:60]!r}")
    except Exception:
        print("   返回不是预期形状：" + raw[:200])
        sys.exit(1)
    if only_probe:
        return

    print()
    print("=" * 70)
    print("2) 发项目摘要，要改进意见（可能要等一两分钟）")
    print("=" * 70)
    # 推理模型会把 max_tokens 分给思考，所以给足；还不够就翻倍再来一次
    st, raw = ask(p, key, [
        {"role": "system", "content": "你是一位非常严格的产品与技术评审。"
                                      "用户给你一份项目摘要，你要给出具体、可执行、"
                                      "有优先级的批评意见。用中文回答。"},
        {"role": "user", "content": PROFILE + "\n" + QUESTIONS},
    ], max_tokens=8000, timeout=600)
    print(f"   HTTP {st}")
    if st != 200:
        print(raw[:500])
        sys.exit(1)
    j = json.loads(raw)
    ch = j["choices"][0]
    msg = ch["message"]
    content = (msg.get("content") or "").strip()
    u = j.get("usage") or {}
    det = u.get("completion_tokens_details") or {}
    if not content:
        print(f"   空回复（finish={ch.get('finish_reason')}，reasoning={det.get('reasoning_tokens')}）"
              " → 额度被推理吃完了，加倍重试")
        st, raw = ask(p, key, [
            {"role": "system", "content": "你是一位非常严格的产品与技术评审。"
                                          "给出具体、可执行、有优先级的批评意见。用中文回答。"},
            {"role": "user", "content": PROFILE + "\n" + QUESTIONS},
        ], max_tokens=16000, timeout=900)
        if st == 200:
            j = json.loads(raw)
            ch = j["choices"][0]
            msg = ch["message"]
            content = (msg.get("content") or "").strip()
            u = j.get("usage") or {}
            det = u.get("completion_tokens_details") or {}
    print("\n" + "=" * 70)
    print(f"{name} 的意见（model={p['model']}，finish={ch.get('finish_reason')}）")
    print("=" * 70)
    print(content or "(还是空的——推理吃光了额度，只能再往上加)")
    print(f"\n[用量 {u.get('total_tokens')} tokens，其中推理 {det.get('reasoning_tokens')}]")


if __name__ == "__main__":
    main()
