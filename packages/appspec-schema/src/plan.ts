// **確定した仕様（v1）**——Plan（要件を固める役）と Build（宣言を書く役）のあいだの契約（設計の正本は
// workspace/mvp/m1/agent/04-plan-agent.md §4。Issue #331）。
//
// 型は appspec-schema の納品物の入口に置く。工場（CommandAgent と、プロダクト内の factory）は control-plane に
// 依存しないので、両方が使う形はここに 1 つだけ置く（02-architecture.md §3.1）。**このパッケージは何にも
// 依存しない**——ここは純粋な TypeScript であり、Cloudflare 固有の API も Node 固有の API も使わない
// （SHA は `crypto.subtle` で計算するので Node でも Worker でも動く）。
//
// **会話の記録（答えの全文・LLM の応答）はこの型に入れない**（同 §4・S-8）。入るのは、原文・質問・答えに
// ID を付けたものと、それを整理した要件の一覧だけである。
//
// ここに置くのは 3 つである：
//   1. wire の型——`artifacts/plan.json` の欄の名前のまま（snake_case。delivery.ts と同じ作法）
//   2. 検査（`checkPlan`）——コードが確かめる 4 つのこと：
//        ・ID の参照がすべて実在する
//        ・`accepted_unwritable` の部分 ID が `parts` にあり「了承して除く」になっている
//        ・解決には根拠（答えの ID／決めたことの ID／既定で決めた理由）がある
//        ・重大な事項が開いたままなら「確定できない」
//   3. 仕様の SHA-256（`planDigest`）——キーの順と空白を正規化してから計算する。`confirmation` の SHA と
//      一致しなければ確認は失効である（`isConfirmationValid`・`checkConfirmedPlan`）

// ── 版と欄 ──────────────────────────────────────────────────────

/**
 * 確定した仕様（v1）の wire の版。`plan.json` の `schema_version` がこれと違えば断る。
 * 契約の版を上げるときは、この値を変えて Plan と Build の両方に同じ版を行き渡らせる。
 */
export const PLAN_SPEC_SCHEMA_VERSION = "musunest.plan-spec/v1" as const;

/** 仕様の SHA-256 を持つ欄の名前。`planDigest` はこの欄を除いて計算する（自分自身を混ぜない） */
export const PLAN_CONFIRMATION_FIELD = "confirmation" as const;

/** SHA-256 の値の形（小文字の 16 進 64 桁。pins の他の欄と同じ） */
export const PLAN_SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** `inputs[]` の種類。原文（`source`）・質問（`question`）・答え（`answer`）である */
export const PLAN_INPUT_KINDS = ["source", "question", "answer"] as const;
export type PlanInputKind = (typeof PLAN_INPUT_KINDS)[number];

/**
 * 要件の種類（04 §4）。`constraining` は「決まりを含む」——値や振る舞いを縛る要件である。
 * `existence` は「在ることだけ」——そのものが在ればよく、細かな決まりを持たない要件である。
 */
export const PLAN_REQUIREMENT_KINDS = ["constraining", "existence"] as const;
export type PlanRequirementKind = (typeof PLAN_REQUIREMENT_KINDS)[number];

/** 元の要件との関係（04 §4）。`added` は足した、`changed` は直した、`removed` は外した */
export const PLAN_CHANGE_KINDS = ["added", "changed", "removed"] as const;
export type PlanChangeKind = (typeof PLAN_CHANGE_KINDS)[number];

/**
 * 部分（`parts[]`）の扱い（04 §4）。`met` は満たす、`accepted_removal` は了承して除く、
 * `alternative` は代わりの案を採る——この 3 つだけである。
 */
export const PLAN_PART_DISPOSITIONS = ["met", "accepted_removal", "alternative"] as const;
export type PlanPartDisposition = (typeof PLAN_PART_DISPOSITIONS)[number];

/** 未解決の事項の状態。`open` は未解決、`resolved` は解決（根拠つきで閉じている）である */
export const PLAN_OPEN_ISSUE_STATUSES = ["open", "resolved"] as const;
export type PlanOpenIssueStatus = (typeof PLAN_OPEN_ISSUE_STATUSES)[number];

