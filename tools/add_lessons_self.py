"""补 2 课，针对用户的自我描述：憋需求、特别敏感、比较幽默。

1. **透明度错觉**（Gilovich、Savitsky & Medvec 1998）：人系统性高估自己的内心状态
   被他人看穿的程度（锚定在自己的完整体验上、调整不足）。敲歌实验最直观：
   敲的人预测约 50% 的听众能猜出歌名，实际 3%。
   而且 Savitsky & Gilovich（2003）发现：**把这个偏差讲清楚，本身就能降低焦虑、
   提升表现**——所以「教这个概念」在这件事上是有直接证据的干预，不是科普。
   配合 **自我沉默**（Jack & Dill 的 Silencing the Self）：为维持关系压下自己的需求，
   和抑郁相关。这一课要治的就是「憋着 + 等她自己发现」这个组合。

2. **幽默的两个方向**（Martin 的四风格模型）：亲和型与关系满意度正相关
   （Cann 等 2011；Hall 2017），自我贬损型负相关。HSQ 里自贬型的一道题几乎是
   这个用户的原话。Winterheld 等（2013）：冲突里亲和型幽默减少愤怒、提升解决满意度，
   而自贬型**不能消气，反而让本就难受的一方更生气**。
   对一个「幽默 + 憋事」的人，这一课的价值是：把幽默从挡板改回桥梁。
"""
import json
import pathlib
import sys

CURRICULUM = pathlib.Path(__file__).resolve().parent.parent / "data" / "curriculum.json"

NEW = [
    {
        "id": "p20", "series": "关系心理学", "level": "A",
        "title": "你的需求，没有你以为的那么明显",
        "read": "有一个被反复验证的偏差值得先记住：人系统性高估自己的内心状态被别人看穿的程度（透明度错觉，Gilovich、Savitsky & Medvec 1998）。机制是你会锚定在自己完整的内心体验上——你知道自己加了四天班、知道你现在只想躺着——然后调整不足，觉得对方「应该能看出来」。最直观的一个数字：让人敲一首歌的节奏，敲的人预测约 50% 的听众能猜出歌名，**实际只有 3%**。另一条线上，为了维持关系而压下自己需求的做法（自我沉默，Jack & Dill）和抑郁是相关的。把这两条接起来看，就是「憋着 + 期待对方发现」这个组合的完整代价：她猜不到，你觉得她不在乎，而你从来没说。",
        "warn": "有个好消息：Savitsky & Gilovich（2003）发现，光是把透明度错觉这件事讲清楚，就能降低演讲者的焦虑、提升他们的表现。所以知道这个偏差本身就有用，不只是在理论上对。但也要说清楚：这不是让你什么都往外说——判断标准是「你有没有在期待对方猜中」，有那个期待就要开口，没有就不用。",
        "apply": {
            "q": "你连着加了四天班，她问你晚上想做什么。你说了「都行」。按这一课，接下来最可能发生什么？",
            "options": [
                "她听出你累了，会主动安排在家休息",
                "她按自己的喜好安排了出门，你去了但全程没精神，然后觉得自己不被体谅",
                "她会追问你到底怎么了",
                "她会生气，因为你敷衍她",
            ],
            "answer": 1,
            "why": "B 是这套组合最常见的走向：她猜不到（3% 那个数字），于是按自己的理解安排；你带着那个没被说出口的期待赴约，然后觉得委屈。而委屈的对方根本不知道发生了什么——你从没给过她这条信息。A 是透明度错觉本身在替你做决定：你觉得「她应该知道」。C 和 D 都把责任推给了她，而问题在于你没说。",
        },
    },
    {
        "id": "p21", "series": "关系心理学", "level": "B",
        "title": "幽默有两个方向，你用哪个",
        "read": "幽默不是一种东西。研究里通常分成四类，其中两类和关系质量的关系正好相反：**亲和型**（共同的、把气氛往下带的玩笑）和关系满意度是正相关的；**自我贬损型**（拿自己开涮来化解尴尬、盖住真实感受）是负相关的。判断你常用哪一类，只要看一道题就够，这道题几乎是这个画像的原话：「如果我遇到问题或不开心，我常用开玩笑盖过去，以至于连最亲近的朋友都不知道我真实感受。」更具体的一条证据：在冲突场景里，亲和型幽默能增加笑声、减少愤怒、提升对解决过程的满意度；而自我贬损型**不能消气，反而让本就难受的一方更生气**。原因不难理解——她认真开口，收到一个玩笑，等于被告知这件事不值得认真对待。",
        "warn": "这不是说自嘲不能用。自嘲在破冰、化解别人的尴尬、接住自己的失误上都非常有效，很多人就是靠这个受欢迎的。要改的只有一种场景：**当对方在认真地跟你谈一件重要的事，或者你自己心里有真实感受想说的时候**。那时候用幽默挡一下，代价最大。另外别把它变成禁令——「不许自嘲」这种禁止式的自我要求本身就会让你紧张。",
        "apply": {
            "q": "她想跟你聊「不确定关系往哪走」，你心里一紧，脱口而出「哈哈，是不是要跟我分手了？」。按这一课，这一句最可能造成什么？",
            "options": [
                "气氛缓和了，大家可以轻松聊下去",
                "她会觉得这件事在你这里不重要——你把自己的在意说成了没当真",
                "她会松一口气，因为你也没那么认真",
                "没什么影响，反正接下来还能聊正题",
            ],
            "answer": 1,
            "why": "B 是这类玩笑的核心代价：它传达的不是「我轻松」，是「这件事不值得认真对待」。她鼓起勇气开口前是有酝酿的，收到玩笑之后最可能的反应不是继续，而是把话咽回去。A 和 D 都假设玩笑之后谈话会自然回到正题——但正题需要一个接住的动作，玩笑恰好省掉了那个动作。C 把玩笑理解成真心话，方向正好反了。",
        },
    },
]


def main() -> None:
    data = json.loads(CURRICULUM.read_text(encoding="utf-8"))
    lessons = data["lessons"]
    have = {l["id"] for l in lessons}
    added = [l for l in NEW if l["id"] not in have]
    if not added:
        print("都已存在")
        return

    errs = []
    for l in added:
        for k in ("id", "series", "level", "title", "read", "warn", "apply"):
            if not l.get(k):
                errs.append(f"{l['id']} 缺字段 {k}")
        a = l["apply"]
        if len(a["options"]) != 4:
            errs.append(f"{l['id']} 选项不是 4 个")
        if not isinstance(a["answer"], int) or not 0 <= a["answer"] < 4:
            errs.append(f"{l['id']} answer 越界")
        if len(l["read"]) < 180:
            errs.append(f"{l['id']} read 太短")
    if errs:
        for e in errs:
            print("  " + e)
        sys.exit("校验失败，未写回")

    lessons.extend(added)
    data["version"] = int(data.get("version", 1)) + 1
    CURRICULUM.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    from collections import Counter
    print(f"已加入 {len(added)} 课，共 {len(lessons)} 课（version {data['version']}）")
    print("series:", dict(Counter(l["series"] for l in lessons)))
    for l in added:
        print(f"  {l['id']} [{l['series']}/{l['level']}] {l['title']} (read {len(l['read'])} 字)")


if __name__ == "__main__":
    main()
