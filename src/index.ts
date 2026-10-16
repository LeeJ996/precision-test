/**
 * Precision Test Selector - GitHub Action Entry Point
 *
 * Coverage-based precision test selector supporting line, function, and file
 * granularity. Wraps the Python `test_selector` package (invoked via
 * `python -m test_selector`) and supports vllm_ascend / sglang / pytorch
 * (GitHub PR); pytorch tracks the upstream pytorch/pytorch repository.
 *
 * The bundled Python package ships next to this script at `dist/test_selector/`
 * and is made importable via PYTHONPATH so `python -m test_selector` resolves
 * it. All relative path inputs are resolved to absolute paths (against the
 * workflow workspace) before being forwarded, because the Python CLI resolves
 * relative paths against the package directory (BASE_DIR), not the workspace.
 *
 * Optional OBS-backed features (all artifacts share one OBS directory):
 * - Coverage upload mode (coverage-tar-path): upload the full coverage tar,
 *   rebuild the test case map from it, upload the map, and reset the append
 *   table (the tar contains the full test set, so the incremental table
 *   restarts from empty). The tar is extracted to `<workspace>/coverage-extract`
 *   and its layout is auto-discovered via the repo adapter (coverage root =
 *   common parent of the test-case dirs; source dir = the bundled covstub).
 *   The discovered dirs are exported as PRECISION_COVERAGE_DIR /
 *   PRECISION_SOURCE_DIR for subsequent workflow steps.
 * - Coverage download mode (download-coverage): download the tar + map
 *   previously uploaded via coverage-tar-path, auto-fill source-dir /
 *   map-file / coverage-dir and let the caller pass github-pr only. The tar
 *   is streamed to disk via SaveAsFile (never buffered in memory) and its
 *   layout is auto-discovered the same way as the upload mode. Any download
 *   failure is fatal (the artifacts are required for selection).
 * - Append-on-merge (append-on-merge): extract the PR's new test cases and
 *   append them to the single append-table object on OBS (accumulate in place).
 * - Recommendation merge (enable-append-table): download the append table and
 *   merge it into the recommended test list.
 * - sglang never uses the append table (adapters keep full data daily).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// The OBS SDK and OIDC client ship without TypeScript declarations.
/* eslint-disable @typescript-eslint/no-var-requires */
const ObsClient = require("esdk-obs-nodejs");
const { getCredentials, configure } = require("@openlibing/huaweicloud-oidc-client");
// Native module objects via require: the ESM namespace from `import * as`
// is frozen (getter-only), so the https.request patch below needs the
// mutable CommonJS module object instead.
const https: typeof import("https") = require("https");
const tls: typeof import("tls") = require("tls");

// esdk-obs-nodejs builds TLS requests with a hardcoded checkServerIdentity
// that always returns undefined: ssl_verify only restores chain validation,
// not hostname validation. Patch https.request once to restore Node's default
// hostname check for *.myhuaweicloud.com OBS endpoints (same as pytest-orch).
const origHttpsRequest = https.request;
https.request = function (this: typeof https, ...args: unknown[]) {
  const opt = args[0] as { host?: string; checkServerIdentity?: unknown };
  if (
    opt &&
    typeof opt === "object" &&
    typeof opt.host === "string" &&
    opt.host.endsWith(".myhuaweicloud.com") &&
    typeof opt.checkServerIdentity === "function"
  ) {
    opt.checkServerIdentity = tls.checkServerIdentity;
  }
  return (origHttpsRequest as (...a: unknown[]) => unknown).apply(this, args);
} as typeof https.request;

/**
 * Security: Python subprocess execution timeout in seconds (prevents DoS).
 * Can be overridden via PYTHON_EXEC_TIMEOUT_SECONDS environment variable.
 */
const PYTHON_EXEC_TIMEOUT_SECONDS = parseInt(
  process.env.PYTHON_EXEC_TIMEOUT_SECONDS || "600",
  10,
);

/**
 * Coverage tar package maximum size in MB (prevents reading an untrusted
 * oversized file into memory). Overridable via MAX_COVERAGE_TAR_SIZE_MB.
 */
const MAX_COVERAGE_TAR_SIZE_MB = parseInt(
  process.env.MAX_COVERAGE_TAR_SIZE_MB || "500",
  10,
);

/** Fixed OBS object names inside the project directory (single copy each). */
const OBS_TAR_KEY_NAME = "coverage.tar.gz";
const OBS_MAP_KEY_NAME = "test_case_map.json";
const OBS_APPEND_KEY_NAME = "appended_tests.txt";

interface ObsContext {
  bucketName: string;
  projectDir: string; // precision/{chip-type}/{project-name}
  oidcConfig: Record<string, unknown>;
}

interface ObsObjectResult {
  ok: boolean;
  status?: number;
  content?: Buffer;
  message?: string;
}

/**
 * Execute a command with timeout. Wraps exec.exec() with timeout functionality.
 */
