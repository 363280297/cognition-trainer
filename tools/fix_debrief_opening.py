# -*- coding: utf-8 -*-
"""复盘要包含她的开场白。

截图脚本崩在一句 `V.sess.log[0].rating` 上——因为**开场白那一轮根本没进 log**。
`log` 只在真的调了一次模型之后才 push，而开场白走的是 forcedReply 那条路，
直接 return 了。

这不只是测试数据的问题。复盘要判断的是「他有没有接住对方说的东西」，
而他的第一句接的正是**开场白**；开场白不在记录里，模型就无从判断第一句
（也就是最容易被看出来有没有听进去的那一句）到底接没接上。
它能看到他的每一句话，却看不到第一句话是在回应什么。

所以把开场白作为第 0 轮补进记录。字段沿用同一套（reply / inner / userText），
不新造结构，页面上原来的逐轮记录也不会因此多出一行不存在的回合。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
TP = os.path.join(ROOT, 'tools', 'check_voice_talk.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    v = sub(v, """  const lines = sess.log.map((o, i) => {
    const r = [
      `第 ${i + 1} 轮`,
      `他说：「${o.userText || '（没说话）'}」`,
      `他回：「${o.reply || ''}」`,
      `他心里的想法：${o.inner || '（没给）'}`,
      `给他的分：${o.rating || '平'}${o.rating_why ? '——' + o.rating_why : ''}`,
    ];
    return r.join('\\n');
  }).join('\\n\\n');""", """  /* 开场白单独放在最前面。log 里没有它（forcedReply 那条路直接 return 了），
     但复盘的第一个判断就是「他的第一句有没有接上她说的」——
     缺了开场白，那句话是在回应什么就无从得知，模型只能夸他「回应及时」这种空话。 */
  const head = [
    '第 0 轮（开局，还没轮到他说）',
    `她开口：「${sc0.opening || ''}」`,
  ].join('\\n');

  const lines = sess.log.map((o, i) => {
    const r = [
      `第 ${i + 1} 轮`,
      `他说：「${o.userText || '（没说话）'}」`,
      `她回：「${o.reply || ''}」`,
      `她心里的想法：${o.inner || '（没给）'}`,
      `给他的分：${o.rating || '平'}${o.rating_why ? '——' + o.rating_why : ''}`,
    ];
    return r.join('\\n');
  }).join('\\n\\n');""", tag='transcript')

    # sc0 在函数开头就要有：原来 sc 是在后面才取
    v = sub(v, """async function makeDebrief(sess) {
  if (!sess.log.length) throw new Error('这一局没聊几句，没什么可复盘的');""",
            """async function makeDebrief(sess) {
  if (!sess.log.length) throw new Error('这一局没聊几句，没什么可复盘的');
  const sc0 = sess.sc || {};""", tag='sc0')

    v = sub(v, """  const sc = sess.sc;
  const user = [
    `场景：${sc.title}`,""", """  const sc = sess.sc;
  const user = [
    `场景：${sc.title}`,""", tag='keep')

    v = sub(v, """    '对话记录：',
    lines,""", """    '对话记录：',
    head,
    '',
    lines,""", tag='head')

    io.open(VP, 'w', encoding='utf-8').write(v)

    # 断言：复盘必须带上开场白
    t = io.open(TP, encoding='utf-8').read()
    t = sub(t, """  chk('复盘真的把用户的原话和她的内心一起送进去了',
    psys.user.includes('你担心的是哪一块') && psys.user.includes('他心里的想法'),
    '');""", """  chk('复盘真的把用户的原话和她的内心一起送进去了',
    psys.user.includes('你担心的是哪一块') && psys.user.includes('他心里的想法'),
    '');
  chk('复盘带上了她的开场白（否则判不出他第一句有没有接上）',
    psys.user.includes(GOOD.opening) && /她开口/.test(psys.user),
    '');
  chk('复盘的数据里有开场白这一轮', /第 0 轮/.test(psys.user));""", tag='assert')
    io.open(TP, 'w', encoding='utf-8').write(t)

    print('复盘现在包含开场白')


if __name__ == '__main__':
    main()
