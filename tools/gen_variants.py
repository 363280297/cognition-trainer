"""给每张卡生成表面变体：同一种情境、同一个考点，换掉人／场景／措辞。

用户的原话是「加入一点变体，一些随机变量，但是核心内容不变」。
这个要求正好对上一种被验证过的做法：变化的是**检索线索**，不变的是**原理**。
每次看到略微不同的场景，你要做的判断是同一类——这比反复看同一句话更难作弊，
也更接近现实（现实里没有两次一模一样的情景）。

硬约束（写在这里防止以后改坏）：
  - **选项一个字都不能改。** 变体只换 context 和 quote。
    因为选项是对「这类话」的反应，只要 quote 还是同一类话，选项就依然成立。
  - quote 必须保持**同一类言语行为**（同样是间接拒绝、同样是抱怨、
    同样是面子保护），不能换成一个需要不同答案的话。
  - 不能引入新的关键信息（比如原本没有的第三方、原本没有的期限），
    那会让正确选项变化。
  - 变了之后原答案必须依然正确、原干扰项必须依然是干扰项——生成后会校验长度和结构，
    但语义等价靠这段提示词约束。

产出写进卡片的 variants 字段：[{context, quote}, ...]。渲染时随机取一条，
核心内容（options / explain / principle / plan）完全不动。
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gen_diagnosis import call_json  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CARDS = ROOT / "data" / "cards.json"
PER_CARD = 4
DOMAINS = ["职场", "恋爱", "朋友", "家人", "泛社交"]

SYSTEM = """你在给一个情商训练 App 的卡片生成「表面变体」。

每张卡是：一个场景 + 对方说的一句话 + 四个选项（判断她实际在表达什么）。
你要生成同一张卡的**表面变体**：换掉人、场合、时间、以及那句话的措辞，
但**必须保持同一类情境和同一个考点**。

严格规则（违反任何一条，这张变体就是废的）：
1. **绝对不要改选项、答案、解释。** 你只产出 context 和 quote 两个字段。
2. quote 必须是**同一类言语行为**：原本是间接拒绝，变体也必须是间接拒绝；
   原本是抱怨，变体也必须是抱怨；原本是面子保护，变体也必须是面子保护。
   一句话：换皮不换骨。
3. **不要引入新的关键信息**。原本没有第三方就别加；原本没有期限就别加；
   原本是同事就别改成伴侣。加入新信息会让正确选项发生变化。
4. 变体之间的差异要真的落在表面：谁说的（同事→同学/邻居/合作方）、
   在哪（会议室→电梯/工位/饭桌）、什么时候（刚开完会→刚下班/周末）、
   怎么措辞。同一张卡的两个变体之间也要互不相同。
5. 长度和原版相当，不要写得更长更复杂。
6. 中文，口语，不要书面腔，不写油腻话术。

