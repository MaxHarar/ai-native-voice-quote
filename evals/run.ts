#!/usr/bin/env bun
// τ-style eval runner on ElevenLabs agent-testing (simulation tests, tool mocking OFF).
// For each task × trial:
//   1. Create a simulation test with a unique eval_tag + session id (so trials never share DB rows).
//   2. Run all tests in one invocation: an LLM caller (persona) talks to the DEPLOYED agent, whose
//      webhook tools hit the DEPLOYED server — real tool calls, real database writes.
//   3. Read each trial's END STATE from the server's admin oracle and judge it; apply global
//      anti-criteria to the transcript. ElevenLabs' LLM judge is recorded as a secondary signal.
// Reports pass^k (reliability) and pass@k per task, then deletes the per-trial tests.
//
// Usage: bun run eval [--trials 2] [--tasks happy-path,out-of-state] [--user-llm claude-sonnet-4-6]

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { client } from "../agent/elevenlabs";
import { RATE_TABLE_VERSIONS } from "../src/rating/rateTable";
import { passAtK, passHatK } from "./passk";
import { concision, globalChecks, TASKS, type AdminQuote, type EndState, type Turn } from "./tasks";

const { values: args } = parseArgs({
  options: {
    trials: { type: "string", default: "2" },
    tasks: { type: "string" },
    "user-llm": { type: "string", default: process.env.EVAL_USER_LLM ?? "claude-sonnet-4-6" },
    "max-turns": { type: "string", default: "50" },
    "timeout-min": { type: "string", default: "25" },
    keep: { type: "boolean", default: false },
  },
});

const deployed = await Bun.file(new URL("../agent/deployed.json", import.meta.url)).json();
const agentId: string = process.env.ELEVENLABS_AGENT_ID ?? deployed.agent_id;
const serverUrl: string = (process.env.SERVER_URL ?? deployed.server_url).replace(/\/$/, "");
const adminSecret = process.env.ADMIN_SECRET;
if (!adminSecret) throw new Error("ADMIN_SECRET is required (eval oracle)");

const trials = Number(args.trials);
const selected = args.tasks ? TASKS.filter((t) => args.tasks!.split(",").includes(t.id)) : TASKS;
if (!selected.length) throw new Error("no tasks selected");
const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const el = client();

const SIM_RULES = `You are role-playing a CALLER phoning an auto insurance quote line. You are NOT an assistant.
Talk like a real person on the phone: short, natural replies. Answer only what you're asked; never volunteer details early.
Use exactly the details below. If asked for something not listed, say you're not sure.
When the call is over (you've received an application number, you've been told you'll be transferred or called back, or you declined), say a brief goodbye.

YOUR DETAILS AND GOALS:
`;

interface Job {
  task: string;
  trial: number;
  evalTag: string;
  testId?: string;
}

interface TestRun {
  test_id: string;
  status: "pending" | "passed" | "failed" | "cancelled";
  agent_responses: Turn[] | null;
  condition_result: { result: string } | null;
  credits_used?: number | null;
}

const jobs: Job[] = selected.flatMap((t) =>
  Array.from({ length: trials }, (_, i) => ({ task: t.id, trial: i + 1, evalTag: `eval-${runId}-${t.id}-t${i + 1}` })),
);

// 1. One simulation test per trial.
for (const job of jobs) {
  const task = TASKS.find((t) => t.id === job.task)!;
  const created = await el.post<{ id: string }>("/v1/convai/agent-testing/create", {
    type: "simulation",
    name: `eval ${runId} ${job.task} #${job.trial}`,
    simulation_scenario: SIM_RULES + task.persona,
    simulation_max_turns: Number(args["max-turns"]),
    simulated_user_model: args["user-llm"],
    success_conditions: [`${task.title}. The agent followed its quote-line policy for this caller.`],
    // The server derives the eval tag from this id; tools bind only system__* variables.
    dynamic_variables: { system__conversation_id: `sim_${job.evalTag}` },
    tool_mock_config: { mocking_strategy: "none" },
    conversation_initiation_source: "twilio",
  });
  job.testId = created.id;
}
console.log(`created ${jobs.length} simulation tests (run ${runId}); running against agent ${agentId}…`);

// 2. Run them all in one invocation and poll to the terminal state.
const t0 = performance.now();
const invocation = await el.post<{ id: string }>(`/v1/convai/agents/${agentId}/run-tests`, { tests: jobs.map((j) => ({ test_id: j.testId })) });
let runs: TestRun[] = [];
const deadline = Date.now() + Number(args["timeout-min"]) * 60_000;
while (Date.now() < deadline) {
  const inv = await el.get<{ test_runs: TestRun[] }>(`/v1/convai/test-invocations/${invocation.id}`);
  runs = inv.test_runs ?? [];
  const pending = runs.filter((r) => r.status === "pending").length;
  if (runs.length >= jobs.length && pending === 0) break;
  await Bun.sleep(10_000);
}
const elapsedS = Math.round((performance.now() - t0) / 1000);

// 3. Judge each trial on server end state.
interface TrialResult {
  task: string;
  trial: number;
  evalTag: string;
  pass: boolean;
  reasons: string[];
  status: string | null;
  turns: number;
  toolErrors: string[];
  concision: ReturnType<typeof concision>;
  llmJudge: string | null;
  credits: number | null;
  transcript: string[];
}

