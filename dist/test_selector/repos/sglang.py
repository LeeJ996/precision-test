"""sglang 仓库适配器。

- REPO_NAME = "sglang"，产品代码前缀 "python/sglang/"
- 覆盖率库路径为 /__w/sglang/sglang/python/sglang/xxx.py，diff 路径为 python/sglang/xxx.py
- 测试文件规则：TEST_ROOTS 下 test_*.py
- 测试名规范化：以 __sglang__sglang__ 为界拆分，后半按编码规则还原仓库相对路径（__ -> /，-- -> ::）
"""

from fnmatch import fnmatchcase
from pathlib import PurePosixPath

from .base import RepoAdapter


class SglangAdapter(RepoAdapter):
    """sglang 仓库适配器。"""

    repo_name = "sglang"
    product_code_prefix = "python/sglang/"

    #: 可纳入 PR 检测的测试根目录
    TEST_ROOTS = ("test/registered/", "test/unit/", "test/e2e/", "test/integration/", "python/sglang/multimodal_gen/test/")

    #: 测试用例目录名中的仓库嵌套编码标记（CI workspace 前缀不固定，以此标记为界拆分）
    _CI_MARKER = "__sglang__sglang__"

    # ------------------------------------------------------------------
    # 覆盖率数据处理
    # ------------------------------------------------------------------
    def _strip_ci_prefix(self, name: str) -> str | None:
        _head, sep, rest = name.partition(self._CI_MARKER)
        return rest if sep else None

    def is_test_case_dir(self, name: str) -> bool:
        rest = self._strip_ci_prefix(name)
        if rest is None:
            return False
        # 剥掉 CI 前缀后必须落在测试树根下（编码形态，__ 编码 /）
        encoded_roots = tuple(root.replace("/", "__") for root in self.TEST_ROOTS)
        return rest.startswith(encoded_roots)

    def normalize_test_name(self, test_name: str) -> str:
        """
        将测试用例目录名转换为标准脚本名。
        - ____w__sglang__sglang__test__registered__npu__xxx__test_foo
          -> test/registered/npu/xxx/test_foo.py（文件级）
        - ____w__sglang__sglang__python__sglang__multimodal_gen__test__...__test_foo.py--TestX--test_bar[p]
          -> python/sglang/multimodal_gen/test/.../test_foo.py::TestX::test_bar[p]（函数级/参数化）
        """
        rest = self._strip_ci_prefix(test_name)
        if rest is None:
            return test_name
        result = rest.replace("__", "/")
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
