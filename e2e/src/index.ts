// @musunest/e2e — staging の見本の採点（M1.2。Issue #110）。
//
// M0 の頃は貫通スモーク（infra/scripts/smoke.ts）だけだった。M1.2 で、host と同じ型付きクライアント
// （@musunest/sdk）を使い、staging の spec・view・action の経路を通る採点の runner を持つ。
export const PACKAGE_NAME = "@musunest/e2e" as const;

export * from "./warikan.js";
// dashboard の見本も warikan と同じ名前（SAMPLE_FILE・SAMPLE_DIRECTORY・MEMBER_NAMES）を持つので、
// 衝突しないよう接頭辞を付けて出す
export {
  ACTIVITIES_VIEW as DASHBOARD_ACTIVITIES_VIEW,
  DASHBOARD_VIEW,
  EXPECTED_ACTIVITIES as DASHBOARD_EXPECTED_ACTIVITIES,
  EXPECTED_BY_KIND as DASHBOARD_EXPECTED_BY_KIND,
  EXPECTED_KINDS as DASHBOARD_KINDS,
  EXPECTED_RANKING as DASHBOARD_EXPECTED_RANKING,
  MEMBER_NAMES as DASHBOARD_MEMBER_NAMES,
  RANKING_NAME as DASHBOARD_RANKING_NAME,
  SAMPLE_DIRECTORY as DASHBOARD_SAMPLE_DIRECTORY,
  SAMPLE_FILE as DASHBOARD_SAMPLE_FILE,
  SCOPE_NAMES as DASHBOARD_SCOPE_NAMES,
  runDashboard,
  type DashboardDeps,
  type DashboardIo,
  type DashboardResult,
} from "./dashboard.js";
// task-board の見本は warikan と同じ名前（SAMPLE_FILE・SAMPLE_DIRECTORY・MEMBER_NAMES）を持つので、
// 衝突しないよう接頭辞を付けて出す
export {
  BOARD_VIEW as TASK_BOARD_VIEW,
  EXPECTED_COLUMNS as TASK_BOARD_COLUMNS,
  EXPECTED_OPEN_TASKS as TASK_BOARD_OPEN_TASKS,
  EXPECTED_TASKS as TASK_BOARD_TASKS,
  HIGHLIGHT_NAME as TASK_BOARD_HIGHLIGHT,
  LIST_VIEW as TASK_BOARD_LIST_VIEW,
  MEMBERS_VIEW as TASK_BOARD_MEMBERS_VIEW,
  MEMBER_NAMES as TASK_BOARD_MEMBER_NAMES,
  SAMPLE_DIRECTORY as TASK_BOARD_SAMPLE_DIRECTORY,
  SAMPLE_FILE as TASK_BOARD_SAMPLE_FILE,
  TASK_TO_FINISH as TASK_BOARD_TASK_TO_FINISH,
  runTaskBoard,
  type TaskBoardDeps,
  type TaskBoardIo,
  type TaskBoardResult,
} from "./task-board.js";
export {
  BASE_URL_ENV,
  CREDENTIAL_ENVS,
  E2eError,
  EXIT_NG,
  EXIT_OK,
  INSTANCE_ENV,
  INSTANCE_PATTERN,
  REDACTED,
  SAMPLE_ENV,
  SAMPLES,
  instanceOf,
  originOf,
  redact,
  runCli,
  sampleOf,
  type CliIo,
  type SampleName,
} from "./cli.js";