async function execWithTimeout(
  commandLine: string,
  args: string[],
  options: exec.ExecOptions,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    exec
      .exec(commandLine, args, options)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Execute a command with timeout and capture its stdout/stderr.
 */
async function execCaptureWithTimeout(
  commandLine: string,
  args: string[],
  options: exec.ExecOptions,
  timeoutMs: number,
): Promise<exec.ExecOutput> {
  return new Promise<exec.ExecOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs / 1000} seconds`));
    }, timeoutMs);
    exec
      .getExecOutput(commandLine, args, options)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Validate a path for security: non-empty and free of traversal characters.
 */
function validatePath(inputPath: string, paramName: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }
  if (path.normalize(inputPath).includes("..")) {
    throw new Error(`${paramName} contains path traversal characters: ${inputPath}`);
  }
  return path.resolve(inputPath);
}

/**
 * Validate a single OBS object key segment (project-name, chip-type...).
 * The value is interpolated into an OBS object key, so it must be one clean
 * path segment: no separators, traversal, NUL bytes, or control characters.
 */
function validateObsKeySegment(segment: string, paramName: string): string {
  if (!segment || segment.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }
  const trimmed = segment.trim();
  if (trimmed.includes("\0")) {
    throw new Error(`${paramName} contains NUL byte`);
  }
  if (trimmed.length > 200) {
    throw new Error(`${paramName} exceeds maximum length of 200 characters`);
  }
  if (trimmed === "." || trimmed === ".." || /[\\/\s\x00-\x1f]/.test(trimmed)) {
    throw new Error(
      `${paramName} must be a single path segment without separators, whitespace or control characters, got: ${trimmed}`,
    );
  }
  return trimmed;
}

/**
 * Validate OBS bucket name: lowercase letters, numbers, hyphens; 3-63 chars;
 * must start and end with a letter or number.
 */
function validateObsBucketName(bucketName: string): string {
  const trimmed = bucketName.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(trimmed)) {
    throw new Error(
      `obs-bucket-name must be 3-63 characters, contain only lowercase letters, ` +
        `numbers, and hyphens, and start/end with letter or number. Got: ${trimmed}`,
    );
  }
  return trimmed;
}

/** Allowed oidc-config fields, matching huaweicloud-oidc-client configure(). */
const OIDC_CONFIG_ALLOWED_FIELDS = [
  "accountId",
  "audience",
  "agencyName",
  "oidcProviderName",
  "region",
  "durationSeconds",
  "refreshBufferSeconds",
  "debug",
];

/** Huawei Cloud region ID format, e.g. "cn-southwest-2". */
const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,3}$/;

/**
 * Validate oidc-config JSON for huaweicloud-oidc-client configure().
 * Returns an object containing only the provided, type-valid fields so that
 * omitted fields keep the SDK built-in defaults (the openlibing account).
 */
function validateOidcConfig(jsonStr: string): Record<string, unknown> {
  if (!jsonStr || jsonStr.trim() === "") {
    return {};
  }
  if (jsonStr.length > 10240) {
    throw new Error("oidc-config exceeds maximum length of 10240 characters");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Invalid JSON format for oidc-config: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("oidc-config must be a JSON object");
  }
  const unknownFields = Object.keys(parsed).filter(
    (k) => !OIDC_CONFIG_ALLOWED_FIELDS.includes(k),
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Unknown fields in oidc-config: ${unknownFields.join(", ")}. ` +
        `Allowed fields: ${OIDC_CONFIG_ALLOWED_FIELDS.join(", ")}`,
    );
  }
  const stringFields = ["accountId", "audience", "agencyName", "oidcProviderName", "region"];
  const numberFields = ["durationSeconds", "refreshBufferSeconds"];
  for (const f of stringFields) {
    if (f in parsed && typeof parsed[f] !== "string") {
      throw new Error(`oidc-config field '${f}' must be a string, got ${typeof parsed[f]}`);
    }
  }
  for (const f of numberFields) {
    if (f in parsed && (typeof parsed[f] !== "number" || !Number.isFinite(parsed[f] as number))) {
      throw new Error(`oidc-config field '${f}' must be a finite number, got ${typeof parsed[f]}`);
    }
  }
  if ("debug" in parsed && typeof parsed["debug"] !== "boolean") {
    throw new Error(`oidc-config field 'debug' must be a boolean, got ${typeof parsed["debug"]}`);
  }
  if ("region" in parsed && !REGION_PATTERN.test(parsed["region"] as string)) {
    throw new Error(
      `oidc-config field 'region' has invalid format (expected like 'cn-southwest-2'), got '${String(parsed["region"])}'`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const f of OIDC_CONFIG_ALLOWED_FIELDS) {
    if (f in parsed && parsed[f] !== undefined && parsed[f] !== null) {
      result[f] = parsed[f];
    }
  }
  return result;
}

/**
 * Create an OBS client using OIDC temporary credentials.
 * Empty oidcConfig keeps the SDK built-in defaults (openlibing account).
 */
async function createObsClient(oidcConfig: Record<string, unknown>): Promise<{
  client: typeof ObsClient;
  region: string;
}> {
  const { region } = configure(oidcConfig);
  const cred = await getCredentials();
  const client = new ObsClient({
    access_key_id: cred.accessKeyId,
    secret_access_key: cred.secretAccessKey,
    security_token: cred.securityToken,
    server: `https://obs.${region}.myhuaweicloud.com`,
    ssl_verify: true,
  });
  return { client, region };
}

/**
 * Run an OBS operation with a fresh client; the client is always closed.
 */
