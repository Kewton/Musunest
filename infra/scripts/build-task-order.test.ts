// build / typecheck の共有の出力への書き込みの順序と、build のキャッシュの復元を、実の turbo で確かめる。
//
// なぜ要るか：typecheck は依存先の build だけを待っていたので、同じパッケージの build と同じ dist /
// tsbuildinfo へ並列に書く組があった。TypeScript の書き込みは原子的でないため、途中の空のファイルが
// build のキャッシュに入り、unit の段でキャッシュから戻されて公開の関数が消える経路が在った（Issue #694）。
// また tsbuildinfo が build の outputs に無いので、dist だけを戻すと増分の状態が揃わなかった。
//
// 直したこと自体が戻らないよう、タスクの図（順序・循環・既存の経路）と、隔離した fixture での
// cold / warm の復元（内容の SHA-256 と入口の関数の typeof）をここで測る。判定に mtime は使わない。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TURBO = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "turbo.cmd" : "turbo");

/** 同じパッケージの build と typecheck が共有する出力。順序が崩れるとここが壊れる。 */
const SHARED_OUTPUTS = ["dist/index.js", "dist/index.d.ts", "tsconfig.tsbuildinfo"];
const ENTRY_FUNCTIONS = ["makeWidget", "makeGadget"];
const CACHE_ROUNDS = 10;

/** Issue 本文が「書き込みの順序が決まっていない組」として名指した 6 パッケージ。 */
const EMITTERS = [
  "@musunest/appspec-schema",
  "@musunest/sdk",
  "@musunest/spec-engine",
  "@musunest/app-do",
  "@musunest/control-plane",
  "@musunest/data-api",
];

type Task = {
  taskId: string;
  task: string;
  package: string;
  directory: string;
  dependencies: string[];
  resolvedTaskDefinition: { dependsOn?: string[]; outputs?: string[] };
};

type DryRun = { packages: string[]; tasks: Task[] };

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function turboEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TURBO_") && key !== "TURBO_TELEMETRY_DISABLED") delete env[key];
  }
  return env;
}

function runTurbo(cwd: string, args: string[]): string {
  try {
    return execFileSync(TURBO, args, { cwd, encoding: "utf8", env: turboEnv(), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    throw new Error(
      `turbo ${args.join(" ")} が失敗した（cwd=${cwd}, exit=${String(failure.status)}）\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
      { cause: error },
    );
  }
}

function dryRun(cwd: string, task: string): DryRun {
  return JSON.parse(runTurbo(cwd, ["run", task, "--dry=json"])) as DryRun;
}

const repoDryCache = new Map<string, DryRun>();

function repoDry(task: string): DryRun {
  const cached = repoDryCache.get(task);
  if (cached) return cached;
  const dry = dryRun(REPO_ROOT, task);
  repoDryCache.set(task, dry);
  return dry;
}

function taskMap(dry: DryRun): Map<string, Task> {
  return new Map(dry.tasks.map((task) => [task.taskId, task]));
}

function readPackageJson(directory: string): PackageJson {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson;
}

function taskDirectory(root: string, task: Task): string {
  return join(root, task.directory);
}

function emitsWithTsc(root: string, task: Task): boolean {
  return (readPackageJson(taskDirectory(root, task)).scripts?.["build"] ?? "").includes("tsc -b");
}

function hasPath(tasks: Map<string, Task>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    if (current === to) return true;
    seen.add(current);
    queue.push(...(tasks.get(current)?.dependencies ?? []));
  }
  return false;
}

/** タスクの図に循環があれば、その閉路を返す。無ければ null。 */
function findCycle(tasks: Map<string, Task>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    if (current === "done") return null;
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of tasks.get(id)?.dependencies ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of tasks.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

describe("実リポジトリの turbo のタスクの図", () => {
  it("emit する各パッケージの typecheck から同じパッケージの build への経路があり、循環が無い", () => {
    const tasks = taskMap(repoDry("typecheck"));

    for (const task of tasks.values()) {
      if (task.task !== "typecheck" || !emitsWithTsc(REPO_ROOT, task)) continue;
      expect(hasPath(tasks, task.taskId, `${task.package}#build`), task.package).toBe(true);
    }

    expect(findCycle(tasks)).toBeNull();
  });

  it("Issue が名指した 6 パッケージの typecheck が、同じパッケージの build を直接待つ", () => {
    const tasks = taskMap(repoDry("typecheck"));

    for (const name of EMITTERS) {
      const task = tasks.get(`${name}#typecheck`);
      expect(task, name).toBeDefined();
      expect(task?.dependencies, name).toContain(`${name}#build`);
    }
  });

  it("host の typecheck は ^build のままで、自身の Vite の build を待たない", () => {
    const tasks = taskMap(repoDry("typecheck"));
    const host = tasks.get("@musunest/host#typecheck");
    expect(host).toBeDefined();
    expect(host?.resolvedTaskDefinition.dependsOn).toEqual(["^build"]);
    expect(host?.dependencies).not.toContain("@musunest/host#build");
    expect(host?.dependencies).toContain("@musunest/sdk#build");
  });

  it("test の既存の ^build の経路を全部保つ", () => {
    const dry = repoDry("test");
    const workspace = new Set(repoDry("typecheck").packages);
    const tasks = taskMap(dry);

    for (const task of tasks.values()) {
      if (task.task !== "test") continue;
      const manifest = readPackageJson(taskDirectory(REPO_ROOT, task));
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      const expected = Object.keys(dependencies)
        .filter((name) => workspace.has(name))
        .map((name) => `${name}#build`)
        .toSorted();

      expect(task.dependencies.toSorted(), task.package).toEqual(expected);
      expect(task.resolvedTaskDefinition.dependsOn, task.package).toEqual(["^build"]);
    }
  });

  it("build の outputs が dist と *.tsbuildinfo を含む（増分の状態も一緒にキャッシュする）", () => {
    const outputs = new Set(repoDry("build").tasks.flatMap((task) => task.resolvedTaskDefinition.outputs ?? []));

    expect(outputs).toContain("dist/**");
    expect(outputs).toContain("*.tsbuildinfo");
  });
});

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixturePackageJson(name: string, dependencies?: Record<string, string>): string {
  return JSON.stringify({
    name,
    private: true,
    type: "module",
    ...(dependencies ? { dependencies } : {}),
    scripts: {
      build: "tsc -b",
      typecheck: "tsc -b --pretty",
      test: 'node -e "process.exit(0)"',
    },
  });
}

