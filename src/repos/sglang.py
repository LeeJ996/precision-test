"""sglang 仓库适配器。

- REPO_NAME = "sglang"，产品代码前缀 "python/sglang/"
- 覆盖率库路径为 /__w/sglang/sglang/python/sglang/xxx.py，diff 路径为 python/sglang/xxx.py
- 测试用例目录前缀 "____w__sglang__sglang__test__"，覆盖率文件直接放在测试目录下
- 测试文件规则：test/registered/... 或 test/{unit,e2e,integration}/... 下 test_*.py
- 测试名规范化：剥离 ____w__sglang__sglang__test__ 前缀，恢复 test/ 前缀
"""

from fnmatch import fnmatchcase
from pathlib import PurePosixPath

from .base import RepoAdapter


class SglangAdapter(RepoAdapter):
    """sglang 仓库适配器。"""

    repo_name = "sglang"
    product_code_prefix = "python/sglang/"
    test_case_dir_prefix = "____w__sglang__sglang__test__"

    #: 可纳入 PR 检测的测试根目录
    TEST_ROOTS = ("test/registered/", "test/unit/", "test/e2e/", "test/integration/", "python/sglang/multimodal_gen/test/")

    # ------------------------------------------------------------------
    # 覆盖率数据处理
    # ------------------------------------------------------------------
    def is_test_case_dir(self, name: str) -> bool:
        return bool(self.test_case_dir_prefix) and name.startswith(self.test_case_dir_prefix)

    def normalize_test_name(self, test_name: str) -> str:
        """
        将测试用例目录名转换为标准脚本名。
        sglang（GitHub Actions 编码目录名 /__w/sglang/sglang/test/... -> ____w__sglang__sglang__test__...）：
        - ____w__sglang__sglang__test__registered__npu__xxx__test_foo.py
          -> test/registered/npu/xxx/test_foo.py（文件级）
        - ...--test_foo -> test/registered/npu/xxx/test_foo.py::test_foo（函数级）
        """
        if not self.test_case_dir_prefix or not test_name.startswith(self.test_case_dir_prefix):
            return test_name
        # rest: 前缀之后的编码路径（如 registered__npu__xxx__test_foo.py）
        rest = test_name[len(self.test_case_dir_prefix):]
        # 恢复 test/ 前缀（前缀以 test__ 结尾，__ 编码 /）
        result = "test/" + rest.replace("__", "/")
        # 处理函数级标记：.../test_foo.py--test_bar -> .../test_foo.py::test_bar
        result = result.replace("--", "::")
        # 文件级测试补 .py 后缀，避免已 .py 结尾时重复
        if "::" not in result and not result.endswith(".py"):
            result = result + ".py"
        return result

    def covered_path_to_rel(self, path: str) -> str | None:
        """覆盖率库路径包含 python/sglang/ 时剥离前缀得到相对路径，否则返回 None。"""
        if self.product_code_prefix not in path:
            return None
        return path.split(self.product_code_prefix)[-1]

    # ------------------------------------------------------------------
    # 测试文件检测（PR 内容检测）
    # ------------------------------------------------------------------
    def is_test_file(self, path: str) -> bool:
        return path.startswith(self.TEST_ROOTS) and fnmatchcase(PurePosixPath(path).name, "test_*.py")