// ── wire の型（`artifacts/plan.json` の欄の名前のまま） ──────────────

/** 原文の 1 つの範囲（04 §4）。**文の範囲**を引用として持ち、ID を付ける */
export interface PlanSourceInput {
  readonly id: string;
  readonly kind: "source";
  /** 原文の、この要件の出どころになった文の範囲 */
  readonly text: string;
}

/** 質問の選択肢 1 つ。作るものが同じになる選択肢はまとめる（04 §6 の 4） */
export interface PlanChoice {
  readonly id: string;
  readonly text: string;
}

/** 推奨の選択肢と、その理由（1 行。04 §6 の 3） */
export interface PlanRecommendedChoice {
  /** `choices` のどれかの ID */
  readonly choice_id: string;
  readonly reason: string;
}

/** 質問（04 §4）。**1 問は未解決の事項 1 つに対応する**（04 §6 の 1） */
export interface PlanQuestionInput {
  readonly id: string;
  readonly kind: "question";
  /** この問いが対応する `open_issues` の ID */
  readonly open_issue_id: string;
  /** 利用者の言葉で書いた問い（宣言の用語を使わない。04 §3） */
  readonly text: string;
  /** 選択肢（2〜4。04 §6 の 3） */
  readonly choices: readonly PlanChoice[];
  readonly recommended: PlanRecommendedChoice;
}

/** 答え（04 §4）。**選んだ選択肢の ID か、自由入力のちょうど一方**を持つ */
export interface PlanAnswerInput {
  readonly id: string;
  readonly kind: "answer";
  /** 答えた質問の ID */
  readonly question_id: string;
  /** 選んだ選択肢の ID（自由入力のときは無い） */
  readonly choice_id?: string;
  /** 自由入力（選択肢を選んだときは無い） */
  readonly free_text?: string;
}

export type PlanInput = PlanSourceInput | PlanQuestionInput | PlanAnswerInput;

/** 要件の出どころ（04 §4）。`inputs` の ID と、その引用である */
export interface PlanOrigin {
  /** 出どころの `inputs` の ID（原文・質問・答えのどれか） */
  readonly input_id: string;
  /** その入力からの引用 */
  readonly quote: string;
}

/** 元の要件との関係（04 §4）。`changed`・`removed` は元の要件 ID を持つ */
export interface PlanChange {
  readonly kind: PlanChangeKind;
  /** 元の要件の ID（`added` 以外は必須） */
  readonly from_requirement_id?: string;
  /** この変更を決めた答えの ID */
  readonly answer_id: string;
}

/** 要件の部分（04 §4）。了承して除く部分は `accepted_unwritable` に記録する（`accepted_removal`） */
export interface PlanPart {
  readonly id: string;
  readonly text: string;
  readonly disposition: PlanPartDisposition;
  /** 代わりの案を採るとき（`alternative`）、代わりの案になる要件の ID */
  readonly alternative_id?: string;
}

/** 要件（04 §4）。「決まりを含む／在ることだけ」の種類と、部分の一覧を持つ */
export interface PlanRequirement {
  readonly id: string;
  readonly text: string;
  readonly kind: PlanRequirementKind;
  readonly origin: PlanOrigin;
  readonly change?: PlanChange;
  readonly parts: readonly PlanPart[];
}

/** 解決の根拠（04 §4）。答えの ID か、決めたことの ID か、既定で決めた理由である */
export interface PlanResolution {
  /** 解決した答えの ID */
  readonly answer_id?: string;
  /** 既定で決めたこと（`decisions`）の ID */
  readonly decision_id?: string;
  /** 既定で決めた理由（聞かずに決めたことの説明） */
  readonly reason?: string;
}

/** 未解決の事項（04 §4）。重大か否かと、状態・解決の根拠を持つ */
export interface PlanOpenIssue {
  readonly id: string;
  readonly text: string;
  /** 重大か否か。**重大な事項が開いたままなら確定できない**（04 §2） */
  readonly critical: boolean;
  readonly status: PlanOpenIssueStatus;
  /** 解決（`resolved`）のときの根拠 */
  readonly resolution?: PlanResolution;
}

