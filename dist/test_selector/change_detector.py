"""CodeChangeDetector - 代码变更检测。

功能：
- 哈希比对扫描范围：整个 source_dir，相对路径基于 source_dir，
  之后由 TestSelector 的通用路径规范化（adapter.normalize_changed_path）统一剥离
  PRODUCT_PREFIX 或 '{repo_name}/' 前缀
- diff 文件读取编码：utf-8-sig（兼容带 BOM）
- diff 前缀过滤：adapter.product_code_prefix
- 行级解析 / 变更场景排除：diff_parser 公共模块
"""

import hashlib
import json
from pathlib import Path

from . import diff_parser
from .repos.base import RepoAdapter


class CodeChangeDetector:
    """代码变更检测器"""

    def __init__(self, source_dir: str, adapter: RepoAdapter):
        """
        Args:
            source_dir: 源代码目录（哈希比对扫描根）
            adapter: 仓库适配器（提供产品代码前缀与哈希扫描根）
        """
        self.source_dir = Path(source_dir)
        self.adapter = adapter
        self.file_hashes = {}

    def compute_file_hash(self, filepath: str) -> str:
        """计算文件 MD5 哈希"""
        hasher = hashlib.md5()
        try:
            with open(filepath, "rb") as f:
                hasher.update(f.read())
            return hasher.hexdigest()
        except Exception as e:
            print(f"  Warning: Error computing file hash: {filepath}: {e}")
            return ""

    def scan_source_files(self) -> dict[str, str]:
        """扫描源文件，计算哈希（整个 source_dir，相对路径基于 source_dir）"""
        self.file_hashes = {}
        root = self.adapter.hash_scan_root(self.source_dir)
        if not root.exists():
            print(f"  Warning: Source directory not found: {root}")
            return self.file_hashes
        for py_file in root.rglob("*.py"):
            rel_path = py_file.relative_to(self.source_dir).as_posix()
            self.file_hashes[rel_path] = self.compute_file_hash(str(py_file))
        return self.file_hashes

    def detect_changes_by_comparison(self) -> dict[str, set[int]]:
        """通过文件哈希比对检测变更（变更文件返回全部行号）"""
        changed_files = {}
        current_hashes = {}

        root = self.adapter.hash_scan_root(self.source_dir)
        if not root.exists():
            print(f"  Warning: Source directory not found: {root}")
            return changed_files

        for py_file in root.rglob("*.py"):
            rel_path = py_file.relative_to(self.source_dir).as_posix()
            current_hashes[rel_path] = self.compute_file_hash(str(py_file))

        baseline_path = self.source_dir / ".file_hashes.json"
        if baseline_path.exists():
            with open(baseline_path) as f:
                old_hashes = json.load(f)

            for rel_path, current_hash in current_hashes.items():
                old_hash = old_hashes.get(rel_path, "")
                if current_hash != old_hash:
                    # 文件有变更，返回全部行号（保守估计）
                    changed_files[rel_path] = set(range(1, 10000))
        else:
            changed_files = {rel_path: set(range(1, 10000)) for rel_path in current_hashes}
            with open(baseline_path, "w") as f:
                json.dump(current_hashes, f)

        return changed_files

    def parse_git_diff(
        self,
        diff_output: str,
        base_content_getter=None,
    ) -> dict[str, set[int]]:
        """
        解析 git diff 输出，提取受影响的 base（变更前）行号。

        Rules:
        - Deleted lines: record the deleted base line itself, nothing more.
        - Pure comment/docstring changes are excluded (needs base content):
          a deletion group where every deleted line is a comment/docstring line
          and the additions are comments or doc prose; an insertion inside a
          docstring or consisting of comment lines only.
        - Pure type annotation changes are excluded in every direction (needs
          base content): inserted, deleted or replaced lines that are all
          simple-name valueless annotations (``x: int``) in a scope where they
          are provably inert - function bodies (never evaluated), plain
          classes (no decorators, no TypedDict/Protocol/Enum/BaseModel/
          NamedTuple base) or module level, unless the annotation expression
          may have runtime side effects (calls, Annotated metadata) and the
          file has no ``from __future__ import annotations``.
        - First-time bindings are excluded for pure insertions (needs base
          content): every added line is an assignment binding simple names
          or self-attributes that occur nowhere in the base file, with inert
          right-hand sides; self-attributes require a function scope whose
          enclosing class has no custom __setattr__ (same-file ancestors only);
          no meaningful line ends in a comma (such lines are call/signature
          arguments, not statements); class-scope insertions follow dataclass
          field-order rules (plain assigns are not fields, annotated fields
          must land at or after the last existing field).
        - Isolated blank-line deletion (neighbours not deleted): treated as a
          one-line insertion -> candidate pair (line above, line below).
        - Pure insertions and blank-deletion pairs are classified via ast of
          the base file (needs base_content_getter):
          1. modifies an existing function -> record the line above only;
          2. sits between two function/class definitions -> excluded;
          3. inserted text belongs to a newly added def/class -> excluded;
          4. otherwise (module-level statements) -> record the line above only.
        - Without base content (or non-parseable Python) pairs fall back to
          counting both sides, bounded by the hunk's base range.

        Args:
            diff_output: diff 内容
            base_content_getter: 可选回调(repo-relative-path -> str | None)，
                返回 base 文件内容用于 ast 分类

        Returns:
            {filepath: {lineno, ...}} - 受影响的 base 行号集合，
            .py 文件且位于 '{product_code_prefix}' 下，前缀已剥离。
            重命名与删除的文件被排除：它们通过 detect_renames() 在文件级匹配。
        """
        filter_prefix = self.adapter.product_code_prefix
        renamed_files, deleted_files = self.detect_renames(diff_output)
        renamed_new_paths = set(renamed_files.values())
        deleted_paths = set(deleted_files)

        files, pending, del_groups = diff_parser._parse_diff_base_lines(diff_output)

        changed_files = {}
        for path, lines in files.items():
            # 重命名/删除的文件走文件级匹配，跳过行级解析
            if path in renamed_new_paths or path in deleted_paths:
                continue
            # 过滤：仅保留产品代码（排除测试文件等）
            if not path.startswith(filter_prefix):
                continue
            if not path.endswith(".py"):
                continue
            # 规范化路径：剥离 '{product_code_prefix}' 前缀
            key = path[len(filter_prefix):]
            changed_files[key] = lines
            pairs = pending.get(path) or []
            groups = del_groups.get(path) or []
            if pairs or groups:
                base_text = base_content_getter(path) if base_content_getter else None
                diff_parser._classify_candidate_pairs(lines, pairs, groups, base_text, path)

        # 丢弃最终没有受影响代码行的文件（如纯注释变更）
        return {k: v for k, v in changed_files.items() if v}

    def detect_renames(self, diff_output: str) -> tuple[dict[str, str], list[str]]:
        """
        检测 git diff 输出中的重命名与删除文件（仅产品代码，under product_code_prefix）。
        两者处理方式相同：使用 base 路径进行文件级匹配，从行级解析中排除。

        Args:
            diff_output: diff 内容

        Returns:
            (rename_mapping, deleted_files)
            - rename_mapping: {old_path: new_path}
            - deleted_files: [path, ...]（base 路径）
        """
        prefix = self.adapter.product_code_prefix
        renames = {}
        deleted = []
        current_old_path = None
        current_new_path = None
        header_old_path = None

        for raw_line in diff_output.split("\n"):
            line = raw_line.rstrip("\r")

            # 检测重命名标记
            if line.startswith("rename from "):
                current_old_path = line[12:].strip()
                continue
            if line.startswith("rename to "):
                current_new_path = line[10:].strip()
                # 同时拿到新旧路径时记录重命名
                if current_old_path and current_new_path:
                    # 去除 a/ 或 b/ 前缀
                    old_path = current_old_path[2:] if current_old_path.startswith("a/") else current_old_path
                    new_path = current_new_path[2:] if current_new_path.startswith("b/") else current_new_path
                    # 仅记录产品代码重命名（under prefix）
                    if old_path.startswith(prefix):
                        renames[old_path] = new_path
                    current_old_path = None
                    current_new_path = None
                continue

            # 通过 '--- a/path' + '+++ /dev/null' 检测删除文件
            if line.startswith("--- "):
                header_old_path = line[4:].strip()
                if header_old_path.startswith("a/"):
                    header_old_path = header_old_path[2:]
            elif line.startswith("+++ "):
                if line[4:].strip() == "/dev/null" and header_old_path and header_old_path.startswith(prefix):
                    deleted.append(header_old_path)
                header_old_path = None

        return renames, deleted

    def parse_pr_diff_file(
        self, diff_file_path: str, base_content_getter=None
    ) -> tuple[dict[str, set[int]], dict[str, str], list[str]]:
        """
        从 PR diff 文件解析变更行号、重命名与删除文件。

        Args:
            diff_file_path: diff 文件路径
            base_content_getter: 可选回调(repo-relative-path -> str | None)，
                返回 base 文件内容用于 ast 分类

        Returns:
            (changed_files_with_lines, rename_mapping, deleted_files)
        """
        try:
            # 读取编码使用 utf-8-sig，兼容带 BOM 的 diff 文件
            with open(diff_file_path, encoding="utf-8-sig") as f:
                diff_content = f.read()
            changed_files = self.parse_git_diff(diff_content, base_content_getter=base_content_getter)
            renames, deleted_files = self.detect_renames(diff_content)
            return changed_files, renames, deleted_files
        except Exception as e:
            print(f"Warning: Failed to read diff file: {e}")
            return {}, {}, []
