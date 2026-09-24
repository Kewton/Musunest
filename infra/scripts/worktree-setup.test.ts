// worktree-setup（Issue #118）の試験。**実環境には一切届かない。**
//
// CLI（`node infra/scripts/worktree-setup.mjs ...`）を本物として動かし、git / gh / commandmate は
// 偽物を差し替える（`--git` / `--gh` / `--commandmate`）。見るのは4つ。
//
//   1. 正常：stdout が worktree-setup.result.v1 として読め（閉じた schema の field を過不足なく持ち）、
//      worktree を作り、baseline を通し、roster を command-code だけにして cliToolId を実測する
//   2. 順序：`commandmate sync` のあとに roster を外す（sync が CLI の固定を戻すため。Issue #118 追記 1）
//   3. baseline が落ちたら partial。worktree は保持し、作成済み/未作成が結果から読める
//   4. collision（既存 branch / directory）と base の drift では作らない
//
// dispatch（cmate-orchestrate の §3.0.1）が読む必須 field と branch 一致は「dispatch から呼べる」で固定する。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROVIDER = join(ROOT, "infra/scripts/worktree-setup.mjs");
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

/** result-contract v1 の top-level field（閉じている。過不足は契約違反）。 */
const RESULT_FIELDS = [
  "result_schema_version",
  "skill_id",
  "skill_version",
  "generated_at",
  "status",
  "phase_reached",
  "request",
  "repository",
  "profile",
  "plan",
  "worktrees",
  "baseline",
  "commandmate_sync",
  "collisions",
  "redactions",
  "next_actions",
  "blocking_reasons",
  "limitations",
  "completion_check",
  "summary_markdown",
] as const;

/** 6つの completion check の id（順序は問わないが、ちょうど1回ずつ現れる）。 */
const CHECK_IDS = [
  "input_validated",
  "plan_confirmed",
  "no_implicit_overwrite",
  "base_reconfirmed",
  "baseline_reported",
  "no_secret_or_abspath",
] as const;

/** summary_markdown の見出し（この順に、ちょうど1回ずつ）。 */
const SUMMARY_HEADINGS = [
  "## 対象と結論",
  "## profile",
  "## plan（dry-run）",
  "## 作成結果",
  "## baseline",
  "## CommandMate sync",
  "## 未解決とnext action",
] as const;

interface PlanEntry {
  issue_number: number;
  branch: string;
  directory: string;
  base_ref: string;
  base_sha: string;
  baseline_command: string;
  sync_planned: boolean;
  blocked_by: string[];
}

interface WorktreeEntry {
  issue_number: number;
  branch: string;
  directory: string;
  base_sha: string | null;
  created: boolean;
  reused: boolean;
  note?: string | null;
}

interface BaselineEntry {
  issue_number: number;
  command: string;
  outcome: string;
  exit_code: number | null;
  redacted: boolean;
  output_excerpt?: string | null;
}

interface ResultDoc {
  result_schema_version: number;
  skill_id: string;
  skill_version: string;
  generated_at: string;
  status: string;
  phase_reached: string;
  request: { issue_numbers: number[]; max_issues: number; reuse_existing: boolean; base_override: string | null };
  repository: {
    slug: string | null;
    current_branch: string | null;
    integration_branch: string | null;
    default_base: string | null;
    remote_name: string | null;
    dirty: boolean | null;
  };
  profile: {
    selected: string;
    verified: boolean;
    detection_evidence: unknown[];
    base_ref: string | null;
    base_sha: string | null;
    branch_template: string | null;
    directory_template: string | null;
    baseline_command: string | null;
  };
  plan: PlanEntry[];
  worktrees: WorktreeEntry[];
  baseline: BaselineEntry[];
  commandmate_sync: { available: boolean; attempted: boolean; worktree_id: string | null; detail: string };
  collisions: { issue_number: number; kind: string; detail: string }[];
  redactions: { kind: string; count: number }[];
  next_actions: { action: string; owner: string }[];
  blocking_reasons: string[];
  limitations: string[];
  completion_check: { passed: boolean; checks: { id: string; passed: boolean; detail: string }[] };
  summary_markdown: string;
}

interface CmInstance {
  id: string;
  cliTool: string;
  alias: string;
}

interface CmWorktree {
  id: string;
  name: string;
  branch: string;
  /** 空なら harness が実 path（repo の兄弟）で埋める */
  path: string;
  instances: CmInstance[];
}

