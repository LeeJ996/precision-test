# precision-test

[English](README.md) | [中文](README_zh.md)

Coverage-based precision test selector for GitHub Actions. Analyzes code changes
and selects relevant test cases based on coverage data with line and function
granularity (file-level matching is reserved for renamed/deleted product code).

## Features

- **Multi-granularity matching**: Line-level and function-level test selection,
  with file-level matching applied internally to renamed/deleted product code
- **Coverage-based selection**: Uses coverage data to identify affected test cases
- **Multi-repo adapters**: Built-in adapters for `vllm_ascend`, `sglang`, and
  `pytorch`, selected via the `repo` input
- **PR integration**: Fetches PR diff from GitHub API (`vllm_ascend` / `sglang`
  / `pytorch`); `pytorch` tracks the upstream `pytorch/pytorch` repository
- **OBS-backed coverage artifacts** (optional): upload the full coverage tar,
  rebuild and share the test case map, and maintain an incremental append table
  of newly merged test cases — all via OIDC temporary credentials, no permanent
  secrets required
- **Security hardening**: Path traversal validation and subprocess execution
  timeout

## Usage

### Basic Workflow

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

### With Test Case Map

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    github-pr: ${{ github.repository }}#${{ github.event.pull_request.number }}
    map-file: test_case_map.json
    build-map: 'true'
```

### GitHub PR (pytorch)

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: pytorch
    github-pr: pytorch/pytorch#${{ github.event.pull_request.number }}
    source-dir: covstub
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `repo` | Repository adapter: `vllm_ascend` / `sglang` / `pytorch` | No | `vllm_ascend` |
| `github-pr` | GitHub PR (vllm_ascend / sglang / pytorch), format: `owner/repo#pr_number` or just `pr_number`; pytorch uses upstream `pytorch/pytorch#N` | No | - |
| `gitcode-pr` | GitCode PR (public fallback module, currently unused by default adapters), format: `owner/repo#pr_number`; mutually exclusive with `github-pr` | No | - |
| `source-dir` | Source code directory | No | `covstub` |
| `map-file` | Test case map file | No | `test_case_map.json` |
| `coverage-dir` | Coverage data directory (required only when building the map) | No | `coverage` |
| `build-map` | Rebuild test case mapping | No | `false` |
| `coverage-tar-path` | Coverage tar package path; when provided: upload to OBS, rebuild the map from it, upload the map, and reset the append table | No | - |
| `append-on-merge` | Append the new test cases of this PR to the OBS append table (run on PR merge event; requires `github-pr` or `gitcode-pr`). Ignored for `sglang` | No | `false` |
| `enable-append-table` | Merge the OBS append table into the recommended test list. Ignored for `sglang` | No | `true` |
| `project-name` | Project name segment of the OBS path (e.g. `MindIE-LLM`, `vllm-ascend`); defaults to the current repository name | No | repo name |
| `chip-type` | Chip type segment of the OBS path | No | `Ascend` |
| `obs-bucket-name` | OBS bucket for coverage tar / map / append table | No | `op-case-result` |
| `oidc-config` | OIDC client config JSON for a custom OBS account (e.g. `{"accountId":"...","region":"cn-southwest-2"}`); empty = default openlibing account | No | - |

> File-level matching is reserved for renamed/deleted product code files and is
> not exposed as an input; it runs automatically when such changes are detected.
> Fine-grained matching toggles (`min-affected`, `dedup`, `enable-line-match`,
> `enable-function-match`, `skip-imports`) still exist in `action.yml`; they are
> omitted here and generally safe to leave at their defaults.

## Outputs

| Output | Description |
|--------|-------------|
| `upload-success` | Whether the coverage tar / map upload succeeded (set only when `coverage-tar-path` is provided) |
| `obs-url` | Public OBS URL of the uploaded coverage tar (set only when upload succeeded) |

The action also writes the recommended test list to `recommended_pytest_paths.txt`
in the workflow workspace and prints `test-list-file=<path>` and `test-count=<n>`
to the log. Read the file directly in a subsequent step:

```yaml
- name: Run Selected Tests
  run: |
    if [ -f recommended_pytest_paths.txt ]; then
      pytest -n auto $(cat recommended_pytest_paths.txt)
    fi
```

## OBS-Backed Artifacts

All optional OBS features share one directory:

