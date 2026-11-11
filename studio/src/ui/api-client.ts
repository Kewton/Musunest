// 画面からサーバの口を呼ぶ共通の入口（Issue #869 の目的・6・Issue #870）。
// すべての API の要求に合言葉のヘッダを付ける。合言葉は画面の HTML の meta に置かれたものを使い、
// コードには埋めない（禁止事項）。
//
// 公開と了承の口（Issue #868）もここから呼ぶ。**オリジンは受け取らない**——公開の応答は
// 経路の後半（`/apps/<インスタンス>`）だけを返し、「開いて試す」のオリジンは画面の HTML の meta
// （`studio-staging-origin`）から読む（Issue #870 の目的・7）。
import type {
  AnswersRequest,
  ApprovalRecord,
  BudgetView,
  ConfirmOutcome,
  JobView,
  PublishRecord,
} from "../shared/api";

export const TOKEN_HEADER = "x-studio-token";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** 同じ origin のときは空。試験では差し替える */
  readonly baseUrl?: string;
  /** 合言葉の読み出し。既定は画面の meta */
  readonly token?: () => string;
  readonly fetchImpl?: FetchLike;
}

/** 100 以上 400 未満の応答の本文を返す。それ以外はコードと文を持つ誤りにする */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiClient {
  getBudget(): Promise<BudgetView>;
  listJobs(): Promise<readonly JobView[]>;
  startJob(request: string): Promise<JobView>;
  getJob(id: string): Promise<JobView>;
  answerQuestions(id: string, answers: AnswersRequest): Promise<JobView>;
  confirmJob(id: string, outcome: ConfirmOutcome): Promise<JobView>;
  cancelJob(id: string): Promise<JobView>;
  /** partial の結果に了承を記録する。画面が見せた SHA をそのまま送る */
  approveJob(id: string, manifestSha256: string): Promise<ApprovalRecord>;
  /** 結果を staging のインスタンスへ公開する。成功・失敗のどちらも 200 で返る */
  publishJob(id: string): Promise<PublishRecord>;
}

const ERROR_HINTS: Record<string, string> = {
  budget: "今日の費用の上限に達しました。明日また試すか、1 回の上限を見直してください。",
  busy: "いま別の依頼を作っています。先に終わるのを待ってください。",
  "stale-revision": "質問が新しくなっています。画面を読み込み直して、もう一度答えてください。",
  "free-text-length": "自由入力が 500 字を超えています。短くしてください。",
  "empty-request": "依頼を書いてください。",
  "request-too-long": "依頼が長すぎます。4,000 字までにしてください。",
  "not-awaiting-answer": "質問の受付が終わっています。状態を読み込み直してください。",
  "not-awaiting-confirm": "確認の受付が終わっています。状態を読み込み直してください。",
  "unknown-question": "質問が新しくなっています。画面を読み込み直してください。",
  "unknown-choice": "選べない選択肢です。画面を読み込み直してください。",
  "not-ready": "まだ結果が出ていません。作成が終わってから公開してください。",
  "not-partial": "この結果は了承の要らないものです。そのまま公開してください。",
  "nothing-to-publish": "作れなかった結果は公開できません。依頼を直してやり直してください。",
  "already-published": "このジョブは公開済みです。",
  "approval-required": "partial の結果は、了承してから公開してください。",
  "approval-sha-mismatch": "画面の SHA がいまの納品物と違います。画面を読み込み直してください。",
  "approval-stale": "了承の SHA がいまの納品物と違います。画面を読み込み直してください。",
  "approval-invalid": "了承の記録を読めませんでした。画面を読み込み直してください。",
  "manifest-unreadable": "納品物を読めませんでした。もう一度作成してください。",
  "summary-invalid": "結果の要約を読めませんでした。もう一度作成してください。",
  "summary-unreadable": "結果の要約を読めませんでした。もう一度作成してください。",
  "production-account": "本番のアカウントへは公開しません。手元の環境を確かめてください。",
  "publish-unavailable": "公開の口が用意されていません。工房の起動を確かめてください。",
};

/** 利用者に出す文。直し方が分かるものを先に返す */
export function messageForApiError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return ERROR_HINTS[error.code] ?? error.message;
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return "通信に失敗しました。少し待ってから試してください。";
}

const tokenFromDocument = (): string => {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? "";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorFromResponse = async (response: Response): Promise<ApiRequestError> => {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = isRecord(body) && typeof body.error === "string" ? body.error : "http";
  const message =
    isRecord(body) && typeof body.message === "string"
      ? body.message
      : `要求に失敗しました（${response.status}）`;
  return new ApiRequestError(response.status, code, message);
};

const jobPath = (id: string): string => `/api/jobs/${encodeURIComponent(id)}`;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const readToken = options.token ?? tokenFromDocument;
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {
      accept: "application/json",
      [TOKEN_HEADER]: readToken(),
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await doFetch(`${baseUrl}${path}`, init);
    if (!response.ok) throw await errorFromResponse(response);
    return (await response.json()) as T;
  };

  return {
    getBudget: () => request<BudgetView>("GET", "/api/budget"),
    listJobs: async () => {
      const body = await request<{ jobs: readonly JobView[] }>("GET", "/api/jobs");
      return body.jobs;
    },
    startJob: (requestText) => request<JobView>("POST", "/api/jobs", { request: requestText }),
    getJob: (id) => request<JobView>("GET", jobPath(id)),
    answerQuestions: (id, answers) => request<JobView>("POST", `${jobPath(id)}/answers`, answers),
    confirmJob: (id, outcome) => request<JobView>("POST", `${jobPath(id)}/confirm`, { outcome }),
    cancelJob: (id) => request<JobView>("POST", `${jobPath(id)}/cancel`),
    approveJob: (id, manifestSha256) =>
      request<ApprovalRecord>("POST", `${jobPath(id)}/approve`, { manifestSha256 }),
    publishJob: (id) => request<PublishRecord>("POST", `${jobPath(id)}/publish`),
  };
}

/** 画面の既定の口。合言葉は要求のたびに meta から読む */
export const defaultApiClient: ApiClient = createApiClient();
