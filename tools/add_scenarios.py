# -*- coding: utf-8 -*-
"""给 data/scenarios.json 追加一批现成情景（6 → 14）。

为什么要有这个脚本：JSON 里有中文引号、破折号，手工在编辑器里补容易把格式弄坏，
而这份文件是**内容**，坏了以后表现为「某个场景少一个字段」，界面上就是一片空白。
脚本里 append 完立刻校验一遍（字段齐、difficulty 是整数、opening 不太长），
过不了就整体不写。

已经有 s1..s6 了，这里加 s7..s14——每个都挑了**不同的关系 + 不同的错法**，
不是同一个东西换句话：上下级的时限、平级的推活、父母的催、父亲生病瞒着、
朋友半夜失恋、伴侣的试探、当众打听收入、邻居搭话。
"""
import io
import json

PATH = 'data/scenarios.json'

NEW = [
    {
        "id": "s7",
        "title": "临下班，上级丢来一个明早要的东西",
        "stage": "职场上下",
        "difficulty": 2,
        "her": "你的直属上级，40 岁上下，说话快、只看结果。他知道这个时间不合理，但上面压着他，他不想解释。",
        "her_state": "他也不喜欢这么安排。他真正在意的是「你会不会先把事接住，再说困难」——他最烦的是当场被顶回来。",
        "opening": "这个明天早上九点前要，你先顶一下。",
        "goal": "把时间不合理这件事说清楚，同时让他觉得你在把事往前推。",
        "trap": "最常见的错法：当场一句「这不可能」把球打回去；或者一声不响接下来，第二天交不出来。",
    },
    {
        "id": "s8",
        "title": "平级同事把该他做的活推过来",
        "stage": "职场平级",
        "difficulty": 2,
        "her": "同组同事，比你早来一年，平时关系还行，一起吃午饭那种。",
        "her_state": "他心里知道这是他的活。他在赌你不好意思拒绝——你越含糊，他越会往下推。",
        "opening": "你顺便帮我看一眼这个吧，你比我熟。",
        "goal": "把这件事挡回去，但不把关系弄僵（以后还要一起干活）。",
        "trap": "最常见的错法：含糊答应，然后自己憋着；或者讲一堆道理证明这是他的活（赢了道理，输了关系）。",
    },
    {
        "id": "s9",
        "title": "妈妈又提起「什么时候带个人回来」",
        "stage": "家人日常",
        "difficulty": 2,
        "her": "你妈，55 岁，快退休了，嘴上唠叨、心里疼你。她一说这种事就绕，从来不直说。",
        "her_state": "她不是非要你结婚。她怕的是自己老了帮不上你，也怕你以后一个人。她真正想听的是「你过得还行」。",
        "opening": "楼下那个阿姨的女儿上个月结婚了，你不知道吧。",
        "goal": "接住她话底下的担心，同时把这件事的主动权留在自己手里。",
        "trap": "最常见的错法：敷衍一句「知道了」把话题掐掉；或者反过来讲道理让她别管你的事。",
    },
    {
        "id": "s10",
        "title": "爸爸住院了，却不肯跟你说实话",
        "stage": "家人日常",
        "difficulty": 3,
        "ta": "他",
        "her": "你爸，60 岁，一辈子报喜不报忧。你们平时话不多，他觉得男人说这些没用。",
        "her_state": "他怕你担心，更怕你嫌他麻烦、怕自己<没用>。他在意的是还能不能自己扛住这件事。",
        "opening": "没什么大事，就是住两天观察观察，你忙你的。",
        "goal": "让他愿意说实话，而不是把关心变成审问。",
        "trap": "最常见的错法：追着问病情细节；或者反过来责备他「怎么不早说」——他会立刻把话收回去。",
    },
    {
        "id": "s11",
        "title": "朋友半夜失恋，只发来一句「在吗」",
        "stage": "朋友之间",
        "difficulty": 2,
        "ta": "他",
        "her": "认识八年的朋友，男的，嘴硬，平时不聊感情。你们可以一起骂人，不太会说软话。",
        "her_state": "他不是要你分析这段感情。他只是不想一个人待着，也说不出口「陪陪我」。",
        "opening": "在吗？没事，就是睡不着。",
        "goal": "让他在你这儿待得住——先接住人，别急着给结论。",
        "trap": "最常见的错法：立刻开始分析对方哪里不对，或者说「这种人分了也好」（他要的不是审判，是有人陪着）。",
    },
    {
        "id": "s12",
        "title": "她说「你最近是不是不太想理我」",
        "stage": "在一起磨合",
        "difficulty": 3,
        "her": "在一起半年的对象，25 岁，安全感不太够，但很少直接抱怨。她攒了几天的委屈才说这一句。",
        "her_state": "这句是试探，也是她最后那点耐心。她真正想确认的是「你还要不要这一段」。",
        "opening": "你最近是不是不太想理我？",
        "goal": "先接住她的感受，再谈事实——别把这一句当成指控来防。",
        "trap": "最常见的错法：立刻自证（「我哪天没回你？」），把对话变成举证；这一局一旦开始自证就赢不了了。",
    },
    {
        "id": "s13",
        "title": "聚会上被当众问收入",
        "stage": "泛社交",
        "difficulty": 2,
        "her": "朋友带来的朋友，30 多岁，爱打听、没分寸，但没有恶意。桌上还有四五个人在听。",
        "her_state": "她是随口一问，根本不关心答案。真正被评估的是「你好不好相处、会不会让人觉得下不来台」。",
        "opening": "你现在一个月能拿多少呀？我们都好奇呢。",
        "goal": "不翻脸地把这个话题关掉，还把桌上的气氛留住。",
        "trap": "最常见的错法：老实报数字（后面全是麻烦）；或者冷脸怼回去（全场尴尬，你还成了那个开不起玩笑的人）。",
    },
    {
        "id": "s14",
        "title": "电梯里遇到同层的邻居",
        "stage": "陌生初见",
        "difficulty": 1,
        "her": "住你楼上的邻居，30 多岁，独居，平时只在电梯里点过头。",
        "her_state": "她认得你，但没说过话。她在意的是「这个人会不会很麻烦」——一次舒服的寒暄就够，别越界。",
        "opening": "你们家昨天是不是也停水了？",
        "goal": "用一句具体的话把它变成一次正常的邻里招呼，而不是硬聊。",
        "trap": "最常见的错法：只回「嗯，停了」把话堵死；或者反过来硬扯到别的话题上，显得有目的。",
    },
]


