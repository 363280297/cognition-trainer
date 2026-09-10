"""给每张卡的每个选项生成「诊断」：为什么这个误读当时显得合理，以及区分它的线索是什么。

为什么值得为 144 个选项逐个写：
frame-of-reference 训练（Bernardin & Buckley 1981；Sulsky & Day 1992）的核心机制不是
「知道正确答案」，而是**拿自己的判断和专家判断对齐，理解差异从哪来**。
只告诉你「答案是 A」，你学到的是这一题；告诉你「你选的 C 是被哪条线索骗的」，
你学到的是**识别这一类线索**。机制研究指向 dispositional reasoning
（Baret & de Kock 2018），所以诊断要落到「哪条线索、为什么把你带偏」。

同时给每个错误选项标一个 err（误读类型），用来在 App 里生成「偏差画像」——
准确率和偏差是两个独立的维度（West & Kenny 2011 的 truth and bias model），
一个人可以准确率不低但一直往同一个方向歪，那比总分更有用。

产出写回 data/cards.json，字段 version 递增。
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "data" / "cards.json"
BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-v4-pro"

# 误读类型。六个方向要互相可区分，且每个都对应这个 App 真正要治的毛病。
ERR_TYPES = {
    "正解": "这条读法是对的（正确答案，或可接受的次优答案）",
    "事务化": "把情感/关系信号读成事务需求。她表达的是感受，你听成了待办事项",
    "过度解读": "把友善或中性读成好感。对方只是正常待人，你读出了特殊意味",
    "消极解读": "把中性或含糊读成敌意、拒绝、挑剔、操控。往最坏处想",
    "投射": "把自己的期待或恐惧当成对方的意思。你想听什么就听到什么",
    "字面化": "把间接表达按字面接受，漏掉言外之意。她说的是 A，意思是 B，你只处理了 A",
    "乐观化": "把不满、敷衍、带情绪的客气当成「没事」。她说没关系，你信了",
    "过度让步": "你**说出来了**（答应了、说了算了、去了），但让出去的是本该守的东西；或者第 N 次还在承担第一次的量。重点在「让得过多」，不在于说不说",
    "过度计较": "小事上不让。把偶发的、无心的、没有实际损失的事当成原则问题来升级",
    "含蓄化": "你**根本没说出来**。把需求留在心里期待对方自己发现、说一半留一半、用玩笑盖过去、找借口回避。和「过度让步」的区别：那个是说出口了但让太多，这个是从头到尾没说",
}

SYSTEM = """你在为一个中文情商训练 App 写「选项诊断」。

用户会看到一句真实的话和四个选项，选一个来回答「她这句话最可能在表达什么」。
选完之后，App 要展示每个选项的诊断。

你要为**每个选项**产出两样东西：

1. why —— 这个读法为什么当时显得合理，以及什么线索能区分它。
   写作要求（很重要）：
   - 2 句以内，不超过 70 字。第一句说它被哪条线索吸引（具体到那句话里的词、场合、语气），
     第二句说这条读法在哪一步断了，或者什么条件下它反而成立。
   - 必须具体。禁止写「这是常见的认知偏差」「要注意沟通」这类空话。
   - 不说教，不夸用户，不用「亲爱的」「宝贝」这类语气，不写油腻话术。
   - 不要出现「正确答案是」这种话，App 会自己标出来。
   - 错误选项的诊断要**可迁移**：让用户下次遇到同类线索能认出来，而不是只记住这一题。

2. err —— 从下面这个封闭集合里挑**恰好一个**，表示这个选项属于哪类误读：
{catalog}

对正确答案（以及被列为可接受的次优答案）必须标 "正解"。

另外再产出 plan：给这张卡配一个「如果……我就……」的行动预案种子。
   - if：一个具体的、能认出来的触发场景。要具体到场合和信号，不要泛泛的「当她不高兴时」。
   - then：你要做的**具体动作**。
   - 硬性要求：then 必须是**正面表述**（去做什么），绝不能是禁止式（「不要辩解」「别急着解释」）。
     禁止式的执行意图会产生反效果——人一紧张反而更容易做那件被禁止的事。
   - 正面示例：if「她说完一件事先停住没接话」，then「我先复述一遍我听到的，再问她我理解得对不对」
   - 反面示例：if「她抱怨同事」，then「不要给她讲道理提建议」 ← 这是禁止式，不合格

