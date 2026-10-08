// identity（利用者・Community・所属・インスタンスの持ち主）の読み書きの unit（#259）。
// **本物の SQLite を実行者にして**、束縛引数・冪等・拒否の伝播まで見る（registry.test.ts と同じ考え方）。
//
// 実行者は test の内側で node:sqlite に繋ぎ、migrations/ の現物を当てる。モックにしないのは、
// SQL と引数の束縛が「動く」ことの証明は、実際に SQL を走らせることでしか得られないからである。
//
// node:sqlite と node:fs は Node 組み込みで、tsconfig の types は workers-types だけなので、
// 使う形だけを局所的に書く（動的 import で型解決を避ける）。
import { describe, expect, it } from "vitest";
import {
  COMMUNITIES_TABLE,
  COMMUNITY_MEMBERSHIPS_TABLE,
  IdentityError,
  INSTANCE_OWNERS_TABLE,
  type RegistryExecutor,
  type SqlResult,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
  USERS_TABLE,
} from "./contract.js";
import {
  getCommunity,
  getUser,
  getUserByGoogleSubject,
  listCommunityInstances,
  listCommunityMembers,
  listUserCommunities,
  registerInstanceOwner,
  registerLogin,
} from "./identity.js";
import { registerApp, registerInstance } from "./registry.js";

// ── Node 組み込みの最小の形（src は workerd 向けなので、型はここだけに書く）──────

interface StatementLike {
  all(...params: SqlValue[]): SqlRow[];
  run(...params: SqlValue[]): { changes: number };
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
}
interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseLike;
}
interface FsModule {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const [{ DatabaseSync }, { readFileSync, readdirSync }] = (await Promise.all([
  importUntyped("node:sqlite"),
  importUntyped("node:fs"),
])) as [SqliteModule, FsModule];

const HERE = (import.meta as ImportMeta & { url: string }).url;
const MIGRATIONS_DIR = decodeURIComponent(new URL("../migrations/", HERE).pathname);

// ── 実行者：本物の SQLite を RegistryExecutor の形で包む（registry.test.ts と同じ）────

class SqliteExecutor implements RegistryExecutor {
  /** 渡された束縛引数を、文の順に記録する（SQL へ埋め込んでいないことの検査に使う） */
  readonly bound: SqlValue[][] = [];
  readonly statements: string[] = [];

  constructor(private readonly db: DatabaseLike) {}

  async query<Row = SqlRow>(statement: SqlStatement): Promise<readonly Row[]> {
    return this.run(statement).rows as readonly Row[];
  }

  async execute(statement: SqlStatement): Promise<number> {
    return this.run(statement).changes;
  }

  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    // D1 の batch は1トランザクション。途中の失敗は全部戻す（部分適用を残さない）
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => this.run(statement));
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private run(statement: SqlStatement): SqlResult {
    const params = [...(statement.params ?? [])];
    this.bound.push(params);
    this.statements.push(statement.sql);
    const prepared = this.db.prepare(statement.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(statement.sql)) {
      return { rows: prepared.all(...params), changes: 0 };
    }
    return { rows: [], changes: prepared.run(...params).changes };
  }
}

const newIdentity = (): { executor: SqliteExecutor } => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
  return { executor: new SqliteExecutor(db) };
};

const countRows = async (executor: RegistryExecutor, table: string): Promise<number> => {
  const rows = await executor.query<{ n: number }>({ sql: `SELECT COUNT(*) AS n FROM ${table}` });
  return rows[0]?.n ?? -1;
};

// ── 入力 ────────────────────────────────────────────────────────────

const SHA_A = "a".repeat(64);
const APP_A = {
  sourceSha256: SHA_A,
  schemaVersion: "community.app-spec/v0.2",
  sourceKey: `specs/${SHA_A}/app.spec.yaml`,
  normalizedKey: `specs/${SHA_A}/normalized.json`,
};
const INSTANCE_1 = { instanceId: "inst-1", sourceSha256: SHA_A };

/** アプリとインスタンスを先に登録して、持ち主を付けられる状態を作る */
const seedInstance = async (executor: RegistryExecutor): Promise<void> => {
  await registerApp(executor, APP_A);
  await registerInstance(executor, INSTANCE_1);
};

