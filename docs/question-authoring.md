# 完整题目与同考点变式

每组包含一道原题和两道完整变式，存入 `data/cards.json`。`skill` 是这一组共同训练的具体判断能力，例如「承诺发生变化时提前说明并协商替代安排」。新变式必须换掉整个事件、冲突和判断依据，重写问题、四个选项及其解析。仅换人名、物品或时间不算新题。

原题保留现有的 `id`、`type`、`domain`、`stage` 和 `principle`。两个变式的 `id` 分别为 `原题id-v1`、`原题id-v2`，`skill` 与原题相同；每个变式必须独立提供：

- `context`、`quote`、`question`：完整情境、对方的话、所需判断。
- `options`：A/B/C/D 四个不同选项，各有 `text`、`why`、`err`。
- `best`、`ok`：首选及可接受答案；首选和可接受选项的 `err` 为「正解」，其余使用 `public/app.js` 已有偏差类型。
- `explain`、`alt`、`action`：结合本题证据解释结论、说明何种新证据会改变结论、给出可执行回应。
- `plan: {if, then}`：具体触发信号和动作；`then` 不超过 60 字，不写禁止句、口号或要背诵的台词。
- 读局题额外提供自己的 `genre`、`genreAlt`、`state`、`genreWhy` 和 `clues`。`genre` 必须在界面八类中；依据有 3–5 条，1–2 条正确，不能继承另一个场景的线索。

同一组原题/v1/v2 的首选字母分别不同。应用展示时还会打乱选项并重新映射答案，选中字母变化不影响语义判分。题目轮换依据该组的复习次数，家族 ID 不变，已有间隔复习进度保留；新记录额外保存 `formId` 和原始 `answerKey`。预案按具体题目保存，旧预案归到原题。

审核时逐组并排读三道题：共同考点是否明确，具体事件是否真的不同，首选是否由题干证据支持，干扰项是否有吸引力且能讲清差异。不要把合理的不同选择都判错，也不要把猜测写成确定的心理事实。四个选项尽量长度相近，避免看长度就能猜答案。

修改后运行以下检查；自动检查只能发现结构、复用和部分明显质量问题，不能代替语义审核：

```text
node tools/check_variant_library.js
node tools/test_content.js
node tools/test_plan.js
node tools/check_card_variants.js
py -3 tools/audit_content_quality.py
py -3 build_offline.py
node tools/check_variant_ui.js
```

旧的 `tools/gen_variants.py` 已停用，它曾强制沿用原选项和解析，不能继续用于扩库。草稿放在 `output/` 等非内容目录；只有审核完成的内容才合并进 `data/cards.json`，否则开发服务器会把草稿误当正式内容加载。
