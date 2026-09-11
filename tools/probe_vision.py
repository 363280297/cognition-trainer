"""这个模型接口到底收不收图片？——先量清楚，再决定功能怎么设计。

要验的两件事：
  1. 这个 key 能用哪些模型（有没有视觉模型）；
  2. 往 messages 里塞一张图，接口是接受、报错、还是**静默忽略图片**。
     （最后一种最坑：它不报错，你会以为是 OCR 不准，其实是图根本没被看。）

用法：
    py -3 tools/probe_vision.py                # 用仓库上一层的 .env
    py -3 tools/probe_vision.py --print        # 顺便把原始响应打出来

图片是现场用 PIL 生成的（带中文），不涉及任何真实聊天记录。
"""
import base64
import io as _io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent.parent / ".env"
BASE = "https://api.deepseek.com"


def load_key():
    if not ENV.exists():
        sys.exit(f"找不到 {ENV}")
    for line in ENV.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("DEEPSEEK_API_KEY=") or line.startswith("DEEPSEEK_KEY="):
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v:
                return v
    sys.exit("README: .env 里没有 DEEPSEEK_API_KEY")


def make_image():
    """生成一张带中文的 PNG——只用得着「能不能读字」，不需要真实截图。"""
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (420, 140), "white")
    d = ImageDraw.Draw(im)
    d.text((14, 14), "她：你今天怎么一直不回我", fill="black")
    d.text((14, 52), "我：在忙，晚点说", fill="black")
    d.text((14, 90), "她：哦，那你忙吧", fill="black")
    buf = _io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def req(method, url, key, body=None):
    r = urllib.request.Request(url, method=method)
    r.add_header("Authorization", "Bearer " + key)
    r.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data, timeout=90) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return -1, f"{type(e).__name__}: {e}"


def main():
    show = "--print" in sys.argv
    key = load_key()
    print("=" * 68)
    print("1) 这个 key 能用哪些模型")
    print("=" * 68)
    st, body = req("GET", BASE + "/models", key)
    print(f"   HTTP {st}")
    models = []
    try:
        j = json.loads(body)
        models = [m.get("id") for m in (j.get("data") or [])]
        print("   模型：" + ", ".join(models) if models else "   （没列出模型）")
    except Exception:
        print("   " + body[:400])
    vis = [m for m in models if any(k in str(m).lower() for k in ("vl", "vision", "omni"))]
    print(f"   看起来是视觉模型：{vis or '（一个都没有）'}")

    print()
    print("=" * 68)
    print("2) 往 messages 里塞一张图，看接口怎么反应")
    print("=" * 68)
    img = make_image()
    b64 = base64.b64encode(img).decode()
    print(f"   测试图：{len(img)} 字节 PNG（白底黑字，三行中文对话），base64 后 {len(b64)} 字符")
    payload = {
        "model": models[0] if models else "deepseek-chat",
        "max_tokens": 300,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "把这张图里的文字一字不差地抄下来。只输出文字。"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
            ],
        }],
    }
    st, body = req("POST", BASE + "/chat/completions", key, payload)
    print(f"   HTTP {st}")
    print("   " + (body if show else body[:900]))
    try:
        j = json.loads(body)
        msg = (j.get("choices") or [{}])[0].get("message", {}).get("content", "")
        if msg:
            print(f"\n   >>> 模型回的内容：{msg!r}")
            if any(t in msg for t in ("她", "你", "忙")):
                print("   >>> 判定：**能读图**（认出了图里的字）")
            else:
                print("   >>> 判定：接口收下了，但没读出图里的字 → 多半把图忽略了，不能当 OCR 用")
        else:
            print("\n   >>> 判定：**没有内容返回** → 这个模型不能用图片")
    except Exception:
        print("\n   >>> 判定：响应不是正常 JSON → 接口不接受这种请求")


if __name__ == "__main__":
    main()