const FIXTURE_TSCONFIG = JSON.stringify({
  extends: "../../tsconfig.base.json",
  compilerOptions: { rootDir: "src", outDir: "dist" },
  include: ["src/**/*"],
});

/** 実リポジトリの turbo.json を使う隔離した workspace。node_modules だけ実物を共有する。 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "build-task-order-"));
  write(root, "package.json", JSON.stringify({ name: "fixture-root", private: true, packageManager: "pnpm@10.13.1" }));
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/app: {}\n\n  packages/core: {}\n");
  write(root, ".gitignore", "node_modules/\n.turbo/\ndist/\n.output/\n*.tsbuildinfo\n");
  write(root, "turbo.json", readFileSync(join(REPO_ROOT, "turbo.json"), "utf8"));
  write(
    root,
    "tsconfig.base.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        composite: true,
        declaration: true,
        declarationMap: true,
        skipLibCheck: true,
      },
    }),
  );
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");

  write(root, "packages/core/package.json", fixturePackageJson("@fixture/core"));
  write(root, "packages/core/tsconfig.json", FIXTURE_TSCONFIG);
  write(
    root,
    "packages/core/src/index.ts",
    "export function makeWidget(): number { return 41 + 1; }\nexport function makeGadget(name: string): string { return name; }\n",
  );
  write(root, "packages/app/package.json", fixturePackageJson("@fixture/app", { "@fixture/core": "workspace:*" }));
  write(root, "packages/app/tsconfig.json", FIXTURE_TSCONFIG);
  write(root, "packages/app/src/index.ts", "export const answer = 42;\n");

  return root;
}

function removeOutputs(root: string): void {
  for (const name of ["core", "app"]) {
    rmSync(join(root, "packages", name, "dist"), { recursive: true, force: true });
    rmSync(join(root, "packages", name, "tsconfig.tsbuildinfo"), { force: true });
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function outputHashes(root: string): Record<string, string> {
  return Object.fromEntries(SHARED_OUTPUTS.map((file) => [file, sha256(join(root, "packages/core", file))]));
}

describe("隔離した fixture の実の turbo", () => {
  it("typecheck は同じパッケージの build を待ち、test の ^build は build だけを待つ", () => {
    const root = makeFixture();
    try {
      const typecheck = taskMap(dryRun(root, "typecheck"));
      expect(typecheck.get("@fixture/core#typecheck")?.dependencies).toContain("@fixture/core#build");
      expect(typecheck.get("@fixture/app#typecheck")?.dependencies).toEqual(
        expect.arrayContaining(["@fixture/app#build", "@fixture/core#build"]),
      );
      expect(findCycle(typecheck)).toBeNull();

      expect(taskMap(dryRun(root, "test")).get("@fixture/app#test")?.dependencies).toEqual(["@fixture/core#build"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "cold / warm 各 10 回で dist と tsbuildinfo が同じ内容で復元され、入口の関数が function のまま",
    async () => {
      const root = makeFixture();
      try {
        for (let round = 0; round < CACHE_ROUNDS; round++) {
          rmSync(join(root, ".turbo", "cache"), { recursive: true, force: true });
          removeOutputs(root);
          runTurbo(root, ["run", "build", "--output-logs=errors-only"]);
          for (const file of SHARED_OUTPUTS) {
            expect(existsSync(join(root, "packages/core", file)), `round ${round}: cold ${file}`).toBe(true);
          }
          const cold = outputHashes(root);

          removeOutputs(root);
          runTurbo(root, ["run", "build", "--output-logs=errors-only"]);
          for (const file of SHARED_OUTPUTS) {
            expect(existsSync(join(root, "packages/core", file)), `round ${round}: restored ${file}`).toBe(true);
          }
          const warm = outputHashes(root);

          expect(warm, `round ${round}`).toEqual(cold);

          const entry = join(root, "packages/core/dist/index.js");
          const module = (await import(`${pathToFileURL(entry).href}?round=${round}`)) as Record<string, unknown>;
          for (const name of ENTRY_FUNCTIONS) {
            expect(typeof module[name], `round ${round}: ${name}`).toBe("function");
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