describe("ログインの登録（本物の SQLite）", () => {
  it("空の登録への読取は null（例外にしない）", async () => {
    const { executor } = newIdentity();
    expect(await getUser(executor, "u-1")).toBeNull();
    expect(await getUserByGoogleSubject(executor, "sub-1")).toBeNull();
    expect(await getCommunity(executor, "c-1")).toBeNull();
  });

  it("初めてのログインで、利用者・Community・所属（owner）が 1 つずつでき、持ち主がその利用者である", async () => {
    const { executor } = newIdentity();
    const result = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    expect(result.user.googleSubject).toBe("sub-1");
    expect(result.user.displayName).toBe("Alice");
    expect(result.user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // 持ち主の Community が 1 つ。名前は表示名から
    expect(result.community.name).toBe("Alice");
    expect(result.community.ownerUserId).toBe(result.user.userId);
    // 所属は owner
    expect(result.membership).toEqual({
      communityId: result.community.communityId,
      userId: result.user.userId,
      role: "owner",
      createdAt: expect.any(String),
    });

    expect(await getUser(executor, result.user.userId)).toEqual(result.user);
    expect(await getUserByGoogleSubject(executor, "sub-1")).toEqual(result.user);
    expect(await getCommunity(executor, result.community.communityId)).toEqual(result.community);
    expect(await countRows(executor, USERS_TABLE)).toBe(1);
    expect(await countRows(executor, COMMUNITIES_TABLE)).toBe(1);
    expect(await countRows(executor, COMMUNITY_MEMBERSHIPS_TABLE)).toBe(1);
  });

  it("Community の名前は communityName で上書きできる", async () => {
    const { executor } = newIdentity();
    const result = await registerLogin(executor, {
      googleSubject: "sub-1",
      displayName: "Alice",
      communityName: "アリスのサークル",
    });
    expect(result.community.name).toBe("アリスのサークル");
  });

  it("同じ Google subject を 2 回登録しても、利用者と Community は 1 つずつしか増えない（冪等）", async () => {
    const { executor } = newIdentity();
    const first = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const second = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    // 2 回目は既存の行をそのまま返す（ID は増えない）
    expect(second.user).toEqual(first.user);
    expect(second.community).toEqual(first.community);
    expect(second.membership).toEqual(first.membership);
    expect(await countRows(executor, USERS_TABLE)).toBe(1);
    expect(await countRows(executor, COMMUNITIES_TABLE)).toBe(1);
    expect(await countRows(executor, COMMUNITY_MEMBERSHIPS_TABLE)).toBe(1);
  });

  it("同じ利用者の 2 回目のログインで、表示名を変えても既存の行を書き換えない", async () => {
    const { executor } = newIdentity();
    const first = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const second = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice Cooper" });

    expect(second.user).toEqual(first.user);
    expect(await countRows(executor, USERS_TABLE)).toBe(1);
  });

  it("別の Google subject は、別の利用者と Community を作る", async () => {
    const { executor } = newIdentity();
    const a = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const b = await registerLogin(executor, { googleSubject: "sub-2", displayName: "Bob" });

    expect(a.user.userId).not.toBe(b.user.userId);
    expect(a.community.communityId).not.toBe(b.community.communityId);
    expect(await countRows(executor, USERS_TABLE)).toBe(2);
    expect(await countRows(executor, COMMUNITIES_TABLE)).toBe(2);
  });

  it("利用者が所属する Community の一覧を返す", async () => {
    const { executor } = newIdentity();
    const { user, community } = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    expect(await listUserCommunities(executor, user.userId)).toEqual([community]);
    expect(await listUserCommunities(executor, "u-unknown")).toEqual([]);
  });

  it("Community に属する利用者の一覧を返す（role = owner）", async () => {
    const { executor } = newIdentity();
    const { user, community } = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    expect(await listCommunityMembers(executor, community.communityId)).toEqual([
      { communityId: community.communityId, userId: user.userId, role: "owner", createdAt: expect.any(String) },
    ]);
  });
});

describe("インスタンスの持ち主（本物の SQLite）", () => {
  it("Community とインスタンスが登録済みなら、持ち主の行を作る", async () => {
    const { executor } = newIdentity();
    await seedInstance(executor);
    const { community } = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    const owner = await registerInstanceOwner(executor, { instanceId: INSTANCE_1.instanceId, communityId: community.communityId });
    expect(owner).toEqual({
      instanceId: INSTANCE_1.instanceId,
      communityId: community.communityId,
      createdAt: expect.any(String),
    });
    expect(await countRows(executor, INSTANCE_OWNERS_TABLE)).toBe(1);
  });

  it("同じ Community の 2 回目は冪等（行を増やさない）", async () => {
    const { executor } = newIdentity();
    await seedInstance(executor);
    const { community } = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const registration = { instanceId: INSTANCE_1.instanceId, communityId: community.communityId };

    const first = await registerInstanceOwner(executor, registration);
    const second = await registerInstanceOwner(executor, registration);

    expect(second).toEqual(first);
    expect(await countRows(executor, INSTANCE_OWNERS_TABLE)).toBe(1);
  });

  it("Community に属するインスタンスの一覧が、他の Community のインスタンスを返さない", async () => {
    const { executor } = newIdentity();
    await seedInstance(executor);
    const a = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const b = await registerLogin(executor, { googleSubject: "sub-2", displayName: "Bob" });
    await registerInstanceOwner(executor, { instanceId: INSTANCE_1.instanceId, communityId: a.community.communityId });

    const owned = await listCommunityInstances(executor, a.community.communityId);
    expect(owned.map((row) => row.instanceId)).toEqual([INSTANCE_1.instanceId]);

    // 他の Community（Bob の）は、Alice のインスタンスを持たない
    expect(await listCommunityInstances(executor, b.community.communityId)).toEqual([]);
    expect(await listCommunityInstances(executor, "c-unknown")).toEqual([]);
  });

  it("未登録の Community を指定すると community_not_found で失敗し、行が入らない", async () => {
    const { executor } = newIdentity();
    await seedInstance(executor);

    await expect(
      registerInstanceOwner(executor, { instanceId: INSTANCE_1.instanceId, communityId: "c-unknown" }),
    ).rejects.toMatchObject({ name: "IdentityError", code: "community_not_found" });
    expect(await countRows(executor, INSTANCE_OWNERS_TABLE)).toBe(0);
  });

  it("未登録のインスタンスを指定すると instance_not_found で失敗し、行が入らない", async () => {
    const { executor } = newIdentity();
    const { community } = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });

    await expect(
      registerInstanceOwner(executor, { instanceId: "inst-unknown", communityId: community.communityId }),
    ).rejects.toMatchObject({ name: "IdentityError", code: "instance_not_found" });
    expect(await countRows(executor, INSTANCE_OWNERS_TABLE)).toBe(0);
  });

  it("既存インスタンスを別の Community へ暗黙に差し替えようとすると owner_conflict で失敗し、行が変わらない", async () => {
    const { executor } = newIdentity();
    await seedInstance(executor);
    const a = await registerLogin(executor, { googleSubject: "sub-1", displayName: "Alice" });
    const b = await registerLogin(executor, { googleSubject: "sub-2", displayName: "Bob" });
    const original = await registerInstanceOwner(executor, {
      instanceId: INSTANCE_1.instanceId,
      communityId: a.community.communityId,
    });

    await expect(
      registerInstanceOwner(executor, { instanceId: INSTANCE_1.instanceId, communityId: b.community.communityId }),
    ).rejects.toMatchObject({ name: "IdentityError", code: "owner_conflict" });

    expect(await listCommunityInstances(executor, a.community.communityId)).toEqual([original]);
    expect(await listCommunityInstances(executor, b.community.communityId)).toEqual([]);
    expect(await countRows(executor, INSTANCE_OWNERS_TABLE)).toBe(1);
  });

  it("値は SQL へ埋め込まず、束縛引数として渡す（引用符を含む ID でも表は壊れない）", async () => {
    const { executor } = newIdentity();
    const hostile = "sub'; DROP TABLE users; --";
    await registerLogin(executor, { googleSubject: hostile, displayName: "Mallory" });

    expect(executor.statements.some((sql) => sql.includes(hostile))).toBe(false);
    const user = await getUserByGoogleSubject(executor, hostile);
    expect(user?.googleSubject).toBe(hostile);
    expect(await countRows(executor, USERS_TABLE)).toBe(1);
  });

  it("実行者が失敗したら、その失敗がそのまま伝播する", async () => {
    const failure = new Error("D1 unavailable");
    const failing: RegistryExecutor = {
      query: async () => {
        throw failure;
      },
      execute: async () => {
        throw failure;
      },
      batch: async () => {
        throw failure;
      },
    };

    await expect(getUser(failing, "u-1")).rejects.toBe(failure);
    await expect(getUserByGoogleSubject(failing, "sub-1")).rejects.toBe(failure);
    await expect(getCommunity(failing, "c-1")).rejects.toBe(failure);
    await expect(listCommunityInstances(failing, "c-1")).rejects.toBe(failure);
    await expect(registerLogin(failing, { googleSubject: "sub-1", displayName: "Alice" })).rejects.toBe(failure);
    await expect(
      registerInstanceOwner(failing, { instanceId: INSTANCE_1.instanceId, communityId: "c-1" }),
    ).rejects.toBe(failure);
  });
});

describe("IdentityError", () => {
  it("失敗はコードで分ける（呼ぶ側が例外の文言に依存しない）", () => {
    const error = new IdentityError("community_not_found", "未登録の Community を指すインスタンスは持たせられない");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("IdentityError");
    expect(error.code).toBe("community_not_found");
  });
});
