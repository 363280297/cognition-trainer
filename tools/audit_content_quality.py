"""内容库自检：把 data/*.json 当成**会出错的产品**来查，而不是当成配置。

为什么要有这个：用户看过 App 之后说「那些资料库，你要自己核对一下，是否真的
正确，我看到有一些问题，比如说人称混乱」。他说的没错——查下来真的有一条：
`scenarios.json` 里 s7（男上级）和 s8（男同事）的正文通篇是「他」，
但**没有 `ta` 字段**，而代码里 `ta` 缺省就是「她」（voice.js:1955 `ta()`，
app.js 侧同理）。于是打开这两局，界面上会把一个 40 岁的男上级叫成「她」。

这类错误靠单元测试发现不了：JSON 结构完全合法、字段都在、没有报错，
只有**把内容和代码的约定放在一起比**才会露出来。所以这里逐条比：

  A. 结构完整性（id 唯一、选项自洽、引用能解析）
  B. 人称/性别（场景的 ta 与正文是否一致；卡片是否把对方的性别写死又说混）
  C. 文本卫生（占位符、露出的 markdown、首尾空白、可疑截断）
  D. 重复（同一段长文本被复制到多处）

退出码非零 = 有真问题。**只报告不修改**，因为很多是判断题，得人看着改。

用法：py -3 tools/audit_content_quality.py
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
APP = os.path.join(ROOT, 'public', 'app.js')

problems = []      # (级别, 文件, 说明)
notes = []         # 只供参考、不算错的观察


def bad(f, msg):
    problems.append(('ERR', f, msg))


def warn(f, msg):
    problems.append(('WARN', f, msg))


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as fh:
        return json.load(fh)


def genres_from_ui():
    """从 app.js 读 GENRES——单一来源，别在这里再抄一份。"""
    src = open(APP, encoding='utf-8').read()
    m = re.search(r'const GENRES\s*=\s*\[([^\]]+)\]', src)
    if not m:
        return None
    return [x.strip().strip("'\"") for x in m.group(1).split(',') if x.strip()]


# ---------------------------------------------------------------- A 结构
def check_ids(files):
    for name, key, arr in files:
        ids = [it.get('id') for it in arr]
        dup = [i for i, n in Counter(ids).items() if n > 1]
        if dup:
            bad(name, f'{key} 里有重复 id：{dup}')
        if any(i is None for i in ids):
            bad(name, f'{key} 里有 {ids.count(None)} 项没有 id')


def check_cards():
    cards = load('cards.json')['cards']
    genres = genres_from_ui()
    stages = {s['id'] for s in load('stages.json')['stages']}
    stages |= {s.get('key') for s in load('stages.json')['stages']}
    for c in cards:
        cid = c.get('id')
        opts = c.get('options') or []
        oids = [o.get('id') for o in opts]
        if len(opts) < 2:
            bad('cards.json', f'{cid} 只有 {len(opts)} 个选项，没法当选择题')
        if len(set(oids)) != len(oids):
            bad('cards.json', f'{cid} 的选项 id 有重复：{oids}')
        if c.get('best') not in oids:
            bad('cards.json', f'{cid} 的 best={c.get("best")!r} 不在选项 {oids} 里')
        for o in (c.get('ok') or []):
            if o not in oids:
                bad('cards.json', f'{cid} 的 ok 里 {o!r} 不是任何一个选项')
        if c.get('best') in (c.get('ok') or []):
            warn('cards.json', f'{cid} 的 best 同时也在 ok 里，会同时算「最好」和「也算」')
        if genres is not None:
            for g in [c.get('genre')] + list(c.get('genreAlt') or []):
                if g and g not in genres:
                    bad('cards.json',
                        f'{cid} 的局「{g}」不在界面的 GENRES 里 → 用户永远选不中，'
                        f'这题不可能判对（达标改成「判对才算」之后这条会直接卡住进度）')
        if c.get('genre') and not c.get('state'):
            warn('cards.json', f'{cid} 有 genre 但没有 state，反馈页讲不清这局是什么')
        if c.get('genreAlt') and not c.get('genre'):
            bad('cards.json', f'{cid} 有 genreAlt 却没有 genre')

    # 「读局卡」和「有读局步骤」必须是同一件事。
    #
    # 这条不变量是补 r05 时才想清楚的：README 写着 84 张里「12 张『读局』」，
    # `type='read'` 的也正好是 12 张，但**只有 11 张有 `genre`**——缺的那张 r05
    # 的 `state` 明明白白在讲局（「这局已经落地了……球落在地上的信号」），
    # `err` 标签也全是「该停不停 / 消极解读 / 投射」。它却因此少了「这是什么局」
    # 那一步，也就不会走 2.37 新增的「必须指一句依据」，达标判定还从
    # 「读局判对」掉到「动作选对」——**同一份卡库两套标准**，而界面上不报错。
    #
    # 这和 s7/s8 那个人称 bug 是同一类：**该有的东西悄悄没有生效**。
    # 所以钉住这条不变量——它比逐张读内容便宜得多，而且正是这一类错误的样子。
    for c in cards:
        cid = c['id']
        if c.get('type') == 'read' and not c.get('genre'):
            bad('cards.json', f'{cid} 是读局卡（type=read）却没有 genre——'
                              f'「这是什么局」和「必须指一句依据」这两步都会悄悄没有')
        if c.get('genre') and c.get('type') != 'read':
            warn('cards.json', f'{cid} 有 genre 但 type={c.get("type")!r}，'
                               f'读局卡的 type 应该统一是 read')

    # 「必须选一句依据才算数」（2.37）——`clues` 这一步的数据校验。
    # 这一步是**强制**的：不指依据就看不到动作选项。所以缺了就等于那张卡
    # 悄悄跳过了这一步（用户要的东西没生效），而界面上不会有任何报错。
    for c in cards:
        cid = c['id']
        clues = c.get('clues')
        if not clues:
            if c.get('genre'):
                bad('cards.json', f'{cid} 有读局步骤却没有 clues——'
                                  f'「必须选一句依据才算数」在这张卡上不会生效')
            continue
        if not c.get('genre'):
            bad('cards.json', f'{cid} 有 clues 却没有 genre——'
                              f'判局那一步不存在，依据这一步就没意义')
        if not (3 <= len(clues) <= 5):
            bad('cards.json', f'{cid} 的依据有 {len(clues)} 条（要 3~5 条）')
        ok_n = sum(1 for x in clues if x.get('ok'))
        if not (1 <= ok_n <= 2):
            bad('cards.json', f'{cid} 的正确依据有 {ok_n} 条（要 1~2 条）')
        texts = [str(x.get('text') or '') for x in clues]
        if any(not t.strip() for t in texts):
            bad('cards.json', f'{cid} 有空的依据文本')
        if len(set(texts)) != len(texts):
            bad('cards.json', f'{cid} 的依据有重复')
        # 依据不能和动作选项撞句子（撞了就像在提前泄题，读起来也怪）
        opt_texts = {str(o.get('text') or '') for o in (c.get('options') or [])}
        same = [t for t in texts if t in opt_texts]
        if same:
            bad('cards.json', f'{cid} 的依据和动作选项文本一样：{same[:1]}')

    # 关于 card.stage：这里**故意不**拿它去比 stages.json。
    # 第一版比了，报出 84 条「stage 在 stages.json 里找不到」——全是误报：
    # 两个 stage 是两个概念。cards 里的是**关系阶段**（陌生初见/认识试探/熟络/
    # 在一起磨合/共事/老朋友…），stages.json 里的是 **6 个关卡**
    # （摸底/字面与言外之意/认出偏向/接住/变成动作/保持）。
    # 一个嘈杂的检查会盖住真问题——那次真问题只有 2 条，淹没在 84 条噪声里。
    # 所以这里只把词汇表打出来供人看，不做断言。
    rel = Counter(c.get('stage') for c in cards if c.get('stage'))
    notes.append(('cards.json',
                  f'关系阶段词汇表（{len(rel)} 种，供人工看有没有近义重复）：'
                  + '、'.join(f'{k}×{v}' for k, v in rel.most_common())))


def check_calibration():
    cal = load('calibration.json')
    verdicts = set(cal['verdicts'].keys())
    for p in cal['phrases']:
        cases = p.get('cases') or []
        if not cases:
            bad('calibration.json', f'{p["id"]} 没有任何 cases')
        for c in cases:
            if c.get('verdict') not in verdicts:
                bad('calibration.json',
                    f'{p["id"]}/{c.get("id")} 的 verdict={c.get("verdict")!r} 不在 {sorted(verdicts)} 里')
            # 判定「改说法才能说」就必须给出改后的说法，否则界面上一片空白
            if c.get('verdict') == 'revise' and not c.get('revised'):
                bad('calibration.json', f'{p["id"]}/{c.get("id")} 判 revise 却没给 revised')
            if not c.get('why'):
                warn('calibration.json', f'{p["id"]}/{c.get("id")} 没有 why')


def check_signal():
    sig = load('signal.json')
    items = sig['items']
    kinds = Counter(i.get('kind') for i in items)
    print(f"      信号场：{dict(kinds)}，每局 {sig['rounds_per_play']} 轮、"
          f"每类 {sig['per_class_per_play']} 个")
    need = sig['per_class_per_play']
    for k, n in kinds.items():
        if n < need:
            bad('signal.json', f'kind={k} 只有 {n} 个，不够一局要的 {need} 个')
    for i in items:
        if i.get('kind') == 'noise' and not i.get('settle'):
            warn('signal.json', f'{i["id"]} 是 noise 但没有 settle（反馈页要说清为什么不是信号）')
        if i.get('kind') == 'signal' and i.get('settle'):
            warn('signal.json', f'{i["id"]} 是 signal 却写了 settle')
        if not isinstance(i.get('exclusive'), bool):
            bad('signal.json', f'{i["id"]} 的 exclusive 不是布尔值（记分要用）')


def check_id_namespace(files):
    """id 是跨文件的**全局名**，撞名 = 静默拿错数据。

    这个洞真的发生过：signal.json 里 11 道 thin 题原来叫 t01…t12，而 cards.json 的
    「怎么接话」卡也叫 t01…t10。今天没事（信号题的 id 不进 state，没人在两张表之间查），
    但只要哪天有人拿信号题的 id 去 CONTENT.cards.cards.find(...)，就会拿到一张接话卡、
    而且**不报错**——正是最难看出来的那种 bug。所以这里钉死：一个 id 只能出现在一个文件里。
    """
    seen = {}
    for fname, key, rows in files:
        for r in rows:
            i = str(r.get('id'))
            if not i or i == 'None':
                continue
            seen.setdefault(i, []).append(fname)
    for i, fs in sorted(seen.items()):
        if len(set(fs)) > 1:
            bad('id 命名空间', f'id「{i}」同时出现在 {sorted(set(fs))}——'
                              '这个名字指向两样东西，查表时会静默拿错')

    # 同一种 kind 用一个前缀（signal=x / base=n / thin=e）：撞名前缀不会互撞，
    # 而是让人一眼看出这是哪一类。所以只算提示，不算错误。
    rows = next((r for f, k, r in files if f == 'signal.json'), [])
    by_kind = {}
    for it in rows:
        by_kind.setdefault(it.get('kind'), []).append(str(it['id']))
    for k, ids in sorted(by_kind.items(), key=lambda kv: str(kv[0])):
        pre = {i[0] for i in ids}
        if len(pre) > 1:
            warn('signal.json', f'kind={k} 里混用了前缀 {sorted(pre)}：{sorted(ids)[:8]}')


# ------------------------------------------------------- B 人称 / 性别
MALE = re.compile(r'(你爸|爸爸|父亲|男的|男性|上级|老板|领导|他知道|他说|他怕|他不想|'
                  r'他在意|他已经|他其实|他会|他能|他真正|他刚|他沉默|他愿意|他很少|他心里|他在赌|他讨厌)')
FEMALE = re.compile(r'(你妈|妈妈|母亲|女的|女性|女朋友|她|姑娘)')


def check_gender():
    """这条就是用户说的那个人称 bug。判据：正文明显在讲男性、却没有 ta='他'。

    代码的约定（voice.js:1955 / 2224）：`ta` 缺省是「她」。
    所以「正文是男的 + 没有 ta」= 界面会把这个人叫成「她」。
    """
    sc = load('scenarios.json')['scenarios']
    for s in sc:
        body = ' '.join(str(s.get(k) or '') for k in
                        ['her', 'her_state', 'title', 'opening', 'trap', 'goal'])
        has_m = bool(MALE.search(body))
        has_f = bool(FEMALE.search(body))
        ta = s.get('ta')
        if has_m and not has_f:
            if ta != '他':
                bad('scenarios.json',
                    f'{s["id"]}（{s.get("title")}）正文讲的是男性，'
                    f'但 ta={ta!r} → 界面上会显示「她」。缺 ta 时默认就是「她」')
        elif has_f and not has_m:
            if ta not in (None, '她'):
                bad('scenarios.json', f'{s["id"]} 正文是女性但 ta={ta!r}')
        elif has_m and has_f:
            warn('scenarios.json', f'{s["id"]} 正文同时出现他/她（可能是第三方角色），需人工看一眼')

    # 卡片的对方性别：**这里只挑最硬的一类证据**——场景里明确说「女朋友」却说「他」，
    # 或者明确说「男朋友/男性」却说「她」。
    #
    # 第一版写得很松（「出现男性角色 + 出现她」就报），结果 f05 被误报：
    # 那张卡的对方是女性（「认识三年的女性朋友」），「男朋友」只是她吵架的对象，
    # 是第三方角色。松判据会产生大量误报，而误报会让这份审计失去可信度——
    # 真出问题的时候就没人看了。所以宁可只抓最确定的。
    cards = load('cards.json')['cards']
    for c in cards:
        blob = ' '.join(str(c.get(k) or '') for k in
                        ['context', 'quote', 'question', 'state', 'principle', 'action', 'explain'])
        if '女朋友' in blob and re.search(r'他(的|在|说|怕|会|能|想)', blob):
            warn('cards.json', f'{c["id"]} 说了「女朋友」却也在用「他」，人工看一眼人称')
        if re.search(r'(男朋友|一个男的)', blob) and '她' in blob and '男朋友' not in blob:
            warn('cards.json', f'{c["id"]} 出现男性角色却又用「她」，人工看一眼人称')


# ------------------------------------------------------------ C 文本卫生
PLACEHOLDER = re.compile(r'(TODO|TBD|FIXME|待补|待填|占位|xxx|XXX|\.\.\.\.|？？|！！)')
CJK = re.compile(r'[\u4e00-\u9fff]')
TEXT_FIELDS = ['context', 'quote', 'question', 'state', 'principle', 'action', 'explain',
               'why', 'trap', 'cue', 'her', 'her_state', 'title', 'goal', 'opening',
               'issue', 'phrase', 'read', 'apply', 'warn', 'name', 'desc',
               'capability', 'gateText', 'sub', 'how', 'when', 'example', 'skeleton']


def walk(obj, path, out):
    """把所有字符串字段捞出来，带路径，方便报告定位。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            walk(v, f'{path}.{k}' if path else k, out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            walk(v, f'{path}[{i}]', out)
    elif isinstance(obj, str):
        out.append((path, obj))


def check_text():
    star_files = set()
    for name in sorted(os.listdir(DATA)):
        if not name.endswith('.json') or name == 'progress.json':
            continue
        strs = []
        walk(load(name), '', strs)
        for path, s in strs:
            if not s.strip():
                continue
            if PLACEHOLDER.search(s):
                warn(name, f'{path} 里有占位符：{s[:50]!r}')
            # 露出的 markdown：** 在 rich() 里会变 <b>，但纯文本位置会原样显示
            if '**' in s:
                star_files.add(name)
            if s != s.strip():
                warn(name, f'{path} 首尾有空白：{s[:30]!r}')
            # 可疑截断：以逗号/顿号结尾，或中文句子里突然断掉
            if CJK.search(s) and re.search(r'[，、；：]$', s):
                warn(name, f'{path} 以逗号结尾，像是被截断：…{s[-30:]!r}')
    # `**` 只按文件汇总一次。逐个列出来会刷出 150 多行，把真问题冲掉；
    # 而且大部分是安全的（走 rich() 的位置会渲染成粗体）。
    if star_files:
        notes.append(('，'.join(sorted(star_files)),
                      '这些文件里有 ** 标记：走 rich() 会渲染成粗体，'
                      '但插进纯文本位置就会原样露出 **（项目里为这一类加过断言）'))


def check_dupes():
    """同一段长文本出现在多处 —— 多半是复制粘贴时忘了改。"""
    seen = defaultdict(list)
    for name in sorted(os.listdir(DATA)):
        if not name.endswith('.json') or name == 'progress.json':
            continue
        strs = []
        walk(load(name), '', strs)
        for path, s in strs:
            if len(s) >= 60 and CJK.search(s):
                seen[s].append(f'{name}:{path}')
    for s, where in seen.items():
        if len(where) > 1:
            locs = ', '.join(w.split(':')[0] for w in where)
            if len(set(locs)) > 1 or len(where) > 1:
                warn(where[0].split(':')[0],
                     f'同一段 {len(s)} 字的内容出现在 {len(where)} 处：{where[:3]}'
                     f' → 「{s[:36]}…」')


def check_readme_stats(cards):
    """README 里写的统计数，必须和数据对得上。

    为什么：README 里原来写着「`ok` 为空的卡目前是 11 张」——**实际是 51 张**，
    多半是后来扩题库时没回头改。文档里写死的数字就是会过期的东西，
    而这个项目已经栽过一次（「文档里留着一个已经不存在的功能，比没有文档更糟」）。
    所以照「版本号三处一致」的做法把数字也钉住：数据一变这条就红，
    逼着改数据的人顺手把文档改对。
    """
    readme_path = os.path.join(ROOT, 'README.md')
    if not os.path.exists(readme_path):
        return
    readme = open(readme_path, encoding='utf-8').read()
    # **先剥掉 markdown 标记再比**。README 里的数字是加粗的（`**` 和反引号夹在
    # 句子中间），第一版直接拿原文找，于是**正确的 README 也报错**，
    # 而那个报错看起来像是"数字对不上"——实际是格式问题。
    # 更糟的是它让负向验证变得没有意义：改错数字和没改错都报同一句，
    # 分不出断言到底管不管用。（同一天里第三次栽在"检查扫的不是我以为的东西"上。）
    plain = re.sub(r'[*`]', '', readme)
    opt = Counter(len(c.get('options') or []) for c in cards)
    okl = Counter(len(c.get('ok') or []) for c in cards)
    claims = [
        (f'ok 为空的卡（3 个干扰项、区分度最好）是 {okl.get(0, 0)} 张', 'ok 为空的卡'),
        (f'{okl.get(2, 0)} 张卡只剩 1 个干扰项', 'ok=2'),
        (f'{okl.get(3, 0)} 张剩 0 个', 'ok=3'),
    ]
    for want, label in claims:
        if want not in plain:
            bad('README.md', f'卡片统计对不上（{label}）：README 里找不到「{want}」'
                             f' → 数据变了就要顺手改 README，两边必须一致'
                             f'（实际分布：ok 个数 {dict(sorted(okl.items()))}）')
    if len(opt) != 1:
        notes.append(('cards.json', f'选项数不再统一：{dict(opt)}'
                                    f' → README 里「84 张卡都是 4 个选项」这句要跟着改'))


def main():
    print('=' * 74)
    print('内容库自检（只报告，不修改）')
    print('=' * 74)

    cards = load('cards.json')['cards']
    files = [
        ('cards.json', 'cards', cards),
        ('calibration.json', 'phrases', load('calibration.json')['phrases']),
        ('curriculum.json', 'lessons', load('curriculum.json')['lessons']),
        ('recovery.json', 'modes', load('recovery.json')['modes']),
        ('scenarios.json', 'scenarios', load('scenarios.json')['scenarios']),
        ('signal.json', 'items', load('signal.json')['items']),
        ('stages.json', 'stages', load('stages.json')['stages']),
        ('talkhints.json', 'moves', load('talkhints.json')['moves']),
        ('chat.json', 'cases', load('chat.json')['cases']),
    ]
    print('\n[A] 结构')
    check_ids(files)
    check_cards()
    check_calibration()
    check_signal()
    check_id_namespace(files)
    print('     卡片 %d 张 / 校准 %d 条 / 微课 %d 条 / 场景 %d 个 / 信号 %d 题'
          % (len(cards), len(files[1][2]), len(files[2][2]),
             len(files[4][2]), len(files[5][2])))

    print('[B] 人称 / 性别')
    check_gender()

    print('[E] README 里写的统计数对不对')
    check_readme_stats(cards)

    print('[C] 文本卫生')
    check_text()

    print('[D] 重复内容')
    check_dupes()

    print()
    print('=' * 74)
    errs = [p for p in problems if p[0] == 'ERR']
    warns = [p for p in problems if p[0] == 'WARN']
    for lvl, f, msg in problems:
        print(f'  {lvl:4} {f:18} {msg}')
    if notes:
        print(f'\n  （另有 {len(notes)} 处提示，例如：）')
        for f, msg in notes[:6]:
            print(f'   注意 {f:18} {msg}')
    print('=' * 74)
    print(f'结果：错误 {len(errs)} · 警告 {len(warns)}' + ('' if not errs else ' ← 见上面的 ERR 行'))
    sys.exit(1 if errs else 0)


if __name__ == '__main__':
    main()