/** 聞かずに決めたこと（04 §4）。確認の画面で直せる */
export interface PlanDecision {
  readonly id: string;
  readonly subject: string;
  readonly value: string;
  readonly reason: string;
}

/** 了承の根拠（04 §4）。文書の版・箇所・制約 ID である（根拠の無い「書けない」は通さない。04 §3 P3） */
export interface PlanUnwritableBasis {
  readonly doc_version: string;
  readonly location: string;
  readonly constraint_id: string;
}

/** 了承して除いた部分（04 §4）。部分 ID・代わりの案の ID・根拠を持つ */
export interface PlanAcceptedUnwritable {
  /** `parts` にある、`disposition: "accepted_removal"` の部分の ID */
  readonly part_id: string;
  /** 代わりの案になる要件の ID */
  readonly alternative_id: string;
  readonly basis: PlanUnwritableBasis;
}

/** 確認（04 §4）。確認した仕様の SHA-256・時刻・人を持つ。仕様が変われば失効する */
export interface PlanConfirmation {
  /** 正規化した仕様の SHA-256（小文字の 16 進 64 桁。`planDigest` が出す） */
  readonly sha256: string;
  readonly confirmed_at: string;
  readonly confirmed_by: string;
}

/** `artifacts/plan.json` の wire。欄の名前は契約の snake_case のまま */
export interface ConfirmedPlan {
  readonly schema_version: string;
  readonly plan_id: string;
  /** 仕様の版。答えを反映するたびに上がる（04 §4） */
  readonly revision: number;
  /** P3 が照らした文書（語彙）の版 */
  readonly vocabulary_version: string;
  readonly inputs: readonly PlanInput[];
  readonly requirements: readonly PlanRequirement[];
  readonly open_issues: readonly PlanOpenIssue[];
  readonly decisions: readonly PlanDecision[];
  readonly accepted_unwritable: readonly PlanAcceptedUnwritable[];
  readonly confirmation: PlanConfirmation;
}

// ── 検査 ────────────────────────────────────────────────────────

/**
 * 検査の誤りの種類。**別の誤りは別の値で返す**——呼ぶ側（門・確認の画面）が、どれを直せばよいかを
 * 文字列の推測なしに選べるようにするためである。
 */
export const PLAN_PROBLEM_CODES = [
  /** 形（欄の欠け・型違い・知らない値） */
  "shape",
  /** 実在しない ID の参照 */
  "unknown_reference",
  /** `accepted_unwritable` の部分 ID が `parts` に無い（了承した範囲の外） */
  "accepted_outside_parts",
  /** `accepted_unwritable` の部分が `parts` にあるが「了承して除く」でない */
  "accepted_not_removal",
  /** 解決（`resolved`）なのに根拠が無い */
  "resolution_without_basis",
  /** 重大でない未解決の事項が残っている（確定できない） */
  "open_issue",
  /** 重大な事項が開いたまま（確定できない） */
  "open_critical",
  /** 確認の SHA-256 が仕様と一致しない（確認が失効している） */
  "confirmation_expired",
] as const;
export type PlanProblemCode = (typeof PLAN_PROBLEM_CODES)[number];

/** 検査の誤り 1 つ。`path` は欄の場所（例 `requirements[0].origin.input_id`） */
export interface PlanProblem {
  readonly code: PlanProblemCode;
  readonly path: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const isOneOf = (allowed: readonly string[], value: unknown): value is string =>
  typeof value === "string" && allowed.includes(value);

/**
 * 確定した仕様（v1）を検査し、見つかった問題をすべて返す。空の配列なら通ったことになる。
 *
 * ここで見るのは**形と、コードで判定できること**だけである（04 §4）。確認の SHA の一致は
 * 非同期の `planDigest` が要るので、ここでは見ない（`isConfirmationValid`・`checkConfirmedPlan`）。
 *
 * 検査の読み（04 §2・§3 P6）：
 *   - `open_issues` は「答えで作るものが変わる」事項である（04 §3 P3）。だから確定の時点で
 *     **すべて根拠つきで閉じている**こと。開いたままの重大な事項は別の誤りに分ける（確定できない）
 *   - `accepted_unwritable` は「了承して除く」部分だけを記録する（04 §5。部分 ID で突き合わせる）
 */
export function checkPlan(plan: unknown): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const report = (code: PlanProblemCode, path: string, message: string): void => {
    problems.push({ code, path, message });
  };
  const requireString = (value: unknown, path: string): boolean => {
    if (!isNonEmptyString(value)) {
      report("shape", path, "空でない文字列でない");
      return false;
    }
    return true;
  };