async function withObsClient<T>(
  oidcConfig: Record<string, unknown>,
  fn: (client: typeof ObsClient, region: string) => Promise<T>,
): Promise<T> {
  const { client, region } = await createObsClient(oidcConfig);
  try {
    return await fn(client, region);
  } finally {
    await client.close();
  }
}

/**
 * Upload a local file to OBS via SourceFile (streamed by the SDK in chunks,
 * O(1) memory — reading a large tar into a Buffer would hit Node's
 * ~512MB single-string limit inside the SDK's logging path). putObject on
 * an existing key overwrites it, which is exactly the single-copy semantics
 * we want for all shared artifacts.
 */
async function obsPutObject(
  obs: ObsContext,
  key: string,
  filePath: string,
): Promise<void> {
  await withObsClient(obs.oidcConfig, async (client) => {
    const resp = await client.putObject({
      Bucket: obs.bucketName,
      Key: key,
      SourceFile: filePath,
    });
    const msg = (resp && resp.CommonMsg) || {};
    if (!(msg.Status >= 200 && msg.Status < 300)) {
      const code = msg.Code ? ` [${msg.Code}]` : "";
      throw new Error(
        `OBS upload failed for ${obs.bucketName}/${key}: HTTP ${msg.Status}${code}: ${msg.Message || "unknown error"}`,
      );
    }
  });
}

/**
 * Upload in-memory text content to OBS by spilling it to a temp file first,
 * so every upload path goes through the streamed SourceFile route.
 */
