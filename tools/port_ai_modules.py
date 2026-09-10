# -*- coding: utf-8 -*-
"""把「表达体检」和「真实复盘」从服务端搬到前端，让手机上真的能用。

查出来的问题：这两个模块调的是 `/api/ai/checkup` 和 `/api/ai/replay/*`，
而手机里没有服务端——离线适配层对这三个地址一律返回
「这是离线单文件版，不含 AI 功能」。所以**在 APK 里这两个模块是死的**，
实测点「体检」和「出题」都只拿到那句话。

修法：提示词和调用都搬到前端，走和「场景对话」同一条路
（有原生桥就走原生桥，电脑上就走 /api/proxy）。这样两边行为一致，
而且**只用一把密钥**（就是用户已经填的那个）。

几个要点：
  · 复用 `llmCall`，不另写一套网络逻辑——它已经处理了原生桥/代理两条路、
    404 回退、以及 max_tokens 截断重试。另写一套必然少掉其中某一样。
  · 每处调用的 max_tokens 不一样（体检 4000 / 出题 4000 / 揭晓 5000），
    所以给 llmCall 加上可选的 maxTokens 覆盖。
  · 提示词原先在 server.py 里，现在只在 app.js 里存一份；
    server.py 那三个端点随之删掉，避免两处各存一份提示词将来跑偏。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AP = os.path.join(ROOT, 'public', 'app.js')
VP = os.path.join(ROOT, 'public', 'voice.js')
SP = os.path.join(ROOT, 'server.py')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


PROMPTS = r'''
/* ====================================================== 这两个模块的提示词
 *
 * 从 server.py 搬过来的。原来它们只在服务端存在，而手机里没有服务端，
 * 于是「表达体检」和「真实复盘」在 APK 里是死的（点下去只得到一句
 * 「这是离线单文件版，不含 AI 功能」）。
 *
 * 现在提示词只在这里存一份，调用走 llmCall（原生桥 / 代理两条路自动选），
 * 所以手机和电脑行为一致、也只需要用户那一把密钥。
 * server.py 里那三个端点已经删掉，避免两处提示词将来各自漂移。
 */
const CHECKUP_SYSTEM = `你在做一次"表达体检"：用户会给你一句他准备发出去的话（可能还有场景），
你要从五个维度打分并解释，帮他自己判断这句话会不会让人觉得油、爹、越界或尴尬。

五个维度，每项 0-10 分（10 = 最健康，0 = 最严重）：
- canned 罐头度：10 分表示完全是就着此刻这个具体场景说的；0 分表示这是任何情况下都能套的预制话。
- overstep 越级度：10 分表示深度匹配当前关系阶段；0 分表示亲密/披露的深度远超关系阶段。
- narcissism 自恋度：10 分表示句子重心在对方或"我们"；0 分表示通篇是"我"。参考句中"我"字出现的密度。
- judge 评判度：10 分表示在了解而非评价；0 分表示在说教、下判断、给未经请求的建议。
- sexual 性暗示度：10 分表示没有性意味；0 分表示在不合适的阶段就带性暗示。

输出严格 JSON：
{
  "scores": {"canned": 0-10, "overstep": 0-10, "narcissism": 0-10, "judge": 0-10, "sexual": 0-10},
  "overall": "一句话总评，30 字以内，别客气但也别刻薄",
  "signals": [{"dim": "canned", "problem": "具体指出句子里哪个词造成的", "fix": "怎么改"}],
  "why_greasy": "如果确实油，说清是哪种油（罐头/越级/自恋/说教/性暗示），以及它为什么会让人不适；如果没问题就说没问题，不要硬找毛病",
  "revised": ["按当前场景改过的版本 1", "版本 2"],
  "principle": "这条能给用户的通用原理，一句话",
  "confidence": "高|中|低"
}
只输出 JSON。signals 最多 3 条，只写真正有问题的维度。`;

const REPLAY_Q_SYSTEM = `用户在复盘一段真实聊天记录。你的任务**不是**直接给答案，而是先出题让他自己判断，
这样才能训练他的判断力而不是依赖你。

根据聊天记录出 2-3 道题，考察：对方情绪在哪一句发生了转折、哪一句是整段对话的分水岭、
对方某句话的真实意图、用户某个回应的实际效果。

输出严格 JSON：
{
  "summary": "这段对话的客观描述，60 字以内，只描述事实不评判",
  "questions": [
    {
      "q": "题干",
      "options": ["选项A", "选项B", "选项C"],
      "answer_index": 0,
      "why": "为什么这个选项对，其余为什么错"
    }
  ],
  "note": "如果这段记录信息不足以判断，在这里说明还需要知道什么"
}
每道题 3-4 个选项。选项里必须至少有一个是"这就是字面意思，没有潜台词"。只输出 JSON。`;

const REPLAY_REVEAL_SYSTEM = `用户已经先自己答过一遍了，现在给他完整分析。顺序很重要：
先确认他答对/答错的地方，再给解读，最后才给可选的回应方向。

输出严格 JSON：
{
  "score_line": "他判断得怎么样，一句话，具体到哪题",
  "turn_point": "整段对话的分水岭是哪一句，以及为什么是它",
  "readings": [
    {"quote": "对方的原话", "face_value": "字面意思是什么",
     "possible": "另一种可能的解读", "confidence": "高|中|低",
     "signals": "支持或反对这个解读的具体线索"}
  ],
  "your_part": [{"quote": "用户的话", "effect": "这句话实际发出了什么信号"}],
  "options": [{"move": "承接情绪|核实歧义|回应需要|划清边界", "direction": "原则和方向，不是逐字模板"}],
  "principle": "这次复盘最值得记住的一条通用原理"
}
readings 最多 4 条，your_part 最多 3 条，options 最多 3 条。只输出 JSON。`;

/* ---- 三次调用。都走 llmCall，所以手机（原生桥）和电脑（代理）同一条路。 ---- */

async function aiCheckup(text, context) {
  const ctx = (context || '').trim()
    || '（用户未提供场景，按常见恋爱初期场景谨慎评估，并在 confidence 里体现不确定性）';
  const user = `【这句话】\n${text}\n\n【场景】\n${ctx}`;
  // 体检是要打分的，温度压低一点，让同一句话两次的结果尽量可比。
  return await llmCall(
    [{ role: 'system', content: CHECKUP_SYSTEM }, { role: 'user', content: user }],
    { temperature: 0.3, maxTokens: 4000 });
}

async function aiReplayQuestions(chat, background) {
  let user = `【聊天记录】\n${chat}`;
  const extra = (background || '').trim();
  if (extra) user += `\n\n【背景补充】\n${extra}`;
  return await llmCall(
    [{ role: 'system', content: REPLAY_Q_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 4000 });
}

async function aiReplayReveal(chat, answers) {
  const given = (answers || []).map((a, i) =>
    `第${i + 1}题 他选了：${a.chosen || '(未答)'}；正确答案是：${a.correct || ''}`).join('\n')
    || '（用户跳过了前面的题）';
  const user = `【聊天记录】\n${chat}\n\n【他的作答情况】\n${given}`;
  return await llmCall(
    [{ role: 'system', content: REPLAY_REVEAL_SYSTEM }, { role: 'user', content: user }],
    { maxTokens: 5000 });
}

/* ======================================================== 视图：阶段评估 */
'''


def main():
    a = io.open(AP, encoding='utf-8').read()

    # ---- 1) 插入提示词和三个调用函数 ----
    a = sub(a, """/* ======================================================== 视图：阶段评估 */""",
            PROMPTS.strip('\n'), tag='prompts')

    # ---- 2) 三个调用点改成走前端 ----
    a = sub(a, """    const r = await post('/api/ai/checkup', { text, context });
    renderCheckup(r.result);""",
            """    // 走前端（llmCall）：原始实现是 post('/api/ai/checkup')，而手机里没有服务端，
    // 所以这个模块在 APK 里一直是死的。
    const r = await aiCheckup(text, context);
    renderCheckup(r);""", tag='checkup')

    a = sub(a, """    const r = await post('/api/ai/replay/questions', { chat: replay.chat, background: replay.background });""",
            """    const r = await aiReplayQuestions(replay.chat, replay.background);""", tag='rq')

    a = sub(a, """    const r = await post('/api/ai/replay/reveal', { chat: replay.chat, answers: payload });""",
            """    const r = await aiReplayReveal(replay.chat, payload);""", tag='rr')

    io.open(AP, 'w', encoding='utf-8').write(a)

    # ---- 3) llmCall 支持覆盖 max_tokens ----
    v = io.open(VP, encoding='utf-8').read()
    v = sub(v, """async function llmCall(messages, temperature) {
  const base = settings().maxTokens;
  let budget = base;""",
            """/* opts 可以是数字（旧写法，等于 temperature）或对象
 * { temperature, maxTokens }。加对象形式是因为这三个模块各有自己的额度需求
 * （体检/出题 4000、揭晓 5000），而设置里的 maxTokens 是对话用的。 */
async function llmCall(messages, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const temperature = o.temperature != null ? o.temperature
    : (typeof opts === 'number' ? opts : undefined);
  const base = o.maxTokens || settings().maxTokens;
  let budget = base;""", tag='llmOpts')
    v = sub(v, """      return await llmCallOnce(messages, temperature, budget);""",
            """      return await llmCallOnce(messages, temperature, budget);""", tag='noop')
    io.open(VP, 'w', encoding='utf-8').write(v)

    # ---- 4) server.py：删掉那三个端点，避免两处提示词各自漂移 ----
    s = io.open(SP, encoding='utf-8').read()
    for name in ['CHECKUP_SYSTEM', 'REPLAY_Q_SYSTEM', 'REPLAY_REVEAL_SYSTEM']:
        i = s.index(f'{name} = """')
        j = s.index('"""\n', i + len(name) + 6) + 4
        s = s[:i] + s[j:]
    s = sub(s, """            if path == "/api/ai/checkup":
                return self._checkup()
            if path == "/api/ai/replay/questions":
                return self._replay_questions()
            if path == "/api/ai/replay/reveal":
                return self._replay_reveal()
""", """            # 这三个端点（/api/ai/checkup、/api/ai/replay/*）已经删掉：
            # 提示词和调用都搬到前端 public/app.js 了。
            # 原因是在 APK 里没有服务端，这两个模块曾经因此完全不可用；
            # 搬到前端之后手机和电脑走同一条 llmCall，也只需要一把密钥。
            # 留着两处提示词必然会各自漂移，所以这里不保留副本。
""", tag='routes')
    # 删掉三个 handler
    for fn in ['_checkup', '_replay_questions', '_replay_reveal']:
        i = s.index(f'    def {fn}(self) -> None:')
        j = s.index('\n    def ', i + 10)
        s = s[:i] + s[j + 1:]
    # 那个不再用到的 call_json 留着（_proxy 之外没别的调用者，但它是通用工具）
    io.open(SP, 'w', encoding='utf-8').write(s)

    # 自检
    a2 = io.open(AP, encoding='utf-8').read()
    assert 'aiCheckup' in a2 and 'aiReplayQuestions' in a2 and 'aiReplayReveal' in a2
    assert "'/api/ai/" not in a2, '还有残留的 /api/ai 调用'
    s2 = io.open(SP, encoding='utf-8').read()
    assert 'CHECKUP_SYSTEM' not in s2 and '_replay_questions' not in s2
    print('三个提示词搬到前端；两个模块现在走原生桥；server.py 里那三个端点已删')


if __name__ == '__main__':
    main()