  if (!isRecord(plan)) {
    report("shape", "", "仕様が写像（オブジェクト）でない");
    return problems;
  }

  if (plan.schema_version !== PLAN_SPEC_SCHEMA_VERSION) {
    report("shape", "schema_version", `版は ${PLAN_SPEC_SCHEMA_VERSION} である`);
  }
  requireString(plan.plan_id, "plan_id");
  if (!Number.isInteger(plan.revision) || (plan.revision as number) < 1) {
    report("shape", "revision", "1 以上の整数でない");
  }
  requireString(plan.vocabulary_version, "vocabulary_version");

  // ── 集める（ID と、あとで照合する参照） ──────────────────────────

  const inputKinds = new Map<string, string>();
  const choiceIdsOfQuestion = new Map<string, Set<string>>();
  const requirementIds = new Set<string>();
  const decisionIds = new Set<string>();
  const openIssueIds = new Set<string>();
  const partDisposition = new Map<string, string>();

  const originRefs: { path: string; inputId: unknown }[] = [];
  const questionRefs: {
    path: string;
    id: string;
    issueId: unknown;
    recommendedChoiceId: unknown;
  }[] = [];
  const answerRefs: { path: string; questionId: unknown; choiceId: unknown }[] = [];
  const changeRefs: {
    path: string;
    kind: unknown;
    fromId: unknown;
    answerId: unknown;
  }[] = [];
  const alternativeRefs: { path: string; id: unknown }[] = [];
  const issueRefs: {
    path: string;
    status: unknown;
    critical: boolean;
    answerId: unknown;
    decisionId: unknown;
    hasReason: boolean;
  }[] = [];
  const unwritableRefs: { path: string; partId: unknown; alternativeId: unknown }[] = [];

  if (!Array.isArray(plan.inputs)) report("shape", "inputs", "並びでない");
  for (const [index, entry] of (Array.isArray(plan.inputs) ? plan.inputs : []).entries()) {
    const path = `inputs[${index}]`;
    if (!isRecord(entry)) {
      report("shape", path, "写像でない");
      continue;
    }
    if (!requireString(entry.id, `${path}.id`) || !isNonEmptyString(entry.id)) continue;
    if (inputKinds.has(entry.id)) {
      report("shape", `${path}.id`, `${entry.id} が重複している`);
      continue;
    }
    if (!isOneOf(PLAN_INPUT_KINDS, entry.kind)) {
      report("shape", `${path}.kind`, `${String(entry.kind)}: ${PLAN_INPUT_KINDS.join(" / ")} のどれか`);
      continue;
    }
    inputKinds.set(entry.id, entry.kind);

    if (entry.kind === "source") {
      requireString(entry.text, `${path}.text`);
      continue;
    }
    if (entry.kind === "question") {
      requireString(entry.open_issue_id, `${path}.open_issue_id`);
      requireString(entry.text, `${path}.text`);
      const choices = new Set<string>();
      if (!Array.isArray(entry.choices) || entry.choices.length < 2) {
        report("shape", `${path}.choices`, "選択肢は 2 つ以上（04 §6 の 3）");
      } else {
        for (const [choiceIndex, choice] of entry.choices.entries()) {
          const choicePath = `${path}.choices[${choiceIndex}]`;
          if (!isRecord(choice)) {
            report("shape", choicePath, "写像でない");
            continue;
          }
          if (!requireString(choice.id, `${choicePath}.id`) || !isNonEmptyString(choice.id)) continue;
          if (choices.has(choice.id)) report("shape", `${choicePath}.id`, `${choice.id} が重複している`);
          choices.add(choice.id);
          requireString(choice.text, `${choicePath}.text`);
        }
      }
      choiceIdsOfQuestion.set(entry.id, choices);
      let recommendedChoiceId: unknown;
      if (!isRecord(entry.recommended)) {
        report("shape", `${path}.recommended`, "写像でない");
      } else {
        requireString(entry.recommended.choice_id, `${path}.recommended.choice_id`);
        requireString(entry.recommended.reason, `${path}.recommended.reason`);
        recommendedChoiceId = entry.recommended.choice_id;
      }
      questionRefs.push({
        path,
        id: entry.id,
        issueId: entry.open_issue_id,
        recommendedChoiceId,
      });
      continue;
    }

    // answer
    requireString(entry.question_id, `${path}.question_id`);
    const hasChoice = entry.choice_id !== undefined;
    const hasFreeText = entry.free_text !== undefined;
    if (hasChoice === hasFreeText) {
      report("shape", path, "choice_id か free_text のちょうど一方を書く");
    }
    if (hasChoice) requireString(entry.choice_id, `${path}.choice_id`);
    if (hasFreeText) requireString(entry.free_text, `${path}.free_text`);
    answerRefs.push({ path, questionId: entry.question_id, choiceId: entry.choice_id });
  }

