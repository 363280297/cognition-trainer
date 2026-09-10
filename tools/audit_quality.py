# -*- coding: utf-8 -*-
"""内容质量审计（不是结构检查）。

tools/test_content.js 验的是**结构**：四个选项、有 why、有 plan、变体字段完整。
它验不了内容好不好——一张卡可以结构完美而内容是次品。

这个脚本查的是「次品」的几种可判定的形态：

  A. 变体只是把原句换了个说法，没有换场景。
     这是最要紧的一条，因为「多场景」正是让训练泛化的条件之一
     （Hansen 等 1989 泛化成功，Berler 等 1982 失败）。如果四条变体，
     全是同一个场景里的同一句话换措辞，那这个机制等于没生效——而它不会报错。

  B. 正确选项是最长的那个。
     长期下来会教出一种作弊策略：挑最长的。那就不是在练判断了。

  C. 一张卡里两个选项说的其实是同一件事（读起来无从下手）。

  D. 变体跨卡片重复（同一个场景出现在两张不同的卡上）。

  E. why 太短或明显是套话。

只用标准库，跑得快，可以每次改完内容都跑。
"""
import difflib
import io
import json
import os
import re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    with io.open(os.path.join(ROOT, 'data', name + '.json'), encoding='utf-8') as f:
        return json.load(f)


def sim(a, b):
    """0~1 的相似度。中文用字符级比对已经够用。"""
    return difflib.SequenceMatcher(None, a or '', b or '').ratio()


def norm(s):
    """去掉标点和空白，只留字，避免「你几点走？」和「你几点走?」被当成不同。"""
    return re.sub(r'[^\w\u4e00-\u9fff]', '', s or '')


def main():
    cards = load('cards')['cards']
    print('=' * 64)
    print('内容质量审计：%d 张卡' % len(cards))
    print('=' * 64)

    # ---------------------------------------------------------- A. 变体质量
    print('\n[A] 变体是不是真的换了场景（不是只换措辞）')
    same_context = []       # context 与原文几乎一样
    reworded = []           # quote 只换了措辞，场景没变
    for c in cards:
        for v in (c.get('variants') or []):
            sc = sim(norm(c['context']), norm(v['context']))
            if sc > 0.72:
                # context 几乎没变，那就是同一个人同一个场合；再看 quote
                sq = sim(norm(c['quote']), norm(v['quote']))
                reworded.append((c['id'], round(sc, 2), round(sq, 2), v['quote']))
            elif sc < 0.30:
                same_context.append((c['id'], round(sc, 2), v['context']))
    print('  context 与原文几乎一样（同人同场合，只换措辞）: %d 条' % len(reworded))
    for r in reworded[:8]:
        print('    %s  场景相似 %.2f / 句相似 %.2f   « %s' % (r[0], r[1], r[2], r[3][:34]))
    if len(reworded) > 8:
        print('    … 另有 %d 条' % (len(reworded) - 8))

    # 变体之间的相似度（同一张卡的变体应当互不相同）
    close_pairs = []
    for c in cards:
        vs = c.get('variants') or []
        for i in range(len(vs)):
            for j in range(i + 1, len(vs)):
                s = sim(norm(vs[i]['quote']), norm(vs[j]['quote']))
                if s > 0.80:
                    close_pairs.append((c['id'], round(s, 2), vs[i]['quote'][:22],
                                        vs[j]['quote'][:22]))
    print('  同一张卡里两条变体近乎同一句: %d 对' % len(close_pairs))
    for r in close_pairs[:8]:
        print('    %s  %.2f  « %s » vs « %s »' % r)

    # --------------------------------------------------- B. 正确选项最长
    print('\n[B] 正确选项是不是最长的那个（会教出「挑最长」的作弊策略）')
    giveaway = []
    for c in cards:
        best = next((o for o in c['options'] if o['id'] == c['best']), None)
        others = [o for o in c['options'] if o['id'] != c['best']]
        if not best or not others:
            continue
        lb = len(best['text'])
        lo = sum(len(o['text']) for o in others) / len(others)
        if lb > max(len(o['text']) for o in others):
            giveaway.append((c['id'], lb, round(lo)))
    print('  正确选项严格最长: %d / %d 张（%.0f%%）'
          % (len(giveaway), len(cards), 100.0 * len(giveaway) / len(cards)))
    worst = sorted(giveaway, key=lambda x: -(x[1] - x[2]))[:6]
    for r in worst:
        print('    %s  正确答案 %d 字 vs 其他平均 %d 字' % r)

    # --------------------------------------------- C. 卡内两个选项过近
    print('\n[C] 同一张卡里有没有两个选项说的是一件事')
    dup_opts = []
    for c in cards:
        for i in range(len(c['options'])):
            for j in range(i + 1, len(c['options'])):
                s = sim(norm(c['options'][i]['text']), norm(c['options'][j]['text']))
                if s > 0.62:
                    dup_opts.append((c['id'], c['options'][i]['id'], c['options'][j]['id'],
                                     round(s, 2)))
    print('  高度相似（>0.62）的卡内选项对: %d' % len(dup_opts))
    for r in dup_opts[:8]:
        print('    %s  %s vs %s  %.2f' % r)

    # ------------------------------------------------- D. 跨卡重复的场景
    print('\n[D] 变体在卡片之间重复')
    seen = defaultdict(list)
    for c in cards:
        for v in (c.get('variants') or []):
            seen[norm(v['quote'])].append(c['id'])
    cross = {k: v for k, v in seen.items() if len(set(v)) > 1}
    print('  同一句话出现在多张卡上: %d 组' % len(cross))
    for k, v in list(cross.items())[:5]:
        print('    « %s » → %s' % (k[:26], sorted(set(v))))

    # ------------------------------------------------------- E. why 质量
    print('\n[E] 诊断文字的长度分布（太短的多半是套话）')
    lens = [len(o['why']) for c in cards for o in c['options']]
    short = [(c['id'], o['id'], len(o['why']), o['why'][:30])
             for c in cards for o in c['options'] if len(o['why']) < 45]
    print('  why 字数: 最短 %d / 中位 %d / 平均 %d / 最长 %d'
          % (min(lens), sorted(lens)[len(lens) // 2], sum(lens) // len(lens), max(lens)))
    print('  少于 45 字的 why: %d 条' % len(short))
    for r in short[:6]:
        print('    %s.%s (%d字) %s' % r)
    expl = [len(c.get('explain') or '') for c in cards]
    print('  explain: 最短 %d / 中位 %d' % (min(expl), sorted(expl)[len(expl) // 2]))

    # ---------------------------------------------------- F. 选项数量/长度
    print('\n[F] 选项长度均衡性')
    wild = []
    for c in cards:
        ls = [len(o['text']) for o in c['options']]
        if max(ls) > 3.0 * min(ls):
            wild.append((c['id'], min(ls), max(ls)))
    print('  最长/最短超过 3 倍的卡: %d 张' % len(wild))
    for r in wild[:6]:
        print('    %s  %d ~ %d 字' % r)

    # ------------------------------------------------------------- 汇总
    print('\n' + '=' * 64)
    bad = len(reworded) + len(close_pairs) + len(dup_opts) + len(cross) + len(short)
    print('可疑项合计: %d' % bad)
    print('（B 项单独看：它不一定是错，但比例高了要处理）')
    print('=' * 64)


if __name__ == '__main__':
    main()
