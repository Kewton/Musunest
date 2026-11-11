// `/api/jobs` と `/api/budget` の口（Issue #866 の目的・7）。短い間隔の問い合わせだけを使い、
// WebSocket・Server-Sent Events は使わない（禁止事項）。
//
// 守りは http.ts と同じ（Host・合言葉・Origin）。既存の `GET /api/health` と静的ファイルは
// このモジュールの外（main.ts の合成）がそのまま扱う。
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnswersRequest, ConfirmOutcome, JobView, SubmittedAnswer } from "./runner.js";
import { guardRequest, pathname } from "./guard.js";
import { ApiError, type Jobs } from "./jobs.js";
import type { PublishJob, StudioPublisher } from "./publish.js";
import { UserWordingError } from "./view.js";

/** 本文の上限（依頼文・答えは小さいので、壊れた入力を読まないための線） */
const MAX_BODY_BYTES = 64 * 1024;

/** `/api/jobs…` と `/api/budget` か */
export function isApiPath(path: string): boolean {
  return path === "/api/jobs" || path.startsWith("/api/jobs/") || path === "/api/budget";
}

export interface ApiHandlerOptions {
  readonly jobs: Jobs;
  readonly token: string;
  readonly port: number;
  /** 公開の口（設定されていれば `approve`・`publish` を使える） */
  readonly publisher?: StudioPublisher;
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const badRequest = (message: string): ApiError => new ApiError(400, "invalid-request", message);

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, "body-too-large", "本文が大きすぎる"));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => reject(error));
  });

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const text = await readBody(request);
  if (text.trim() === "") throw badRequest("本文が空である");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("本文が JSON ではない");
  }
};

const parseStart = (value: unknown): string => {
  if (!isRecord(value) || typeof value.request !== "string") throw badRequest("request が文字列ではない");
  return value.request;
};

const parseAnswer = (value: unknown): SubmittedAnswer => {
  if (!isRecord(value) || typeof value.questionId !== "string") {
    throw badRequest("答えに questionId が無い");
  }
  if (value.choiceId !== undefined && typeof value.choiceId !== "string") {
    throw badRequest("choiceId が文字列ではない");
  }
  if (value.freeText !== undefined && typeof value.freeText !== "string") {
    throw badRequest("freeText が文字列ではない");
  }
  return {
    questionId: value.questionId,
    ...(value.choiceId === undefined ? {} : { choiceId: value.choiceId }),
    ...(value.freeText === undefined ? {} : { freeText: value.freeText }),
  };
};

const parseAnswers = (value: unknown): AnswersRequest => {
  if (!isRecord(value) || typeof value.revision !== "number") {
    throw badRequest("revision が数値ではない");
  }
  if (value.kind === "all-recommended") {
    return { kind: "all-recommended", revision: value.revision };
  }
  if (value.kind !== "answers" || !Array.isArray(value.answers)) {
    throw badRequest("kind が answers / all-recommended ではない");
  }
  return { kind: "answers", revision: value.revision, answers: value.answers.map(parseAnswer) };
};

const parseConfirm = (value: unknown): ConfirmOutcome => {
  if (!isRecord(value) || (value.outcome !== "build" && value.outcome !== "stop")) {
    throw badRequest("outcome が build / stop ではない");
  }
  return value.outcome;
};

/** 了承の要求から、画面が見せた manifest の SHA-256 を読む。 */
const parseApprovalSha = (value: unknown): string => {
  if (!isRecord(value)) throw badRequest("本文が写像ではない");
  const raw = value["manifestSha256"] ?? value["manifest_sha256"] ?? value["sha256"];
  if (typeof raw !== "string") throw badRequest("manifestSha256 が文字列ではない");
  return raw;
};

/** 公開の口へ渡す、ジョブの最小の姿。 */
const publishJobOf = (job: JobView): PublishJob => ({
  id: job.id,
  state: job.state,
  verdict: job.result?.verdict ?? null,
});