  if (!Array.isArray(plan.requirements)) report("shape", "requirements", "並びでない");
  for (const [index, entry] of (Array.isArray(plan.requirements) ? plan.requirements : []).entries()) {
    const path = `requirements[${index}]`;
    if (!isRecord(entry)) {
      report("shape", path, "写像でない");
      continue;
    }
    if (!requireString(entry.id, `${path}.id`) || !isNonEmptyString(entry.id)) continue;
    if (requirementIds.has(entry.id)) report("shape", `${path}.id`, `${entry.id} が重複している`);
    requirementIds.add(entry.id);
    requireString(entry.text, `${path}.text`);
    if (!isOneOf(PLAN_REQUIREMENT_KINDS, entry.kind)) {
      report("shape", `${path}.kind`, `${String(entry.kind)}: ${PLAN_REQUIREMENT_KINDS.join(" / ")} のどれか`);
    }

    if (!isRecord(entry.origin)) {
      report("shape", `${path}.origin`, "写像でない");
    } else {
      requireString(entry.origin.input_id, `${path}.origin.input_id`);
      requireString(entry.origin.quote, `${path}.origin.quote`);
      originRefs.push({ path: `${path}.origin.input_id`, inputId: entry.origin.input_id });
    }

    if (entry.change !== undefined) {
      if (!isRecord(entry.change)) {
        report("shape", `${path}.change`, "写像でない");
      } else {
        const kind = entry.change.kind;
        if (!isOneOf(PLAN_CHANGE_KINDS, kind)) {
          report("shape", `${path}.change.kind`, `${String(kind)}: ${PLAN_CHANGE_KINDS.join(" / ")} のどれか`);
        } else if (kind !== "added") {
          requireString(entry.change.from_requirement_id, `${path}.change.from_requirement_id`);
        }
        requireString(entry.change.answer_id, `${path}.change.answer_id`);
        changeRefs.push({
          path,
          kind,
          fromId: entry.change.from_requirement_id,
          answerId: entry.change.answer_id,
        });
      }
    }

    if (!Array.isArray(entry.parts)) {
      report("shape", `${path}.parts`, "並びでない");
      continue;
    }
    for (const [partIndex, part] of entry.parts.entries()) {
      const partPath = `${path}.parts[${partIndex}]`;
      if (!isRecord(part)) {
        report("shape", partPath, "写像でない");
        continue;
      }
      if (!requireString(part.id, `${partPath}.id`) || !isNonEmptyString(part.id)) continue;
      if (partDisposition.has(part.id)) {
        report("shape", `${partPath}.id`, `${part.id} が重複している`);
        continue;
      }
      requireString(part.text, `${partPath}.text`);
      if (!isOneOf(PLAN_PART_DISPOSITIONS, part.disposition)) {
        report(
          "shape",
          `${partPath}.disposition`,
          `${String(part.disposition)}: ${PLAN_PART_DISPOSITIONS.join(" / ")} のどれか`,
        );
        partDisposition.set(part.id, String(part.disposition));
        continue;
      }
      partDisposition.set(part.id, part.disposition);
      if (part.alternative_id !== undefined) {
        requireString(part.alternative_id, `${partPath}.alternative_id`);
        alternativeRefs.push({ path: `${partPath}.alternative_id`, id: part.alternative_id });
      } else if (part.disposition === "alternative") {
        report("shape", `${partPath}.alternative_id`, "代わりの案を採るときは代わりの案の ID を書く");
      }
    }
  }