def check(sc):
    bad = []
    for s in sc:
        for k in ('title', 'her', 'her_state', 'opening', 'goal', 'trap'):
            if not str(s.get(k, '')).strip():
                bad.append('%s 缺 %s' % (s.get('id'), k))
        if not isinstance(s.get('difficulty'), int):
            bad.append('%s difficulty 不是整数' % s.get('id'))
        if len(s.get('opening', '')) > 40:
            bad.append('%s opening 太长（%d 字）' % (s.get('id'), len(s.get('opening', ''))))
        if s.get('ta') not in (None, '他', '她'):
            bad.append('%s ta 只能是 他/她' % s.get('id'))
    return bad


def main():
    with io.open(PATH, encoding='utf-8') as f:
        doc = json.load(f)
    have = {s['id'] for s in doc['scenarios']}
    for s in NEW:
        if s['id'] in have:
            continue
        doc['scenarios'].append(s)
    bad = check(doc['scenarios'])
    if bad:
        raise SystemExit('不通过，没有写文件：\n  ' + '\n  '.join(bad))
    with io.open(PATH, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('场景数：%d' % len(doc['scenarios']))
    for s in doc['scenarios']:
        print('  %s %-22s %s 难度%s%s' % (s['id'], s['stage'], s['title'],
                                          s['difficulty'], ' [他]' if s.get('ta') == '他' else ''))


if __name__ == '__main__':
    main()
