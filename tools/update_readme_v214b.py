# -*- coding: utf-8 -*-
"""README 第二批：剩下的旧说法 + 测试清单。

上一批改的是「结构性描述」（tab 数、场景来源），这一批是零散但会误导人的句子：
   - 「语音陪练」这个词还剩三处（其中两处在「已知限制」里）
   - 测试清单里 test_stages 写着 34 项，实际 32 项
   - 浏览器端验证只列了 check_settings_ui，而现在已经有一组

测试计数这种东西最容易腐烂：它看起来像事实，改代码时又没人会回头改它。
所以这里改成「不写会过期的总数，写清每一项盯什么」——数字只保留最稳的那几个。
"""
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, 'README.md')

EDITS = [
    (
        "（APK 里没有服务端，语音陪练是网页直接调 DeepSeek——所以 key 要在 App 的 ⚙ 设置里自己填一次。）",
        "（APK 里没有服务端，场景对话是网页直接调 DeepSeek——所以 key 要在 App 的 ⚙ 设置里自己填一次。）",
    ),
    (
        "- 语音陪练里的「她」是模型演的，**她的反应不是现实中的必然**。它训练的是你的观察和回应习惯，不是预测某一个具体的人。",
        "- 场景对话里的「对方」是模型演的，**他的反应不是现实中的必然**。它训练的是你的观察和回应习惯，不是预测某一个具体的人。",
    ),
    (
        "- 语音陪练每轮都要调一次模型，会消耗你自己的 API 额度，一局 10 轮大约几毛钱。",
        "- 场景对话每轮都要调一次模型（**建场景也算一次**），会消耗你自己的 API 额度，一局 10 轮大约几毛钱。",
    ),

    # ---- 测试清单：补上浏览器那一组，修掉过期计数 ----
    (
        "```bash\n"
        "node tools/test_plan.js    # 18 项：禁止式、台词、空话、超长，以及 44 条种子必须全部能通过\n"
        "node tools/test_ask.js     # 12 项：追问判定的字面重合型与回指型\n"
        "node tools/test_stages.js  # 34 项：关卡判定、纵向比对、「刷题过不去」不变式、让/守平衡\n"
        "node tools/test_daily.js   # 18 项：达标判定、跳过一次规则、加练不顶替必备项\n"
        "node verify_offline.js     # 37 项：离线单文件的完整性（见下）\n"
        "```\n",

        "```bash\n"
        "node tools/test_plan.js    # 禁止式、台词、空话、超长，以及 44 条种子必须全部能通过\n"
        "node tools/test_ask.js     # 追问判定的字面重合型与回指型\n"
        "node tools/test_content.js # 卡片/微课/场景的字段完整性、变体不带 options、误读类型与代码同步\n"
        "node tools/test_stages.js  # 关卡判定、纵向比对、「刷题过不去」不变式、让/守平衡\n"
        "node tools/test_daily.js   # 达标判定、跳过一次规则、加练不顶替必备项\n"
        "node tools/test_bridge.js  # 扫全部 Java 源码：不许有系统级状态、不许往磁盘写脚本（见上）\n"
        "node verify_offline.js     # 离线单文件的完整性（见下）\n"
        "```\n\n"
        "浏览器端（`tools/check_*.js`，跑的都是**离线单文件版 = APK 里那一份**，\n"
        "所以查的是真实渲染结果而不是源码；`check_settings_ui.js` 需要先起 `py -3 server.py`）：\n\n"
        "```bash\n"
        "node tools/check_scene_talk.js   # 建场景页：提示词在前、示例一键填入、坏输入不放行\n"
        "node tools/check_read_flow.js    # 判局真的挡在选项前面、偏重出题不是只出弱项、今日复盘\n"
        "node tools/check_today_ui.js     # 今天页：达标进度条真的可见（曾经的隐形 bug）\n"
        "node tools/check_talk_cards.js   # 「怎么接话」卡片\n"
        "node tools/check_llm_errors.js   # 地址/模型名/404 的报错文案\n"
        "node tools/check_settings_ui.js  # 设置页三态 + 重装恢复四条路径（需 server.py）\n"
        "```\n\n"
        "**这里刻意不写「合计 N 项」。** 那个数每加一条断言就过期，而过期的数字看起来仍像事实。\n"
        "每条后面写的是它盯什么——那不会过期，也正是回归时你需要知道的。\n",
    ),
]


def main():
    with io.open(P, encoding='utf-8') as f:
        s = f.read()
    miss = []
    for old, new in EDITS:
        if s.count(old) != 1:
            miss.append((s.count(old), old.splitlines()[0][:70]))
            continue
        s = s.replace(old, new)
    if miss:
        for n, t in miss:
            print(f'  !! 命中 {n} 次：{t}')
        raise SystemExit('有段落没对上，先看一眼再改')
    with io.open(P, 'w', encoding='utf-8') as f:
        f.write(s)
    print(f'README 第二批已更新（{len(EDITS)} 处）')


if __name__ == '__main__':
    main()
