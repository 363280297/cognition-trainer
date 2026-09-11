"""把该跑的检查一次跑完，最后给一行总账。

为什么要有这个脚本：检查脚本已经有二十多个，挨个手敲既慢又会漏（漏一次就等于
那一块没查）。这里按「先静态、再离线页、最后要服务的」顺序跑，任何一项非零退出
就在结尾汇总里标红，但仍然继续跑完——一次跑完能看到全部问题，比跑到一半停下更有用。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

# (脚本, 需要 server.py 吗, 一句话说明)
CHECKS = [
    ("verify_offline.js", False, "离线版 HTML 与源码/数据同步（含输入指纹）"),
    ("tools/test_content.js", False, "题库内容：出处、边界、精品度"),
    ("tools/test_bridge.js", False, "原生桥：暴露/调用/回调/不可残留"),
    ("tools/check_reported_bugs.js", False, "用户报过的每个 bug 都还在被守着"),
    ("tools/check_truncate.js", False, "正文不被截断"),
    ("tools/check_tabs_unique.js", False, "tab 之间不串内容"),
    ("tools/test_daily.js", False, "每日计划/达标/闸门状态"),
    ("tools/test_stages.js", False, "阶段评估"),
    ("tools/test_plan.js", False, "预案"),
    ("tools/test_ask.js", False, "提问/追问"),
    ("tools/check_today_ui.js", False, "今天页 UI + 换人称安全边界"),
    ("tools/check_read_flow.js", False, "读局/偏重出题/今日复盘已删"),
    ("tools/check_game.js", False, "信号场（d′、反套利、记账）"),
    ("tools/check_audio.js", False, "背景声（含雨：颗粒/密度/不削顶/高频不刺耳）"),
    ("tools/check_music_asr.js", False, "我自己的音乐（识别三层路由已随功能删除）"),
    ("tools/check_talk_history.js", False, "对话历史（存/看/删/续聊）"),
    ("tools/check_talk_cards.js", False, "怎么接话卡片"),
    ("tools/check_llm_errors.js", False, "模型报错文案"),
    ("tools/check_voice_talk.js", False, "对话流程（打字回她）+ 随机场景 + 复盘"),
    ("tools/check_talk_hint.js", False, "接话提示（本地、不调模型）+ 白话回落不显示 JSON 报错"),
    ("tools/check_scene_talk.js", False, "场景对话（含正文不截断）"),
    ("tools/check_scene_lib.js", False, "AI 情景库（缺口表/去重/进库/按关系混排）"),
    ("tools/check_ai_modules.js", False, "AI 模块入口都在"),
    ("tools/check_doubao.js", False, "音色/引擎相关"),
    ("tools/check_voice_pack.js", False, "语音包"),
    ("tools/check_replay_shot.js", False, "复盘传截图（切段/请求形状/失败提示/桥的形状）"),
    ("tools/check_card_feedback.js", False, "卡片反馈三条路（答对/答错/次优都讲清）"),
    ("tools/audit_content_quality.py", False, "内容库自检（人称/性别、选项自洽、占位符、重复）"),
    ("tools/audit_innerhtml.py", False, "注入面自检（不可信字符串进 innerHTML）"),
    ("tools/audit_project.js", False, "项目自检（死代码/版本/产物新鲜度/硬约束）"),
]

# check_settings_ui 需要 server.py（它测的是重装恢复那四条路径，要走 HTTP）
NEEDS_SERVER = ["tools/check_settings_ui.js"]


def main():
    only = sys.argv[1:] if len(sys.argv) > 1 else None
    results = []
    for rel, _need, desc in CHECKS:
        if only and not any(o in rel for o in only):
            continue
        p = ROOT / rel
        if not p.exists():
            results.append((rel, desc, None, "脚本不存在"))
            continue
        # 按扩展名选解释器。原来写死 node——加了 python 的检查之后，
        # 「脚本不存在」会变成莫名其妙的语法错，白白多查一轮。
        if p.suffix == ".py":
            # py -3 是 Windows 上唯一可靠的（裸 python 是 2.7）
            cmd = ["py", "-3", str(p)]
        else:
            cmd = ["node", str(p)]
        r = subprocess.run(cmd, cwd=str(ROOT),
                           capture_output=True, text=True, errors="replace")
        out = (r.stdout or "") + (r.stderr or "")
        tail = ""
        for line in reversed(out.strip().split("\n")):
            if line.startswith("结果：") or line.startswith("自检：") or line.startswith("错误 "):
                tail = line.strip()
                break
        results.append((rel, desc, r.returncode, tail or out.strip()[-120:]))

    print("\n" + "=" * 70)
    bad = 0
    for rel, desc, code, tail in results:
        if code is None:
            mark, bad = "跳过", bad + 1
        elif code == 0:
            mark = "通过"
        else:
            mark, bad = "失败", bad + 1
        print(f"  {mark}  {rel:<34} {tail}")
    print("=" * 70)
    print(f"共 {len(results)} 项，失败 {bad} 项。"
          + ("（check_settings_ui.js 要 server.py 在跑，单独执行）" if not only else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
