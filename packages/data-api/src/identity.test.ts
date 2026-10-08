// 利用者の識別（M2.1。Issue #260）の unit テスト。
//
// 依存はテストの内側で差し替える（FakeIdentity）。これは src/cloudflare.ts の adapter が包む相手と
// **同じインターフェース**なので、ここで確かめた判定は実機（D1）でも同じ順で走る。実機の binding と
// 経路（401 の応答・他の Community のものが混ざらないこと）は src/index.test.ts が見る。
//
// 見るのは3つである。
//   1. 登録（registerIdentity）が、control-plane の登録の結果から userId と communityId を返す
//   2. 識別ヘッダの無い一覧は 401 `UNAUTHENTICATED` で、**D1 を読まない**（IdentityStore を一度も呼ばない）
//   3. 一覧は**その利用者の Community のインスタンスだけ**を返す（他の Community のものは混ぜない）
import { describe, expect, it } from "vitest";
import type {
  CommunityRecord,
  InstanceOwnerRecord,
  LoginRegistration,
  LoginResult,
} from "@musunest/control-plane";
import type { IdentityStore } from "./identity.js";
import { listMyInstances, registerIdentity } from "./identity.js";

const AT = "2026-10-08T00:00:00.000Z";

const community = (communityId: string): CommunityRecord => ({
  communityId,
  name: communityId,
  ownerUserId: `owner-${communityId}`,
  createdAt: AT,
});

const owner = (instanceId: string, communityId: string): InstanceOwnerRecord => ({
  instanceId,
  communityId,
  createdAt: AT,
});

/** 差し替える依存（adapter が包む相手＝control-plane の identity と同じインターフェース） */
class FakeIdentity implements IdentityStore {
  /** 呼ばれた順の記録。**D1 を読まないこと**（呼び出しが 0 件であること）をここで見る */
  readonly calls: string[] = [];
  login: LoginResult = {
    user: { userId: "u-a", googleSubject: "sub-a", displayName: "A", createdAt: AT },
    community: community("c-a"),
    membership: { communityId: "c-a", userId: "u-a", role: "owner", createdAt: AT },
  };
  lastRegistration: LoginRegistration | null = null;
  communities: readonly CommunityRecord[] = [];
  instances: Readonly<Record<string, readonly InstanceOwnerRecord[]>> = {};

  async register(registration: LoginRegistration): Promise<LoginResult> {
    this.calls.push(`register:${registration.googleSubject}`);
    this.lastRegistration = registration;
    return this.login;
  }

  async listCommunities(userId: string): Promise<readonly CommunityRecord[]> {
    this.calls.push(`communities:${userId}`);
    return this.communities;
  }

  async listInstances(communityId: string): Promise<readonly InstanceOwnerRecord[]> {
    this.calls.push(`instances:${communityId}`);
    return this.instances[communityId] ?? [];
  }
}

const deps = (identity: IdentityStore) => ({ identity });

describe("registerIdentity（利用者の登録の入口。Issue #260）", () => {
  it("登録の結果から、利用者 ID と持ち主の Community の ID を返す（200）", async () => {
    const identity = new FakeIdentity();
    const result = await registerIdentity(deps(identity), {
      googleSubject: "sub-a",
      displayName: "A",
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      body: { userId: "u-a", communityId: "c-a" },
    });
    // 渡した登録の内容が、そのまま control-plane の登録へ渡る（communityName は載っているときだけ）
    expect(identity.lastRegistration).toEqual({ googleSubject: "sub-a", displayName: "A" });
  });

  it("communityName を渡せば、そのまま渡す（省略したときは欄そのものを載せない）", async () => {
    const identity = new FakeIdentity();
    await registerIdentity(deps(identity), {
      googleSubject: "sub-a",
      displayName: "A",
      communityName: "わたしたち",
    });

    expect(identity.lastRegistration).toEqual({
      googleSubject: "sub-a",
      displayName: "A",
      communityName: "わたしたち",
    });
  });
});

describe("listMyInstances（自分のアプリの一覧。Issue #260）", () => {
  it("識別ヘッダが無ければ 401 UNAUTHENTICATED で、**D1 を読まない**", async () => {
    const identity = new FakeIdentity();

    for (const userId of [null, ""]) {
      const result = await listMyInstances(deps(identity), userId);
      expect(result).toEqual({
        ok: false,
        failure: { error: "UNAUTHENTICATED", fields: [], validations: [] },
      });
    }
    // 誰のものかを決められないので、登録を一度も読まない
    expect(identity.calls).toEqual([]);
  });

  it("自分の Community のインスタンスだけを返す（他の Community のものは混ぜない）", async () => {
    const identity = new FakeIdentity();
    // A は community-a の持ち主。B の community-b は A の所属ではない
    identity.communities = [community("community-a")];
    identity.instances = {
      "community-a": [owner("inst-a1", "community-a"), owner("inst-a2", "community-a")],
      "community-b": [owner("inst-b1", "community-b")],
    };

    const result = await listMyInstances(deps(identity), "u-a");
    expect(result).toEqual({
      ok: true,
      status: 200,
      body: {
        instances: [{ instanceId: "inst-a1" }, { instanceId: "inst-a2" }],
      },
    });
    // 読んだのは A の Community と、その持ち物だけである（B の Community は一度も読まない）
    expect(identity.calls).toEqual(["communities:u-a", "instances:community-a"]);
  });

  it("所属が無ければ、空の並びを返す（成功に見せかけた失敗にしない）", async () => {
    const identity = new FakeIdentity();
    identity.communities = [];
    identity.instances = { "community-b": [owner("inst-b1", "community-b")] };

    const result = await listMyInstances(deps(identity), "u-nobody");
    expect(result).toEqual({ ok: true, status: 200, body: { instances: [] } });
    expect(identity.calls).toEqual(["communities:u-nobody"]);
  });
});
