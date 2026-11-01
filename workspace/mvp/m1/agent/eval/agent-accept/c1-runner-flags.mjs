// One source for optional C1 CLI flags, effective conditions and native Build audit.
export const C1_FLAGS = { "--c1-reference-enum": "c1_reference_enum", "--c1-conditional-fields": "c1_conditional_fields" };
export function parseC1Flags(args, mode) {
  const flags = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--c1-")) continue;
    const key = C1_FLAGS[arg];
    if (key === undefined) throw new Error("c1:unknown-flag");
    if (key in flags) throw new Error("c1:duplicate");
    const value = args[++i];
    if (value !== "on" && value !== "off") throw new Error("c1:value");
    flags[key] = value;
  }
  const enabled = Object.values(flags).some((v) => v === "on");
  if (enabled && (mode.pipeline !== "v1.2" || !mode.buildFrom || mode.plan || mode.planOnly || mode.compare || mode.makePairs || mode.stageMode)) throw new Error("c1:mode");
  return Object.fromEntries(Object.values(C1_FLAGS).filter((key) => flags[key] === "on").map((key) => [key, "on"]));
}
export const c1Argv = (flags) => Object.entries(C1_FLAGS).flatMap(([arg, key]) => flags[key] === "on" ? [arg, "on"] : []);
export function c1BuildReport(flags, record) {
  const values = record?.conditions;
  const expected = Object.fromEntries(Object.values(C1_FLAGS).map((k) => [k, flags[k] ?? "off"]));
  const observed = Object.fromEntries(Object.values(C1_FLAGS).map((k) => [k, values && typeof values === "object" && k in values ? values[k] : "off"]));
  const enabled = Object.keys(flags).length > 0;
  const status = enabled && (!values || typeof values !== "object") ? "missing"
    : Object.values(observed).some((v) => v !== "on" && v !== "off") || Object.keys(expected).some((k) => expected[k] !== observed[k]) ? "mismatch" : "match";
  return { status, expected, observed };
}
export function c1ConditionsMatch(flags, params) {
  return c1BuildReport(flags, { conditions: params }).status === "match";
}
