"""把写成「台词」的行动预案改写成「动作」。

背景：第一版 plan 有 32/36 条是带引号的完整台词，比如
  「我先停一下，说'我听到你有点失望，这周确实太多次了'，然后给她一个具体的弥补时间」
这是两件事同时错了：

1. 用户在最早的需求里就明确否掉了「可背话术」——背句子不算学会说话，
   而且场合稍有变化就失效，这正是他痛恨的那种「油腻话术」。
2. 机制上也不对。执行意图起作用的是「情境线索 → 动作」这条链被自动化，
   不是让你在紧张时检索一句稿子。台词越长，越不可能在那半秒里想起来。

所以 then 必须是**动作描述**：做什么，不说什么。
  ✗ 「我先说'听起来你有点失望'，再给一个替代时间」
  ✓ 「我先承认这周确实太多次，再给一个具体的替代时间」
"""
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_diagnosis import call_json, is_prohibition  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "data" / "cards.json"

QUOTES = "「」“”‘’\"'`《》"

SYSTEM = """你在把一个「如果……我就……」行动预案里的「我就」部分，从「台词」改写成「动作」。

不合格的样子（台词）：
  我先停一下，说“我听到你有点失望，这周确实太多次了”，然后给她一个具体的弥补时间
  我先回一句“是有点久了，我也挺想你的”，然后主动约一个具体时间
  我直接回“不烦，我在听”，再把她刚才说的最后一件事复述一遍

合格的样子（动作）：
  我先承认这周确实太多次，再给一个具体的替代时间
  我先承认确实隔得久了，再主动提一个具体的时间
  先让她把话说完，再用自己的话复述一遍她刚说的重点，问她我理解得对不对

差别在于：合格版本说的是**你做什么**，不合格版本说的是**你念什么**。

改写要求：
- 只输出动作，一个字的具体台词都不要。不要出现引号、不要出现「我说」「回一句」「接一句」+ 引号内容
  这种结构。
- 保留原来想解决的意图，别换成另一件事。
- 40 字以内。
- 必须是正面表述（去做什么），不能是禁止式（「不要…」「别…」）。
  禁止式在紧张时反而更容易让人做出被禁止的动作。
- 动词要具体到可执行。禁止写「保持耐心」「注意沟通」「好好回应」这类没有动作的字眼。
- 不写油腻话术，不写甜腻的恭维。

只输出 JSON：{"then": "改写后的动作"}"""


def is_script(then: str) -> bool:
    if any(ch in then for ch in QUOTES):
        return True
    # 没有引号但仍是「说一句 X」的结构
    return bool(re.search(r"(说|回|接|讲)(了)?[一]?(句|声)", then))


def rewrite(card: dict) -> str | None:
    c = card
    user = (
        f"场景：{c['context']}\n"
        f"对方说的话：「{c['quote']}」\n"
        f"这张卡教的原则：{c.get('principle', '')}\n\n"
        f"原来的预案：\n  如果：{c['plan']['if']}\n  我就：{c['plan']['then']}\n\n"
        "请把「我就」改写成动作。"
    )
    try:
        out = call_json(SYSTEM, user, max_tokens=3000)
    except Exception:  # noqa: BLE001
        return None
    t = (out.get("then") or "").strip()
    if not t or is_script(t) or is_prohibition(t) or len(t) > 45:
        return None
    return t


def main() -> None:
    data = json.loads(CARDS.read_text(encoding="utf-8"))
    cards = data["cards"]
    todo = [c for c in cards if "plan" in c and is_script(c["plan"]["then"])]
    print(f"需要改写 {len(todo)} 条（共 {len(cards)} 张卡）")

    if not todo:
        print("没有需要改写的")
        return

    done: dict[str, str] = {}
    fails: list[str] = []

    def work(c):
        for attempt in range(3):
            r = rewrite(c)
            if r:
                return c["id"], r
            time.sleep(1 + attempt * 2)
        return c["id"], None

    with ThreadPoolExecutor(max_workers=4) as ex:
        for i, (cid, r) in enumerate(ex.map(work, todo), 1):
            if r:
                done[cid] = r
                print(f"  [{i}/{len(todo)}] {cid} ok")
            else:
                fails.append(cid)
                print(f"  [{i}/{len(todo)}] {cid} 失败")

    if fails:
        print(f"\n改写失败：{', '.join(fails)}")
    if not done:
        sys.exit("没有一条改写成功")

    for c in cards:
        if c["id"] in done:
            c["plan"]["then"] = done[c["id"]]

    data["version"] = int(data.get("version", 1)) + 1
    CARDS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    left = [c["id"] for c in cards if "plan" in c and is_script(c["plan"]["then"])]
    print(f"\n已写回（version {data['version']}），仍是台词的剩 {len(left)} 条：{left or '无'}")
    print("\n抽查：")
    for cid in ("c02", "c06", "c07", "c11"):
        c = next((x for x in cards if x["id"] == cid), None)
        if c and "plan" in c:
            print(f"  {cid} if  {c['plan']['if']}")
            print(f"      then {c['plan']['then']}")
    if left:
        sys.exit(1)


if __name__ == "__main__":
    main()