  if (!Array.isArray(plan.open_issues)) report("shape", "open_issues", "並びでない");
  for (const [index, entry] of (Array.isArray(plan.open_issues) ? plan.open_issues : []).entries()) {
    const path = `open_issues[${index}]`;
    if (!isRecord(entry)) {
      report("shape", path, "写像でない");
      continue;
    }
    if (!requireString(entry.id, `${path}.id`) || !isNonEmptyString(entry.id)) continue;
    if (openIssueIds.has(entry.id)) report("shape", `${path}.id`, `${entry.id} が重複している`);
    openIssueIds.add(entry.id);
    requireString(entry.text, `${path}.text`);
    if (typeof entry.critical !== "boolean") report("shape", `${path}.critical`, "真偽でない");
    if (!isOneOf(PLAN_OPEN_ISSUE_STATUSES, entry.status)) {
      report("shape", `${path}.status`, `${String(entry.status)}: ${PLAN_OPEN_ISSUE_STATUSES.join(" / ")} のどれか`);
    }

    let answerId: unknown;
    let decisionId: unknown;
    let hasReason = false;
    if (entry.resolution !== undefined) {
      if (!isRecord(entry.resolution)) {
        report("shape", `${path}.resolution`, "写像でない");
      } else {
        answerId = entry.resolution.answer_id;
        decisionId = entry.resolution.decision_id;
        if (answerId !== undefined) requireString(answerId, `${path}.resolution.answer_id`);
        if (decisionId !== undefined) requireString(decisionId, `${path}.resolution.decision_id`);
        if (entry.resolution.reason !== undefined) {
          hasReason = isNonEmptyString(entry.resolution.reason);
          if (!hasReason) report("shape", `${path}.resolution.reason`, "空でない文字列でない");
        }
      }
    }
    issueRefs.push({
      path,
      status: entry.status,
      critical: entry.critical === true,
      answerId,
      decisionId,
      hasReason,
    });
  }

  if (!Array.isArray(plan.decisions)) report("shape", "decisions", "並びでない");
  for (const [index, entry] of (Array.isArray(plan.decisions) ? plan.decisions : []).entries()) {
    const path = `decisions[${index}]`;
    if (!isRecord(entry)) {
      report("shape", path, "写像でない");
      continue;
    }
    if (!requireString(entry.id, `${path}.id`) || !isNonEmptyString(entry.id)) continue;
    if (decisionIds.has(entry.id)) report("shape", `${path}.id`, `${entry.id} が重複している`);
    decisionIds.add(entry.id);
    requireString(entry.subject, `${path}.subject`);
    requireString(entry.value, `${path}.value`);
    requireString(entry.reason, `${path}.reason`);
  }

  if (!Array.isArray(plan.accepted_unwritable)) report("shape", "accepted_unwritable", "並びでない");
  for (const [index, entry] of (Array.isArray(plan.accepted_unwritable) ? plan.accepted_unwritable : []).entries()) {
    const path = `accepted_unwritable[${index}]`;
    if (!isRecord(entry)) {
      report("shape", path, "写像でない");
      continue;
    }
    requireString(entry.part_id, `${path}.part_id`);
    requireString(entry.alternative_id, `${path}.alternative_id`);
    if (!isRecord(entry.basis)) {
      report("shape", `${path}.basis`, "写像でない");
    } else {
      requireString(entry.basis.doc_version, `${path}.basis.doc_version`);
      requireString(entry.basis.location, `${path}.basis.location`);
      requireString(entry.basis.constraint_id, `${path}.basis.constraint_id`);
    }
    unwritableRefs.push({ path, partId: entry.part_id, alternativeId: entry.alternative_id });
  }

