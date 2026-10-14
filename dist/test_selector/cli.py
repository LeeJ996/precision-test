"""统一 CLI 入口。

功能：
- 路径解析/输出位置：相对路径基于仓库根目录，绝对路径保持原样
- CLI 参数：adapter 提供默认值，参数统一（--repo 选择仓库适配器）
- 粒度开关：--enable/--disable-line-match、--enable/--disable-function-match，disable 优先
- 全量测试触发：adapter.has_full_suite_changes（如 vllm 的 csrc 检查）
- 测试文件提取：pr_detector 公共模块（逐行解析 + adapter.is_test_file）
- PR 拉取：github / gitcode 公共模块

用法：
    python -m test_selector --repo vllm_ascend --github-pr owner/repo#123
    python -m test_selector --repo torch_npu --github-pr pytorch/pytorch#123
    python -m test_selector --repo sglang --build-map --coverage-dir coverage
    python vllm/test_selector.py --github-pr 123          # 薄入口（默认 vllm_ascend）
    python sglang/test_selector.py --github-pr 123        # 薄入口（默认 sglang）
    python PyTorch/test_selector.py --github-pr 123       # 薄入口（默认 torch_npu，检测上游 pytorch/pytorch）
"""

import argparse
from pathlib import Path

from . import github, gitcode, pr_detector
from .change_detector import CodeChangeDetector
from .coverage_selector import CoverageSelector
from .repos import AVAILABLE_REPOS, get_adapter
from .test_selector import TestSelector

#: 仓库根目录（test_selector 包的上级）：相对路径基准 + 输出文件位置
BASE_DIR = Path(__file__).resolve().parent.parent


def _resolve_abs(base: Path, p: str) -> Path:
    """相对路径基于 base 解析，绝对路径保持原样。"""
    path = Path(p)
    return path if path.is_absolute() else base / path


def build_parser(adapter, default_repo: str) -> argparse.ArgumentParser:
    """构建命令行解析器，参数默认值由仓库适配器提供（cli_defaults）。"""
    defaults = adapter.cli_defaults()
    parser = argparse.ArgumentParser(
        description="Coverage-based precision test selector (line, function, file granularity)"
    )
    parser.add_argument(
        "--repo", "-r",
        default=default_repo,
        choices=list(AVAILABLE_REPOS),
        help=f"Repository adapter to use (default: {default_repo})",
    )
    parser.add_argument("--github-pr", "-pr", help="GitHub PR, format: owner/repo#pr_number")
    parser.add_argument("--gitcode-pr", help="GitCode PR, format: owner/repo#pr_number")
    parser.add_argument(
        "--source-dir", "-s", default=defaults["source_dir"], help=f"Source code directory (default: {defaults['source_dir']})"
    )
    parser.add_argument(
        "--map-file", "-m", default=defaults["map_file"], help=f"Test case map file (default: {defaults['map_file']})"
    )
    parser.add_argument(
        "--coverage-dir", "-c", default=defaults["coverage_dir"], help=f"Coverage data directory (default: {defaults['coverage_dir']})"
    )
    parser.add_argument("--build-map", "-b", action="store_true", help="Rebuild test case mapping")
    parser.add_argument(
        "--min-affected", "-a", type=int, default=defaults["min_affected"],
        help=f"Minimum affected lines threshold (default: {defaults['min_affected']})",
    )
    parser.add_argument(
        "--dedup",
        action="store_true",
        default=defaults["dedup"],
        help="Enable deduplication (keep only one test for same covered lines, default off)",
    )
    parser.add_argument(
        "--enable-line-match",
        action="store_true",
        default=defaults["enable_line_match"],
        help="Enable line-level matching (default from adapter)",
    )
    parser.add_argument("--disable-line-match", action="store_true", help="Disable line-level matching")
    parser.add_argument(
        "--enable-function-match",
        action="store_true",
        default=defaults["enable_function_match"],
        help="Enable function-level matching (default from adapter)",
    )
    parser.add_argument("--disable-function-match", action="store_true", help="Disable function-level matching")
    parser.add_argument(
        "--skip-imports",
        action="store_true",
        default=defaults["skip_imports"],
        help="Skip import statement lines (only effective for function-level matching, default off)",
    )
    parser.add_argument(
        "--new-tests-output",
        help="Write the new test files extracted from the PR diff to this file (one per line, for the append-table workflow)",
    )
    return parser


