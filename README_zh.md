# precision-test（精准测试选择器）

[English](README.md) | [中文](README_zh.md)

基于覆盖率数据的 GitHub Actions 精准测试选择器。分析代码变更，以行级和函数级粒度
选择相关测试用例（文件级匹配保留给重命名/删除的产品代码场景）。

## 特性

- **多粒度匹配**：行级 + 函数级测试选择，文件级匹配内部应用于重命名/删除的产品代码
- **基于覆盖率的选择**：利用覆盖率数据识别受影响的测试用例
- **多仓库适配器**：内置 `vllm_ascend`、`sglang`、`pytorch` 适配器，通过 `repo` 输入选择
- **PR 集成**：通过 GitHub API 拉取 PR diff（`vllm_ascend` / `sglang` / `pytorch`）；
  `pytorch` 跟踪上游 `pytorch/pytorch` 仓库
- **OBS 覆盖率产物**（可选）：上传全量覆盖率 tar 包、重建并共享测试用例 map、
  维护新合入用例的增量追加表 —— 全程使用 OIDC 临时凭证，无需永久密钥
- **安全加固**：路径穿越校验、子进程执行超时保护

## 用法

### 基础 Workflow

```yaml
name: Precision Test

on:
  pull_request:
    branches: [main]

jobs:
  select-tests:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Precision Test Selector
        id: selector
        uses: lb-actions/precision-test@v1.0.0
        with:
          github-pr: ${{ github.repository }}#${{ github.event.pull_request.number }}
          source-dir: src
          coverage-dir: coverage
          min-affected: 1

      - name: Run Selected Tests
        run: |
          if [ -f recommended_pytest_paths.txt ]; then
            pytest -n auto $(cat recommended_pytest_paths.txt)
          fi
```

### 使用测试用例 map

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    github-pr: ${{ github.repository }}#${{ github.event.pull_request.number }}
    map-file: test_case_map.json
    build-map: 'true'
```

### GitHub PR（pytorch）

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: pytorch
    github-pr: pytorch/pytorch#${{ github.event.pull_request.number }}
    source-dir: covstub
```

## 输入参数

| 参数 | 说明 | 必填 | 默认值 |
|------|------|------|--------|
| `repo` | 仓库适配器：`vllm_ascend` / `sglang` / `pytorch` | 否 | `vllm_ascend` |
| `github-pr` | GitHub PR（vllm_ascend / sglang / pytorch），格式：`owner/repo#pr_number` 或仅 `pr_number`；pytorch 使用上游 `pytorch/pytorch#N` | 否 | - |
| `gitcode-pr` | GitCode PR（公共备用模块，当前无适配器默认使用），格式：`owner/repo#pr_number`；与 `github-pr` 互斥 | 否 | - |
| `source-dir` | 源码目录 | 否 | `covstub` |
| `map-file` | 测试用例 map 文件 | 否 | `test_case_map.json` |
| `coverage-dir` | 覆盖率数据目录（仅构建 map 时需要） | 否 | `coverage` |
| `build-map` | 重建测试用例映射 | 否 | `false` |
| `coverage-tar-path` | 覆盖率 tar 包路径；提供即触发：上传 OBS、从 tar 重建 map、上传 map、重置追加表 | 否 | - |
| `download-coverage` | 从 OBS 下载覆盖率 tar 包与 map（此前由 `coverage-tar-path` 上传）并自动回填 `source-dir` / `map-file` / `coverage-dir`；调用方只需传 `github-pr`。任何下载失败都会使运行失败。与 `coverage-tar-path`、`build-map` 互斥 | 否 | `false` |
| `append-on-merge` | 将本 PR 的新增用例追加到 OBS 追加表（在 PR 合并事件时运行；需配 `github-pr` 或 `gitcode-pr`）。sglang 忽略此项 | 否 | `false` |
| `enable-append-table` | 将 OBS 追加表合并进推荐用例列表。sglang 忽略此项 | 否 | `true` |
| `project-name` | OBS 路径中的项目名段（如 `MindIE-LLM`、`vllm-ascend`）；缺省回退当前仓库名 | 否 | 仓库名 |
| `chip-type` | OBS 路径中的芯片类型段 | 否 | `Ascend` |
| `obs-bucket-name` | 覆盖率 tar / map / 追加表所在的 OBS 桶 | 否 | `op-case-result` |
| `oidc-config` | 自定义 OBS 账号的 OIDC 客户端配置 JSON（如 `{"accountId":"...","region":"cn-southwest-2"}`）；留空使用默认 openlibing 账号 | 否 | - |

