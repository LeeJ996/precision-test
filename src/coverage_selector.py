"""CoverageSelector - 构建 测试用例 -> 覆盖文件/行号 映射。

依赖仓库适配器（adapter）提供仓库差异点：
- is_test_case_dir：识别覆盖率数据目录下的测试用例目录
- normalize_test_name：测试用例目录名 -> 标准脚本名
- covered_path_to_rel：覆盖率库路径 -> 仓库相对路径
- resolve_source_file：相对路径 -> 磁盘源文件

覆盖率文件布局自动探测：
- 测试目录下存在 covdata/ 子目录时读取 covdata/ 下的覆盖率文件
- 否则读取测试目录下直接放置的覆盖率文件
"""

import json
import os
import sqlite3
from collections import defaultdict
from pathlib import Path

from .function_parser import FunctionParser
from .noise_filter import NoiseFilter
from .repos.base import RepoAdapter


def _long_path(p) -> str:
    """Windows MAX_PATH(260) workaround: sqlite3 打不开超长绝对路径，加 \\?\ 前缀绕过。"""
    s = str(p)
    if os.name == "nt" and len(s) > 259 and not s.startswith("\\\\?\\"):
        return "\\\\?\\" + s
    return s


class CoverageSelector:
    """基于覆盖率的测试选择器（负责构建 test_case_map）。"""

    def __init__(self, coverage_data_dir: str = None, source_dir: str = None, adapter: RepoAdapter = None):
        """
        Args:
            coverage_data_dir: 覆盖率数据目录（仅构建 map 时需要）
            source_dir: 源代码目录（仅函数级匹配 / 噪音过滤时需要）
            adapter: 仓库适配器（必须提供）
        """
        if adapter is None:
            raise ValueError("CoverageSelector requires a repo adapter")
        self.adapter = adapter
        self.coverage_data_dir = Path(coverage_data_dir) if coverage_data_dir else None
        self.source_dir = Path(source_dir) if source_dir else None
        self.test_case_map = {}  # test_case_name -> {files: {filepath: {lines}}}
        self._noise_filter = NoiseFilter()

    def scan_test_cases(self) -> list[str]:
        """
        扫描所有测试用例目录。
        目录下（或其 covdata/ 子目录下）存在 coverage.* 文件即视为测试用例目录，
        目录名匹配规则由仓库适配器提供。
        """
        test_cases = []
        if not self.coverage_data_dir or not self.coverage_data_dir.exists():
            print(f"  Warning: Coverage data directory not found: {self.coverage_data_dir}")
            return test_cases
        for item in self.coverage_data_dir.rglob("*"):
            if not item.is_dir():
                continue
            name = item.name
            # 目录名规则由仓库适配器决定（vllm: tests__ 前缀 / cpu-ut；sglang: ____w__... 前缀）
            if not self.adapter.is_test_case_dir(name):
                continue
            # 布局探测：covdata/ 子目录（vllm/pytorch）或目录下直接放置（sglang）
            covdata_dir = item / "covdata"
            has_cov_files = any(item.glob(self.adapter.coverage_file_glob))
            if covdata_dir.exists() and any(covdata_dir.glob(self.adapter.coverage_file_glob)):
                has_cov_files = True
            if has_cov_files:
                rel = item.relative_to(self.coverage_data_dir).as_posix()
                test_cases.append(rel)
        return sorted(test_cases)

    def normalize_test_name(self, test_name: str) -> str:
        """将测试用例目录名转换为标准脚本名（委托仓库适配器）。"""
        return self.adapter.normalize_test_name(test_name)

    def get_covered_lines_from_file(self, cov_file: str, filename: str) -> set[int]:
        """
        从单个覆盖率 SQLite 文件获取某个文件的覆盖行号。
        """
        lines = set()
        try:
            conn = sqlite3.connect(_long_path(cov_file))
            cursor = conn.cursor()

            # 模糊路径匹配查找文件 ID
            cursor.execute("SELECT id FROM file WHERE path LIKE ?", (f"%{filename}",))
            row = cursor.fetchone()
            if not row:
                conn.close()
                return lines
            file_id = row[0]

            # 获取所有 arc，计算覆盖行号
            cursor.execute("SELECT DISTINCT fromno, tono FROM arc WHERE file_id = ?", (file_id,))
            for fromno, tono in cursor.fetchall():
                if fromno > 0:
                    lines.add(fromno)
                if tono > 0:
                    lines.add(tono)

            conn.close()
        except Exception as e:
            print(f"  Warning: Error reading {cov_file}: {e}")
        return lines

    def get_covered_files_from_file(self, cov_file: str) -> set[str]:
        """从单个覆盖率文件获取所有覆盖的产品代码文件（相对路径，委托仓库适配器）。"""
        files = set()
        try:
            conn = sqlite3.connect(_long_path(cov_file))
            cursor = conn.cursor()
            cursor.execute("SELECT path FROM file")
            for (path,) in cursor.fetchall():
                rel_path = self.adapter.covered_path_to_rel(path)
                if rel_path is not None:
                    files.add(rel_path)
            conn.close()
        except Exception as e:
            print(f"  Warning: Error reading {cov_file}: {e}")
        return files

    def _resolve_source_file(self, filename: str) -> Path | None:
        """
        根据相对文件名解析源文件路径（委托仓库适配器）。

        Args:
            filename: 相对文件路径（如 'vllm_ascend/core/worker.py' 或 'srt/models/qwen3_vl.py'）

        Returns:
            Path 对象（存在时），否则 None
        """
        if not self.source_dir:
            return None
        return self.adapter.resolve_source_file(self.source_dir, filename)

    def build_test_case_map(self) -> dict:
        """构建 测试用例 -> 覆盖文件映射（含行号）"""
        print("Scanning test cases...")
        test_cases = self.scan_test_cases()
        print(f"  Found {len(test_cases)} test cases")

        for i, test_case in enumerate(test_cases):
            print(f"  [{i + 1}/{len(test_cases)}] Processing {test_case}...")
            test_case_dir = self.coverage_data_dir / test_case
            covdata_dir = test_case_dir / "covdata"

            file_lines_map = defaultdict(set)  # filepath -> set of lines

            # 布局探测：vllm/pytroch 将 coverage 放在 covdata/ 子目录，sglang 直接放在测试目录下
            cov_dirs = [covdata_dir] if covdata_dir.exists() else [test_case_dir]

            for cov_dir in cov_dirs:
                for cov_file in cov_dir.glob(self.adapter.coverage_file_glob):
                    covered_files = self.get_covered_files_from_file(str(cov_file))

                    for filename in covered_files:
                        lines = self.get_covered_lines_from_file(str(cov_file), filename)
                        if lines:
                            # source_dir 可用时过滤噪音行
                            if self.source_dir:
                                source_file = self._resolve_source_file(filename)
                                if source_file and source_file.exists():
                                    lines = self._noise_filter.filter_noise_lines(str(source_file), lines)
                            # 过滤后无覆盖则跳过
                            if lines:
                                file_lines_map[filename].update(lines)

            normalized_name = self.normalize_test_name(test_case)
            # 参数化用例（...[param_id]）合并为无参数条目：入参实例共享同一函数代码，推荐粒度是函数
            base_name = normalized_name.split("[", 1)[0]
            entry = self.test_case_map.get(base_name)
            if entry is None:
                self.test_case_map[base_name] = {
                    "files": dict(file_lines_map),
                    "file_count": len(file_lines_map),
                    "line_count": sum(len(v) for v in file_lines_map.values()),
                }
            else:
                tgt = entry["files"]
                for f, lines in file_lines_map.items():
                    tgt.setdefault(f, set()).update(lines)
                entry["file_count"] = len(tgt)
                entry["line_count"] = sum(len(v) for v in tgt.values())

            print(f"    -> {len(file_lines_map)} files, {sum(len(v) for v in file_lines_map.values())} lines")

        return self.test_case_map

    def save_map(self, output_path: str = "test_case_map.json"):
        """保存测试用例映射到文件"""
        serializable_map = {}
        for test_case, data in self.test_case_map.items():
            serializable_map[test_case] = {
                "files": {k: list(v) for k, v in data["files"].items()},
                "file_count": data["file_count"],
                "line_count": data["line_count"],
            }

        with open(output_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(serializable_map, f, indent=2, ensure_ascii=False)
        print(f"\nTest case mapping saved to: {output_path}")

    def load_map(self, input_path: str = "test_case_map.json"):
        """从文件加载测试用例映射"""
        with open(input_path, encoding="utf-8") as f:
            serializable_map = json.load(f)

        self.test_case_map = {}
        for test_case, data in serializable_map.items():
            self.test_case_map[test_case] = {
                "files": {k: set(v) for k, v in data["files"].items()},
                "file_count": data["file_count"],
                "line_count": data["line_count"],
            }
        print(f"Loaded {len(self.test_case_map)} test case mappings from {input_path}")
        return self.test_case_map