def main(argv=None, default_repo: str = "vllm_ascend") -> None:
    """统一 CLI 主入口。

    Args:
        argv: 命令行参数列表（None 时使用 sys.argv[1:]）
        default_repo: 默认仓库适配器（薄入口可注入，如 sglang 入口默认 'sglang'）
    """
    # 第一阶段：仅解析 --repo 以确定仓库适配器（其余参数默认值依赖 adapter）
    pre_parser = argparse.ArgumentParser(add_help=False)
    pre_parser.add_argument("--repo", "-r", default=default_repo, choices=list(AVAILABLE_REPOS))
    pre_args, _ = pre_parser.parse_known_args(argv)

    adapter = get_adapter(pre_args.repo)

    # 第二阶段：完整解析，默认值来自 adapter.cli_defaults()
    args = build_parser(adapter, default_repo).parse_args(argv)

    # 粒度开关：disable 优先
    if args.disable_line_match:
        args.enable_line_match = False
    if args.disable_function_match:
        args.enable_function_match = False

    # PR 源互斥校验（gitcode 与 github 只能指定其一）
    if args.github_pr and args.gitcode_pr:
        print("Error: --github-pr and --gitcode-pr are mutually exclusive, please specify only one")
        exit(1)

    # 相对路径基于仓库根目录解析，绝对路径保持原样
    coverage_dir = _resolve_abs(BASE_DIR, args.coverage_dir) if args.coverage_dir else None
    source_dir = _resolve_abs(BASE_DIR, args.source_dir)
    map_file = _resolve_abs(BASE_DIR, args.map_file)

    # 1. Build or load test case mapping
    selector = CoverageSelector(str(coverage_dir) if coverage_dir else None, str(source_dir), adapter)

    if args.build_map or not map_file.exists():
        # Coverage data dir is required only when building the map
        if not coverage_dir:
            print("Error: --coverage-dir is required when building the test case map (no map file found)")
            exit(1)
        print("\n=== Building Test Case Mapping ===")
        selector.build_test_case_map()
        selector.save_map(str(map_file))
    else:
        print("\n=== Loading Test Case Mapping ===")
        selector.load_map(str(map_file))

    # If only need to generate map file, exit directly
    if args.build_map and not args.github_pr and not args.gitcode_pr:
        print("\n=== Map file generated, done ===")
        return

    # 2. Parse code changes
    print("\n=== Parsing Code Changes ===")
    change_detector = CodeChangeDetector(str(source_dir), adapter)

    diff_file = None
    base_content_getter = None
    changed_files_with_lines: dict[str, set[int]] = {}
    if args.github_pr:
        # Fetch changes from GitHub PR
        diff_file, base_content_getter = github.fetch_pr_diff(args.github_pr)
    elif args.gitcode_pr:
        # Fetch changes from GitCode PR（拼接后的 diff 格式与 GitHub 一致，下游处理复用公共逻辑）
        diff_file, base_content_getter = gitcode.fetch_pr_diff(args.gitcode_pr)
    else:
        # Get from file comparison (default)
        change_detector.scan_source_files()
        changed_files_with_lines = change_detector.detect_changes_by_comparison()
        print(f"Detected {len(changed_files_with_lines)} changed files")

    # ===== Action 1: Extract new/deleted test files & full-suite changes =====
    has_full_suite = False
    new_test_files: list[str] = []
    deleted_test_files: list[str] = []
    if diff_file:
        # 读取编码使用 utf-8-sig，兼容带 BOM 的 diff 文件
        with open(diff_file, encoding="utf-8-sig") as f:
            diff_content = f.read()
        new_test_files = pr_detector.get_test_files_from_pr_diff(diff_content, adapter)
        deleted_test_files = pr_detector.get_deleted_test_files_from_pr(diff_content, adapter)
        has_full_suite = pr_detector.has_full_suite_changes(diff_content, adapter)

    # ===== Action 2: Detect Python product code changes -> Precision matching =====
    selected: list[tuple[str, dict, int]] = []
    expand_reason = ""

    if has_full_suite:
        # 全量触发变更（如 vllm 的 csrc 目录），由 adapter 判断
        print("\n=== Full-Suite Changes Detected - Running Full Test Suite ===")
    else:
        renames: dict[str, str] = {}
        deleted_files: list[str] = []
        if diff_file:
            changed_files_with_lines, renames, deleted_files = change_detector.parse_pr_diff_file(
                diff_file, base_content_getter=base_content_getter
            )
            print(f"Parsed {len(changed_files_with_lines)} changed files:")
            for file_path, line_set in changed_files_with_lines.items():
                print(f"  {adapter.repo_name}/{file_path}: {TestSelector._format_line_range(list(line_set))}")

            # detect_renames already filters to product code prefix only
            if renames:
                print(f"\n=== Detected {len(renames)} Product Code Renamed File(s) - Using File-Level Matching ===")
                for old_path, new_path in renames.items():
                    print(f"  {old_path} -> {new_path}")

            if deleted_files:
                print(
                    f"\n=== Detected {len(deleted_files)} Product Code Deleted File(s) - Using File-Level Matching ==="
                )
                for path in deleted_files:
                    print(f"  {path}")

        if changed_files_with_lines or renames or deleted_files:
            # Select test cases by precision matching
            print("\n=== Selecting Affected Test Cases ===")
            test_selector = TestSelector(selector.test_case_map, adapter)

            # Renamed/deleted files are already excluded from changed_files by
            # parse_git_diff; they are matched at file level below
            normal_files = changed_files_with_lines

            # Process normal files with precision matching
            if normal_files:
                selected, expand_reason = test_selector.select_tests(
                    normal_files,
                    min_affected_lines=args.min_affected,
                    source_dir=str(source_dir),
                    enable_line_match=args.enable_line_match,
                    enable_function_match=args.enable_function_match,
                    enable_file_match=False,  # File-level matching reserved for renamed/deleted files only
                    enable_skip_imports=args.skip_imports,
                    enable_dedup=args.dedup,
                )

            # Process renamed/deleted files: file-level matching with the base path
            file_level_paths = [(p, f"{p} -> {n}") for p, n in renames.items()]
            file_level_paths += [(p, p) for p in deleted_files]
            for path, label in file_level_paths:
                fl_selected, fl_expand = test_selector.select_tests(
                    {path: set()},
                    min_affected_lines=args.min_affected,
                    source_dir=str(source_dir),
                    enable_line_match=False,  # Disable line match for file-level matching
                    enable_function_match=False,  # Disable function match for file-level matching
                    enable_file_match=True,  # Enable file match for renamed/deleted files
                    enable_skip_imports=args.skip_imports,
                    enable_dedup=args.dedup,
                )
                selected.extend(fl_selected)
                expand_reason += fl_expand
                # Print file-level matched test cases (even when empty, for diagnosis)
                print(f"\n=== File-Level Matched Tests for {label} ===")
                if fl_selected:
                    for test_name, _, _ in fl_selected:
                        print(f"  {test_name}")
                else:
                    print("  (0 tests matched: no coverage data for this path in test_case_map)")

            # Deduplicate
            seen = set()
            deduped = []
            for item in selected:
                if item[0] not in seen:
                    seen.add(item[0])
                    deduped.append(item)
            selected = deduped

            test_selector.print_selection(
                selected, changed_files_with_lines, min_affected_lines=args.min_affected, expand_reason=expand_reason
            )
        else:
            print("\n=== No product source code changes found ===")

    # ===== Merge results =====
    # Base set: full suite for full-suite changes, otherwise use precision results
    if has_full_suite:
        base_selected = [(test_name, {}, 0) for test_name in selector.test_case_map]
        print(f"\n=== Full Test Suite: {len(base_selected)} tests ===")
    else:
        base_selected = selected

    # Add new test files
    existing_test_names = {s[0] for s in base_selected}
    for test_name in new_test_files:
        if test_name not in existing_test_names:
            base_selected.append((test_name, {}, 0))
            existing_test_names.add(test_name)

    if new_test_files:
        print(f"\n=== New Test Files Added: {len(new_test_files)} ===")
        print(f"  {new_test_files}")

    # Remove deleted test files
    if deleted_test_files:
        print(f"\n=== Deleted Test Files Removed: {len(deleted_test_files)} ===")
        print(f"  {deleted_test_files}")
        deleted_set = set(deleted_test_files)
        base_selected = [
            (name, detail, count)
            for name, detail, count in base_selected
            if name not in deleted_set and not any(name.startswith(d) for d in deleted_set)
        ]

    # ===== Output results =====
    test_names = [s[0] for s in base_selected]
    if test_names:
        print(f"\n=== Recommended Test Cases ({len(test_names)} tests) ===")
        print(test_names)
    else:
        print("\n=== No Test Cases Recommended ===")

    # Always write output file (even if empty), next to the repo root
    output_file = BASE_DIR / "recommended_pytest_paths.txt"
    with open(output_file, "w", encoding="utf-8") as f:
        for test_name in test_names:
            f.write(test_name + "\n")
    print(f"\nResults saved to: {output_file}")

    # Write new test files to a separate file when requested (append-table workflow)
    if args.new_tests_output:
        new_tests_path = _resolve_abs(BASE_DIR, args.new_tests_output)
        with open(new_tests_path, "w", encoding="utf-8") as f:
            for test_name in new_test_files:
                f.write(test_name + "\n")
        print(f"New test files ({len(new_test_files)}) saved to: {new_tests_path}")


if __name__ == "__main__":
    main()
