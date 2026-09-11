"""这个 key 到底哪个模型**真的能看图**？——用真实聊天截图量，不用手画的图。

为什么再写一个：`probe_vision.py` 用手画的 PNG 测，模型回了「①①①①①①①①①①①」，
判不清是"接口把图忽略了"还是"那张图有问题"（PIL 找不到中文字体时会画成方框）。
而且它没有回答最关键的那个问题：**App 里写死的那两个视觉模型名，这个 key 认不认。**

这一版测三件事：
  1. `GET /models` 列出这个 key 能用的模型；
  2. 把**同一张真实聊天截图**（`output/fake-chat.png`，内容是
     「怎么了，工作上出问题了？/不是，就是感觉没人说话/我在啊/嗯」）
     按 App 的请求形状发给每个候选模型名，看是 404、报错、还是回话；
  3. **A/B 判定它有没有真的看图**：同一段提示词、换成另一张内容完全不同的图，
     如果两次回答一模一样，那就是没看（这条比"答案像不像"更能定性）。
     另外还发一张纯白图作为对照。

不打印密钥。用法：py -3 tools/probe_vision_models.py
"""
import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT.parent / ".env"
IMG = ROOT / "output" / "fake-chat.png"
BASE = "https://api.deepseek.com"

# App 里默认用的那个（voice.js 的 VISION_MODEL），加上模型列表里真实存在的两个
CANDIDATES = ["deepseek-v4-flash-vision-exp", "deepseek-v4-pro", "deepseek-flash"]

# 和 App 的 OCR_SYS 同一个要求：只抄字，看不清就写 [看不清]，不要猜
PROMPT = ("把这张图里的聊天记录一字不差地抄下来。格式：每行一句，"
          "在每句前面标出是谁说的（能看出来就标，看不出来就写「不明」）。"
          "只输出聊天内容本身，不要解释、不要总结。看不清的字写 [看不清]，不要猜。")

# 判定用的真值关键词（fake-chat.png 里的原话）
TRUTH = ["工作上出问题", "没人说话", "我在啊"]


def load_key():
    if not ENV.exists():
        sys.exit(f"找不到 {ENV}")
    for line in ENV.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("DEEPSEEK_API_KEY=") or line.startswith("DEEPSEEK_KEY="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v:
                return v
    sys.exit(".env 里没有 DEEPSEEK_API_KEY")


def post(key, model, blocks, max_tokens=900):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": blocks}],
        "max_tokens": max_tokens,
        "temperature": 0,
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        BASE + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


def dataurl(p):
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode("ascii")


def make_white():
    """纯白对照图——如果模型对白图和聊天图回答一样，就说明它没看图。"""
    from PIL import Image
    import io
    im = Image.new("RGB", (700, 900), (255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def main():
    key = load_key()

    print("=" * 68)
    print("1) GET /models")
    print("=" * 68)
    req = urllib.request.Request(BASE + "/models",
                                headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            ids = [m["id"] for m in json.loads(r.read().decode())["data"]]
        print("   HTTP", r.status, "→", ", ".join(ids))
    except urllib.error.HTTPError as e:
        sys.exit(f"   HTTP {e.code}：{e.read().decode('utf-8', 'replace')[:200]}")

    if not IMG.exists():
        sys.exit(f"找不到测试图 {IMG}")
    chat_url = dataurl(IMG)
    white_url = make_white()
    print(f"   测试图：{IMG.name} {IMG.stat().st_size} 字节 → base64 {len(chat_url)} 字符")

    print()
    print("=" * 68)
    print("2) 每个候选模型名：按 App 的请求形状发这张聊天截图")
    print("=" * 68)
    verdict = {}
    for m in CANDIDATES:
        if m not in ids:
            print(f"\n   [{m}]  不在 /models 列表里")
        st, j = post(key, m, [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": chat_url}},
        ])
        if st != 200:
            err = j.get("error") or j.get("raw") or j
            print(f"   [{m}]  HTTP {st} → {str(err)[:150]}")
            verdict[m] = None
            continue
        msg = j["choices"][0]["message"]
        txt = (msg.get("content") or "").strip()
        u = j.get("usage") or {}
        print(f"   [{m}]  HTTP 200  usage={u.get('total_tokens')} "
              f"(prompt {u.get('prompt_tokens')} / completion {u.get('completion_tokens')})")
        print("      回复：" + txt.replace("\n", " ⏎ ")[:200])
        hit = [t for t in TRUTH if t in txt]
        print(f"      命中真值关键词 {len(hit)}/{len(TRUTH)}：{hit}")
        verdict[m] = txt

    print()
    print("=" * 68)
    print("3) A/B：换成纯白图，答案变了没有（变了才算真看图）")
    print("=" * 68)
    for m, chat_txt in verdict.items():
        if chat_txt is None:
            continue
        st, j = post(key, m, [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": white_url}},
        ])
        if st != 200:
            print(f"   [{m}]  白图 HTTP {st}")
            continue
        white_txt = (j["choices"][0]["message"].get("content") or "").strip()
        same = white_txt[:60] == chat_txt[:60] and white_txt != ""
        print(f"   [{m}]  白图回复：" + white_txt.replace("\n", " ⏎ ")[:90])
        print(f"      → {'两次一模一样，说明没看图' if same else '两次不同，看图了'}")
        # 白图上出现真值关键词 = 它在编
        fake = [t for t in TRUTH if t in white_txt]
        if fake:
            print(f"      **白图上竟然报出了聊天内容 {fake} → 纯编造**")

    print()
    print("结论怎么读：只有「命中真值关键词」且「白图答案不同」的模型，才能当 OCR 用。")
    print("如果三个都不行，App 里那个默认视觉模型名就得改，或者这个 key 换不了图。")


if __name__ == "__main__":
    main()