interface GitState {
  toplevel: string;
  branch: string;
  remote: string;
  baseSha: string;
  baseShaAfter?: string;
  dirty: boolean;
  worktrees: { path: string; branch?: string; head?: string }[];
  localBranches: string[];
  remoteBranches: string[];
  worktreeAddFails?: boolean;
}

// ── 偽物（git / gh / commandmate）────────────────────────────────────────────

/** argv を state に従って解釈する偽 git。`worktree add` は実 directory も作る（baseline の cwd になる）。 */
const FAKE_GIT = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.WS_FAKE_GIT_STATE, "utf8"));
const args = process.argv.slice(2);
if (process.env.WS_FAKE_GIT_CALLS) appendFileSync(process.env.WS_FAKE_GIT_CALLS, JSON.stringify(args) + "\\n");
const out = (v) => process.stdout.write(v + "\\n");
// base SHA の解決。2回目以降（作成直前の再確認）に baseShaAfter があればそれを返し、drift を作る。
const revParseCommit = () => {
  state.baseShaCount = (state.baseShaCount || 0) + 1;
  writeFileSync(process.env.WS_FAKE_GIT_STATE, JSON.stringify(state));
  return state.baseShaAfter && state.baseShaCount > 1 ? state.baseShaAfter : state.baseSha;
};
if (args[0] === "rev-parse" && args[1] === "--show-toplevel") out(state.toplevel);
else if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") out(state.branch);
else if (args[0] === "rev-parse" && String(args[1]).endsWith("^{commit}")) out(revParseCommit());
else if (args[0] === "remote" && args[1] === "get-url") out(state.remote);
else if (args[0] === "status") { if (state.dirty) out(" M a.txt"); }
else if (args[0] === "worktree" && args[1] === "list") {
  for (const w of state.worktrees || []) { out("worktree " + w.path); if (w.branch) out("branch refs/heads/" + w.branch); out(""); }
} else if (args[0] === "for-each-ref") {
  const ref = args[args.length - 1];
  for (const b of (ref === "refs/heads" ? state.localBranches : state.remoteBranches) || []) out(b);
} else if (args[0] === "worktree" && args[1] === "add") {
  const at = args.indexOf("-b");
  const branch = args[at + 1];
  const path = args[at + 2];
  if (state.worktreeAddFails) { process.stderr.write("fatal: fake worktree add failed\\n"); process.exit(1); }
  mkdirSync(path, { recursive: true });
  (state.worktrees ||= []).push({ path, branch, head: args[at + 3] });
  out("Preparing worktree (" + branch + ")");
} else {
  process.stderr.write("fake git: unknown " + args.join(" ") + "\\n");
  process.exit(1);
}
`;

/** Issue title だけを返す偽 gh。 */
const FAKE_GH = `
import { readFileSync } from "node:fs";
const titles = JSON.parse(readFileSync(process.env.WS_FAKE_GH_TITLES, "utf8"));
const number = process.argv.slice(2)[2];
if (titles[number] === undefined) { process.stderr.write("fake gh: no title for " + number + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ title: titles[number] }) + "\\n");
`;

/** sync / ls / instances を state に従って返す偽 commandmate。`remove` は roster を実際に書き換える。 */
const FAKE_CM = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.WS_FAKE_CM_STATE, "utf8"));
const args = process.argv.slice(2);
if (process.env.WS_FAKE_CM_CALLS) appendFileSync(process.env.WS_FAKE_CM_CALLS, JSON.stringify(args) + "\\n");
const out = (v) => process.stdout.write(v + "\\n");
const save = () => writeFileSync(process.env.WS_FAKE_CM_STATE, JSON.stringify(state));
const find = (id) => (state.worktrees || []).find((w) => w.id === id);
if (args[0] === "sync") {
  if (state.syncFails) { process.stderr.write("sync unavailable\\n"); process.exit(1); }
  save();
  out(JSON.stringify({ rescanned: (state.worktrees || []).length }));
} else if (args[0] === "ls") {
  out(JSON.stringify((state.worktrees || []).map((w) => ({ id: w.id, name: w.name, branch: w.branch, path: w.path, cliToolId: w.instances[0] ? w.instances[0].cliTool : null, agentInstances: w.instances }))));
} else if (args[0] === "instances" && args[2] === "--json") {
  const w = find(args[1]);
  if (!w) { process.stderr.write("fake cm: no worktree " + args[1] + "\\n"); process.exit(1); }
  out(JSON.stringify(w.instances.map((i) => ({ instanceId: i.id, alias: i.alias, cliTool: i.cliTool, running: false, autoYes: false }))));
} else if (args[0] === "instances" && args[2] === "remove") {
  const w = find(args[1]);
  if (w) { w.instances = w.instances.filter((i) => i.cliTool !== args[3]); save(); }
  out("{}");
} else {
  process.stderr.write("fake cm: unknown " + args.join(" ") + "\\n");
  process.exit(1);
}
`;

