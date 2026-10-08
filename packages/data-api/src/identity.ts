// 利用者の識別（M2.1。Issue #260）。
//
// data-api が引き受けるのは 2 つである。
//   registerIdentity … gateway だけが呼ぶ登録の入口（`/identity/login`。**`/api` の外**）。
//                      Google OIDC の subject と表示名を受け取り、利用者と、持ち主の Community を登録する
//   listMyInstances  … ログインした利用者のアプリの一覧（`/api/me/instances`。**`/api` の中**）。
//                      識別ヘッダ（`IDENTITY_HEADER`）が指す利用者の Community のインスタンスだけを返す
//
// 依存は**引数で受け取る**（I/O の実体をここに置かない）——登録（D1）は control-plane の
// `src/identity.ts` を adapter が包んで渡す（`IdentityStore`）。判定はここ（唯一の権限強制点）が持ち、
// `Request` も Cloudflare の型もここには出てこない（`src/index.test.ts` の境界の走査が確かめる）。
//
// 決めたこと:
//   - 識別ヘッダが無い（`null`・空）一覧の要求は **401 `UNAUTHENTICATED`**。**D1 を読まない**
//     ——誰のものかを決められないので、登録を読む意味が無い（`IdentityStore` を一度も呼ばない）
//   - 一覧は**その利用者の Community のインスタンスだけ**を返す。他の Community のものは混ぜない
//     （唯一の権限強制点として、ここで絞る）

import { API_READ_STATUS } from "@musunest/appspec-schema";
import type {
  ApiInstanceSummary,
  ApiInstancesBody,
  ApiLoginBody,
  ApiLoginRegistration,
} from "@musunest/appspec-schema";
import type {
  CommunityRecord,
  InstanceOwnerRecord,
  LoginRegistration,
  LoginResult,
} from "@musunest/control-plane";
import type { ApiFailureResult, ApiResult } from "./app-api.js";

// ── 依存（I/O の実体は adapter が渡す） ──────────────────────────────

/** 利用者と Community の登録（D1）。control-plane の `src/identity.ts` が実体 */
export interface IdentityStore {
  /** ログインを登録する。**同じ Google subject の 2 回目は冪等**（既存の行を返す） */
  register(registration: LoginRegistration): Promise<LoginResult>;
  /** 利用者が所属する Community の一覧 */
  listCommunities(userId: string): Promise<readonly CommunityRecord[]>;
  /** Community が持つインスタンスの一覧。**他の Community のものは返らない** */
  listInstances(communityId: string): Promise<readonly InstanceOwnerRecord[]>;
}

export interface IdentityDeps {
  readonly identity: IdentityStore;
}

const ok = <Body>(body: Body): ApiResult<Body> => ({ ok: true, status: API_READ_STATUS, body });

/** 識別ヘッダが無い一覧の要求（M2.1）。**D1 を読まずに**断る */
const unauthenticated = (): ApiFailureResult => ({
  ok: false,
  failure: { error: "UNAUTHENTICATED", fields: [], validations: [] },
});

// ── 公開の 2 操作 ───────────────────────────────────────────────

/**
 * `POST /identity/login`。**gateway だけが呼ぶ**（Service Binding 越し。`/api` の外）。
 * Google OIDC で確かめた subject と表示名を受け取り、初めてなら利用者・Community・所属を作る。
 * **同じ subject の 2 回目は冪等**である（利用者も Community も増やさず、既存の行を返す）。
 */
export async function registerIdentity(
  deps: IdentityDeps,
  registration: ApiLoginRegistration,
): Promise<ApiResult<ApiLoginBody>> {
  const result = await deps.identity.register(registration);
  return ok({ userId: result.user.userId, communityId: result.community.communityId });
}

/**
 * `GET /api/me/instances`。**識別ヘッダ（`IDENTITY_HEADER`）が指す利用者**の Community の
 * インスタンスだけを返す。ヘッダが無ければ 401 `UNAUTHENTICATED` で、**D1 を読まない**。
 *
 * 並びは「所属の順 → その Community の持ち物の順」である（今の表は並び順を持たないので、
 * 決まった順とは約束しない。読み手は集合として扱う）。
 */
export async function listMyInstances(
  deps: IdentityDeps,
  userId: string | null,
): Promise<ApiResult<ApiInstancesBody>> {
  if (userId === null || userId === "") return unauthenticated();
  const instances: ApiInstanceSummary[] = [];
  for (const community of await deps.identity.listCommunities(userId)) {
    for (const owner of await deps.identity.listInstances(community.communityId)) {
      instances.push({ instanceId: owner.instanceId });
    }
  }
  return ok({ instances });
}
