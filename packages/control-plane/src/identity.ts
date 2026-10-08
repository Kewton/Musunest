// identity（利用者・Community・所属・インスタンスの持ち主）の読み書き。**SQL と引数の束縛、
// 行の読み取りをここに集める。**（#259）
//
// 表の正本は migrations/0003_identity.sql。実行は注入された RegistryExecutor が行う
// （型は src/contract.ts。Cloudflare の型は使わない）。
//
// 規律（registry.ts と同じ。runbook §4.3）：
//   - SQL へ値や表名を埋め込まない。表名は contract.ts の定数、値は必ず束縛引数
//   - 読み取りは列名を書く（SELECT * を使わない）。知らない列が増えても落ちないため
//   - 書き込みは列名を書く。既存行は書き換えない（ON CONFLICT ... DO NOTHING）
//   - 「読む→書く」を1回の batch にまとめる。D1 の batch は1トランザクションなので、途中の状態を読まない
//   - 未登録の Community・インスタンスを指す行は、読み書きの側（INSERT ... WHERE EXISTS）で拒否する
import {
  APP_INSTANCES_TABLE,
  COMMUNITIES_TABLE,
  COMMUNITY_MEMBERSHIPS_TABLE,
  IdentityError,
  INSTANCE_OWNERS_TABLE,
  USERS_TABLE,
  type CommunityRecord,
  type InstanceOwnerRecord,
  type InstanceOwnerRegistration,
  type LoginRegistration,
  type LoginResult,
  type MembershipRecord,
  type MembershipRole,
  type RegistryExecutor,
  type SqlRow,
  type UserRecord,
} from "./contract.js";

const USER_COLUMNS = "user_id, google_subject, display_name, created_at";
const COMMUNITY_COLUMNS = "community_id, name, owner_user_id, created_at";
const MEMBERSHIP_COLUMNS = "community_id, user_id, role, created_at";
const INSTANCE_OWNER_COLUMNS = "instance_id, community_id, created_at";

const SELECT_USER = `SELECT ${USER_COLUMNS} FROM ${USERS_TABLE} WHERE user_id = ?`;
const SELECT_USER_BY_SUBJECT = `SELECT ${USER_COLUMNS} FROM ${USERS_TABLE} WHERE google_subject = ?`;
const SELECT_COMMUNITY = `SELECT ${COMMUNITY_COLUMNS} FROM ${COMMUNITIES_TABLE} WHERE community_id = ?`;
const SELECT_COMMUNITY_BY_SUBJECT =
  `SELECT c.community_id, c.name, c.owner_user_id, c.created_at` +
  ` FROM ${COMMUNITIES_TABLE} c JOIN ${USERS_TABLE} u ON u.user_id = c.owner_user_id` +
  ` WHERE u.google_subject = ?`;
const SELECT_COMMUNITIES_OF_USER =
  `SELECT c.community_id, c.name, c.owner_user_id, c.created_at` +
  ` FROM ${COMMUNITY_MEMBERSHIPS_TABLE} m JOIN ${COMMUNITIES_TABLE} c ON c.community_id = m.community_id` +
  ` WHERE m.user_id = ?`;
const SELECT_MEMBERSHIP_BY_SUBJECT =
  `SELECT m.community_id, m.user_id, m.role, m.created_at` +
  ` FROM ${COMMUNITY_MEMBERSHIPS_TABLE} m` +
  ` JOIN ${COMMUNITIES_TABLE} c ON c.community_id = m.community_id` +
  ` JOIN ${USERS_TABLE} u ON u.user_id = c.owner_user_id` +
  ` WHERE u.google_subject = ? AND m.user_id = c.owner_user_id`;
const SELECT_MEMBERS_OF_COMMUNITY = `SELECT ${MEMBERSHIP_COLUMNS} FROM ${COMMUNITY_MEMBERSHIPS_TABLE} WHERE community_id = ?`;
const SELECT_INSTANCE_OWNER = `SELECT ${INSTANCE_OWNER_COLUMNS} FROM ${INSTANCE_OWNERS_TABLE} WHERE instance_id = ?`;
const SELECT_INSTANCES_OF_COMMUNITY = `SELECT ${INSTANCE_OWNER_COLUMNS} FROM ${INSTANCE_OWNERS_TABLE} WHERE community_id = ?`;
const SELECT_INSTANCE = `SELECT instance_id FROM ${APP_INSTANCES_TABLE} WHERE instance_id = ?`;

