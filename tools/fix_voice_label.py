# -*- coding: utf-8 -*-
"""给音色加一个能区分彼此的短标签。

从截图里看出来的真问题：两行都写着
    「中文（中国大陆）· 可离线 · 音质高」
只有底下那行灰色的小字（zh-cn-x-ccc-local / zh-cn-x-fff-local）不一样。
也就是说，**在一个专门用来「挑一个」的列表里，有两项看起来完全一样**——
用户只能靠一行他不认识的英文去猜，那这个列表就没起到挑的作用。

而它们确实是不同的嗓子（引擎用最后那段是 speaker 编号，ccc 和 fff 是两个人）。
所以把这一段抽出来，做成一个短标签挂在后面：`… · 音质高 · ccc`。

不能抽出可辨识段时就不加，不硬凑——不同引擎的命名规则差别很大，
猜错给错的标签比不给更糟。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')
TP = os.path.join(ROOT, 'tools', 'check_voice_pack.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    v = sub(v, """function voiceLabel(v) {
  // 音色名（zh-cn-x-ccc-local）对用户没有意义，翻成人能判断的东西
  const loc = /CN|Hans/i.test(v.locale || '') ? '中文（中国大陆）'
    : /TW|Hant/i.test(v.locale || '') ? '中文（台湾）'
      : /HK/i.test(v.locale || '') ? '中文（香港）' : (v.locale || '中文');
  const bits = [loc];
  if (v.network) bits.push('需联网');
  else bits.push('可离线');
  if (v.quality >= 500) bits.push('音质很高');
  else if (v.quality >= 400) bits.push('音质高');
  else if (v.quality >= 300) bits.push('音质中');
  return bits.join(' · ');
}""",
            """/* 从音色名里抽一个能区分彼此的短标签。
 *
 * 为什么需要：从截图里发现两行都显示「中文（中国大陆）· 可离线 · 音质高」——
 * 而这**恰恰是一个用来「挑一个」的列表**，两项长得一模一样等于没得挑，
 * 用户只能去看底下那行他不认识的英文。
 * 这几段编号（ccc / fff）在引擎里就是不同的 speaker，确实是两个嗓子。
 *
 * 抽不出来就不加：各引擎命名规则差别很大，硬猜一个错的标签比不加更糟。 */
function voiceTag(name) {
  const parts = String(name || '').toLowerCase().split('-').filter(Boolean);
  if (parts.length < 4) return '';
  const mid = parts[3];
  // 只接受短的、字母数字的段（ccc / fff / a 之类）；长了多半是别的含义
  if (!/^[a-z0-9]{1,5}$/.test(mid)) return '';
  return mid;
}

function voiceLabel(v) {
  // 音色名（zh-cn-x-ccc-local）对用户没有意义，翻成人能判断的东西
  const loc = /CN|Hans/i.test(v.locale || '') ? '中文（中国大陆）'
    : /TW|Hant/i.test(v.locale || '') ? '中文（台湾）'
      : /HK/i.test(v.locale || '') ? '中文（香港）' : (v.locale || '中文');
  const bits = [loc];
  if (v.network) bits.push('需联网');
  else bits.push('可离线');
  if (v.quality >= 500) bits.push('音质很高');
  else if (v.quality >= 400) bits.push('音质高');
  else if (v.quality >= 300) bits.push('音质中');
  // 加可辨识段：否则同参数的音色在界面上完全一样，没法挑
  const tag = voiceTag(v.name);
  if (tag) bits.push(tag);
  return bits.join(' · ');
}""", tag='voiceLabel')
    io.open(VP, 'w', encoding='utf-8').write(v)

    t = io.open(TP, encoding='utf-8').read()
    t = sub(t, """  chk('把音色名翻成了人话（不是 zh-cn-x-ccc-local）', !list.rawNameShown);""",
            """  chk('把音色名翻成了人话（不是 zh-cn-x-ccc-local）', !list.rawNameShown);
  // 同一台手机上同参数的音色必须能区分开：否则这个列表就没法用来挑
  chk('每一行的标签互不相同', new Set(list.labels).size === list.labels.length,
    list.labels.join(' / '));
  chk('标签里带了可辨识的短编号（ccc / fff 这种）',
    list.labels.filter((x) => /· *[a-z0-9]{1,5}$/.test(x)).length >= 3,
    list.labels.filter((x) => /· *[a-z0-9]{1,5}$/.test(x)).join(' / '));""", tag='assert')
    io.open(TP, 'w', encoding='utf-8').write(t)
    print('音色标签加了可辨识短编号；并断言每行互不相同')


if __name__ == '__main__':
    main()