const results: TrialResult[] = [];
for (const job of jobs) {
  const run = runs.find((r) => r.test_id === job.testId);
  const res = await fetch(`${serverUrl}/admin/quotes?eval_tag=${encodeURIComponent(job.evalTag)}`, { headers: { "x-admin-secret": adminSecret! } });
  const quotes = ((await res.json()) as { quotes?: AdminQuote[] }).quotes ?? [];
  const state: EndState = { quotes, transcript: run?.agent_responses ?? [] };
  const task = TASKS.find((t) => t.id === job.task)!;
  const taskCheck = task.check(state);
  const global = globalChecks(state);
  const harness = !run ? ["harness: test run missing"] : run.status === "pending" ? ["harness: timed out"] : run.status === "cancelled" ? ["harness: cancelled"] : [];
  const r: TrialResult = {
    task: job.task,
    trial: job.trial,
    evalTag: job.evalTag,
    pass: harness.length === 0 && taskCheck.pass && global.pass,
    reasons: [...harness, ...taskCheck.reasons, ...global.reasons],
    status: quotes[0]?.status ?? null,
    turns: state.transcript.length,
    toolErrors: quotes.flatMap((q) => q.events.filter((e) => !e.ok).map((e) => `${e.tool}:${e.error}`)),
    concision: concision(state),
    llmJudge: run?.condition_result?.result ?? run?.status ?? null,
    credits: run?.credits_used ?? null,
    transcript: state.transcript.map((t) => `${t.role}: ${t.message ?? ""}${t.tool_calls?.length ? ` [${t.tool_calls.map((c) => c.tool_name).join(",")}]` : ""}`),
  };
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.task} #${r.trial} (status=${r.status}, judge=${r.llmJudge})${r.pass ? "" : " — " + r.reasons.join("; ")}`);
}

// 4. Cleanup per-trial tests (results are persisted locally).
if (!args.keep) for (const job of jobs) await el.del(`/v1/convai/agent-testing/${job.testId}`).catch(() => {});

const byTask = selected.map((t) => {
  const rs = results.filter((r) => r.task === t.id);
  const n = rs.length;
  const c = rs.filter((r) => r.pass).length;
  const hat = Object.fromEntries(Array.from({ length: n }, (_, i) => [`pass^${i + 1}`, +passHatK(n, c, i + 1).toFixed(3)]));
  return { task: t.id, title: t.title, n, c, ...hat, [`pass@${n}`]: +passAtK(n, c, n).toFixed(3) } as { task: string; title: string; n: number; c: number; [metric: string]: string | number };
});
const meanOf = (k: number) => +(byTask.reduce((s, t) => s + passHatK(t.n, t.c, k), 0) / byTask.length).toFixed(3);
const sentenceMeans = results.flatMap((r) => (r.concision.turns ? [r.concision.meanSentences] : []));
const policyHash = createHash("sha256").update(await Bun.file(new URL("../policy/quote-line-policy.md", import.meta.url)).text()).digest("hex").slice(0, 12);
const gitSha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: new URL("..", import.meta.url).pathname }).stdout.toString().trim();

const report = {
  runId,
  meta: {
    agentId,
    agentLlm: deployed.llm,
    backupLlms: deployed.backup_llms,
    voiceId: deployed.voice_id,
    ttsModel: deployed.tts_model,
    userSimulatorLlm: args["user-llm"],
    harness: "elevenlabs agent-testing simulation, tool mocking off, end-state oracle",
    trialsPerTask: trials,
    rateTableVersions: RATE_TABLE_VERSIONS,
    policyHash,
    gitSha,
    serverUrl,
    elapsedSeconds: elapsedS,
  },
  aggregate: {
    "pass^1": meanOf(1),
    ...(trials >= 2 ? { "pass^2": meanOf(2) } : {}),
    ...(trials >= 3 ? { "pass^3": meanOf(3) } : {}),
    meanSentencesPerAgentTurn: sentenceMeans.length ? +(sentenceMeans.reduce((a, b) => a + b, 0) / sentenceMeans.length).toFixed(2) : null,
    llmJudgeAgreement: +(results.filter((r) => (r.llmJudge === "success" || r.llmJudge === "passed") === r.pass).length / results.length).toFixed(2),
    credits: results.reduce((s, r) => s + (r.credits ?? 0), 0),
  },
  tasks: byTask,
  trials: results,
};
await Bun.write(new URL(`./results/${runId}.json`, import.meta.url), JSON.stringify(report, null, 2) + "\n");

console.log(`\n| task | n | c | pass^1${trials >= 2 ? " | pass^2" : ""} |\n|---|---|---|---${trials >= 2 ? "|---" : ""}|`);
for (const t of byTask) console.log(`| ${t.task} | ${t.n} | ${t.c} | ${t["pass^1"]}${trials >= 2 ? ` | ${t["pass^2"]}` : ""} |`);
console.log(`\naggregate: ${JSON.stringify(report.aggregate)}\nwrote evals/results/${runId}.json (${elapsedS}s)`);