只输出 JSON。"""



def _norm(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isalnum())


def _too_close(a: str, others, threshold: float = 0.75) -> bool:
    """a 跟 others 里任何一句的相似度超过阈值就算太近。"""
    import difflib
    na = _norm(a)
    if not na:
        return True
    for b in others:
        nb = _norm(b)
        if not nb:
            continue
        if difflib.SequenceMatcher(None, na, nb).ratio() >= threshold:
            return True
    return False


def one(card: dict, n: int) -> dict:
    have = card.get("variants") or []
    # 已有的必须列出来，否则补生成会跟现有的撞车——模型看不到自己产过什么。
    avoid = ""
    if have:
        avoid = ("\n已经有的变体（**不要重复它们**，要换一批不同的人和场合）：\n"
                 + "\n".join(f"- {v['context']} / {v['quote']}" for v in have) + "\n")
    user = (
        f"原卡片：\n"
        f"领域：{card['domain']}\n"
        f"场景：{card['context']}\n"
        f"对方说的话：{card['quote']}\n"
        f"问题：{card['question']}\n"
        f"正确选项：{[o['text'] for o in card['options'] if o['id'] == card['best']]}\n"
        f"{avoid}\n"
        f"请生成 {n} 个表面变体。每个变体保持同一类情境和同一个考点，"
        f"只换人／场合／时间／措辞。\n\n"
        '严格按这个结构输出：\n'
        '{"variants": [' + ", ".join('{"context": "...", "quote": "..."}' for _ in range(n)) + ']}'
    )
    out = call_json(SYSTEM, user, max_tokens=6000)
    vs = out.get("variants") or []
    seen = {v["quote"] for v in have}
    good = []
    for v in vs:
        c = (v.get("context") or "").strip()
        q = (v.get("quote") or "").strip()
        # 结构校验：太长、太短、跟原句一样、或者跟已有变体撞车的都丢掉
        if not (8 <= len(c) <= 160 and 2 <= len(q) <= 80):
            continue
        if q == card["quote"] and c == card["context"]:
            continue
        if q in seen:
            continue
        # 护栏：句子层面也要够不一样。
        # 之前只查了「完全相同」，于是产出过这种东西——
        #   「你上次说的那家咖啡店，还算数吗？」 vs 「你上次说的那家甜品店，还算数吗？」
        # 两个词一换就算一条新变体，而检索线索其实一模一样：练的人在读同一句话。
        # 变体的全部意义就是换检索线索，所以这里按相似度挡掉，不只是去重。
        if _too_close(q, [card["quote"]] + [v["quote"] for v in have] + seen):
            continue
        seen.add(q)
        good.append({"context": c, "quote": q})
    return {"id": card["id"], "variants": good}


def main() -> None:
    data = json.loads(CARDS.read_text(encoding="utf-8"))
    cards = data["cards"]
    only = sys.argv[1:] if len(sys.argv) > 1 else None
    todo = [c for c in cards if (not only or c["id"] in only)]

    cache_path = Path(__file__).resolve().parent / ".cache_variants.json"
    cache = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}
    # 补足到 PER_CARD：已有的卡不跳过，只生成缺的那几条。
    # 原来的写法是「已经有 variants 的卡不用重跑」，那在 PER_CARD 从 2 调到 4 时
    # 会一张都不生成——工具打印「待生成 0」然后什么都不做，看起来像跑成功了。
    #
    # 还要把**缓存算进去**：一次跑二十多分钟，中途被 kill 时缓存是唯一留下的东西。
    # 不认缓存，重跑就把生成过的全部重来一遍；认了，只补剩下的。
    def total_vs(c):
        return len(c.get("variants") or []) + len(cache.get(c["id"]) or [])

    need = [c for c in todo if total_vs(c) < PER_CARD]
    print(f"生成变体：{len(todo)} 张卡，缓存里已有 {len(cache)} 张，"
          f"待生成 {len(need)}（每张目标 {PER_CARD} 条）")

    def work(c):
        n = PER_CARD - total_vs(c)
        for a in range(3):
            try:
                return one(c, n)
            except Exception as e:  # noqa: BLE001
                if a == 2:
                    print(f"  {c['id']} 失败：{e}")
                    return None
                time.sleep(2 + a * 3)
        return None

    if need:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for i, r in enumerate(ex.map(work, need), 1):
                if r:
                    cache[r["id"]] = r["variants"]
                    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1),
                                          encoding="utf-8")
                    print(f"  [{i}/{len(need)}] {r['id']} → {len(r['variants'])} 条")

    filled = 0
    thin = []
    for c in cards:
        # 原有的 + 这次补的，合并（不是覆盖）
        vs = (c.get("variants") or []) + (cache.get(c["id"]) or [])
        if vs:
            c["variants"] = vs
            filled += 1
        if len(vs) < PER_CARD:
            thin.append(f"{c['id']}({len(vs)})")

    if not filled:
        sys.exit("一条变体都没生成，未写回")

    data["version"] = int(data.get("version", 1)) + 1
    NOTE = (" 每张卡带 variants：同一种情境的表面变体（换人／场合／措辞，考点不变）。"
            "渲染时随机取一条，options/explain/plan 完全不动——练的是同一类判断，"
            "但每次的检索线索不同。")
    # 这句以前每跑一次就追加一次，note 里已经能看到重复。加上幂等判断。
    if "每张卡带 variants" not in data.get("note", ""):
        data["note"] = (data.get("note", "") + NOTE).strip()
    CARDS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    total = sum(len(c.get("variants") or []) for c in cards)
    print(f"\n已写回（version {data['version']}）")
    print(f"  有变体的卡：{filled} / {len(cards)}，变体总数 {total}")
    if thin:
        print(f"  变体不足 {PER_CARD} 条的：{' '.join(thin)}")
    if cache_path.exists():
        cache_path.unlink()
    print("\n抽查看一条：")
    for c in cards[:2]:
        if c.get("variants"):
            print(f"  {c['id']} 原句：{c['quote']}")
            for v in c["variants"]:
                print(f"       变体：{v['quote']}")


if __name__ == "__main__":
    main()