const requirePublisher = (options: ApiHandlerOptions): StudioPublisher => {
  if (options.publisher === undefined) {
    throw new ApiError(500, "publish-unavailable", "公開の口が設定されていない");
  }
  return options.publisher;
};

const decodeId = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw badRequest("ジョブの ID が壊れている");
  }
};

const JOB_PATH = /^\/api\/jobs(?:\/([^/]+))?(?:\/(answers|confirm|cancel|approve|publish))?$/;

const route = async (
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  options: ApiHandlerOptions,
): Promise<void> => {
  if (path === "/api/budget") {
    if (method !== "GET") throw new ApiError(405, "method-not-allowed", "GET だけを使える");
    sendJson(response, 200, options.jobs.budget());
    return;
  }

  const match = JOB_PATH.exec(path);
  if (match === null) {
    sendJson(response, 404, { error: "not_found", message: "知らない口である" });
    return;
  }

  const rawId = match[1];
  const action = match[2];

  if (rawId === undefined) {
    if (method === "GET") {
      sendJson(response, 200, { jobs: options.jobs.list() });
      return;
    }
    if (method === "POST") {
      const requestText = parseStart(await readJson(request));
      sendJson(response, 201, options.jobs.start(requestText));
      return;
    }
    throw new ApiError(405, "method-not-allowed", "GET / POST だけを使える");
  }

  const id = decodeId(rawId);

  if (action === undefined) {
    if (method !== "GET") throw new ApiError(405, "method-not-allowed", "GET だけを使える");
    const job = options.jobs.get(id);
    if (job === null) throw new ApiError(404, "not_found", `ジョブが無い: ${id}`);
    sendJson(response, 200, job);
    return;
  }

  if (method !== "POST") throw new ApiError(405, "method-not-allowed", "POST だけを使える");

  if (action === "answers") {
    sendJson(response, 200, options.jobs.answer(id, parseAnswers(await readJson(request))));
    return;
  }
  if (action === "confirm") {
    sendJson(response, 200, options.jobs.confirm(id, parseConfirm(await readJson(request))));
    return;
  }
  if (action === "approve") {
    const job = options.jobs.get(id);
    if (job === null) throw new ApiError(404, "not_found", `ジョブが無い: ${id}`);
    const publisher = requirePublisher(options);
    sendJson(response, 200, await publisher.approve(publishJobOf(job), parseApprovalSha(await readJson(request))));
    return;
  }
  if (action === "publish") {
    const job = options.jobs.get(id);
    if (job === null) throw new ApiError(404, "not_found", `ジョブが無い: ${id}`);
    const publisher = requirePublisher(options);
    sendJson(response, 200, await publisher.publish(publishJobOf(job)));
    return;
  }
  sendJson(response, 200, options.jobs.cancel(id));
};

/**
 * `/api/jobs…` と `/api/budget` を扱う。扱ったら true（呼ぶ側は静的ファイルへ進まない）。
 * Host・合言葉・Origin はここでも確かめる（API の要求は静的ファイルの守りを通らないため）。
 */
export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiHandlerOptions,
): Promise<boolean> {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  const path = pathname(url);
  if (!isApiPath(path)) return false;

  const failure = guardRequest(method, url, request.headers, { token: options.token, port: options.port });
  if (failure === 421) {
    response.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("Misdirected Request");
    return true;
  }
  if (failure === 403) {
    sendJson(response, 403, { error: "forbidden", message: "合言葉か Origin が合わない" });
    return true;
  }

  try {
    await route(request, response, method, path, options);
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(response, error.status, { error: error.code, message: error.message });
      return true;
    }
    if (error instanceof UserWordingError) {
      sendJson(response, 500, { error: "wording", message: "表示の言葉に宣言の用語が混ざっている" });
      return true;
    }
    sendJson(response, 500, { error: "internal", message: "サーバの内部で失敗した" });
  }
  return true;
}