async function obsPutText(
  obs: ObsContext,
  key: string,
  content: string,
): Promise<void> {
  const tmp = path.join(os.tmpdir(), `precision-obs-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    await obsPutObject(obs, key, tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Download an object from OBS. A 404 returns { ok: false, status: 404 } without
 * throwing so callers can treat "not exists yet" as a normal case.
 */
async function obsGetObject(
  obs: ObsContext,
  key: string,
): Promise<ObsObjectResult> {
  try {
    return await withObsClient(obs.oidcConfig, async (client) => {
      const resp = await client.getObject({ Bucket: obs.bucketName, Key: key });
      const msg = (resp && resp.CommonMsg) || {};
      if (msg.Status >= 200 && msg.Status < 300) {
        const content = resp.InterfaceResult && resp.InterfaceResult.Content;
        return { ok: true, status: msg.Status, content: Buffer.from(content) };
      }
      return {
        ok: false,
        status: msg.Status,
        message: `HTTP ${msg.Status}: ${msg.Message || "unknown error"}`,
      };
    });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/**
 * Download an object from OBS to a local file via SaveAsFile (streamed by
 * the SDK to disk — O(1) memory, same rationale as the SourceFile upload:
 * buffering a >512MB tar would exceed Node's string/Buffer limits). Unlike
 * obsGetObject this throws on any failure — download-coverage is an explicit
 * intent, so a missing or unreadable artifact must fail the run.
 */
async function obsGetObjectToFile(
  obs: ObsContext,
  key: string,
  destPath: string,
): Promise<void> {
  await withObsClient(obs.oidcConfig, async (client) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const resp = await client.getObject({
      Bucket: obs.bucketName,
      Key: key,
      SaveAsFile: destPath,
    });
    const msg = (resp && resp.CommonMsg) || {};
    if (!(msg.Status >= 200 && msg.Status < 300)) {
      const code = msg.Code ? ` [${msg.Code}]` : "";
      throw new Error(
        `OBS download failed for ${obs.bucketName}/${key}: HTTP ${msg.Status}${code}: ${msg.Message || "unknown error"}`,
      );
    }
  });
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    throw new Error(`OBS download produced no local file for ${obs.bucketName}/${key}: ${destPath}`);
  }
}

/**
 * Extract a coverage tar package with Python's tarfile module (the runtime
 * always has python3 available). Members are validated against path
 * traversal before extraction.
 */
async function extractTar(tarPath: string, destDir: string, pythonBin: string): Promise<void> {
  const script = [
    "import sys, tarfile",
    `tar = tarfile.open(${JSON.stringify(tarPath)})`,
    "dest = " + JSON.stringify(destDir),
    "members = tar.getmembers()",
    "for m in members:",
    "    if m.name.startswith('/') or '..' in m.name.split('/') or '\\\\' in m.name:",
    "        sys.exit(f'unsafe member path: {m.name}')",
    "try:",
    "    tar.extractall(dest, filter='data')",
    "except TypeError:",
    "    tar.extractall(dest)",
    "tar.close()",
  ].join("\n");
  const scriptFile = path.join(os.tmpdir(), `precision_extract_${process.pid}.py`);
  fs.writeFileSync(scriptFile, script, "utf-8");
  try {
    await execWithTimeout(pythonBin, [scriptFile], { silent: true }, 120000);
  } finally {
    fs.unlinkSync(scriptFile);
  }
}

interface TarLayout {
  /** Directory whose direct/recursive test-case dirs feed the map keys (rel paths). */
  coverageRoot: string;
  /** Source dir (covstub) bundled inside the tar, or null when not present. */
  sourceDir: string | null;
  /** Number of test-case dirs found (dirs matching the adapter rules AND holding coverage files). */
  testCaseCount: number;
}

/**
 * Discover the layout inside an extracted coverage tar using the repo adapter
 * rules (stdlib-only import, no venv needed):
 * - test-case dirs: adapter.is_test_case_dir(name) AND containing coverage
 *   files (same criteria as CoverageSelector.scan_test_cases)
 * - coverageRoot: common parent of all test-case dirs — relative paths from
 *   this root become the map keys (e.g. "tests__e2e__foo" -> "tests/e2e/foo.py"),
 *   so passing the tar root directly would corrupt the keys with extra prefixes
 * - sourceDir: first "covstub" dir found (the bundled source tree)
 */
async function discoverTarLayout(extractDir: string, repo: string): Promise<TarLayout> {
  const distDir = path.resolve(__dirname);
  const script = [
    "import glob as globmod, json, os",
    "from test_selector.repos import get_adapter",
    `adapter = get_adapter(${JSON.stringify(repo)})`,
    `root = os.path.realpath(${JSON.stringify(extractDir)})`,
    "test_dirs, covstub = [], None",
    "def has_cov_files(d):",
    "    pat = adapter.coverage_file_glob",
    "    if globmod.glob(os.path.join(d, pat)):",
    "        return True",
    "    cd = os.path.join(d, 'covdata')",
    "    return os.path.isdir(cd) and bool(globmod.glob(os.path.join(cd, pat)))",
    "for dirpath, dirnames, _ in os.walk(root):",
    "    dirnames[:] = sorted(d for d in dirnames if d != '__pycache__' and not d.startswith('.'))",
    "    if covstub is None and 'covstub' in dirnames:",
    "        covstub = os.path.join(dirpath, 'covstub')",
    "    for name in dirnames:",
    "        d = os.path.join(dirpath, name)",
    "        if adapter.is_test_case_dir(name) and has_cov_files(d):",
    "            test_dirs.append(d)",
    "if not test_dirs:",
    "    coverage_root = root",
    "else:",
    "    common = os.path.dirname(test_dirs[0])",
    "    for d in test_dirs[1:]:",
    "        while not d.startswith(common + os.sep):",
    "            common = os.path.dirname(common)",
    "    coverage_root = common",
    "print(json.dumps({'coverage_root': coverage_root, 'source_dir': covstub, 'test_case_count': len(test_dirs)}))",
  ].join("\n");
  const scriptFile = path.join(os.tmpdir(), `precision_discover_${process.pid}.py`);
  fs.writeFileSync(scriptFile, script, "utf-8");
  try {
    const result = await execCaptureWithTimeout(
      "python3",
      [scriptFile],
      { silent: true, env: { ...process.env, PYTHONPATH: distDir } },
      120000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tar layout discovery failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop() || "{}");
    return {
      coverageRoot: String(parsed.coverage_root || extractDir),
      sourceDir: parsed.source_dir ? String(parsed.source_dir) : null,
      testCaseCount: Number(parsed.test_case_count || 0),
    };
  } finally {
    fs.unlinkSync(scriptFile);
  }
}

/**
 * Read the append table (one test path per line) from OBS.
 * Missing (404) or failed downloads yield an empty list with a warning —
 * callers treat it as "no appended tests available".
 */
async function downloadAppendTable(obs: ObsContext): Promise<string[]> {
  const key = `${obs.projectDir}/${OBS_APPEND_KEY_NAME}`;
  const result = await obsGetObject(obs, key);
  if (result.ok && result.content) {
    const lines = result.content
      .toString("utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    console.log(`Append table downloaded: ${lines.length} test(s) from ${key}`);
    return lines;
  }
  if (result.status === 404) {
    console.log(`Append table not found on OBS (new table): ${key}`);
    return [];
  }
  core.warning(`Append table download failed for ${key}: ${result.message} — continuing without it`);
  return [];
}

interface SelectorParams {
  repo: string;
  githubPr: string;
  gitcodePr: string;
  sourceDir: string;
  mapFile: string;
  coverageDir: string;
  buildMap: boolean;
  minAffected: number;
  dedup: boolean;
  enableLineMatch: boolean;
  enableFunctionMatch: boolean;
  skipImports: boolean;
  newTestsOutput?: string;
}

interface SelectorResult {
  success: boolean;
  testListFile: string;
  testCount: number;
}

/**
 * Execute precision test selector.
 */
async function runPrecisionTest(params: SelectorParams): Promise<SelectorResult> {
  const venvPath = path.join(os.tmpdir(), `precision_test_venv_${process.pid}`);
  // The bundled Python package lives next to this script at dist/test_selector/.
  const packageDir = path.resolve(__dirname, "test_selector");
  const distDir = path.resolve(__dirname);
  // Python writes output to BASE_DIR (the package's parent = dist).
  const outputFile = path.join(distDir, "recommended_pytest_paths.txt");
  // Mirror into the workspace so subsequent workflow steps can read it.
  const workspaceOutput = path.join(process.cwd(), "recommended_pytest_paths.txt");
  let pythonCommand = "python3";
  let pipCommand = "pip3";
  try {
    if (!fs.existsSync(packageDir)) {
      throw new Error(`Python package not found at ${packageDir}`);
    }
    // Create virtual environment (60s timeout to prevent hanging).
    console.log("Creating virtual environment...");
    await execWithTimeout("python3", ["-m", "venv", venvPath], { silent: true }, 60000);
    pythonCommand = path.join(venvPath, "bin", "python");
    pipCommand = path.join(venvPath, "bin", "pip");
    // Install regex dependency (60s timeout).
    console.log("Installing dependencies...");
    await execWithTimeout(pipCommand, ["install", "regex", "-q"], { silent: true }, 60000);

    // Build command arguments for `python -m test_selector ...`.
    const args = ["-m", "test_selector", "--repo", params.repo];
    if (params.githubPr) {
      args.push("--github-pr", params.githubPr);
    }
    if (params.gitcodePr) {
      args.push("--gitcode-pr", params.gitcodePr);
    }
    args.push("--source-dir", params.sourceDir);
    args.push("--map-file", params.mapFile);
    args.push("--coverage-dir", params.coverageDir);
    args.push("--min-affected", params.minAffected.toString());
    if (params.buildMap) {
      args.push("--build-map");
    }
    if (params.dedup) {
      args.push("--dedup");
    }
    if (params.enableLineMatch) {
      args.push("--enable-line-match");
    } else {
      args.push("--disable-line-match");
    }
    if (params.enableFunctionMatch) {
      args.push("--enable-function-match");
    } else {
      args.push("--disable-function-match");
    }
    if (params.skipImports) {
      args.push("--skip-imports");
    }
    if (params.newTestsOutput) {
      args.push("--new-tests-output", params.newTestsOutput);
    }
    // Make dist/ importable so `python -m test_selector` finds the package.
    const env = {
      ...process.env,
      PYTHONPATH: distDir,
    };
    // Execute Python script (parameterized exec, not shell; validated inputs).
    console.log("Running precision test selector...");
    await execWithTimeout(
      pythonCommand,
      args,
      { env, cwd: process.cwd() },
      PYTHON_EXEC_TIMEOUT_SECONDS * 1000,
    );

    // Read output file produced by the Python CLI.
    if (fs.existsSync(outputFile)) {
      const content = fs.readFileSync(outputFile, "utf-8");
      const testList = content
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "");
      fs.writeFileSync(workspaceOutput, content);
      return {
        success: true,
        testListFile: workspaceOutput,
        testCount: testList.length,
      };
    }
    console.log("No test cases recommended");
    return { success: true, testListFile: workspaceOutput, testCount: 0 };
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to run precision test selector: ${err.message}`);
  }
}