  if (!isRecord(plan.confirmation)) {
    report("shape", "confirmation", "確認が無い");
  } else {
    if (typeof plan.confirmation.sha256 !== "string" || !PLAN_SHA256_PATTERN.test(plan.confirmation.sha256)) {
      report("shape", "confirmation.sha256", "小文字の 16 進 64 桁でない");
    }
    requireString(plan.confirmation.confirmed_at, "confirmation.confirmed_at");
    requireString(plan.confirmation.confirmed_by, "confirmation.confirmed_by");
  }

  // ── 参照を照合する（実在しない ID を指していないか） ──────────────

  for (const ref of originRefs) {
    if (!(typeof ref.inputId === "string" && inputKinds.has(ref.inputId))) {
      report("unknown_reference", ref.path, `${String(ref.inputId)}: inputs に無い`);
    }
  }

  for (const ref of questionRefs) {
    if (!(typeof ref.issueId === "string" && openIssueIds.has(ref.issueId))) {
      report("unknown_reference", `${ref.path}.open_issue_id`, `${String(ref.issueId)}: open_issues に無い`);
    }
    if (typeof ref.recommendedChoiceId === "string") {
      const choices = choiceIdsOfQuestion.get(ref.id) ?? new Set<string>();
      if (!choices.has(ref.recommendedChoiceId)) {
        report(
          "unknown_reference",
          `${ref.path}.recommended.choice_id`,
          `${ref.recommendedChoiceId}: 選択肢に無い`,
        );
      }
    }
  }

  for (const ref of answerRefs) {
    const questionId = ref.questionId;
    if (!(typeof questionId === "string" && inputKinds.get(questionId) === "question")) {
      report("unknown_reference", `${ref.path}.question_id`, `${String(questionId)}: 質問（inputs）に無い`);
      continue;
    }
    if (typeof ref.choiceId === "string") {
      const choices = choiceIdsOfQuestion.get(questionId) ?? new Set<string>();
      if (!choices.has(ref.choiceId)) {
        report("unknown_reference", `${ref.path}.choice_id`, `${ref.choiceId}: その質問の選択肢に無い`);
      }
    }
  }

  for (const ref of changeRefs) {
    if (ref.kind !== "added" && !(typeof ref.fromId === "string" && requirementIds.has(ref.fromId))) {
      report(
        "unknown_reference",
        `${ref.path}.change.from_requirement_id`,
        `${String(ref.fromId)}: requirements に無い`,
      );
    }
    if (!(typeof ref.answerId === "string" && inputKinds.get(ref.answerId) === "answer")) {
      report("unknown_reference", `${ref.path}.change.answer_id`, `${String(ref.answerId)}: 答え（inputs）に無い`);
    }
  }

  for (const ref of alternativeRefs) {
    if (!(typeof ref.id === "string" && requirementIds.has(ref.id))) {
      report("unknown_reference", ref.path, `${String(ref.id)}: requirements に無い`);
    }
  }

  for (const ref of issueRefs) {
    if (ref.status === "resolved") {
      const hasBasis =
        isNonEmptyString(ref.answerId) || isNonEmptyString(ref.decisionId) || ref.hasReason;
      if (!hasBasis) {
        report(
          "resolution_without_basis",
          `${ref.path}.resolution`,
          "解決の根拠（答えの ID・決めたことの ID・既定で決めた理由）が無い",
        );
      }
      if (isNonEmptyString(ref.answerId) && inputKinds.get(ref.answerId) !== "answer") {
        report("unknown_reference", `${ref.path}.resolution.answer_id`, `${ref.answerId}: 答え（inputs）に無い`);
      }
      if (isNonEmptyString(ref.decisionId) && !decisionIds.has(ref.decisionId)) {
        report("unknown_reference", `${ref.path}.resolution.decision_id`, `${ref.decisionId}: decisions に無い`);
      }
    } else if (ref.status === "open") {
      if (ref.critical) {
        report("open_critical", `${ref.path}.status`, "重大な事項が開いたまま（確定できない）");
      } else {
        report("open_issue", `${ref.path}.status`, "未解決の事項が残っている（確定できない）");
      }
    }
  }