// ── ハーネス ────────────────────────────────────────────────────────────────

interface ProviderRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: ResultDoc;
  /** worktree の実 path を作るために使う temp の親（repo はこの下の Musunest） */
  tempRoot: string;
  calls: { git: string[][]; cm: string[][] };
}

interface Setup {
  issues: number[];
  base?: string;
  titles?: Record<string, string>;
  baseline?: string[];
  git?: Partial<GitState>;
  cm?: { worktrees?: CmWorktree[]; syncFails?: boolean };
  /** target directory（repo の兄弟）を事前に作る。directory collision 用 */
  preCreateTarget?: boolean;
}

const EXPECTED = { branch: "feat/101-alpha", directory: "Musunest-issue-101" };

let bin: string;
const tempRoots: string[] = [];

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "worktree-setup-bin-"));
  writeFileSync(join(bin, "git.mjs"), FAKE_GIT);
  writeFileSync(join(bin, "gh.mjs"), FAKE_GH);
  writeFileSync(join(bin, "cm.mjs"), FAKE_CM);
});

afterAll(() => {
  rmSync(bin, { recursive: true, force: true });
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  tempRoots.length = 0;
});

function runProvider(setup: Setup): ProviderRun {
  const tempRoot = mkdtempSync(join(tmpdir(), "worktree-setup-repo-"));
  tempRoots.push(tempRoot);
  const repo = join(tempRoot, "Musunest");
  mkdirSync(join(repo, ".commandmate", "profiles"), { recursive: true });
  if (setup.preCreateTarget === true) mkdirSync(join(tempRoot, EXPECTED.directory), { recursive: true });

  writeFileSync(
    join(repo, ".commandmate", "profiles", "test.json"),
    JSON.stringify({
      id: "test",
      repository: "Kewton/Musunest",
      base: "origin/main",
      branch_template: "feat/{number}-{slug}",
      worktree_template: "../{repo}-issue-{number}",
      baseline: setup.baseline ?? ["true"],
      verified: false,
    }),
  );

  const gitState: GitState = {
    toplevel: repo,
    branch: "main",
    remote: "https://github.com/Kewton/Musunest.git",
    baseSha: SHA,
    dirty: false,
    worktrees: [],
    localBranches: [],
    remoteBranches: [],
    ...setup.git,
  };
  const cmState = {
    worktrees: (setup.cm?.worktrees ?? []).map((worktree) => ({
      ...worktree,
      path: worktree.path === "" ? join(tempRoot, worktree.name) : worktree.path,
    })),
    syncFails: setup.cm?.syncFails ?? false,
  };

  const gitStatePath = join(repo, ".ws-git-state.json");
  const gitCallsPath = join(repo, ".ws-git-calls.jsonl");
  const ghTitlesPath = join(repo, ".ws-gh-titles.json");
  const cmStatePath = join(repo, ".ws-cm-state.json");
  const cmCallsPath = join(repo, ".ws-cm-calls.jsonl");
  writeFileSync(gitStatePath, JSON.stringify(gitState));
  writeFileSync(gitCallsPath, "");
  writeFileSync(ghTitlesPath, JSON.stringify(setup.titles ?? { "101": "alpha" }));
  writeFileSync(cmStatePath, JSON.stringify(cmState));
  writeFileSync(cmCallsPath, "");

  const result = spawnSync(
    process.execPath,
    [
      PROVIDER,
      "--issues", setup.issues.join(","),
      "--profile", "test",
      "--base", setup.base ?? "origin/main",
      "--git", `${process.execPath} ${join(bin, "git.mjs")}`,
      "--gh", `${process.execPath} ${join(bin, "gh.mjs")}`,
      "--commandmate", `${process.execPath} ${join(bin, "cm.mjs")}`,
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env["PATH"] ?? "",
        WS_FAKE_GIT_STATE: gitStatePath,
        WS_FAKE_GIT_CALLS: gitCallsPath,
        WS_FAKE_GH_TITLES: ghTitlesPath,
        WS_FAKE_CM_STATE: cmStatePath,
        WS_FAKE_CM_CALLS: cmCallsPath,
      },
      encoding: "utf8",
    },
  );

  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: JSON.parse(result.stdout) as ResultDoc,
    tempRoot,
    calls: { git: readCalls(gitCallsPath), cm: readCalls(cmCallsPath) },
  };
}

