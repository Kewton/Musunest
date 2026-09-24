#!/usr/bin/env node
// worktree-setup — cmate-worktree-setup の provider（Issue #118）。
//
// dispatch は worktree を作らない。`--prepare-worktrees --worktree-setup <launcher>` は
// この program を
//     <launcher> --issues <n[,n...]> --profile <id> --base <ref>
// の形で呼び、stdout の `worktree-setup.result.v1` を検証してから dispatch を続ける
// （cmate-orchestrate の dispatch の契約 §3.0.1、裁定は adr-worktree-preparation.md）。
// 手順（collision 検査・作成直前の base SHA 再確認・proportional baseline・CommandMate sync・
// worktree roster の固定）はここが持つ。Node stdlib のみで、依存を足さない。
//
// 順序（Issue #118「追記 1（2026-09-24・窓口）」）：**sync を先に**走らせ、そのあと roster を
// `command-code` だけにしてから `cliToolId` を実測する。`commandmate sync` は worktree ごとの
// CLI の固定を既定（claude）へ戻すので、逆順にすると固定が消える。順番は結果に効く。
//
// profile は `--profile <id>` を `.commandmate/profiles/<id>.json` として解決する
// （branch_template / worktree_template / baseline / base / repository）。
// `{slug}` は Issue の title を planner（orchestrate.mjs の slugify）と同じ規則で畳んだもので、
// dispatch の branch 一致（`worktrees[].branch` == plan の branch）がこれで成立する。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKILL_ID = "cmate-worktree-setup";
const RESULT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_ISSUES = 5;
const DEFAULT_SKILL_VERSION = "0.1.6";
const EXPECTED_CLI_TOOL_ID = "command-code";

const EXIT_OK = 0;
const EXIT_PARTIAL = 7;
const EXIT_NG = 1;

const USAGE = `worktree-setup — cmate-worktree-setup の provider（Issue #118）

Usage:
  node infra/scripts/worktree-setup.mjs --issues <n[,n...]> --profile <id> [--base <ref>] [options]

Options:
  --issues <n[,n...]>   対象 Issue 番号（正の整数の並び。必須）
  --profile <id>        .commandmate/profiles/<id>.json の profile（必須）
  --base <ref>          base ref を profile の既定から上書きする
  --max-issues <n>      1 回で扱う上限（既定 ${DEFAULT_MAX_ISSUES}）
  --reuse-existing      exact match の reuse を許可する（既定 off）
  --repo-root <path>    対象 repository の root（既定 cwd）
  --git <argv>          git の起動 argv（既定 "git"。テストの差し替え用）
  --gh <argv>           gh の起動 argv（既定 "gh"。Issue title の取得に使う）
  --commandmate <argv>  commandmate の起動 argv（既定 "commandmate"）
  --help               これを出す

stdout は worktree-setup.result.v1（JSON）のみ。人が読む進捗は stderr へ出す。
`;

// =============================================================================
// 小さな道具
// =============================================================================

// planner（orchestrate.mjs）の slugify と同一。ここがずれると branch が一致しなくなる。
function slugify(value, maxLen = 48) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const compact = normalized.slice(0, maxLen).replace(/^-+|-+$/g, "");
  return compact || "task";
}

function expandTemplate(template, { number, slug, repo }) {
  return String(template)
    .replaceAll("{number}", String(number))
    .replaceAll("{slug}", slug)
    .replaceAll("{repo}", repo);
}