const toUserRecord = (row: SqlRow): UserRecord => ({
  userId: row["user_id"] as string,
  googleSubject: row["google_subject"] as string,
  displayName: row["display_name"] as string,
  createdAt: row["created_at"] as string,
});

const toCommunityRecord = (row: SqlRow): CommunityRecord => ({
  communityId: row["community_id"] as string,
  name: row["name"] as string,
  ownerUserId: row["owner_user_id"] as string,
  createdAt: row["created_at"] as string,
});

const toMembershipRecord = (row: SqlRow): MembershipRecord => ({
  communityId: row["community_id"] as string,
  userId: row["user_id"] as string,
  role: row["role"] as MembershipRole,
  createdAt: row["created_at"] as string,
});

const toInstanceOwnerRecord = (row: SqlRow): InstanceOwnerRecord => ({
  instanceId: row["instance_id"] as string,
  communityId: row["community_id"] as string,
  createdAt: row["created_at"] as string,
});

/** 利用者 ID で利用者を読む。未登録は null（例外にしない）。 */
export async function getUser(executor: RegistryExecutor, userId: string): Promise<UserRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_USER, params: [userId] });
  const row = rows[0];
  return row === undefined ? null : toUserRecord(row);
}

/** Google OIDC の subject で利用者を読む。未登録は null。 */
export async function getUserByGoogleSubject(
  executor: RegistryExecutor,
  googleSubject: string,
): Promise<UserRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_USER_BY_SUBJECT, params: [googleSubject] });
  const row = rows[0];
  return row === undefined ? null : toUserRecord(row);
}

/** Community ID で Community を読む。未登録は null。 */
export async function getCommunity(executor: RegistryExecutor, communityId: string): Promise<CommunityRecord | null> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_COMMUNITY, params: [communityId] });
  const row = rows[0];
  return row === undefined ? null : toCommunityRecord(row);
}

/** 利用者が所属する Community の一覧（所属の行から引く）。 */
export async function listUserCommunities(
  executor: RegistryExecutor,
  userId: string,
): Promise<readonly CommunityRecord[]> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_COMMUNITIES_OF_USER, params: [userId] });
  return rows.map(toCommunityRecord);
}

/** Community に属する利用者の一覧（所属の行）。 */
export async function listCommunityMembers(
  executor: RegistryExecutor,
  communityId: string,
): Promise<readonly MembershipRecord[]> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_MEMBERS_OF_COMMUNITY, params: [communityId] });
  return rows.map(toMembershipRecord);
}

/** Community に属するインスタンスの一覧（持ち主の行）。**他の Community のものは返さない。** */
export async function listCommunityInstances(
  executor: RegistryExecutor,
  communityId: string,
): Promise<readonly InstanceOwnerRecord[]> {
  const rows = await executor.query<SqlRow>({ sql: SELECT_INSTANCES_OF_COMMUNITY, params: [communityId] });
  return rows.map(toInstanceOwnerRecord);
}

/**
 * ログインを登録する。**同じ Google subject の 2 回目は冪等**——利用者も Community も増やさず、
 * 既存の行を返す。**初めてのときだけ**、その利用者が持ち主の Community を 1 つ作り（名前は表示名。
 * `communityName` があればそれ）、所属（role = `owner`）も 1 行作る。
 *
 * 「読む→書く」は 1 回の batch にまとめる（D1 では1トランザクション）。途中まで書いて止まらない。
 */
