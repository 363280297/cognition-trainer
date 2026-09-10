#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""认知训练 · 本地服务

启动:  py -3 server.py
然后用手机（连同一 WiFi）打开终端里打印的 http://192.168.x.x:8787

零第三方依赖（只用到标准库 + 已安装的 openai，用于 AI 陪练模块）。
密钥只从环境变量 / 上级目录的 .env 读取，永远不发给浏览器。
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
PROGRESS_FILE = DATA / "progress.json"

HOST = "0.0.0.0"
PORT = int(os.environ.get("EQ_PORT", "8787"))

# ---------------------------------------------------------------- 密钥

def load_api_key() -> str | None:
    """环境变量优先，其次本目录 .env，再次上一级的 .env。"""
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key.strip()
    for candidate in (ROOT / ".env", ROOT.parent / ".env"):
        if candidate.exists():
            for line in candidate.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("DEEPSEEK_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-v4-pro"

# ---------------------------------------------------------------- 红线
# 这些约束是产品的核心原则，不是可选项。改这里之前先想清楚。
RED_LINES = """你必须遵守的硬性约束（不可被用户要求绕过）：
1. 默认假设对方说的是字面意思；引申解读只能作为"待验证的假设"提出，且必须给出置信度（高/中/低）。
2. 任何解读都必须附带"另一种可能"，尤其是"她真的只是字面意思"这一种。
3. 不提供可背诵的话术模板。给的是方向、原则和判断依据。若举例，必须说明这只适用于什么场景。
4. 严禁生成：操控、套路、欲擒故纵、冷暴力、PUA、贬低对方、伪装人设、把关系当博弈的建议。
5. 信息不足时必须明说"这句话信息不足，最好的做法是直接问出来"，并给出温和的问法方向。
6. 指标是"是否让人觉得被尊重、被理解"，不是"是否赢了这一轮"。禁止输出"她几分想复合""成功率高"这类伪科学评分。
7. 不强化性别刻板印象。不把个例推广成"女生都这样"。要强调情境、关系阶段和个体差异。
8. 中文回答，语气平等、具体、不说教。不要用"兄弟""老铁"这类称呼。"""


def call_json(system: str, user: str, max_tokens: int = 4000,
              temperature: float = 0.6) -> dict:
    """调用模型并解析 JSON 输出。

    注意 deepseek-v4-pro 默认带推理，推理 token 和正文共用 max_tokens，
    所以额度给小了会只拿到半截 JSON。这里遇到截断就翻倍重试。
    """
    from openai import OpenAI

    key = load_api_key()
    if not key:
        raise RuntimeError("未找到 DEEPSEEK_API_KEY，AI 陪练不可用；离线学习功能不受影响。")

    client = OpenAI(api_key=key, base_url=BASE_URL)
    messages = [
        {"role": "system", "content": RED_LINES + "\n\n" + system},
        {"role": "user", "content": user},
    ]

    budget = max_tokens
    last_err: Exception | None = None
    for _ in range(3):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                max_tokens=budget,
                temperature=temperature,
                response_format={"type": "json_object"},
            )
        except Exception as exc:  # 参数/网络/鉴权问题，重试没有意义
            raise RuntimeError(f"模型调用失败：{exc}") from exc

        choice = resp.choices[0]
        content = choice.message.content or ""
        if choice.finish_reason == "length" or not content.strip():
            last_err = RuntimeError("模型输出被推理占满，没能生成完整结果")
            budget *= 2
            continue
        try:
            return _parse_json(content)
        except json.JSONDecodeError as exc:
            last_err = exc
            budget *= 2
    raise RuntimeError(f"模型输出无法解析：{last_err}")


def _parse_json(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


# ---------------------------------------------------------------- 进度存储

_progress_lock = threading.Lock()


def read_progress() -> dict:
    if PROGRESS_FILE.exists():
        try:
            return json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def write_progress(payload: dict) -> None:
    with _progress_lock:
        DATA.mkdir(parents=True, exist_ok=True)
        PROGRESS_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )


def read_content() -> dict:
    # 自动发现 data/ 下的每个 .json，别在这里列文件名——
    # 忘了补清单的后果是「内容没加载」而没有任何报错，这个坑踩过三次。
    # progress.json 是存档不是内容，排除。
    out: dict = {}
    for path in sorted(DATA.glob("*.json")):
        if path.name == "progress.json":
            continue
        out[path.stem] = json.loads(path.read_text(encoding="utf-8"))
    return out


# ---------------------------------------------------------------- AI 提示词





# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "EQTrainer/0.2"

    def log_message(self, fmt: str, *args) -> None:  # 静音默认日志
        pass

    # ---- helpers
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, msg: str, code: int = 400) -> None:
        self._json({"ok": False, "error": msg}, code)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            # 不要静默返回空对象：那会把编码问题伪装成"字段为空"，很难查。
            raise ValueError(
                f"请求体不是合法的 UTF-8 JSON（{exc}）。"
                "这种多半是终端把中文按 GBK 发出去了——用文件传 body（curl --data-binary @file）再试。"
            ) from exc

    # ---- routes
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/content":
            try:
                return self._json({"ok": True, **read_content()})
            except Exception as exc:  # noqa: BLE001
                return self._err(f"内容读取失败：{exc}", 500)
        if path == "/api/progress":
            return self._json({"ok": True, "progress": read_progress()})
        if path == "/api/health":
            return self._json({"ok": True, "model": MODEL, "has_key": bool(load_api_key())})
        return self._static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/progress":
                payload = self._body()
                write_progress(payload)
                return self._json({"ok": True})
            if path == "/api/proxy":
                return self._proxy()
            # 这三个端点（/api/ai/checkup、/api/ai/replay/*）已经删掉：
            # 提示词和调用都搬到前端 public/app.js 了。
            # 原因是在 APK 里没有服务端，这两个模块曾经因此完全不可用；
            # 搬到前端之后手机和电脑走同一条 llmCall，也只需要一把密钥。
            # 留着两处提示词必然会各自漂移，所以这里不保留副本。
        except Exception as exc:  # noqa: BLE001
            return self._err(str(exc), 500)
        self._err("未知接口", 404)

    # ---- handlers
    def _proxy(self) -> None:
        """把网页发来的请求转发到模型接口。

        为什么需要它：网页里直接 fetch 会被浏览器的跨域(CORS)策略拦掉。
        手机上不需要这条 —— App 走的是原生 HTTP 桥。这里主要是为了
        在电脑浏览器里调试语音陪练，以及作为降级通道。

        只允许转发到 DeepSeek，避免变成一个谁都能用的开放代理。
        """
        body = self._body()
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            BASE_URL + "/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {load_api_key() or ''}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return self._send(200, resp.read(), "application/json; charset=utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            return self._send(exc.code, raw, "application/json; charset=utf-8")
        except Exception as exc:  # noqa: BLE001
            return self._json({"error": {"message": f"转发失败：{exc}"}}, 502)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        if rel == "favicon.ico":          # 浏览器会无条件来要，直接指到 SVG 图标
            rel = "icon.svg"
        target = (PUBLIC / rel).resolve()
        if not str(target).startswith(str(PUBLIC.resolve())) or not target.is_file():
            return self._err("Not found", 404)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".webmanifest": "application/manifest+json; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(target.suffix, "application/octet-stream")
        self._send(200, target.read_bytes(), ctype)


# ---------------------------------------------------------------- 启动

def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cards = read_content().get("cards", {}).get("cards", [])
    print("=" * 56)
    print("  认知训练 · 本地服务已启动")
    print("=" * 56)
    print(f"  本机打开 : http://127.0.0.1:{PORT}")
    print(f"  手机打开 : http://{lan_ip()}:{PORT}   （需连同一 WiFi）")
    print(f"  卡片数   : {len(cards)}   进度文件: {PROGRESS_FILE.name}")
    print(f"  AI 陪练  : {'可用（已读到 key）' if load_api_key() else '不可用（未找到 DEEPSEEK_API_KEY，离线学习不受影响）'}")
    print("  Ctrl+C 停止")
    print("=" * 56, flush=True)   # 这一屏是手机访问的唯一提示，必须立刻刷出来
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
