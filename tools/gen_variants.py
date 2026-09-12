"""旧的表面变体生成器已停用，避免重新写入仅有 context/quote 的数据。

新题按 docs/question-authoring.md 编写和审核；原题与变式都必须有自己的
问题、四个选项、答案、逐项解析和预案。本入口不读取密钥、不调用模型、不改题库。
"""
import sys


def main():
    print("旧的表面变体生成器已停用：仅换场景、沿用原答案不符合当前题库要求。")
    print("请按 docs/question-authoring.md 编写完整变式，再运行：")
    print("  node tools/check_variant_library.js")
    print("  node tools/test_content.js")
    print("  node tools/test_plan.js")
    return 1


if __name__ == "__main__":
    sys.exit(main())