export async function registerLogin(
  executor: RegistryExecutor,
  registration: LoginRegistration,
): Promise<LoginResult> {
  const { googleSubject, displayName } = registration;
  const communityName = registration.communityName ?? displayName;
  // ID は呼ぶ側に持たせない（gateway は OIDC だけを渡す）。2 回目の値は使われない（DO NOTHING）
  const userId = crypto.randomUUID();
  const communityId = crypto.randomUUID();

  const results = await executor.batch([
    {
      sql:
        `INSERT INTO ${USERS_TABLE} (user_id, google_subject, display_name) VALUES (?, ?, ?)` +
        ` ON CONFLICT(google_subject) DO NOTHING`,
      params: [userId, googleSubject, displayName],
    },
    {
      // その利用者がまだ 1 つも Community を持っていないときだけ作る（M2.1 は 1 人 1 つ）
      sql:
        `INSERT INTO ${COMMUNITIES_TABLE} (community_id, name, owner_user_id)` +
        ` SELECT ?, ?, u.user_id FROM ${USERS_TABLE} u` +
        ` WHERE u.google_subject = ?` +
        ` AND NOT EXISTS (SELECT 1 FROM ${COMMUNITIES_TABLE} c WHERE c.owner_user_id = u.user_id)` +
        ` ON CONFLICT(community_id) DO NOTHING`,
      params: [communityId, communityName, googleSubject],
    },
    {
      // 持ち主の所属。無ければ作る（2 回目は DO NOTHING）
      sql:
        `INSERT INTO ${COMMUNITY_MEMBERSHIPS_TABLE} (community_id, user_id, role)` +
        ` SELECT c.community_id, c.owner_user_id, 'owner' FROM ${COMMUNITIES_TABLE} c` +
        ` JOIN ${USERS_TABLE} u ON u.user_id = c.owner_user_id` +
        ` WHERE u.google_subject = ?` +
        ` ON CONFLICT(community_id, user_id) DO NOTHING`,
      params: [googleSubject],
    },
    { sql: SELECT_USER_BY_SUBJECT, params: [googleSubject] },
    { sql: SELECT_COMMUNITY_BY_SUBJECT, params: [googleSubject] },
    { sql: SELECT_MEMBERSHIP_BY_SUBJECT, params: [googleSubject] },
  ]);

  const userRow = results[3]?.rows[0];
  const communityRow = results[4]?.rows[0];
  const membershipRow = results[5]?.rows[0];
  if (userRow === undefined || communityRow === undefined || membershipRow === undefined) {
    throw new IdentityError("login_not_registered", `${USERS_TABLE} / ${COMMUNITIES_TABLE} へ登録した行を読めなかった`);
  }
  return {
    user: toUserRecord(userRow),
    community: toCommunityRecord(communityRow),
    membership: toMembershipRecord(membershipRow),
  };
}

/**
 * インスタンスを Community の持ち物として登録する。**同じ Community の 2 回目は冪等**（既存の行を返す）。
 * 未登録の Community なら `community_not_found`、未登録のインスタンスなら `instance_not_found` を投げ、行を入れない。
 * 既存インスタンスの持ち主を別の Community へ暗黙に差し替えようとすると `owner_conflict` を投げ、行は変えない。
 * **はっきり移す道は、この Issue では用意しない**（持ち主の移転は M2.3 以降）。
 */
export async function registerInstanceOwner(
  executor: RegistryExecutor,
  registration: InstanceOwnerRegistration,
): Promise<InstanceOwnerRecord> {
  const { instanceId, communityId } = registration;
  const results = await executor.batch([
    {
      // Community とインスタンスのどちらも登録済みのときだけ挿入する（未登録を指す行を入れない）。
      // 既存行には触らない（DO NOTHING）
      sql:
        `INSERT INTO ${INSTANCE_OWNERS_TABLE} (instance_id, community_id)` +
        ` SELECT ?, ? WHERE EXISTS (SELECT 1 FROM ${COMMUNITIES_TABLE} WHERE community_id = ?)` +
        ` AND EXISTS (SELECT 1 FROM ${APP_INSTANCES_TABLE} WHERE instance_id = ?)` +
        ` ON CONFLICT(instance_id) DO NOTHING`,
      params: [instanceId, communityId, communityId, instanceId],
    },
    { sql: SELECT_INSTANCE_OWNER, params: [instanceId] },
    { sql: SELECT_COMMUNITY, params: [communityId] },
    { sql: SELECT_INSTANCE, params: [instanceId] },
  ]);

  const ownerRow = results[1]?.rows[0];
  if (ownerRow !== undefined) {
    const record = toInstanceOwnerRecord(ownerRow);
    if (record.communityId !== communityId) {
      throw new IdentityError("owner_conflict", `既存インスタンスの持ち主は暗黙に差し替えない`);
    }
    return record;
  }
  if (results[2]?.rows[0] === undefined) {
    throw new IdentityError("community_not_found", `未登録の Community を指すインスタンスは持たせられない`);
  }
  throw new IdentityError("instance_not_found", `未登録のインスタンスは Community の持ち物にできない`);
}
