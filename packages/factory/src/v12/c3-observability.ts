// Diagnostic output only; no response rewriting, acceptance, budget, or retry decisions.
import { sha256Hex } from "@musunest/spec-engine";
import type { BundleArtifact } from "../bundle.js";
import type { CallAttemptObserver, CallAttemptEnd } from "../call.js";
import { incompleteReason, responseStatus, type CallDiagnosticDetail } from "../call-diagnostics.js";
import { serializeJson, type Problem, type StageFailure } from "../stages/prompt.js";

type Attempt = { logical_attempt: number; real_attempt: number; ledger_attempt: number | null; terminal: string | null;
  error_kind?: string; malformed_kind?: string; late_responses: number } & CallDiagnosticDetail;
type Rejection = { attempt: number; problems: readonly { field: string; message: string }[]; text: string | null };
type Bundle = { round: number; bundle: number; target_count: number; terminal: string | null; attempts: Attempt[]; rejections: Rejection[];
  incomplete_reason?: string; response_status?: string; http_status?: number };
export class C3Observability {
  readonly #bundles: Bundle[] = [];
  bundle(round: number, bundle: number, targetCount: number) {
    const row: Bundle = { round, bundle, target_count: targetCount, terminal: null, attempts: [], rejections: [] };
    this.#bundles.push(row);
    let logical = 0;
    const observer: CallAttemptObserver = {
      beginCall: () => { logical++; },
      beginAttempt: () => {
        const attempt: Attempt = { logical_attempt: logical, real_attempt: row.attempts.length + 1, ledger_attempt: null, terminal: null, late_responses: 0 };
        row.attempts.push(attempt);
        return {
          ledger: (id) => { attempt.ledger_attempt = id; },
          detail: (detail) => { Object.assign(attempt, detail); },
          settle: (end: CallAttemptEnd) => {
            if (attempt.terminal !== null) return;
            attempt.terminal = end.kind;
            if (end.kind === "error") { attempt.error_kind = end.errorKind; if (end.malformedKind !== undefined) attempt.malformed_kind = end.malformedKind; }
          },
          late: () => { attempt.late_responses++; },
        };
      },
    };
    return {
      observer,
      reject: (attempt: number, output: unknown, problems: readonly Problem[]): void => {
        let text: string | null; try { text = serializeJson(output); } catch { text = null; }
        row.rejections.push({ attempt, text, problems: problems.map(({ field, message }) => ({ field, message })) });
      },
      finish: (failure?: StageFailure): void => {
        row.terminal = failure?.kind ?? "ok";
        if (failure?.kind === "incomplete") { row.incomplete_reason = incompleteReason(failure.reason); row.response_status = responseStatus(failure.responseStatus); }
        const last = row.attempts.at(-1); if (last?.http_status !== undefined) row.http_status = last.http_status;
      },
      thrown: (): void => { row.terminal = "thrown"; },
    };
  }
  async files(): Promise<readonly BundleArtifact[]> {
    if (this.#bundles.length === 0) return [];
    const bundles = await Promise.all([...this.#bundles].sort((a, b) => a.round - b.round || a.bundle - b.bundle).map(async ({ rejections, ...row }) => ({
      ...row, rejections: await Promise.all(rejections.map(async ({ text, ...rejection }) => ({ ...rejection, candidate_sha256: text === null ? null : await sha256Hex(text) }))),
    })));
    return [{ path: "diagnostics/semantic-check-observability.json", text: JSON.stringify({ schema: "factory/semantic-check-observability/v1", bundles }, null, 2) + "\n" }];
  }
}