/** 偽物が記録した呼び出し（1 行 1 argv）。 */
function readCalls(path: string): string[][] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as string[]);
}

/** 作成された worktree の実 path（repo の兄弟） */
function worktreePath(run: ProviderRun, directory: string): string {
  return join(run.tempRoot, directory);
}

const ADDED = (run: ProviderRun): boolean => run.calls.git.some((args) => args[0] === "worktree" && args[1] === "add");

/** command-code だけが残った roster を返す偽 commandmate の worktree。 */
function cmWorktree(instances: CmInstance[] = [{ id: "command-code", cliTool: "command-code", alias: "Command Code" }]): CmWorktree {
  return { id: "wt-101", name: EXPECTED.directory, branch: EXPECTED.branch, path: "", instances };
}

// ── 1. 正常 ────────────────────────────────────────────────────────────────

describe("worktree-setup：正常（worktree を作り、baseline を通し、roster を固定する）", () => {
  function happyRun(): ProviderRun {
    return runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      cm: {
        worktrees: [
          cmWorktree([
            { id: "claude", cliTool: "claude", alias: "Claude" },
            { id: "codex", cliTool: "codex", alias: "Codex" },
            { id: "command-code", cliTool: "command-code", alias: "Command Code" },
          ]),
        ],
      },
    });
  }

  it("status=success。worktree を作り、baseline が pass し、roster を command-code だけにする", () => {
    const run = happyRun();
    expect(run.json.status).toBe("success");
    expect(run.json.phase_reached).toBe("complete");
    expect(run.json.worktrees).toHaveLength(1);
    expect(run.json.worktrees[0]?.created).toBe(true);
    expect(run.json.worktrees[0]?.branch).toBe(EXPECTED.branch);
    expect(run.json.worktrees[0]?.directory).toBe(EXPECTED.directory);
    expect(run.json.worktrees[0]?.base_sha).toBe(SHA);
    expect(run.json.baseline[0]?.outcome).toBe("pass");
    expect(run.json.commandmate_sync.available).toBe(true);
    expect(run.json.commandmate_sync.detail).toContain("command-code");
    expect(run.json.completion_check.passed).toBe(true);
    expect(existsSync(worktreePath(run, EXPECTED.directory))).toBe(true);

    // roster の remove は command-code 以外（claude / codex）にだけ打つ
    const removals = run.calls.cm.filter((args) => args[2] === "remove").map((args) => args[3]);
    expect(removals.toSorted()).toEqual(["claude", "codex"]);
  });

  it("result は閉じた schema に適合する（field の過不足・enum・check・summary の見出し）", () => {
    const doc = happyRun().json;
    expect(Object.keys(doc).toSorted()).toEqual([...RESULT_FIELDS].toSorted());
    expect(doc.result_schema_version).toBe(1);
    expect(doc.skill_id).toBe("cmate-worktree-setup");
    expect(doc.skill_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(doc.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(["success", "partial", "failure"]).toContain(doc.status);
    expect(["inspect", "plan", "create", "baseline", "sync", "complete"]).toContain(doc.phase_reached);
    expect(doc.completion_check.checks.map((check) => check.id).toSorted()).toEqual([...CHECK_IDS].toSorted());

    // plan[].directory は安全な相対 path（絶対 path でも `..` でもない）
    for (const entry of doc.plan) {
      expect(entry.directory).not.toMatch(/^[/\\]|(?:^|\/)\.\.(?:\/|$)|\\/);
    }

    // summary の見出しは、この順にちょうど1回ずつ
    let previous = -1;
    for (const heading of SUMMARY_HEADINGS) {
      const index = doc.summary_markdown.indexOf(heading);
      expect(index, heading).toBeGreaterThan(previous);
      expect(doc.summary_markdown.split(heading)).toHaveLength(2);
      previous = index;
    }
  });

  it("token・secret・機械固有の絶対 path を stdout に残さない", () => {
    const run = happyRun();
    expect(run.stdout).not.toMatch(/\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\//);
    expect(run.json.completion_check.checks.find((check) => check.id === "no_secret_or_abspath")?.passed).toBe(true);
  });

  it("dispatch（§3.0.1）が読む必須 field があり、worktrees[].branch が plan の branch と一致する", () => {
    const run = happyRun();
    for (const field of RESULT_FIELDS) expect(run.json, field).toHaveProperty(field);
    expect(run.json.worktrees[0]?.branch).toBe("feat/101-alpha");
    // exit code は文書が読めなかったときだけ見る。文書が適合していれば stdout が判断材料
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  it("sync は roster の remove より先に走る（Issue #118 追記 1。sync が CLI の固定を戻すため）", () => {
    const run = happyRun();
    const syncIndex = run.calls.cm.findIndex((args) => args[0] === "sync");
    const firstRemove = run.calls.cm.findIndex((args) => args[2] === "remove");
    const lastLs = run.calls.cm.reduce((last, args, index) => (args[0] === "ls" ? index : last), -1);
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeLessThan(firstRemove);
    // cliToolId の実測は roster を固定した後（最後の ls）に読む
    expect(lastLs).toBeGreaterThan(firstRemove);
  });
});

// ── 2. baseline 失敗 ───────────────────────────────────────────────────────

describe("worktree-setup：baseline が落ちたら partial（worktree は保持する）", () => {
  it("outcome=fail を丸めず、created=true のままにする", () => {
    const run = runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      baseline: ["false"],
      cm: { worktrees: [cmWorktree()] },
    });
    expect(run.json.status).toBe("partial");
    expect(run.json.worktrees[0]?.created).toBe(true);
    expect(run.json.baseline[0]?.outcome).toBe("fail");
    expect(run.json.baseline[0]?.exit_code).not.toBe(0);
    expect(run.json.limitations.some((line) => line.includes("baseline"))).toBe(true);
    // 失敗を fail として記録し、worktree を保持したこと自体は check を通る（丸めていない）
    expect(run.json.completion_check.checks.find((check) => check.id === "baseline_reported")?.passed).toBe(true);
    expect(existsSync(worktreePath(run, EXPECTED.directory))).toBe(true);
  });
});

// ── 3. collision / drift ───────────────────────────────────────────────────

describe("worktree-setup：collision と drift では作らない", () => {
  it("既存の local branch があれば、その entry は作らない（collision で止まる）", () => {
    const run = runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      git: { localBranches: [EXPECTED.branch] },
    });
    expect(run.json.status).toBe("failure");
    expect(run.json.worktrees[0]?.created).toBe(false);
    expect(run.json.plan[0]?.blocked_by).toContain("local_branch");
    expect(run.json.collisions.some((collision) => collision.kind === "local_branch")).toBe(true);
    expect(ADDED(run)).toBe(false);
    expect(run.json.blocking_reasons.length).toBeGreaterThan(0);
  });

  it("target directory が既にあれば、その entry は作らない（directory collision）", () => {
    const run = runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      preCreateTarget: true,
    });
    expect(run.json.status).toBe("failure");
    expect(run.json.worktrees[0]?.created).toBe(false);
    expect(run.json.plan[0]?.blocked_by).toContain("directory");
    expect(run.json.collisions.some((collision) => collision.kind === "directory")).toBe(true);
    expect(ADDED(run)).toBe(false);
  });

  it("plan の後に base が動いたら（drift）、その entry は作らない", () => {
    const run = runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      git: { baseShaAfter: "b1".repeat(20) },
    });
    expect(run.json.worktrees[0]?.created).toBe(false);
    expect(run.json.worktrees[0]?.note).toContain("drift");
    expect(run.json.completion_check.checks.find((check) => check.id === "base_reconfirmed")?.passed).toBe(false);
    expect(ADDED(run)).toBe(false);
    expect(run.json.status).toBe("failure");
  });

  it("commandmate sync が使えなくても、worktree は作成済みで失敗にしない（partial）", () => {
    const run = runProvider({
      issues: [101],
      titles: { "101": "alpha" },
      cm: { syncFails: true },
    });
    expect(run.json.status).toBe("partial");
    expect(run.json.worktrees[0]?.created).toBe(true);
    expect(run.json.commandmate_sync.available).toBe(false);
    expect(run.json.blocking_reasons).toHaveLength(0);
  });
});