/**
 * Main function.
 */
async function run(): Promise<void> {
  try {
    console.log("=".repeat(60));
    console.log("Starting Precision Test Selector...");
    console.log("=".repeat(60));

    // Get input parameters.
    core.startGroup("Step 1: Get input parameters");
    const repo = core.getInput("repo", { required: false }) || "vllm_ascend";
    const githubPr = core.getInput("github-pr", { required: false });
    const gitcodePr = core.getInput("gitcode-pr", { required: false });
    const sourceDir = core.getInput("source-dir", { required: false }) || "covstub";
    const mapFile = core.getInput("map-file", { required: false }) || "test_case_map.json";
    const coverageDir = core.getInput("coverage-dir", { required: false }) || "coverage";
    const buildMap = core.getInput("build-map", { required: false }) === "true";
    const minAffected = parseInt(
      core.getInput("min-affected", { required: false }) || "1",
      10,
    );
    const dedup = core.getInput("dedup", { required: false }) === "true";
    const enableLineMatch =
      core.getInput("enable-line-match", { required: false }) !== "false";
    const enableFunctionMatch =
      core.getInput("enable-function-match", { required: false }) !== "false";
    const skipImports = core.getInput("skip-imports", { required: false }) === "true";

    // Coverage upload / append table inputs.
    const coverageTarRaw = core.getInput("coverage-tar-path", { required: false });
    const downloadCoverage = core.getInput("download-coverage", { required: false }) === "true";
    const projectNameRaw = core.getInput("project-name", { required: false });
    const chipTypeRaw = core.getInput("chip-type", { required: false }) || "Ascend";
    const obsBucketRaw = core.getInput("obs-bucket-name", { required: false }) || "op-case-result";
    const oidcConfig = validateOidcConfig(core.getInput("oidc-config", { required: false }));

    // sglang never uses the append table (its adapters keep full data daily).
    let appendOnMerge = core.getInput("append-on-merge", { required: false }) === "true";
    let enableAppendTable = core.getInput("enable-append-table", { required: false }) !== "false";
    if (repo === "sglang" && (appendOnMerge || enableAppendTable)) {
      console.log("  - sglang: append table features disabled");
      appendOnMerge = false;
      enableAppendTable = false;
    }

    console.log("Input parameters:");
    console.log(`  - repo: ${repo}`);
    console.log(`  - github-pr: ${githubPr ? "(provided)" : "(not specified)"}`);
    console.log(`  - gitcode-pr: ${gitcodePr ? "(provided)" : "(not specified)"}`);
    console.log("  - source-dir: (validated)");
    console.log("  - map-file: (validated)");
    console.log("  - coverage-dir: (validated)");
    console.log(`  - build-map: ${buildMap}`);
    console.log(`  - min-affected: ${minAffected}`);
    console.log(`  - dedup: ${dedup}`);
    console.log(`  - enable-line-match: ${enableLineMatch}`);
    console.log(`  - enable-function-match: ${enableFunctionMatch}`);
    console.log(`  - skip-imports: ${skipImports}`);
    console.log(`  - coverage-tar-path: ${coverageTarRaw || "(not set, upload skipped)"}`);
    console.log(`  - download-coverage: ${downloadCoverage}`);
    console.log(`  - append-on-merge: ${appendOnMerge}`);
    console.log(`  - enable-append-table: ${enableAppendTable}`);
    if (coverageTarRaw || appendOnMerge || enableAppendTable || downloadCoverage) {
      console.log(`  - project-name: ${projectNameRaw || "(fallback to repository name)"}`);
      console.log(`  - chip-type: ${chipTypeRaw}`);
      console.log(`  - obs-bucket-name: ${obsBucketRaw}`);
      console.log(
        `  - oidc-config: ${Object.keys(oidcConfig).length ? Object.keys(oidcConfig).join(", ") : "(default account)"}`,
      );
    }
    // Mask sensitive inputs.
    if (sourceDir) core.setSecret(sourceDir);
    if (coverageDir) core.setSecret(coverageDir);
    if (mapFile) core.setSecret(mapFile);
    core.endGroup();

    // github-pr and gitcode-pr are mutually exclusive.
    if (githubPr && gitcodePr) {
      throw new Error(
        "github-pr and gitcode-pr are mutually exclusive; specify only one",
      );
    }

    // download-coverage is the OBS-backed variant of the local inputs: it
    // fetches the tar + map uploaded by a previous coverage-tar-path run.
    // Uploading and downloading in the same invocation makes no sense, and a
    // downloaded map must not be rebuilt by build-map.
    if (downloadCoverage && coverageTarRaw) {
      throw new Error(
        "download-coverage and coverage-tar-path are mutually exclusive; " +
          "coverage-tar-path uploads the coverage data, download-coverage downloads it",
      );
    }
    if (downloadCoverage && buildMap) {
      throw new Error(
        "download-coverage and build-map are mutually exclusive; " +
          "the map is downloaded from OBS, not rebuilt from local coverage data",
      );
    }

    // Validate paths (resolve relative paths against the workspace).
    core.startGroup("Step 2: Validate paths");
    const validatedSourceDir = validatePath(sourceDir, "source-dir");
    const validatedCoverageDir = validatePath(coverageDir, "coverage-dir");
    const validatedMapFile = path.resolve(mapFile);
    console.log(`Validated source-dir: ${validatedSourceDir}`);
    console.log(`Validated coverage-dir: ${validatedCoverageDir}`);
    console.log(`Validated map-file: ${validatedMapFile}`);
    core.endGroup();

    // Resolve the OBS context once for all optional features.
    let obs: ObsContext | null = null;
    if (coverageTarRaw || appendOnMerge || enableAppendTable || downloadCoverage) {
      let projectName = projectNameRaw;
      if (!projectName) {
        const repository = process.env.ATOMGIT_REPOSITORY || process.env.GITHUB_REPOSITORY || "";
        projectName = repository.includes("/") ? repository.split("/").pop()! : repository;
      }
      obs = {
        bucketName: validateObsBucketName(obsBucketRaw),
        projectDir: `precision/${validateObsKeySegment(chipTypeRaw, "chip-type")}/${validateObsKeySegment(projectName, "project-name")}`,
        oidcConfig,
      };
      console.log(`OBS directory: ${obs.bucketName}/${obs.projectDir}`);
    }

    // append-on-merge requires a PR source (new test extraction needs the diff).
    if (appendOnMerge && !githubPr && !gitcodePr) {
      throw new Error("append-on-merge requires github-pr or gitcode-pr");
    }

    // Coverage download mode (D): fetch the tar + map previously uploaded by
    // a coverage-tar-path run, auto-fill source-dir / map-file / coverage-dir
    // and let the caller pass github-pr only. Any failure is fatal.
    let effectiveSourceDir = validatedSourceDir;
    let effectiveCoverageDir = validatedCoverageDir;
    if (downloadCoverage && obs) {
      core.startGroup("Step 3: Download coverage data from OBS");
      const tarKey = `${obs.projectDir}/${OBS_TAR_KEY_NAME}`;
      const downloadDir = path.join(process.cwd(), "coverage-download");
      fs.rmSync(downloadDir, { recursive: true, force: true });
      fs.mkdirSync(downloadDir, { recursive: true });
      const tarPath = path.join(downloadDir, OBS_TAR_KEY_NAME);
      console.log(`Downloading ${obs.bucketName}/${tarKey}...`);
      await obsGetObjectToFile(obs, tarKey, tarPath);
      console.log(
        `Coverage tar downloaded: ${tarPath} (${(fs.statSync(tarPath).size / (1024 * 1024)).toFixed(1)}MB)`,
      );

      // Extract into a persistent workspace directory and discover the layout
      // (same as the upload mode so both paths stay symmetric).
      const extractDir = path.join(process.cwd(), "coverage-extract");
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      console.log(`Extracting tar to ${extractDir}...`);
      await extractTar(tarPath, extractDir, "python3");

      console.log("Discovering tar layout (coverage root / bundled source dir)...");
      const layout = await discoverTarLayout(extractDir, repo);
      effectiveCoverageDir = layout.coverageRoot || extractDir;
      effectiveSourceDir = layout.sourceDir || validatedSourceDir;
      console.log(`  Coverage root: ${effectiveCoverageDir} (${layout.testCaseCount} test case dir(s))`);
      console.log(
        `  Source dir: ${effectiveSourceDir}${layout.sourceDir ? " (bundled in tar)" : " (from source-dir input)"}`,
      );
      if (layout.testCaseCount === 0) {
        core.warning(
          `No test case directories found inside the tar for repo '${repo}'; ` +
            `the selection may be incomplete — check the repo setting or the tar structure`,
        );
      }
      // Export for subsequent workflow steps (two-step usage pattern).
      core.exportVariable("PRECISION_COVERAGE_DIR", effectiveCoverageDir);
      core.exportVariable("PRECISION_SOURCE_DIR", effectiveSourceDir);

      // Download the map built by the last coverage-tar-path run.
      const mapKey = `${obs.projectDir}/${OBS_MAP_KEY_NAME}`;
      console.log(`Downloading map to ${validatedMapFile}...`);
      await obsGetObjectToFile(obs, mapKey, validatedMapFile);
      console.log(
        `Test case map downloaded: ${mapKey} -> ${validatedMapFile} (${(fs.statSync(validatedMapFile).size / 1024).toFixed(1)}KB)`,
      );
      core.endGroup();
    }

    // ===== Coverage upload mode (A) =====
    // Upload the full coverage tar, rebuild the map from it, upload the map,
    // and reset the append table. Any failure is fatal (no silent data loss).
    let coverageTarHandled = false;
    if (coverageTarRaw && obs) {
      core.startGroup("Step 3: Upload coverage tar and rebuild map");
      const tarPath = validatePath(coverageTarRaw, "coverage-tar-path");
      if (!fs.existsSync(tarPath)) {
        throw new Error(`coverage-tar-path does not exist: ${tarPath}`);
      }
      const lstat = fs.lstatSync(tarPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw new Error(`coverage-tar-path is not a regular file: ${tarPath}`);
      }
      if (lstat.size > MAX_COVERAGE_TAR_SIZE_MB * 1024 * 1024) {
        throw new Error(
          `coverage tar exceeds maximum size of ${MAX_COVERAGE_TAR_SIZE_MB}MB: ${tarPath}`,
        );
      }
      // A1. Upload the tar (fixed key, single copy, overwrite mode). The SDK
      // streams SourceFile in chunks — no full-file read into memory.
      const tarKey = `${obs.projectDir}/${OBS_TAR_KEY_NAME}`;
      console.log(`Uploading ${tarPath} to ${obs.bucketName}/${tarKey}...`);
      await obsPutObject(obs, tarKey, tarPath);
      console.log(`Coverage tar uploaded: ${tarKey} (overwrote previous copy)`);

      // A2. Extract the tar into a persistent workspace directory (subsequent
      // workflow steps may reuse the bundled covstub) and discover the layout.
      const extractDir = path.join(process.cwd(), "coverage-extract");
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      console.log(`Extracting tar to ${extractDir}...`);
      await extractTar(tarPath, extractDir, "python3");

      console.log("Discovering tar layout (coverage root / bundled source dir)...");
      const layout = await discoverTarLayout(extractDir, repo);
      const mapCoverageDir = layout.coverageRoot || extractDir;
      const mapSourceDir = layout.sourceDir || validatedSourceDir;
      console.log(`  Coverage root: ${mapCoverageDir} (${layout.testCaseCount} test case dir(s))`);
      console.log(`  Source dir: ${mapSourceDir}${layout.sourceDir ? " (bundled in tar)" : " (from source-dir input)"}`);
      if (layout.testCaseCount === 0) {
        core.warning(
          `No test case directories found inside the tar for repo '${repo}'; ` +
            `the generated map will be empty — check the repo setting or the tar structure`,
        );
      }
      // Export for subsequent workflow steps (two-step usage pattern).
      core.exportVariable("PRECISION_COVERAGE_DIR", mapCoverageDir);
      core.exportVariable("PRECISION_SOURCE_DIR", mapSourceDir);
      effectiveSourceDir = mapSourceDir;

      console.log("Rebuilding test case map from extracted coverage data...");
      await runPrecisionTest({
        repo,
        githubPr: "",
        gitcodePr: "",
        sourceDir: mapSourceDir,
        mapFile: validatedMapFile,
        coverageDir: mapCoverageDir,
        buildMap: true,
        minAffected,
        dedup,
        enableLineMatch,
        enableFunctionMatch,
        skipImports,
      });

      // A3. Upload the freshly built map (fixed key, single copy).
      if (!fs.existsSync(validatedMapFile)) {
        throw new Error(`map file not generated at: ${validatedMapFile}`);
      }
      const mapKey = `${obs.projectDir}/${OBS_MAP_KEY_NAME}`;
      console.log(`Uploading map to ${obs.bucketName}/${mapKey}...`);
      await obsPutObject(obs, mapKey, validatedMapFile);
      console.log(`Test case map uploaded: ${mapKey}`);

      // A4. Reset the append table: the tar carries the full test set, so the
      // incremental table restarts from empty (overwrite with empty content).
      const appendKey = `${obs.projectDir}/${OBS_APPEND_KEY_NAME}`;
      await obsPutText(obs, appendKey, "");
      console.log(`Append table reset: ${appendKey}`);

      // Publish outputs.
      const { region } = configure(obs.oidcConfig);
      core.setOutput("upload-success", "true");
      core.setOutput("obs-url", `https://${obs.bucketName}.obs.${region}.myhuaweicloud.com/${tarKey}`);
      const atomgitOutput = process.env.ATOMGIT_OUTPUT;
      if (atomgitOutput) {
        fs.appendFileSync(
          atomgitOutput,
          `upload-success=true\nobs-url=https://${obs.bucketName}.obs.${region}.myhuaweicloud.com/${tarKey}\n`,
        );
      }
      coverageTarHandled = true;
      core.endGroup();
    }

    // ===== Precision test selection (always runs when a PR is provided) =====
    let selectedTests: string[] = [];
    let newTestsFile: string | null = null;
    if (githubPr || gitcodePr) {
      core.startGroup("Step 4: Execute precision test selector");
      if (appendOnMerge) {
        newTestsFile = path.join(os.tmpdir(), `precision_new_tests_${process.pid}.txt`);
      }
      const result = await runPrecisionTest({
        repo,
        githubPr,
        gitcodePr,
        // When the coverage tar was just uploaded or downloaded, use the
        // effective dirs (bundled covstub / tar coverage root) instead of
        // the workspace defaults which may not exist.
        sourceDir: effectiveSourceDir,
        mapFile: validatedMapFile,
        coverageDir: effectiveCoverageDir,
        // When the coverage tar was just uploaded, the freshly built map file
        // already exists locally — the Python CLI loads it (no rebuild needed).
        buildMap,
        minAffected,
        dedup,
        enableLineMatch,
        enableFunctionMatch,
        skipImports,
        newTestsOutput: newTestsFile || undefined,
      });
      selectedTests = fs.existsSync(result.testListFile)
        ? fs
            .readFileSync(result.testListFile, "utf-8")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "")
        : [];
      console.log(`Selected test cases: ${selectedTests.length}`);
      core.endGroup();
    }

    // ===== Append-on-merge (B) =====
    // Append this PR's new test cases to the single append-table object.
    // Skipped when the coverage tar was just uploaded: the full data already
    // contains those cases and the table was just reset.
    if (appendOnMerge && !coverageTarHandled && obs && newTestsFile) {
      core.startGroup("Step 5: Append new test cases to OBS append table");
      const newTests = fs.existsSync(newTestsFile)
        ? fs
            .readFileSync(newTestsFile, "utf-8")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "")
        : [];
      console.log(`New test cases in this PR: ${newTests.length}`);
      // Download the current table (missing/failed -> start from empty table).
      const existing = await downloadAppendTable(obs);
      // Union preserving order: existing entries first, then the new ones.
      const merged = Array.from(new Set([...existing, ...newTests]));
      const appendKey = `${obs.projectDir}/${OBS_APPEND_KEY_NAME}`;
      await obsPutText(obs, appendKey, merged.join("\n") + (merged.length ? "\n" : ""));
      console.log(`Append table updated: ${existing.length} + ${newTests.length} new = ${merged.length} total (${appendKey})`);
      core.endGroup();
    } else if (appendOnMerge && coverageTarHandled) {
      console.log("Step 5: append-on-merge skipped (coverage tar upload just reset the table)");
    }

    // ===== Recommendation merge (C) =====
    // Merge the append table into the recommended list (union, dedup).
    if (enableAppendTable && !coverageTarHandled && obs && (githubPr || gitcodePr)) {
      core.startGroup("Step 6: Merge append table into recommended list");
      const appended = await downloadAppendTable(obs);
      if (appended.length > 0) {
        const merged = Array.from(new Set([...selectedTests, ...appended]));
        const outputFile = path.join(process.cwd(), "recommended_pytest_paths.txt");
        fs.writeFileSync(outputFile, merged.join("\n") + "\n", "utf-8");
        console.log(
          `Recommended list merged with append table: ${selectedTests.length} selected + ${appended.length} appended = ${merged.length} total`,
        );
        selectedTests = merged;
      } else {
        console.log("Append table empty or unavailable — recommended list unchanged");
      }
      core.endGroup();
    }

    // Print test list file (declared outputs intentionally omitted; print only).
    core.startGroup("Step 7: Test list file");
    console.log(`test-list-file=${path.join(process.cwd(), "recommended_pytest_paths.txt")}`);
    console.log(`test-count=${selectedTests.length}`);
    core.endGroup();

    console.log("=".repeat(60));
    console.log("Precision test selection completed.");
    console.log("=".repeat(60));
  } catch (error) {
    const err = error as Error;
    core.error("=".repeat(60));
    core.error(`Precision test selection failed: ${err.message}`);
    core.error("=".repeat(60));
    if (err.stack) {
      core.error(`Stack trace:\n${err.stack}`);
    }
    core.setFailed(err.message);
  }
}

// Run main function.
run();