// 長さの上限は schema が決めている（超えると契約違反になる）。切ったことは末尾の … で示す。
function clip(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function parseArgv(value) {
  return String(value).split(/\s+/).filter(Boolean);
}

function normalizeRemoteUrl(url) {
  const text = String(url ?? "").trim();
  const match = text.match(/^(?:git@[^:]+:|ssh:\/\/git@[^/]+\/|https?:\/\/[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function parsePorcelainWorktrees(text) {
  const out = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  if (current) out.push(current);
  return out;
}

function samePath(a, b) {
  return resolve(String(a)) === resolve(String(b));
}

// schema の repo_path と同じ形（相対・先頭 / なし・`..` なし・backslash と制御文字なし）。
function isSafeRepoPath(value) {
  const text = String(value);
  if (text === "" || text.startsWith("/") || text.includes("\\")) return false;
  if (text.split("/").includes("..")) return false;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// =============================================================================
// redaction（safety.md 第6節）
// =============================================================================

const REDACTIONS = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["bearer_token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["api_key", /\b[A-Za-z][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)=[^\s'"]+/g],
  ["signed_url", /[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|signature|sig|token|access_token)=[^&\s]+/gi],
  ["absolute_path", /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/var\/[^/\s]+|\/var\/folders\/[^/\s]+|\/tmp\/[^/\s]+)(?:\/[^\s'"`),;]*)*/g],
  ["personal_data", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

function makeRedactor() {
  const tally = new Map();
  const redact = (value) => {
    let text = String(value ?? "");
    for (const [kind, pattern] of REDACTIONS) {
      text = text.replace(pattern, () => {
        tally.set(kind, (tally.get(kind) ?? 0) + 1);
        return `<redacted:${kind}>`;
      });
    }
    return text;
  };
  const list = () => [...tally.entries()].map(([kind, count]) => ({ kind, count }));
  return { redact, list };
}

// =============================================================================
// 実行（Node stdlib の spawnSync だけ。シェルを経由しない）
// =============================================================================

function makeExec(env) {
  return (argv, args, cwd) => {
    const result = spawnSync(argv[0], [...argv.slice(1), ...args], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  };
}

// =============================================================================
// 引数
// =============================================================================

function parseArgs(argv) {
  const values = { options: {}, positional: [] };
  const withValue = new Set(["--issues", "--profile", "--base", "--max-issues", "--repo-root", "--git", "--gh", "--commandmate"]);
  const boolean = new Set(["--reuse-existing", "--help", "-h"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (withValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} には値が要る`);
      values.options[arg] = value;
      i += 1;
    } else if (boolean.has(arg)) {
      values[arg === "-h" ? "--help" : arg] = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知の引数: ${arg}`);
    } else {
      values.positional.push(arg);
    }
  }
  return values;
}

function parseIssueNumbers(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("--issues が要る（例：--issues 101,102）");
  }
  const numbers = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    if (!/^[0-9]+$/.test(token)) throw new Error(`--issues は正の整数の並び: ${token}`);
    const number = Number(token);
    if (!Number.isInteger(number) || number < 1) throw new Error(`--issues は正の整数: ${token}`);
    numbers.push(number);
  }
  if (numbers.length === 0) throw new Error("--issues が空");
  return [...new Set(numbers)].toSorted((a, b) => a - b);
}

function parseMaxIssues(raw) {
  if (raw === undefined) return DEFAULT_MAX_ISSUES;
  if (!/^[0-9]+$/.test(String(raw))) throw new Error(`--max-issues は正の整数: ${raw}`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--max-issues は正の整数: ${raw}`);
  return value;
}

// =============================================================================
// profile
// =============================================================================

function loadProfile(root, id) {
  const path = join(root, ".commandmate", "profiles", `${id}.json`);
  if (!existsSync(path)) throw new Error(`profile が無い: .commandmate/profiles/${id}.json`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`profile が JSON として読めない: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("profile は JSON object であること");
  for (const key of ["id", "repository", "base", "branch_template", "worktree_template", "baseline"]) {
    if (raw[key] === undefined || raw[key] === null) throw new Error(`profile に "${key}" が無い`);
  }
  if (!Array.isArray(raw.baseline) || raw.baseline.some((command) => typeof command !== "string")) {
    throw new Error("profile.baseline は文字列の配列であること");
  }
  return {
    id: String(raw.id),
    repository: String(raw.repository),
    base: String(raw.base),
    branch_template: String(raw.branch_template),
    worktree_template: String(raw.worktree_template),
    baseline: raw.baseline.map(String),
    verified: raw.verified === true,
  };
}

// profile は node/rust の signal で種別を決める（profile-conventions.md 第1節と同じ signal）。
function detectProfileKind(root) {
  if (existsSync(join(root, "package.json"))) return { selected: "node", evidence: [{ signal: "package.json", path: "package.json" }] };
  if (existsSync(join(root, "Cargo.toml"))) return { selected: "rust", evidence: [{ signal: "Cargo.toml", path: "Cargo.toml" }] };
  return { selected: "unverified", evidence: [] };
}

// 実効 version は install 済み manifest から読む（ドリフトを防ぐ）。無ければ既定値。
function readSkillVersion(root) {
  for (const dir of [".claude", ".agents"]) {
    const path = join(root, dir, "skills", SKILL_ID, "commandmate.skill.yaml");
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
    if (match) return match[1];
  }
  return DEFAULT_SKILL_VERSION;
}

// =============================================================================
// 本体
// =============================================================================

function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const exec = makeExec(env);
  let gitArgv = io.git ?? ["git"];
  let ghArgv = io.gh ?? ["gh"];
  let cmArgv = io.commandmate ?? ["commandmate"];
  const now = (io.now ?? (() => new Date()))();
  // 人が読む進捗は stderr。stdout は result document（JSON）だけにする（dispatch が JSON.parse する）。
  const stderrLines = [];
  const say = (line) => stderrLines.push(line);

  const git = (args, cwd) => exec(gitArgv, args, cwd);
  const cm = (args, cwd) => exec(cmArgv, args, cwd);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `worktree-setup: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  if (parsed["--help"]) return { exitCode: EXIT_OK, stdout: USAGE, stderr: "" };
  if (parsed.positional.length > 0) {
    return { exitCode: 2, stdout: "", stderr: `worktree-setup: 位置引数は取らない: ${parsed.positional.join(" ")}\n` };
  }

  const options = parsed.options;
  // CLI の差し替え口（テスト用）。io で渡された argv が優先する。
  if (io.git === undefined && typeof options["--git"] === "string") gitArgv = parseArgv(options["--git"]);
  if (io.gh === undefined && typeof options["--gh"] === "string") ghArgv = parseArgv(options["--gh"]);
  if (io.commandmate === undefined && typeof options["--commandmate"] === "string") cmArgv = parseArgv(options["--commandmate"]);
  let issues;
  let maxIssues;
  try {
    issues = parseIssueNumbers(options["--issues"]);
    maxIssues = parseMaxIssues(options["--max-issues"]);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `worktree-setup: ${error instanceof Error ? error.message : String(error)}\n` };
  }
  const profileId = options["--profile"];
  if (typeof profileId !== "string" || profileId.trim() === "") {
    return { exitCode: 2, stdout: "", stderr: "worktree-setup: --profile が要る（例：--profile musubi）\n" };
  }
  const root = resolve(options["--repo-root"] ?? io.cwd ?? process.cwd());
  const reuseExisting = parsed["--reuse-existing"] === true;
  const baseOverride = typeof options["--base"] === "string" && options["--base"].trim() !== "" ? options["--base"] : null;

  const requested = issues.slice(0, maxIssues);
  const dropped = issues.slice(maxIssues);
  const redactor = makeRedactor();
  const redact = (value) => redactor.redact(value);

  const limitations = [];
  const blockingReasons = [];
  const nextActions = [];
  const plan = [];
  const worktrees = [];
  const baseline = [];
  const collisions = [];

  const detection = detectProfileKind(root);
  const document = {
    result_schema_version: RESULT_SCHEMA_VERSION,
    skill_id: SKILL_ID,
    skill_version: readSkillVersion(root),
    generated_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    status: "failure",
    phase_reached: "inspect",
    request: {
      issue_numbers: requested,
      max_issues: maxIssues,
      base_override: baseOverride,
      reuse_existing: reuseExisting,
    },
    repository: {
      slug: null,
      current_branch: null,
      integration_branch: null,
      default_base: null,
      remote_name: null,
      dirty: null,
    },
    profile: {
      selected: detection.selected,
      verified: false,
      detection_evidence: detection.evidence,
      base_ref: baseOverride,
      base_sha: null,
      branch_template: null,
      directory_template: null,
      baseline_command: null,
    },
    plan,
    worktrees,
    baseline,
    commandmate_sync: { available: false, attempted: false, worktree_id: null, detail: "not attempted" },
    collisions,
    redactions: [],
    next_actions: nextActions,
    blocking_reasons: blockingReasons,
    limitations,
    completion_check: { passed: false, checks: [] },
    summary_markdown: "",
  };

  if (dropped.length > 0) {
    limitations.push(clip(`--max-issues ${maxIssues} を超えた ${dropped.length} 件（#${dropped.join(", #")}）を落とした`, 300));
  }

  const finalize = (status, phase, exitCode) => {
    document.status = status;
    document.phase_reached = phase;
    document.redactions = redactor.list();
    document.summary_markdown = buildSummary(document);
    return { exitCode, stdout: JSON.stringify(document, null, 2), stderr: stderrLines.length ? `${stderrLines.join("\n")}\n` : "" };
  };

  // --- profile を読む ---------------------------------------------------------
  let profile;
  try {
    profile = loadProfile(root, profileId);
  } catch (error) {
    blockingReasons.push(clip(`profile_unconfirmed: ${error instanceof Error ? error.message : String(error)}`, 300));
    return finalize("failure", "inspect", EXIT_NG);
  }
  const repoName = profile.repository.split("/").pop() || "repo";
  document.profile.branch_template = profile.branch_template;
  document.profile.directory_template = profile.worktree_template;
  document.profile.baseline_command = profile.baseline.length > 0 ? clip(profile.baseline.join(" && "), 500) : null;
  document.profile.verified = profile.verified === true && (detection.selected === "node" || detection.selected === "rust");
  document.repository.default_base = clip(profile.base, 200);
  document.profile.base_ref = clip(baseOverride ?? profile.base, 200);
  say(`worktree-setup: profile=${profileId} issues=${requested.join(",")} base=${baseOverride ?? profile.base}`);

  // --- repository を inspect する（read-only）--------------------------------
  const toplevelResult = git(["rev-parse", "--show-toplevel"], root);
  if (toplevelResult.status !== 0) {
    blockingReasons.push(clip(`repository_unresolved: git rev-parse --show-toplevel が失敗した（${redact(toplevelResult.stderr.trim()) || "no output"}）`, 300));
    return finalize("failure", "inspect", EXIT_NG);
  }
  const toplevel = resolve(toplevelResult.stdout.trim());

  const currentBranchResult = git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  document.repository.current_branch = currentBranchResult.status === 0 ? clip(currentBranchResult.stdout.trim(), 200) : null;
  const remoteResult = git(["remote", "get-url", "origin"], root);
  document.repository.remote_name = remoteResult.status === 0 ? "origin" : null;
  document.repository.slug = remoteResult.status === 0 ? normalizeRemoteUrl(remoteResult.stdout.trim()) : null;
  const statusResult = git(["status", "--porcelain"], root);
  document.repository.dirty = statusResult.status === 0 ? statusResult.stdout.trim() !== "" : null;
  const baseRef = baseOverride ?? profile.base;
  document.repository.integration_branch = clip(baseRef.replace(/^origin\//, ""), 200);

  if (document.repository.dirty === true) {
    blockingReasons.push(clip("dirty_integration: 統合 worktree に未コミットの変更がある。ここでは変更しない", 300));
    return finalize("failure", "inspect", EXIT_NG);
  }

  const worktreeResult = git(["worktree", "list", "--porcelain"], root);
  const existingWorktrees = worktreeResult.status === 0 ? parsePorcelainWorktrees(worktreeResult.stdout) : [];
  const localBranches = new Set(
    (git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root).stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const remoteBranches = new Set(
    (git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], root).stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

  // --- base ref を resolved commit SHA に確定する ----------------------------
  const baseShaResult = git(["rev-parse", `${baseRef}^{commit}`], root);
  const baseSha = baseShaResult.status === 0 ? baseShaResult.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    blockingReasons.push(clip(`base_unresolved: ${redact(baseRef)} を commit SHA に確定できない（symbolic ref のままでは作成しない）`, 300));
    return finalize("failure", "plan", EXIT_NG);
  }
  document.profile.base_sha = baseSha;

  // --- plan（dry-run。ここでは作成しない）-----------------------------------
  // `plan[].directory` は schema の repo_path（`..` を含めない安全な相対 path）なので、
  // repository の親から見た相対を記録する。作成・baseline・roster が使う実 path はここに持つ。
  const targets = new Map();
  for (const number of requested) {
    const titleResult = exec(ghArgv, ["issue", "view", String(number), "--repo", profile.repository, "--json", "title"], root);
    if (titleResult.status !== 0) {
      blockingReasons.push(clip(`issue_unresolved: #${number} の title を読めない（gh issue view: ${redact(titleResult.stderr.trim()) || "no output"}）`, 300));
      continue;
    }
    let title;
    try {
      title = JSON.parse(titleResult.stdout).title;
    } catch {
      blockingReasons.push(clip(`issue_unresolved: #${number} の gh 応答が JSON として読めない`, 300));
      continue;
    }
    const slug = slugify(title);
    const branch = clip(expandTemplate(profile.branch_template, { number, slug, repo: repoName }), 200);
    const targetAbs = resolve(toplevel, expandTemplate(profile.worktree_template, { number, slug, repo: repoName }));
    targets.set(number, targetAbs);
    const directory = relative(dirname(toplevel), targetAbs).split("\\").join("/");

    const blockedBy = [];
    if (!isSafeRepoPath(directory)) {
      blockedBy.push("directory");
      collisions.push({ issue_number: number, kind: "directory", detail: clip(redact(`path escape rejected: ${directory}`), 300) });
    } else {
      if (localBranches.has(branch)) {
        blockedBy.push("local_branch");
        collisions.push({ issue_number: number, kind: "local_branch", detail: clip(redact(branch), 300) });
      }
      if (remoteBranches.has(`origin/${branch}`)) {
        blockedBy.push("remote_branch");
        collisions.push({ issue_number: number, kind: "remote_branch", detail: clip(redact(`origin/${branch}`), 300) });
      }
      const existingWorktree = existingWorktrees.find((entry) => entry.branch === branch || samePath(entry.path, targetAbs));
      if (existingWorktree) {
        blockedBy.push("worktree");
        collisions.push({ issue_number: number, kind: "worktree", detail: clip(redact(existingWorktree.branch || existingWorktree.path), 300) });
      } else if (existsSync(targetAbs)) {
        blockedBy.push("directory");
        collisions.push({ issue_number: number, kind: "directory", detail: clip(redact(directory), 300) });
      }
    }

    plan.push({
      issue_number: number,
      branch,
      directory,
      base_ref: clip(baseRef, 200),
      base_sha: baseSha,
      baseline_command: clip(profile.baseline.join(" && "), 500) || "true",
      sync_planned: true,
      blocked_by: [...new Set(blockedBy)],
    });
  }

  if (plan.length === 0) {
    if (blockingReasons.length === 0) blockingReasons.push(clip("no_plan: 対象 Issue の plan を1件も作れなかった", 300));
    return finalize("failure", "plan", EXIT_NG);
  }

  // --- 作成（base SHA を作成直前に再確認する）-------------------------------
  let phase = "plan";
  let reconfirmed = true;
  for (const entry of plan) {
    if (entry.blocked_by.length > 0) {
      worktrees.push({ issue_number: entry.issue_number, branch: entry.branch, directory: entry.directory, base_sha: null, created: false, reused: false, note: clip(`blocked: ${entry.blocked_by.join(", ")}`, 300) });
      limitations.push(clip(`#${entry.issue_number}: collision のため作成しない（${entry.blocked_by.join(", ")}）`, 300));
      continue;
    }
    const confirmResult = git(["rev-parse", `${baseRef}^{commit}`], root);
    const confirmSha = confirmResult.status === 0 ? confirmResult.stdout.trim() : "";
    if (confirmSha !== entry.base_sha) {
      reconfirmed = false;
      worktrees.push({ issue_number: entry.issue_number, branch: entry.branch, directory: entry.directory, base_sha: null, created: false, reused: false, note: clip("base drift: plan 後に base が動いた", 300) });
      limitations.push(clip(`#${entry.issue_number}: base が drift した（plan ${entry.base_sha.slice(0, 12)} → ${confirmSha.slice(0, 12)}）。plan を作り直して再実行する`, 300));
      continue;
    }
    const addResult = git(["worktree", "add", "-b", entry.branch, targets.get(entry.issue_number), entry.base_sha], root);
    if (addResult.status !== 0) {
      reconfirmed = false;
      worktrees.push({ issue_number: entry.issue_number, branch: entry.branch, directory: entry.directory, base_sha: null, created: false, reused: false, note: clip(`git worktree add が失敗した（exit ${addResult.status}）`, 300) });
      blockingReasons.push(clip(`create_failed: #${entry.issue_number} の worktree を作れない（${redact(addResult.stderr.trim()) || "no output"}）`, 300));
      continue;
    }
    worktrees.push({ issue_number: entry.issue_number, branch: entry.branch, directory: entry.directory, base_sha: entry.base_sha, created: true, reused: false });
    phase = "create";
  }

  const created = worktrees.filter((entry) => entry.created === true || entry.reused === true);
  say(`worktree-setup: created ${created.length}/${requested.length}`);

  // --- baseline（作成した worktree の中で、profile の順に実行する）----------
  for (const entry of created) {
    const cwd = targets.get(entry.issue_number);
    let failed = false;
    for (const command of profile.baseline) {
      const tokens = parseArgv(command);
      const result = exec([tokens[0]], tokens.slice(1), cwd);
      const outcome = result.status === 0 ? "pass" : "fail";
      const excerptText = redact(`${result.stdout}${result.stderr}`.trim()).slice(-2000);
      baseline.push({
        issue_number: entry.issue_number,
        command: clip(command, 500),
        outcome,
        exit_code: typeof result.status === "number" ? result.status : null,
        redacted: excerptText !== `${result.stdout}${result.stderr}`.trim(),
        output_excerpt: excerptText === "" ? null : excerptText,
      });
      if (outcome === "fail") {
        failed = true;
        break;
      }
    }
    if (failed) {
      limitations.push(clip(`#${entry.issue_number}: baseline が失敗した。worktree は診断のため保持する`, 300));
      nextActions.push({ action: clip(`#${entry.issue_number} の worktree 内で baseline の失敗を診断し、直してから再実行する（worktree は保持されている）`, 300), owner: "operator" });
    }
    phase = "baseline";
  }

  // --- CommandMate sync → roster 固定 → cliToolId 実測 ----------------------
  let syncAvailable = false;
  let syncWorktreeId = null;
  const cliFix = [];
  if (created.length > 0) {
    phase = "sync";
    const syncResult = cm(["sync", "--json"], root);
    document.commandmate_sync.attempted = true;
    if (syncResult.status === 0) {
      syncAvailable = true;
    } else {
      document.commandmate_sync.detail = clip(`commandmate sync を使えない（exit ${syncResult.status ?? "null"}）。sync は optional なので失敗にしない`, 300);
      limitations.push(clip("commandmate sync を使えない（server 未起動、または sync を持たない旧 CLI）。worktree は作成済み", 300));
    }
  }

  if (created.length > 0 && syncAvailable) {
    const lsResult = cm(["ls", "--json"], root);
    let ls = null;
    try {
      ls = JSON.parse(lsResult.stdout);
    } catch {
      ls = null;
    }
    if (!Array.isArray(ls)) {
      limitations.push(clip("commandmate ls --json を読めない。worktree ID と cliToolId を解決できない", 300));
      document.commandmate_sync.detail = clip("sync は通ったが ls --json を読めない。worktree ID と cliToolId は未解決（推測で埋めない）", 300);
    } else {
      for (const entry of created) {
        const targetAbs = targets.get(entry.issue_number);
        const row = ls.find((item) => item && (item.branch === entry.branch || (typeof item.path === "string" && samePath(item.path, targetAbs))));
        if (!row) {
          limitations.push(clip(`#${entry.issue_number}: commandmate ls に branch ${entry.branch} の worktree が見つからない`, 300));
          continue;
        }
        if (syncWorktreeId === null) syncWorktreeId = typeof row.id === "string" ? row.id : null;

        // 追記 1 の順序：sync の後で roster を command-code だけにする。
        const instancesResult = cm(["instances", row.id, "--json"], root);
        let instances = null;
        try {
          instances = JSON.parse(instancesResult.stdout);
        } catch {
          instances = null;
        }
        if (!Array.isArray(instances)) {
          limitations.push(clip(`#${entry.issue_number}: commandmate instances --json を読めない。roster を固定できない`, 300));
          continue;
        }
        let removed = 0;
        for (const instance of instances) {
          const cliTool = instance && typeof instance.cliTool === "string" ? instance.cliTool : null;
          if (cliTool === null || cliTool === EXPECTED_CLI_TOOL_ID) continue;
          const removeResult = cm(["instances", row.id, "remove", cliTool], root);
          if (removeResult.status === 0) removed += 1;
        }
        const afterResult = cm(["ls", "--json"], root);
        let cliToolId = null;
        try {
          const after = JSON.parse(afterResult.stdout);
          const afterRow = Array.isArray(after) ? after.find((item) => item && item.id === row.id) : null;
          cliToolId = afterRow && typeof afterRow.cliToolId === "string" ? afterRow.cliToolId : null;
        } catch {
          cliToolId = null;
        }
        cliFix.push({ issue: entry.issue_number, removed, cliToolId });
        if (cliToolId === EXPECTED_CLI_TOOL_ID) {
          limitations.push(clip(`#${entry.issue_number}: roster を ${EXPECTED_CLI_TOOL_ID} だけにし、cliToolId=${cliToolId} を実測した（他 ${removed} 件を remove）`, 300));
        } else {
          limitations.push(clip(`#${entry.issue_number}: roster の固定が不完全。cliToolId=${cliToolId ?? "unknown"}（${EXPECTED_CLI_TOOL_ID} を期待）`, 300));
          nextActions.push({ action: clip(`#${entry.issue_number} の worktree の roster から他の CLI を外し、cliToolId を ${EXPECTED_CLI_TOOL_ID} にする`, 300), owner: "operator" });
        }
      }
    }
  }

  say(`worktree-setup: commandmate sync available=${syncAvailable} cliToolId=${cliFix.map((item) => item.cliToolId ?? "unknown").join(",") || "-"}`);

  if (syncAvailable) {
    document.commandmate_sync.available = true;
    document.commandmate_sync.worktree_id = syncWorktreeId;
    const fixed = cliFix.filter((item) => item.cliToolId === EXPECTED_CLI_TOOL_ID);
    document.commandmate_sync.detail = clip(
      `sync ok; ${created.length} 件のうち ${fixed.length} 件で roster を ${EXPECTED_CLI_TOOL_ID} だけにし cliToolId=${EXPECTED_CLI_TOOL_ID} を実測した`,
      300,
    );
  }

  // --- completion check ------------------------------------------------------
  const allCreated = created.length === requested.length;
  // baseline が空の profile（実行するものが無い）は pass と読む。行があれば全部 pass であること。
  const allBaselinePass = created.length > 0 && created.every((entry) =>
    baseline.filter((row) => row.issue_number === entry.issue_number).every((row) => row.outcome === "pass"));
  const cliFixed = created.length > 0 && cliFix.length === created.length && cliFix.every((item) => item.cliToolId === EXPECTED_CLI_TOOL_ID);
  // result / summary に token・secret・絶対 path が残っていないことを、組み立てた文書そのもので確かめる。
  const forbidden = /(?:\/Users\/[^\s"/]+|\/home\/[^\s"/]+|\/private\/var\/|\/var\/folders\/|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
  const noSecrets = !forbidden.test(JSON.stringify({ ...document, summary_markdown: "", redactions: [] }));

  const checks = [
    { id: "input_validated", passed: requested.length > 0 && requested.every((n) => Number.isInteger(n) && n >= 1), detail: clip(`${requested.length} 件（max_issues ${maxIssues}${dropped.length ? `, ${dropped.length} 件を打ち切り` : ""}）`, 300) },
    { id: "plan_confirmed", passed: plan.length > 0, detail: clip("承認済み plan の profile/base/issues で呼ばれた（dispatch の準備段）。plan を作ってから作成した", 300) },
    { id: "no_implicit_overwrite", passed: worktrees.every((entry) => entry.reused === false), detail: clip(`既存 branch/directory/worktree を上書き・reset・reuse していない（collision ${collisions.length} 件は作成しなかった）`, 300) },
    { id: "base_reconfirmed", passed: reconfirmed, detail: clip(reconfirmed ? "作成した worktree はすべて作成直前に base SHA を再確認した" : "base が drift した entry は作成しなかった", 300) },
    { id: "baseline_reported", passed: baseline.every((entry) => entry.outcome === "pass" || entry.outcome === "fail"), detail: clip(`${baseline.length} 件を丸めず記録した（失敗しても worktree は保持）`, 300) },
    { id: "no_secret_or_abspath", passed: noSecrets, detail: clip(`token・secret・絶対 path を残していない（redactions ${document.redactions.length} kind）`, 300) },
  ];
  document.redactions = redactor.list();
  const checksPassed = checks.every((check) => check.passed);
  document.completion_check = { passed: checksPassed, checks };

  // --- status（result-contract.md 第2節。sync が使えないことも partial の条件に含まれる）---
  let status;
  if (created.length === 0) {
    status = "failure";
    if (blockingReasons.length === 0) blockingReasons.push(clip("no_worktree_created: worktree を1件も作成できなかった", 300));
  } else if (allCreated && allBaselinePass && cliFixed && checksPassed && syncAvailable) {
    status = "success";
  } else {
    status = "partial";
  }

  if (status === "partial") {
    if (!syncAvailable) nextActions.push({ action: clip("CommandMate server を起動して commandmate sync を実行し、新しい worktree を registry に載せる", 300), owner: "operator" });
    if (collisions.length > 0) nextActions.push({ action: clip("collision した既存 branch/directory/worktree を解消する（削除は cmate-worktree-cleanup が持つ）", 300), owner: "operator" });
    if (!allBaselinePass) nextActions.push({ action: clip("baseline が失敗した worktree を直して再実行する", 300), owner: "operator" });
    if (!cliFixed) nextActions.push({ action: clip(`worktree の roster を ${EXPECTED_CLI_TOOL_ID} だけにして cliToolId を実測する`, 300), owner: "operator" });
    if (nextActions.length === 0) nextActions.push({ action: clip("worktree-setup の result を読み、未達の項目を解消する", 300), owner: "operator" });
  } else if (status === "success") {
    nextActions.push({ action: clip("dispatch を続行する（worktree は用意できた）", 300), owner: "operator" });
  }

  const phaseFinal = status === "success" ? "complete" : (phase === "sync" ? "sync" : phase);
  const exitCode = status === "success" ? EXIT_OK : (status === "partial" ? EXIT_PARTIAL : EXIT_NG);
  return finalize(status, phaseFinal, exitCode);
}

// =============================================================================
// summary_markdown（result-contract.md 第4節の見出しを、この順でちょうど1回ずつ）
// =============================================================================

function buildSummary(document) {
  const lines = [];
  const created = document.worktrees.filter((entry) => entry.created === true || entry.reused === true);
  const requested = document.request.issue_numbers;

  lines.push("## 対象と結論");
  if (document.status === "success") {
    lines.push(`- status: success — ${requested.length} 件すべての worktree を作成し、baseline が pass した`);
  } else if (document.status === "partial") {
    lines.push(`- status: partial — 作成済み: ${created.length} 件 / 未作成: ${requested.length - created.length} 件`);
  } else {
    lines.push(`- status: failure — 作成済み: 0 件 / 未作成: ${requested.length} 件`);
  }
  lines.push(`- 対象: ${requested.map((n) => `#${n}`).join(", ")}`);
  lines.push(`- base: ${document.profile.base_ref ?? "-"}（${document.profile.base_sha ?? "未確定"}）`);

  lines.push("");
  lines.push("## profile");
  lines.push(`- selected: ${document.profile.selected}（verified: ${document.profile.verified}）`);
  lines.push(`- base_ref: ${document.profile.base_ref ?? "-"}`);
  lines.push(`- branch_template: ${document.profile.branch_template ?? "-"}`);
  lines.push(`- directory_template: ${document.profile.directory_template ?? "-"}`);
  lines.push(`- baseline: ${document.profile.baseline_command ?? "-"}`);

  lines.push("");
  lines.push("## plan（dry-run）");
  lines.push("| issue | branch | directory | base_sha | blocked_by |");
  lines.push("|---|---|---|---|---|");
  for (const entry of document.plan) {
    lines.push(`| #${entry.issue_number} | ${entry.branch} | ${entry.directory} | ${entry.base_sha.slice(0, 12)} | ${entry.blocked_by.join(", ") || "-"} |`);
  }

  lines.push("");
  lines.push("## 作成結果");
  for (const entry of document.worktrees) {
    const state = entry.created ? "作成" : entry.reused ? "reuse" : "未作成";
    lines.push(`- #${entry.issue_number}: ${state} — ${entry.branch} → ${entry.directory}${entry.note ? `（${entry.note}）` : ""}`);
  }

  lines.push("");
  lines.push("## baseline");
  if (document.baseline.length === 0) {
    lines.push("- 実行なし");
  } else {
    for (const entry of document.baseline) {
      lines.push(`- #${entry.issue_number}: ${entry.outcome}（exit ${entry.exit_code ?? "null"}）— ${entry.command}`);
    }
  }

  lines.push("");
  lines.push("## CommandMate sync");
  lines.push(`- available: ${document.commandmate_sync.available} / attempted: ${document.commandmate_sync.attempted} / worktree_id: ${document.commandmate_sync.worktree_id ?? "null"}`);
  lines.push(`- ${document.commandmate_sync.detail}`);

  lines.push("");
  lines.push("## 未解決とnext action");
  const unresolved = [...document.blocking_reasons, ...document.limitations];
  if (unresolved.length === 0) {
    lines.push("- 未解決なし");
  } else {
    for (const item of unresolved) lines.push(`- ${item}`);
  }
  for (const item of document.next_actions) lines.push(`- next: ${item.action}（owner: ${item.owner}）`);

  return lines.join("\n");
}

// =============================================================================
// CLI
// =============================================================================

function main() {
  const result = run(process.argv.slice(2), {});
  if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}

export { run, slugify, parseIssueNumbers, normalizeRemoteUrl, parsePorcelainWorktrees };