  for (const ref of unwritableRefs) {
    const disposition = isNonEmptyString(ref.partId) ? partDisposition.get(ref.partId) : undefined;
    if (disposition === undefined) {
      report("accepted_outside_parts", `${ref.path}.part_id`, `${String(ref.partId)}: parts に無い`);
    } else if (disposition !== "accepted_removal") {
      report("accepted_not_removal", `${ref.path}.part_id`, `${String(ref.partId)}: 「了承して除く」になっていない`);
    }
    if (!(typeof ref.alternativeId === "string" && requirementIds.has(ref.alternativeId))) {
      report("unknown_reference", `${ref.path}.alternative_id`, `${String(ref.alternativeId)}: requirements に無い`);
    }
  }

  return problems;
}

// ── 仕様の SHA-256（正規化してから計算する） ─────────────────────
//
// 決めごと（04 §4）：
//   1. **キーの順と空白は値に現れない。** 正規化（キーの昇順・区切りの空白なし）してから計算する。
//      同じ中身の仕様は、キーの並べ方が違っても同じ SHA になる
//   2. **`confirmation` は混ぜない。** それは確認した仕様の SHA そのものを持つ欄だからである
//      （自分自身を混ぜると値が決まらない）。だから仕様が 1 か所でも変われば SHA が変わり、
//      記録した `confirmation.sha256` と一致しなくなる＝確認が失効する
//   3. **WebCrypto（`crypto.subtle`）で計算する。** Node でも Worker でも同じものが動く（依存を増やさない）

const textEncoder = new TextEncoder();

/** 小文字の 16 進 64 桁にする */
function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * JSON を、キーの順と空白を正規化した 1 つの文字列にする。**同じ中身からは同じ文字列**になり、
 * **1 か所でも違えば違う文字列**になる（配列の順は値の一部なので入れ替えない）。
 * `undefined` の値を持つキーは落とす（`JSON.stringify` と同じ扱い）。
 */
export function canonicalPlanJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalPlanJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalPlanJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

/** `confirmation` を除いた写像を作る（`planDigest` は自分自身の SHA を混ぜない） */
function withoutConfirmation(plan: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key !== PLAN_CONFIRMATION_FIELD) copy[key] = value;
  }
  return copy;
}

/**
 * 確定した仕様の SHA-256（小文字の 16 進 64 桁）を求める。**キーの順と空白を正規化してから**計算し、
 * **`confirmation` は混ぜない**（決めごと 1〜3）。`confirmation` に記録する値はこれである。
 */
export async function planDigest(plan: unknown): Promise<string> {
  const content = isRecord(plan) ? withoutConfirmation(plan) : plan;
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonicalPlanJson(content)));
  return hexOf(new Uint8Array(digest));
}

/**
 * `confirmation` の SHA-256 が、いまの仕様のそれと一致するか。**一致しなければ確認は失効している**
 * （04 §4。仕様が確認のあとに 1 か所でも変わったとき）。
 */
export async function isConfirmationValid(plan: unknown): Promise<boolean> {
  if (!isRecord(plan) || !isRecord(plan.confirmation)) return false;
  const sha = plan.confirmation.sha256;
  if (typeof sha !== "string") return false;
  return sha === (await planDigest(plan));
}

/**
 * 形・参照・了承・解決の検査（`checkPlan`）に加えて、**確認の失効**まで見る。
 * 空の配列なら、この仕様は確定して Build に渡せる（04 §4）。
 */
export async function checkConfirmedPlan(plan: unknown): Promise<PlanProblem[]> {
  const problems = checkPlan(plan);
  if (!isRecord(plan) || !isRecord(plan.confirmation)) return problems;
  const sha = plan.confirmation.sha256;
  if (typeof sha !== "string" || sha !== (await planDigest(plan))) {
    problems.push({
      code: "confirmation_expired",
      path: "confirmation.sha256",
      message: "仕様の SHA-256 と一致しない（確認が失効している）",
    });
  }
  return problems;
}