```
{obs-bucket-name}/precision/{chip-type}/{project-name}/
  ├── coverage.tar.gz        # full coverage tar (fixed name, overwritten each upload)
  ├── test_case_map.json     # test case map (fixed name, overwritten each rebuild)
  └── appended_tests.txt     # append table of newly merged test cases (single file, accumulates)
```

### Coverage upload mode (`coverage-tar-path`)

Upload the full coverage tar, rebuild the map from it with the existing Python
flow, upload the map, and reset the append table (the tar carries the full test
set, so the incremental table restarts from empty). Any upload failure fails
the step — no silent data loss. Requires `permissions: id-token: write`.

The tar is extracted to `<workspace>/coverage-extract/` and its layout is
auto-discovered via the repo adapter rules (test-case dirs holding coverage
files, plus the bundled `covstub/` source tree when present), so the tar can
use either a packaged layout (`<pkg>/{covstub, <run>/<test-case-dirs>}`) or a
flat one. The discovered directories are exported as `PRECISION_COVERAGE_DIR`
and `PRECISION_SOURCE_DIR` environment variables for subsequent steps.

```yaml
- name: Upload coverage and rebuild map
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    coverage-tar-path: coverage.tar.gz
    project-name: vllm-ascend
```

### Append on merge (`append-on-merge`)

On a PR merge event, extract the PR's new test cases and append them to the
single append-table object on OBS (union, dedup; the file accumulates in place,
never creating new files). Runs the normal test selection as well — the
recommended list stays available for subsequent steps. Ignored for `sglang`
(its coverage data is full-suite daily, so there is nothing incremental to
append). Requires `github-pr` or `gitcode-pr`.

```yaml
on:
  pull_request:
    types: [closed]

# in the job (guard with `if: github.event.pull_request.merged == true`):
- name: Update append table
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    github-pr: vllm-project/vllm-ascend#${{ github.event.pull_request.number }}
    append-on-merge: 'true'
```

### Recommendation merge (`enable-append-table`)

When recommending tests (PR validation runs), the append table is downloaded
and merged into the recommended list (union, dedup) so that newly merged test
cases are never missed even before the next full coverage upload. Requires a
PR input (`github-pr` or `gitcode-pr`); skipped in coverage-upload mode (the
table has just been reset). Download failures are warnings — the local
recommendation still runs. On by default; ignored for `sglang`.

### Custom OBS account (`oidc-config`)

By default all uploads use the built-in openlibing account. To use your own
Huawei Cloud OBS account, pass an OIDC config JSON (fields: `accountId`,
`audience`, `agencyName`, `oidcProviderName`, `region`, `durationSeconds`,
`refreshBufferSeconds`, `debug`; only provided fields override the defaults):

```yaml
- name: Upload coverage (custom OBS account)
  uses: lb-actions/precision-test@v1.0.0
  with:
    repo: vllm_ascend
    coverage-tar-path: coverage.tar.gz
    obs-bucket-name: my-own-bucket
    oidc-config: '{"accountId": "my-account", "agencyName": "my-agency", "region": "cn-southwest-2"}'
```

## Environment Variables

The action forwards the workflow environment to the Python subprocess, so
token-based authentication is picked up automatically. Only the variables
below are read by the action (Node entry or Python package):

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` / `GH_TOKEN` | - | GitHub API token for PR diff fetch (used by `vllm_ascend` / `sglang` / `pytorch`). The default `github.token` is sufficient for public repos and same-org PRs. |
| `GITCODE_TOKEN` | - | GitCode API token (only when using the `gitcode-pr` fallback; unused by default adapters). Provide via a secret, e.g. `${{ secrets.GITCODE_TOKEN }}`. |
| `PYTHON_EXEC_TIMEOUT_SECONDS` | `600` | Overall Python subprocess execution timeout in seconds (DoS guard). |
| `MAX_COVERAGE_TAR_SIZE_MB` | `500` | Maximum coverage tar size in MB for the OBS upload mode. |

### Example

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PYTHON_EXEC_TIMEOUT_SECONDS: 900
  with:
    github-pr: ${{ github.repository }}#${{ github.event.pull_request.number }}
```

For `pytorch` (upstream `pytorch/pytorch` PRs), pass the upstream repository
explicitly:

```yaml
- name: Precision Test Selector
  uses: lb-actions/precision-test@v1.0.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    repo: pytorch
    github-pr: pytorch/pytorch#${{ github.event.pull_request.number }}
```

## Coverage Data Format

The action expects coverage data in SQLite format with the following tables:

- `file`: File path information
- `arc`: Coverage arc data (fromno, tono)

## License

MIT