只输出 JSON，不要任何解释文字。"""


def catalog() -> str:
    return "\n".join(f'   - "{k}"：{v}' for k, v in ERR_TYPES.items())


def load_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    env = ROOT.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("没找到 DEEPSEEK_API_KEY")


_client = OpenAI(api_key=load_key(), base_url=BASE_URL)


def call_json(system: str, user: str, max_tokens: int = 6000) -> dict:
    """deepseek-v4-pro 默认带推理，推理 token 和正文共用 max_tokens，给小了会拿到半截 JSON。"""
    budget = max_tokens
    last = ""
    for _ in range(3):
        r = _client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": user}],
            max_tokens=budget,
            temperature=0.5,
            response_format={"type": "json_object"},
        )
        ch = r.choices[0]
        content = ch.message.content or ""
        if ch.finish_reason == "length" or not content.strip():
            last = f"截断/空 (finish={ch.finish_reason})"
            budget *= 2
            continue
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            last = f"JSON 解析失败: {e}"
            budget *= 2
    raise RuntimeError(last)


PROHIBIT = ("不要", "别", "不能", "避免", "禁止", "不许", "不该", "少")


def is_prohibition(then: str) -> bool:
    """禁止式的执行意图会产生反效果（Gollwitzer：否定框架的 if-then 计划有逆火风险），
    所以 then 必须是「去做什么」，不能是「别做什么」。"""
    t = then.lstrip("，,。 ")
    return t.startswith(PROHIBIT)


def fix_plan(pif: str, pthen: str) -> dict | None:
    """只重写 plan，不动已经生成好的诊断。"""
    user = (
        "下面是一个「如果……我就……」行动预案，它不合格。\n\n"
        f"如果：{pif}\n我就：{pthen}\n\n"
        "不合格的原因可能是：① 用了禁止式表述（「不要…」「别…」），"
        "而禁止式会让人在紧张时反而更想做那件事；② 太长。\n\n"
        "请改写。要求：\n"
        "- 「我就」必须是**正面动作**：说清楚去做什么，而不是别做什么。\n"
        "- if 不超过 30 字，then 不超过 45 字。\n"
        "- 保留原来想解决的问题，别换成一个不相干的行为。\n"
        "- 具体、可执行。禁止写成「保持耐心」「注意沟通」这种没动作的话。\n"
        "- 不写油腻话术。\n\n"
        '只输出 JSON：{"if": "...", "then": "..."}'
    )
    try:
        out = call_json("你在改写行动预案。只输出 JSON。", user, max_tokens=3000)
    except Exception:  # noqa: BLE001
        return None
    i, t = (out.get("if") or "").strip(), (out.get("then") or "").strip()
    if not (i and t):
        return None
    if is_prohibition(t) or len(i) > 50 or len(t) > 80:
        return None
    return {"if": i, "then": t}


def one_card(card: dict) -> dict:
    payload = {
        "场景": card["context"],
        "她/他说的话": card["quote"],
        "问题": card["question"],
        "选项": [{"id": o["id"], "text": o["text"]} for o in card["options"]],
        "正确答案": card["best"],
        "也接受": card.get("ok") or [],
        "已有解释": card.get("explain", ""),
    }
    user = (
        "请为下面这张卡产出诊断。\n\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
        + "\n\n严格按这个结构输出 JSON：\n"
        '{\n'
        '  "options": [\n'
        '    {"id": "A", "err": "误读类型", "why": "该选项的诊断，2 句以内"},\n'
        '    ... 每个选项一条，id 要和输入完全一致 ...\n'
        '  ],\n'
        '  "plan": {"if": "具体触发场景", "then": "正面表述的具体动作"}\n'
        '}'
    )
    out = call_json(SYSTEM.replace("{catalog}", catalog()), user)
    return {"id": card["id"], "result": out}


def main() -> None:
    data = json.loads(CARDS.read_text(encoding="utf-8"))
    cards = data["cards"]
    only = sys.argv[1:] if len(sys.argv) > 1 else None
    todo = [c for c in cards if not only or c["id"] in only]

    # 原始模型输出先落盘。生成 36 张卡要几十次调用，任何一次校验不过都不该让整批白跑。
    cache_path = Path(__file__).resolve().parent / ".cache_diagnosis.json"
    cache = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}

    need = [c for c in todo if c["id"] not in cache]
    print(f"生成诊断：{len(todo)} 张卡（共 {len(cards)}），缓存命中 {len(todo) - len(need)}，待生成 {len(need)}")

    errors: list[str] = []

    def work(c):
        for attempt in range(3):
            try:
                return one_card(c)
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    errors.append(f"{c['id']}: {e}")
                    return None
                time.sleep(2 + attempt * 3)
        return None

    if need:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for i, r in enumerate(ex.map(work, need), 1):
                if r:
                    cache[r["id"]] = r["result"]
                    print(f"  [{i}/{len(need)}] {r['id']} ok")
                    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1),
                                          encoding="utf-8")
                else:
                    print(f"  [{i}/{len(need)}] 失败")

    if errors:
        print("\n失败：")
        for e in errors:
            print("  " + e)
    if not cache:
        sys.exit("没有任何结果")

    results = {c["id"]: cache[c["id"]] for c in todo if c["id"] in cache}

    # ---- 校验。分两类：结构错误中止，plan 的问题定点修 ----
    problems: list[str] = []
    for c in cards:
        r = results.get(c["id"])
        if not r:
            continue
        by_id = {o.get("id"): o for o in r.get("options", []) if isinstance(o, dict)}
        for o in c["options"]:
            got = by_id.get(o["id"])
            if not got:
                problems.append(f"{c['id']}.{o['id']} 缺诊断")
                continue
            why = (got.get("why") or "").strip()
            err = (got.get("err") or "").strip()
            if not why:
                problems.append(f"{c['id']}.{o['id']} why 为空")
                continue
            if err not in ERR_TYPES:
                problems.append(f"{c['id']}.{o['id']} err 非法: {err!r}")
                continue
            # 正确答案必须标正解，否则偏差画像会被算歪
            should_be_correct = o["id"] == c["best"] or o["id"] in (c.get("ok") or [])
            if should_be_correct and err != "正解":
                problems.append(f"{c['id']}.{o['id']} 是正确答案却标成 {err}")
                continue
            if not should_be_correct and err == "正解":
                problems.append(f"{c['id']}.{o['id']} 是错误选项却标成正解")
                continue
            o["why"] = why
            o["err"] = err

    if problems:
        print(f"\n结构校验未通过 {len(problems)} 处：")
        for p in problems[:40]:
            print("  " + p)
        sys.exit("中止，未写回文件")

    # ---- plan：禁止式和超长的定点重写，而不是丢掉整批 ----
    plans: dict[str, dict] = {}
    bad_plan: list[tuple[dict, str, str]] = []
    for c in cards:
        r = results.get(c["id"])
        if not r:
            continue
        plan = r.get("plan") or {}
        pif, pthen = (plan.get("if") or "").strip(), (plan.get("then") or "").strip()
        if not (pif and pthen):
            continue
        if is_prohibition(pthen):
            bad_plan.append((c, pif, pthen))
        elif len(pif) > 50 or len(pthen) > 80:
            bad_plan.append((c, pif, pthen))
        else:
            plans[c["id"]] = {"if": pif, "then": pthen}

    if bad_plan:
        print(f"\n修复 {len(bad_plan)} 个 plan（禁止式或超长）：")
        for c, pif, pthen in bad_plan:
            fixed = fix_plan(pif, pthen)
            if fixed:
                plans[c["id"]] = fixed
                print(f"  {c['id']} 已改写")
            else:
                print(f"  {c['id']} 改写失败，沿用原句")
                plans[c["id"]] = {"if": pif, "then": pthen}

    # 至少要有 plan 才算合格（plan 是这个功能的载体）
    no_plan = [c["id"] for c in cards if c["id"] in results and c["id"] not in plans]
    if no_plan:
        print(f"\n这些卡没有可用的 plan，跳过（不写 plan 字段）：{', '.join(no_plan)}")

    for c in cards:
        if c["id"] in plans:
            c["plan"] = plans[c["id"]]

    data["version"] = int(data.get("version", 1)) + 1
    data["note"] = ("每张卡带逐选项诊断（why）和误读类型（err），用于生成偏差画像；"
                    "plan 是 if-then 行动预案种子。"
                    "诊断的来源：frame-of-reference 训练的机制是比对判断差异，不是公布答案。")
    CARDS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n已写回 {CARDS}（version {data['version']}）")
    n = sum(1 for c in cards for o in c["options"] if "why" in o)
    print(f"带诊断的选项: {n}")
    print(f"带 plan 的卡片: {sum(1 for c in cards if 'plan' in c)}")
    if cache_path.exists():
        cache_path.unlink()   # 已落进正式数据，缓存清掉免得下次误用旧稿
        print("已清理缓存")


if __name__ == "__main__":
    main()
