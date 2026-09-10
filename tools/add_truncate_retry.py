# -*- coding: utf-8 -*-
"""把 README 里声称存在、实际不存在的「max_tokens 截断重试」补上。

起因是核对文档时发现的两处不符：
  · README 说「现在默认 4000」，代码里是 3000。
  · README 说「遇到 finish_reason=length 会自动翻倍重试」——
    **而 finish_reason 这个词在 voice.js 里出现 0 次**，那个兜底根本不存在。

这不是文档小毛病：被截断的输出会变成残缺 JSON，用户看到的是
「返回的不是 JSON：{...」这种完全指不到原因的错误。这个坑项目里真踩过
（原来的 1800 被推理吃掉 1762，正文只剩 83 字节）。

两种修法：把文档改成实话，或者把功能做出来。选后者——这个失败模式是真的、
而且很难自查（尤其带推理的模型，推理 token 和正文共用额度，
换模型之后截断概率还会变）。做出来之后文档自然就成实话了。

实现上把原来的 llmCall 改名 llmCallOnce（一字未动），外面套一层
负责「截断就翻倍重试一次」的 llmCall。这样不动那段敏感的 404 回退逻辑，
出错面最小。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VP = os.path.join(ROOT, 'public', 'voice.js')


def sub(s, old, new, n=1, tag=''):
    assert s.count(old) == n, f'{tag} 期望 {n} 次，实得 {s.count(old)}：{old[:70]!r}'
    return s.replace(old, new)


def main():
    v = io.open(VP, encoding='utf-8').read()

    # 1) 原名改成 llmCallOnce，并允许调用方覆盖 max_tokens
    v = sub(v, """async function llmCall(messages, temperature) {
  const s = settings();
  if (!s.apiKey && V.native) throw new Error('还没填 API 密钥：点右上角 ⚙ 填一次就行');
  const payload = JSON.stringify({
    model: s.model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: s.maxTokens,
    temperature: temperature == null ? 0.9 : temperature,
  });""",
            """async function llmCallOnce(messages, temperature, maxTokens) {
  const s = settings();
  if (!s.apiKey && V.native) throw new Error('还没填 API 密钥：点右上角 ⚙ 填一次就行');
  const payload = JSON.stringify({
    model: s.model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: maxTokens || s.maxTokens,
    temperature: temperature == null ? 0.9 : temperature,
  });""", tag='once')

    # 2) 返回值里带上 finish_reason（判断是否被截断要用）
    v = sub(v, """  const j = JSON.parse(res.body);
  const content = j.choices && j.choices[0] && j.choices[0].message
    ? (j.choices[0].message.content || '') : '';
  if (!String(content).trim()) throw new Error('模型返回了空内容，再试一次');""",
            """  const j = JSON.parse(res.body);
  const ch0 = j.choices && j.choices[0];
  const content = ch0 && ch0.message ? (ch0.message.content || '') : '';
  // finish_reason === 'length' 表示是被 max_tokens 截断的，内容不完整。
  // 这个信号必须往上传：截断后的 JSON 是残缺的，再往下走只会得到
  // 「返回的不是 JSON」这种指不到原因的错误。
  if (ch0 && ch0.finish_reason === 'length') {
    const e = new Error('输出被 max_tokens 截断');
    e.truncated = true;
    e.raw = String(content);
    throw e;
  }
  if (!String(content).trim()) throw new Error('模型返回了空内容，再试一次');""", tag='finish')

    # 3) 新的 llmCall：截断就翻倍重试一次
    v = sub(v, """  return parseJsonLoose(stripFence(String(content)));
}

function stripFence(t) {""",
            """  return parseJsonLoose(stripFence(String(content)));
}

/* 截断兜底：被 max_tokens 截断就把额度翻倍重试一次，还截断就如实报错。
 *
 * 为什么需要它：推理模型的**推理 token 和正文共用这个额度**，
 * 所以同一个 max_tokens 在不同模型上结果完全不同——这个项目真踩过
 * （1800 被推理吃掉 1762，正文只剩 83 字节的残缺 JSON，报的是
 * 「返回的不是 JSON」，完全看不出是额度问题）。
 *
 * 只重试一次、上限 12000：翻倍是解决「差一点」，不是在追一个永远不够的额度。
 * 第二次还截断就说明这个模型要的额度远超预期，那时**如实说出来**比继续加钱有用。 */
async function llmCall(messages, temperature) {
  const base = settings().maxTokens;
  let budget = base;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await llmCallOnce(messages, temperature, budget);
    } catch (e) {
      if (!e.truncated) throw e;
      if (attempt === 0 && budget < 12000) {
        budget = Math.min(budget * 2, 12000);
        toast(`模型输出被长度限制截断了，把额度提到 ${budget} 重试一次`);
        continue;
      }
      throw new Error(
        `模型输出被长度限制截断了（${budget} tokens 还不够）。`
        + '如果当前用的是带推理的模型，推理会吃掉大半额度——'
        + '换成 deepseek-chat 这类不带推理的模型通常就好了；'
        + '或者在设置页把模型换掉再试。');
    }
  }
}

function stripFence(t) {""", tag='retry')

    io.open(VP, 'w', encoding='utf-8').write(v)
    print('max_tokens 截断现在真的会翻倍重试，并如实报错')

    # 4) README 的数字改成实话
    RP = os.path.join(ROOT, 'README.md')
    r = io.open(RP, encoding='utf-8').read()
    r = sub(r, """- **`max_tokens` 要给足。** `deepseek-v4-pro` 默认带推理，推理 token 和正文**共用**这个额度。原来的 1800 被推理吃掉 1762，正文只剩 83 字节的残缺 JSON。现在默认 4000，遇到 `finish_reason=length` 会自动翻倍重试。""",
            """- **`max_tokens` 要给足，而且会截断。** 带推理的模型，推理 token 和正文**共用**这个额度。原来设 1800，被推理吃掉 1762，正文只剩 83 字节的残缺 JSON——而报出来的是「返回的不是 JSON」，完全看不出是额度问题。现在默认 3000，并且**真的会在 `finish_reason=length` 时把额度翻倍重试一次**（上限 12000），两次都截断就如实说是额度不够、并指出多半是推理吃掉了。""",
            tag='readme')
    io.open(RP, 'w', encoding='utf-8').write(r)
    print('README 里那两句不符的地方改成实话了')


if __name__ == '__main__':
    main()