> 文件级匹配保留给重命名/删除的产品代码文件，不作为输入暴露；检测到此类变更时自动执行。
> 细粒度匹配开关（`min-affected`、`dedup`、`enable-line-match`、
> `enable-function-match`、`skip-imports`）在 `action.yml` 中仍然存在；
> 此处省略，保持默认值即可。

## 输出参数

| 输出 | 说明 |
|------|------|
| `upload-success` | 覆盖率 tar / map 上传是否成功（仅在提供 `coverage-tar-path` 时设置） |
| `obs-url` | 已上传覆盖率 tar 的 OBS 公网 URL（仅在上传成功时设置） |

action 同时将推荐用例列表写入工作区的 `recommended_pytest_paths.txt`，并向日志
打印 `test-list-file=<path>` 和 `test-count=<n>`。后续步骤直接读取该文件即可：

```yaml
- name: Run Selected Tests
  run: |
    if [ -f recommended_pytest_paths.txt ]; then
      pytest -n auto $(cat recommended_pytest_paths.txt)
    fi
```

## OBS 覆盖率产物

所有可选 OBS 功能共享同一目录：

```
{obs-bucket-name}/precision/{chip-type}/{project-name}/
  ├── coverage.tar.gz        # 全量覆盖率 tar 包（固定名，每次上传覆盖）
  ├── test_case_map.json     # 测试用例 map（固定名，每次重建覆盖）
  └── appended_tests.txt     # 新合入用例追加表（单文件，累积增长）
```

### 覆盖率上传模式（`coverage-tar-path`）

上传全量覆盖率 tar 包，用现有 Python 流程从中重建 map，上传 map，并重置追加表
（tar 携带全量用例集，增量表从空重新开始）。任何上传失败都会使步骤失败——
不静默丢数据。需要 `permissions: id-token: write`。

tar 包解压到 `<workspace>/coverage-extract/`，布局由仓库适配器规则自动发现
（含覆盖率文件的测试用例目录，以及内置的 `covstub/` 源码树），因此 tar 既可以是
打包布局（`<pkg>/{covstub, <run>/<test-case-dirs>}`）也可以是扁平布局。发现的
目录通过 `PRECISION_COVERAGE_DIR` 和 `PRECISION_SOURCE_DIR` 环境变量导出，
供后续步骤使用。

```yaml
- name: Upload coverage and rebuild map
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    coverage-tar-path: coverage.tar.gz
    project-name: vllm-ascend
```

### 覆盖率下载模式（`download-coverage`）

PR 验证运行时无需再传本地 `source-dir` / `map-file` / `coverage-dir`：
action 会下载此前 `coverage-tar-path` 运行上传的 tar 包与 map（固定键名，位于
`precision/{chip-type}/{project-name}/` 下），将 tar 解压到
`<workspace>/coverage-extract/`，按与上传模式相同的规则自动发现布局，
然后照常执行选择——调用方只需传 `github-pr` 与 OBS 参数。tar 通过 OBS SDK 的
`SaveAsFile` 流式落盘（全程不进内存）。任何下载失败都会使运行失败（与追加表不同，
这两样产物是选择所必需的）。与 `coverage-tar-path`、`build-map` 互斥。需要
`permissions: id-token: write`。

