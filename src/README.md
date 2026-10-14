# Test Selector 统一使用指导

## 一、功能概述

**精准测试选择器** — 基于已有覆盖率数据，从 PR/变更中智能选择需要执行的测试用例。支持 **行级 + 函数级** 匹配（并行执行，合并去重），**文件级** 匹配作为兜底（重命名/删除文件场景）。



**入口**：

```bash
python -m test_selector --repo vllm_ascend --github-pr "vllm-project/vllm-ascend#12379"
python -m test_selector --repo torch_npu --github-pr "pytorch/pytorch#150000"
```

> **PR 源选择**：三仓库均使用 GitHub（`--github-pr`）；torch_npu 检测上游仓库 [pytorch/pytorch](https://github.com/pytorch/pytorch)。

**核心工作流**（main 函数结构）：

```
┌─────────────────────────────────────────────────────────────────┐
│  main() 函数结构                                                  │
├─────────────────────────────────────────────────────────────────┤
│  行 A: 下载 diff（github.py / gitcode.py，拼接后格式一致）          │
├─────────────────────────────────────────────────────────────────┤
│  动作1: 测试文件提取（pr_detector，规则由 adapter 提供）            │
│    - get_test_files_from_pr_diff() → new_tests                  │
│    - get_deleted_test_files_from_pr() → deleted_tests           │
├─────────────────────────────────────────────────────────────────┤
│  动作2: 全量触发变更检测（adapter.has_full_suite_changes）         │
│    - vllm_ascend: csrc/ 目录变更（非 .md）→ 全量测试              │
│    - sglang / torch_npu: 恒为 False（原生代码变更不解析进精准匹配） │
├─────────────────────────────────────────────────────────────────┤
│  动作3: 产品代码变更检测（change_detector）                        │
│    - parse_pr_diff_file() → changed_files_with_lines, renames   │
│    └─ select_tests()（行级/函数级并行 + 文件级兜底）              │
│         ├─ normal_files → 精准匹配                                │
│         └─ renames/deleted → 旧路径文件级匹配（禁行级/函数级）      │
├─────────────────────────────────────────────────────────────────┤
│  合并结果:                                                        │
│    - base = has_full_suite ? 全量 : 精准结果（含 rename 旧路径）   │
│    - result = (base ∪ new_tests) - deleted_tests                 │
├─────────────────────────────────────────────────────────────────┤
│  输出: BASE_DIR/recommended_pytest_paths.txt                     │
└─────────────────────────────────────────────────────────────────┘
```

**关键决策逻辑**：

- **csrc 变更检测（仅 vllm_ascend）**：diff 含 `csrc/` 目录变更（排除 `.md`）→ 执行全量测试
- **精准匹配**：无全量触发时，基于行/函数/文件级匹配选择测试
- **文件重命名检测**：rename 新路径在覆盖率数据中不存在，用旧路径做文件级匹配召回
- **新增/删除处理**：新增测试文件直接加入；已删除测试文件从结果中移除
- **排除变更场景**：纯注释/docstring、纯类型注解、首次新增的变量绑定、函数/类定义间空行插入、新增 def/class 整体、新文件等不构成代码变更的场景，在 diff 解析阶段剔除（见第五章）

**代码结构**：

```
test_selector/
├── cli.py                 # 统一 CLI（三仓共用 main 入口）
├── __main__.py            # python -m test_selector 入口
├── github.py              # PR 拉取（公共）
├── pr_detector.py         # 检测 PR 内容：测试文件/删除文件/全量触发（规则委托 adapter）
├── diff_parser.py         # 排除变更场景：纯注释/docstring/纯注解/首次绑定/新文件跳过等
├── noise_filter.py        # map 噪音处理：import/def/class/docstring/空行
├── function_parser.py     # 函数区间解析（sglang 优化版，区间线性扫描）
├── coverage_selector.py   # 构建 测试用例→覆盖文件/行号 映射
├── change_detector.py     # 哈希比对 + PR diff 解析
├── test_selector.py       # TestSelector：行/函数/文件三级级联匹配
└── repos/                 # 仓库差异按仓归类
    ├── base.py            #   RepoAdapter 抽象接口
    ├── vllm_ascend.py     #   vllm_ascend 适配器
    ├── sglang.py          #   sglang 适配器
    ├── torch_npu.py     #   torch_npu（上游 PyTorch / GitHub）适配器
    └── __init__.py        #   适配器注册表 get_adapter()
```

---

## 二、目录结构要求

统一代码库位于仓库根目录（`test_selector` 包的上级目录），所有相对路径均基于此解析（绝对路径保持原样）。

```
仓库根目录/
├── test_selector/                   # 统一代码库
├── vllm/test_selector.py            # vllm 薄入口
├── sglang/test_selector.py          # sglang 薄入口
├── PyTorch/test_selector.py         # PyTorch 薄入口
│
├── <覆盖率数据目录>/                 # 覆盖率数据（仅构建 map 时需要，名称不写死）
│   ├── <vllm 布局>/
│   │   ├── tests__e2e__...__test_xxx/
│   │   │   └── covdata/             # vllm：覆盖率文件在 covdata/ 子目录
│   │   │       └── coverage.*
│   │   └── cpu-ut/
│   │       └── covdata/
│   │           └── coverage.*
│   ├── <sglang 布局>/
│   │   └── ____w__sglang__sglang__test__registered__npu__...__test_xxx/
│   │       └── coverage.linux-*     # sglang：覆盖率文件直接放在测试目录下
│   └── <pytorch 布局>/
│       └── _inductor__test_add/     # pytorch：目录名含 __ 或以 test_ 开头
│           └── covdata/             # pytorch：覆盖率文件在 covdata/ 子目录
│               └── coverage.*
│
├── covstub/                         # 源码目录（函数级匹配需要）
│   ├── vllm_ascend/                 #   vllm：对应仓库根目录
│   ├── sglang/                      #   sglang：对应仓库 python/sglang/
│   └── torch/                       #   torch_npu：对应 pytorch/pytorch 仓库根目录
├── test_case_map.json               # 自动生成的映射文件
└── recommended_pytest_paths.txt     # 推荐测试用例列表（输出）
```

**覆盖率目录布局自动探测**（三仓库兼容）：

- 测试目录下存在 `covdata/` 子目录（vllm / pytorch 布局）→ 从 `covdata/` 读取 `coverage.*`
- 无 `covdata/` 子目录（sglang 布局）→ 直接读取测试目录下的 `coverage.*`

**测试用例目录识别规则**（adapter 提供）：

| 仓库          | 规则                                               |
| ----------- | ------------------------------------------------ |
| vllm_ascend | 目录名以 `tests__` 开头，或等于 `cpu-ut`                   |
| sglang      | 目录名以 `____w__sglang__sglang__test__` 开头          |
| torch_npu   | 目录名含 `__`，或以 `test_` 开头（如 `_inductor__test_add`） |

**测试用例名称转换规则**（adapter 提供）：

| 仓库          | 转换示例                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vllm_ascend | `tests__e2e__pull_request__one_card__test_xxx` → `tests/e2e/pull_request/one_card/test_xxx.py`；含 `--test_foo` → `...::test_foo`（函数级）；`cpu-ut` 保持不变                                                  |
| sglang      | `____w__sglang__sglang__test__registered__npu__basic_function__backends__test_npu_sampling_backend` → `test/registered/npu/basic_function/backends/test_npu_sampling_backend.py`；含 `--` → `::`（函数级） |
| torch_npu   | `_inductor__test_add` → `_inductor/test_add.py`；含 `--test_foo` → `...::test_foo`（函数级）                                                                                                               |

**产品代码路径前缀**（diff / 覆盖率库路径 → 仓库相对路径）：

| 仓库          | 前缀               | 相对路径示例                                                            |
| ----------- | ---------------- | ----------------------------------------------------------------- |
| vllm_ascend | `vllm_ascend/`   | `vllm_ascend/core/worker.py` → `core/worker.py`                   |
| sglang      | `python/sglang/` | `python/sglang/srt/models/qwen3_vl.py` → `srt/models/qwen3_vl.py` |
| torch_npu   | `torch/`         | `torch/distributed/utils.py` → `distributed/utils.py`             |

---

## 三、基础用法

> 相对路径基于仓库根目录解析，也支持绝对路径。`--source-dir` 建议传入；`--coverage-dir` 仅构建 map 时需要（`--build-map` 或 map 文件不存在时必填），推荐测试时无需传入。

### 1. 构建测试用例映射（首次使用或数据更新后）

```bash
# vllm_ascend
python -m test_selector --repo vllm_ascend --build-map \
    --coverage-dir "VLLM-ASCEND@task_2026072021" \
    --source-dir ./covstub

# sglang
python -m test_selector --repo sglang --build-map \
    --coverage-dir "sglang@20260908" \
    --source-dir ./covstub

# torch_npu
python -m test_selector --repo torch_npu --build-map \
    --coverage-dir "PyTorch@Task20260903" \
    --source-dir ./covstub
```

**输出示例**：

```
=== Building Test Case Mapping ===
Scanning test cases...
  Found 32 test cases
  [1/32] Processing ____w__sglang__sglang__test__registered__npu__basic_function__backends__test_npu_sampling_backend...
    -> 450 files, 8939 lines
  ...
Test case mapping saved to: test_case_map.json
```

### 2. 从 PR 推荐测试

```bash
# vllm_ascend（GitHub）
python -m test_selector --repo vllm_ascend \
    --github-pr "vllm-project/vllm-ascend#12379" \
    --source-dir ./covstub

# sglang（GitHub）
python -m test_selector --repo sglang \
    --github-pr "sgl-project/sglang#37043" \
    --source-dir ./covstub

# torch_npu（GitHub 上游 pytorch/pytorch）
python -m test_selector --repo torch_npu \
    --github-pr "pytorch/pytorch#150000" \
    --source-dir ./covstub
```

> 推荐测试时加载已存在的 `test_case_map.json`，**不需要** `--coverage-dir`。只有 map 文件不存在（首次使用）或需重建时才传入。

---

## 四、核心参数说明

参数默认值由所选仓库适配器（`cli_defaults()`）提供；三仓库当前默认值一致，后续可按仓调整。

### 公共参数

| 参数                      | 必填       | 说明                                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `--repo` / `-r`         | 否        | 仓库适配器：`vllm_ascend` / `sglang` / `torch_npu`（默认：`vllm_ascend`，薄入口默认各自仓库）                    |
| `--github-pr` / `-pr`   | 二选一      | GitHub PR（三仓库通用），格式：`owner/repo#pr_number` 或仅 `pr_number`（自动从 git remote 推导）；torch_npu 传上游 `pytorch/pytorch#N` |
| `--gitcode-pr`          | 二选一      | GitCode PR（公共备用模块，当前无仓库默认使用），格式：`owner/repo#pr_number` 或仅 `pr_number`（自动从 git remote 推导）；两参数互斥     |
| `--source-dir` / `-s`   | 建议       | 源码目录（默认：`covstub`；函数级匹配与噪音过滤需要）                                                             |
| `--map-file` / `-m`     | 否        | 映射文件（默认：`test_case_map.json`）                                                               |
| `--coverage-dir` / `-c` | 构建 map 时 | 覆盖率数据目录（默认：`coverage`）                                                                      |
| `--build-map` / `-b`    | 否        | 强制重建测试用例映射；仅构建 map 时使用                                                                      |
| `--min-affected` / `-a` | 否        | 最少受影响行数阈值（默认：1）                                                                             |
| `--dedup`               | 否        | 去重：相同覆盖行的测试只保留一个（默认关闭）                                                                      |
| `--skip-imports`        | 否        | 函数级匹配时跳过 import 语句行（默认关闭）                                                                   |
| `--new-tests-output`    | 否        | 将从 PR diff 提取的新增测试文件写入指定文件（每行一个），供 GitHub Action 层的追加表（append table）流程使用；不传则不写出        |

### 匹配粒度开关

| 参数                         | 默认  | 说明                        |
| -------------------------- | --- | ------------------------- |
| `--enable-line-match`      | 开启  | 启用行级匹配（默认值来自 adapter）     |
| `--disable-line-match`     | -   | 关闭行级匹配（**优先级高于 enable**）  |
| `--enable-function-match`  | 开启  | 启用函数级匹配（默认值来自 adapter）    |
| `--disable-function-match` | -   | 关闭函数级匹配（**优先级高于 enable**） |

**处理规则**：`disable` 参数优先于 `enable`：

```python
if args.disable_line_match:
    args.enable_line_match = False
if args.disable_function_match:
    args.enable_function_match = False
```

> **提示**：文件重命名/删除场景内部已固定使用"仅文件级匹配"（行级/函数级强制关闭），不受这些开关影响。

### 仓库差异对照

| 维度      | vllm_ascend                                         | sglang                                                          | torch_npu                                                   |
| ------- | --------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| PR 源    | GitHub                                              | GitHub                                                          | GitHub（pytorch/pytorch）                                     |
| 产品代码前缀  | `vllm_ascend/`                                      | `python/sglang/`                                                | `torch/`                                                     |
| 测试目录识别  | `tests__` 前缀 / `cpu-ut`                             | `____w__sglang__sglang__test__` 前缀                              | 目录名含 `__` 或以 `test_` 开头                                     |
| 覆盖率文件位置 | `covdata/` 子目录                                      | 测试目录下直接放置（兼容探测 covdata）                                         | `covdata/` 子目录                                              |
| 测试文件规则  | `tests/e2e/pull_request/`、`tests/ut/` 下 `test_*.py` | `test/registered/`、`test/{unit,e2e,integration}/` 下 `test_*.py` | `test/` 下 `test_*.py` |
| 全量触发变更  | csrc/ 目录（非 .md）→ 全量测试                               | 无（csrc/rust 走精准匹配）                                              | 无（原生变更走精准匹配）                                                |
| 测试名规范化  | `--`→`::`、`__`→`/`、文件级补 `.py`                       | 剥离编码前缀恢复 `test/`、`__`→`/`、`--`→`::`                             | `--`→`::`、`__`→`/`、文件级补 `.py`                               |
| 变更检测    | 本地哈希比对（默认）或 PR diff                                 | 同左                                                              | 同左                                                          |

---

## 五、匹配逻辑详解

### 全量触发变更检测（仅 vllm_ascend）

当 diff 中检测到 `csrc/` 目录变更（排除 `.md` 文件）时，**直接执行全量测试**，跳过精准匹配：

```
检测到 csrc 目录变更
  → base = 全量测试用例（test_case_map 中所有条目）
  → 跳过 parse_pr_diff_file() 和 select_tests()
  → 直接进入合并步骤
```

**原因**：`csrc` 目录通常包含底层 C/C++ 代码，其变更可能影响多个模块，难以通过精准匹配覆盖。

> sglang 不触发全量：`csrc/*.cu`、`rust/*.rs` 等原生代码变更不会被解析进精准匹配（仅保留 `.py`），推荐结果由 Python 产品代码匹配 + 新增/删除测试文件决定。
> 
> torch_npu 不触发全量：`torch/csrc/` 等原生代码（C++/CUDA）变更不会被解析进精准匹配（仅保留 `.py`）。**注意**：纯原生代码变更的 PR 可能返回 0 推荐，此时存在漏测风险，建议人工评估是否需跑相关用例（详见故障排除表）。

### 排除变更场景（diff_parser）

`_parse_diff_base_lines()` 解析统一 diff 文本为受影响的 base（变更前）行号，并在解析阶段/后续分类阶段排除以下**不构成代码变更**的场景：

| 场景                                   | 处理                                   |
| ------------------------------------ | ------------------------------------ |
| 纯注释/docstring 变更                     | 删除组全为注释/docstring 且新增为注释/doc 说明 → 剔除 |
| 纯类型注解变更（插入/替换/删除）                    | 可证明惰性的注解（函数体内、普通类、模块级，无副作用）→ 豁免      |
| 首次新增的变量绑定（纯插入）                    | 全部为绑定全新名字的带值赋值（名字在 base 中不存在、RHS 惰性、无尾逗号行）→ 豁免 |
| 函数/类定义之间的空行插入                        | 位于两个 def/class 之间 → 排除               |
| 新增 def/class 整体                      | 插入文本属于新定义的函数/类 → 排除                  |
| 新文件（`--- /dev/null` + `@@ -0,0 ...`） | 无 base 版本，跳过行级解析（避免无意义的 base 内容拉取）   |
| 函数体内纯插入                              | 记录插入位置上方的行号                          |
| 隔离空行删除                               | 按单行插入处理为候选对（上、下两行）                   |

**候选对分类**（`_classify_candidate_pairs`，需要 base 文件内容）：通过 GitHub contents API / GitCode raw 接口单路拉取 base 内容后做 AST 分类；拉取失败重试 3 次后直接退出（不允许降级），仅 AST 解析失败等无法分类的场景回退为 hunk 范围内双侧计数。

### 新增测试文件处理

从 diff 中提取新增/修改的测试文件（规则由 adapter 提供），直接加入推荐列表：

```python
new_tests = pr_detector.get_test_files_from_pr_diff(diff_content, adapter)
# vllm: 匹配 tests/e2e/pull_request/... 或 tests/ut/... 下 test_*.py
# sglang: 匹配 test/registered/... 或 test/{unit,e2e,integration}/... 下 test_*.py
# torch_npu: 匹配 test/ 下 test_*.py
```

### 已删除测试文件处理

从 diff 中检测被删除的测试文件（`--- a/...` + `+++ /dev/null` 对），从推荐列表中移除：

```python
deleted_tests = pr_detector.get_deleted_test_files_from_pr(diff_content, adapter)
```

### 结果合并公式

```
result = (base ∪ new_tests) - deleted_tests

其中:
  base = has_full_suite ? 全量测试 : 精准匹配结果
```

### 文件重命名/删除检测

当 diff 中检测到文件重命名或删除时，采用**特殊处理策略**：

```
检测到 rename: old_path -> new_path
  → new_path 在覆盖率数据中不存在（改名后未重新跑测试），精准匹配无效
  → old_path 在覆盖率数据中仍存在，单独做文件级匹配
  → 结果合并去重
```

**处理流程**：

```python
# 1. 检测 rename / delete（detect_renames，仅产品代码前缀下）
renames = detect_renames(diff_content)      # {old_path: new_path}
deleted_files = ...                          # [path, ...]

# 2. rename 新路径 / 删除文件从 changed_files 中排除（行级解析阶段已排除）

# 3. old_path 做文件级匹配
for path, label in file_level_paths:         # rename 旧路径 + 删除路径
    fl_selected, _ = select_tests(
        {path: set()},
        enable_line_match=False,      # 禁用（可能没有实际代码变更）
        enable_function_match=False,  # 禁用
        enable_file_match=True,       # 仅文件级（召回覆盖旧文件的测试）
    )
    selected.extend(fl_selected)
```

**控制台输出示例**：

```
=== Detected 1 Product Code Renamed File(s) - Using File-Level Matching ===
  vllm_ascend/core/worker.py -> vllm_ascend/core/worker_v2.py

=== File-Level Matched Tests for vllm_ascend/core/worker.py -> vllm_ascend/core/worker_v2.py ===
  cpu-ut
  tests/e2e/pull_request/one_card/test_worker.py
```

### 行级匹配

精确计算变更行与测试覆盖行的交集：

```
变更行: {100, 101, 102, 150, 151}
测试覆盖: {100, 101, 200, 201}
→ 交集: {100, 101} → 相关
```

### 函数级匹配

如果变更行落在某个函数内，则该函数被覆盖的所有测试都相关：

```
变更行 150 位于函数 process_request()
函数 process_request() 覆盖行: {140-200}
测试A 覆盖: {145, 146, 147} → 相关（覆盖了 process_request）
```

### 合并去重

行级和函数级**同时执行**，结果**合并去重**（行级结果优先）；无结果时级联**文件级匹配**兜底。

### 变更检测方式（change_detector）

- **PR 模式**：`parse_pr_diff_file()` 解析 PR diff，产出变更行号 + 重命名映射 + 删除列表
- **本地模式**（默认）：`detect_changes_by_comparison()` 扫描 `--source-dir` 下全部 `.py`，与 `.file_hashes.json` 基线比对 MD5，变更文件保守返回全部行号（1~9999），首次运行生成基线

### GitCode PR 拉取（公共备用模块）

GitCode PR 拉取通过公共模块 `test_selector.gitcode`（`--gitcode-pr`，当前无仓库默认使用；torch_npu 已切换到 GitHub 上游仓库 pytorch/pytorch），与 GitHub 版（`test_selector.github`，`--github-pr`）的差异：

| 维度            | github.py                                            | gitcode.py                                                           |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| PR 详情/diff 获取 | `/pulls/{n}` 返回 base.sha；diff 直连 `github.com/{repo}/pull/{n}.diff` 公开端点         | `/pulls/{n}` 返回 base.sha；diff 优先 `.diff` 公开端点，失败兜底 `/pulls/{n}/files` 拼接 |
| diff 拼接       | 无需拼接                                                 | `_build_unified_diff()` 合成 git 标记（`rename from/to`、`deleted file mode`、`--- a/` / `+++ b/` 头），结果格式与 GitHub 一致；`patch.diff` 为空时：纯改名/删除/新增仍合成标记（保文件级信号）、二进制/纯 mode 变更显式跳过、`too_large` 打印警告且行级变更不包含在拼接结果中 |
| base 内容获取     | GitHub contents API（`?ref=base_sha`，base64）          | `raw.gitcode.com/{repo}/raw/{sha}/{path}`                            |
| 认证方式          | `Authorization: Bearer`（`GITHUB_TOKEN` / `GH_TOKEN`） | `access_token` 查询参数（`GITCODE_TOKEN`）                                 |

> 拼接后的 diff 格式与 GitHub 一致，因此下游 `diff_parser` 的噪音分类逻辑完全复用，不感知数据源差异。
> **代理要求**：GitCode/GitHub API 均需直连外网；华为内网环境必须配置代理（见第九章）。若未配置代理，`urllib` 抛 `WinError 10060` 连接超时，3 次重试后退出。
> **不允许降级**：PR 详情（base.sha）、diff 主路（`.diff` 端点）与 base 文件内容拉取失败均重试 3 次（间隔 30 秒，避开边缘限流窗口）后直接退出，不降级继续；diff 获取仅 GitCode 保留 `/files` 拼接兜底（GitHub 无兜底），兜底同样重试 3 次，全部失败即退出。

---

## 六、Map 构建逻辑

### 噪音过滤功能

构建 Map 时，自动过滤无效噪音行（`NoiseFilter`，每文件一次 AST 解析并缓存）：

| 类型              | 说明                                   | 示例                               |
| --------------- | ------------------------------------ | -------------------------------- |
| `import`        | import/from...import 语句行（含多行 import） | `import torch`、`from X import Y` |
| `def`           | 函数定义行（含多行 def 头部）                    | `def func():`、`async def foo():` |
| `class`         | 类定义行                                 | `class MyClass:`                 |
| `docstring`     | 模块级、类、函数的 docstring 行                | `"""doc"""`、`'''doc'''`          |
| `@staticmethod` | 静态方法装饰器                              | `@staticmethod`                  |
| `@classmethod`  | 类方法装饰器                               | `@classmethod`                   |
| `@property`     | 属性装饰器                                | `@property`                      |
| `blank`         | 空行/纯空白行                              | 空行、仅含空格/制表符的行                    |

**装饰器过滤规则**：只过滤 `@staticmethod`、`@classmethod`、`@property` 三种；其他装饰器（如 `@triton.jit`、`@wraps`、`@contextmanager`）**保留**。

**空行过滤说明**：Coverage arc 数据基于字节码控制流转移，空行也会作为控制流节点被记录（如 `if` 块结束后的空行、`return` 后的空行）。不过滤会导致行级匹配命中空行，产生误报。

**生效条件**：`--source-dir` 已指定（用于定位源码文件进行 AST 解析）。

**空文件自动过滤**：覆盖行经噪音过滤后为空则该文件不写入 map（减少 map 体积，不影响选择逻辑）。

### Map 文件结构

```json
{
  "test/registered/npu/basic_function/backends/test_npu_sampling_backend.py": {
    "files": {
      "srt/arg_groups/model_overrides/qwen3_vl.py": [16, 19],
      "srt/configs/qwen3_vl.py": [5, 6, 143, 144]
    },
    "file_count": 2,
    "line_count": 4
  },
  "tests/ut/core/test_distributed.py::test_get_global_rank": {
    "files": {
      "vllm_ascend/distributed/utils.py": [50, 51, 52, 60, 61]
    },
    "file_count": 1,
    "line_count": 5
  }
}
```

**注意**：

- map 的 key 为 normalize 后的测试路径（vllm：`tests/.../test_xxx.py` 或 `...::test_func`、`cpu-ut`；sglang：`test/.../test_xxx.py`；torch_npu：`test/.../test_xxx.py`、`_inductor/test_add.py` 等，文件级补 `.py`）
- files 的 key 为剥离产品代码前缀后的相对路径（vllm：`core/worker.py`；sglang：`srt/xxx.py`；torch_npu：`distributed/xxx.py`）
- 保存时强制使用 LF 换行（`newline="\n"`），避免 Windows CRLF 导致 JSON 体积膨胀，保证跨平台 git 差异对比一致

---

## 七、输出说明

### 控制台输出示例

**场景1：检测到 csrc 变更（vllm，执行全量）**

```
=== CSRC Directory Changes Detected - Running Full Test Suite ===

=== Full Test Suite: 3481 tests ===

=== Recommended Test Cases (3483 tests) ===
Results saved to: recommended_pytest_paths.txt
```

**场景2：精准匹配**

```
Parsed 4 changed files:
  vllm_ascend/core/worker.py: 2-5
  vllm_ascend/distributed/utils.py: 1339-1340

=== Selecting Affected Test Cases ===
  Line match: 12 tests, Function match: 3 tests, Total: 15 tests

======================================================================
Code changes: 4 files, 15 lines
Selected: 15 test cases (Line+Function match)
======================================================================

#    Test Case                                              Affected Lines
----------------------------------------------------------------------
1    cpu-ut                                                  3 (2-5)
2    tests/e2e/pull_request/four_card/context_parallel/test_accuracy  3 (114, 3987-3988)
...
```

**场景3：包含新增/删除测试**

```
=== New Test Files Added: 1 ===
  ['tests/ut/core/test_new_feature.py']

=== Deleted Test Files Removed: 1 ===
  ['tests/ut/core/test_deprecated.py']
```

### 输出文件（`recommended_pytest_paths.txt`）

写入仓库根目录，每行一个测试用例路径：

```
cpu-ut
tests/e2e/pull_request/four_card/context_parallel/test_accuracy
test/registered/npu/basic_function/backends/test_npu_sampling_backend.py
...
```

### 新增测试文件输出（`--new-tests-output`）

传入 `--new-tests-output <path>` 时，PR diff 中提取的新增测试文件（与推荐列表同构，每行一个标准测试名）单独写入该文件。GitHub Action 层（`src/index.ts`）在 PR 合并事件中读取此文件，将其与 OBS 上的追加表合并去重后回传，实现"合入新用例"的增量积累；纯 Python 使用无需关心此参数。

---

## 八、典型使用场景

### 场景1：分析 PR

```bash
# GitHub PR（vllm_ascend / sglang）
python -m test_selector --repo vllm_ascend \
    --github-pr "vllm-project/vllm-ascend#16104" -s ./covstub

python -m test_selector --repo sglang \
    --github-pr "sgl-project/sglang#37043" -s ./covstub

# GitHub PR（torch_npu，上游 pytorch/pytorch）
python -m test_selector --repo torch_npu \
    --github-pr "pytorch/pytorch#150000" -s ./covstub
```

### 场景2：更新覆盖率数据后重建映射

```bash
# 1. 跑完测试，得到新的覆盖率数据
# 2. 重建映射
python -m test_selector --repo sglang --build-map -c "sglang@20260909" -s ./covstub

# 3. 推荐测试
python -m test_selector --repo sglang --github-pr "sgl-project/sglang#37758" -s ./covstub
```

### 场景3：精准回归测试

```bash
# 推荐测试
python -m test_selector --repo vllm_ascend --github-pr "owner/repo#123" -s ./covstub

# 查看 recommended_pytest_paths.txt 获取测试列表并执行
pytest tests/e2e/pull_request/one_card/test_worker.py -v
```

### 场景4：本地哈希比对检测变更（无 PR）

```bash
# 首次运行生成基线 .file_hashes.json
python -m test_selector --repo vllm_ascend -s ./covstub

# 修改源码后再运行 → 检测到变更文件并推荐
python -m test_selector --repo vllm_ascend -s ./covstub
```

### 场景5：代码库内部结构说明

```python
from test_selector.repos import get_adapter
from test_selector.coverage_selector import CoverageSelector
from test_selector.change_detector import CodeChangeDetector
from test_selector.test_selector import TestSelector

adapter = get_adapter("sglang")                 # 选择仓库适配器（vllm_ascend / sglang / torch_npu）

selector = CoverageSelector("coverage", "covstub", adapter)
selector.build_test_case_map()
selector.save_map("test_case_map.json")

detector = CodeChangeDetector("covstub", adapter)
changed = detector.detect_changes_by_comparison()

ts = TestSelector(selector.test_case_map, adapter)
selected, reason = ts.select_tests(changed, source_dir="covstub")
```

---

## 九、故障排除

| 问题                                                                  | 可能原因                                                              | 解决方案                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Error: --coverage-dir is required when building the test case map` | map 文件不存在且未传覆盖率目录                                                 | 首次使用需传 `--coverage-dir`（或先 `--build-map`）                                                             |
| `Coverage data directory not found`                                 | 覆盖率目录路径不对                                                         | 确认 `--coverage-dir` 指向含测试用例目录的根目录                                                                     |
| `没有测试用例覆盖变更的代码行`                                                    | 变更文件无覆盖数据                                                         | 确认覆盖率数据来自变更前的全量用例                                                                                     |
| `解析 PR 失败` / GitHub API 超时                                          | 内网无法直连 GitHub                                                     | 设置代理环境变量后重试（见下方）                                                                                      |
| `WinError 10060` 连接超时（GitCode）                                      | 内网无法直连 GitCode API                                                | 设置代理环境变量后重试（见下方）；git 全局已配置 `proxycn2.huawei.com:8080` 认证代理时，PowerShell 中执行 `$env:HTTPS_PROXY=...` 后重试 |
| `函数级匹配失败`                                                           | 源码目录路径不对                                                          | 确认 `--source-dir` 指向包含 `vllm_ascend/` / `sglang/` / `torch/` 包的根目录                                |
| 推荐结果过多                                                              | 变更函数被大量测试覆盖                                                       | 启用 `--dedup` 或提高 `--min-affected`                                                                     |
| 推荐结果为空                                                              | PR 仅含原生代码变更且无新测试文件（sglang）                                        | 正常，原生代码变更不触发全量                                                                                        |
| 推荐结果为空                                                              | PR 仅含原生代码变更（torch_npu，如 `torch/csrc/` 下 C++/CUDA 文件）        | 正常但**存在漏测风险**：原生代码变更不解析进精准匹配；建议人工评估是否需跑相关用例                                                        |
| `Full-Suite Changes Detected`（vllm）                                 | diff 含 csrc/ 目录变更                                                 | 正常行为，触发全量测试                                                                                           |
| `New Test Files Added: X`                                           | diff 中有新增测试文件                                                     | 正常，直接加入推荐列表                                                                                           |
| `Deleted Test Files Removed: X`                                     | diff 中有已删除测试文件                                                    | 正常，从推荐列表移除                                                                                            |
| `Detected X Renamed File(s)`                                        | diff 中包含文件重命名                                                     | 正常，旧路径做文件级匹配                                                                                          |
| 变更行数偏多、含 context 行                                                  | diff 解析按 hunk 范围推算                                                | 已知限制，算法保守偏多报                                                                                          |
| `Unknown repo 'xxx'`                                                | `--repo` 拼写错误                                                     | 使用 `vllm_ascend` / `sglang` / `torch_npu`                                                             |

**代理配置示例（华为内网环境）**：

```bash
# Windows PowerShell / CMD
set HTTP_PROXY=http://<user>:<pwd>@proxycn2.huawei.com:8080/
set HTTPS_PROXY=http://<user>:<pwd>@proxycn2.huawei.com:8080/

python -m test_selector --repo vllm_ascend --github-pr "vllm-project/vllm-ascend#16104" -s ./covstub
python -m test_selector --repo torch_npu --github-pr "pytorch/pytorch#150000" -s ./covstub
```

> **说明**：
> 
> - Python `urllib` 会自动读取 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量走代理；脚本内部已通过自定义 `ssl_context` 关闭证书校验。
> - GitHub 与 GitCode 均适用；本机 git 全局代理（`git config --global http.proxy`，如 `http://<user>:<pwd>@proxycn2.huawei.com:8080/`）可直接复用为环境变量。
> - PowerShell 中设置环境变量用 `$env:HTTPS_PROXY='...'`（`set` 仅对 CMD 有效）。