```yaml
- name: Precision test (coverage downloaded from OBS)
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    github-pr: vllm-project/vllm-ascend#${{ github.event.pull_request.number }}
    download-coverage: 'true'
    project-name: vllm-ascend
```

### 合并追加（`append-on-merge`）

在 PR 合并事件中，提取该 PR 的新增测试用例，追加到 OBS 上的单一追加表对象
（并集去重；文件原地累积，不新建文件）。同时照常执行测试选择——推荐列表
仍可供后续步骤使用。sglang 忽略此项（其覆盖率数据为每日全量，无增量可追加）。
需要 `github-pr` 或 `gitcode-pr`。

```yaml
on:
  pull_request:
    types: [closed]

# job 中（用 if: github.event.pull_request.merged == true 守卫）:
- name: Update append table
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    github-pr: vllm-project/vllm-ascend#${{ github.event.pull_request.number }}
    append-on-merge: 'true'
```

### 推荐合并（`enable-append-table`）

推荐测试时（PR 验证运行），下载追加表并合并进推荐列表（并集去重），确保在下次
全量覆盖率上传之前新合入的测试用例不会被遗漏。需要 PR 输入（`github-pr` 或
`gitcode-pr`）；覆盖率上传模式下跳过（表刚被重置）。下载失败仅告警——本地推荐
照常进行。默认开启；sglang 忽略此项。

### 自定义 OBS 账号（`oidc-config`）

默认所有上传使用内置 openlibing 账号。要使用自己的华为云 OBS 账号，传入 OIDC
配置 JSON（字段：`accountId`、`audience`、`agencyName`、`oidcProviderName`、
`region`、`durationSeconds`、`refreshBufferSeconds`、`debug`；仅传入的字段
覆盖默认值）：

```yaml
- name: Upload coverage (custom OBS account)
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    coverage-tar-path: coverage.tar.gz
    obs-bucket-name: my-own-bucket
    oidc-config: '{"accountId": "my-account", "agencyName": "my-agency", "region": "cn-southwest-2"}'
```

> **注意**：在 GitHub 平台运行时，openlibing 账号侧需使用 `GitHubActions`
> 提供商（默认的 `GitCodeActions` 提供商仅接受 GitCode Actions 平台签发的
> Token）。可通过 `oidc-config: '{"oidcProviderName":"GitHubActions"}'` 覆盖，
> 并确保委托信任策略已放行该提供商。

## 环境变量

action 会将 workflow 环境透传给 Python 子进程，基于 token 的认证自动生效。
仅以下变量会被 action（Node 入口或 Python 包）读取：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GITHUB_TOKEN` / `GH_TOKEN` | - | PR diff 拉取的 GitHub API token（`vllm_ascend` / `sglang` / `pytorch` 使用）。公共仓库和同组织 PR 用默认 `github.token` 即可。 |
| `GITCODE_TOKEN` | - | GitCode API token（仅 `gitcode-pr` 备用模块使用；默认适配器不使用）。通过 secret 提供，如 `${{ secrets.GITCODE_TOKEN }}`。 |
| `PYTHON_EXEC_TIMEOUT_SECONDS` | `600` | Python 子进程整体执行超时（秒，DoS 防护）。 |
| `MAX_COVERAGE_TAR_SIZE_MB` | `500` | OBS 上传模式下覆盖率 tar 包的最大体积（MB）。 |

### 示例

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PYTHON_EXEC_TIMEOUT_SECONDS: 900
  with:
    github-pr: ${{ github.repository }}#${{ github.event.pull_request.number }}
```

`pytorch`（上游 `pytorch/pytorch` PR）需显式传入上游仓库：

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    repo: pytorch
    github-pr: pytorch/pytorch#${{ github.event.pull_request.number }}
```

## 覆盖率数据格式

action 期望 SQLite 格式的覆盖率数据，包含以下表：

- `file`：文件路径信息
- `arc`：覆盖率弧数据（fromno, tono）

## 许可证

MIT
