import test from "node:test";
import assert from "node:assert/strict";

import {
  ARM_ERROR,
  assertComparable,
  buildTurnInputs,
  costOf,
  leakCheck,
  runArm,
  summarize,
} from "../src/reference-model.mjs";

// A deterministic stand-in for the model. No network, no provider, no key —
// which is the point: every failure path below is reachable in a unit test.
function fakeModel({ hidden = 0, visible = 40, failOnTurn = null } = {}) {
  const seen = [];
  const generate = async ({ prompt, setting }) => {
    seen.push({ prompt, setting });
    if (failOnTurn !== null && prompt.turnNumber === failOnTurn) {
      throw new Error("upstream 503");
    }
    return {
      text: `line for turn ${prompt.turnNumber}`,
      usage: { hidden, visible },
      latencyMs: 100,
    };
  };
  return { generate, seen };
}

const buildPrompt = (args) => ({ ...args });

const SCENARIO = {
  id: "grind",
  turns: [
    { state: "reaction", context: "turn 1 board" },
    { state: "reaction", context: "turn 2 board" },
    { state: "reaction", context: "turn 3 board" },
  ],
};

test("turn inputs are derived deterministically and are immutable", () => {
  const a = buildTurnInputs(SCENARIO);
  const b = buildTurnInputs(SCENARIO);

  assert.deepEqual(a, b, "same scenario must produce identical inputs");
  assert.equal(a.length, 3);
  assert.equal(a[0].turnNumber, 1);
  assert.ok(Object.isFrozen(a[0]), "inputs must not be mutable by a caller");
});

test("an empty scenario is rejected rather than silently benchmarked", () => {
  assert.throws(() => buildTurnInputs({ id: "x", turns: [] }), TypeError);
  assert.throws(() => buildTurnInputs({ id: "", turns: [{ state: "a" }] }), TypeError);
});

test("the model's own prior output accumulates in order across turns", async () => {
  const { generate, seen } = fakeModel();
  await runArm({ scenario: SCENARIO, setting: "minimal", buildPrompt, generate });

  assert.deepEqual(seen[0].prompt.priorOutputs, []);
  assert.deepEqual(seen[1].prompt.priorOutputs, ["line for turn 1"]);
  assert.deepEqual(seen[2].prompt.priorOutputs, [
    "line for turn 1",
    "line for turn 2",
  ]);
});

test("the prompt builder cannot mutate the running history", async () => {
  const { generate } = fakeModel();
  const sabotage = (args) => {
    args.priorOutputs.push("injected");
    return args;
  };

  const arm = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt: sabotage,
    generate,
  });

  // Three real turns, none displaced by the mutation attempt.
  assert.equal(arm.samples.length, 3);
  assert.ok(arm.samples.every((s) => s.ok));
});

test("a failed call is an error sample, never a zero score", async () => {
  const { generate } = fakeModel({ hidden: 500, failOnTurn: 2 });
  const arm = await runArm({
    scenario: SCENARIO,
    setting: "high",
    buildPrompt,
    generate,
  });

  const failed = arm.samples.filter((s) => !s.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, ARM_ERROR.CALL_FAILED);
  assert.equal(failed[0].turnNumber, 2);

  // The failure must not enter the mean as a legitimate 0.
  const summary = summarize(arm);
  assert.equal(summary.n, 2, "only successful calls count toward n");
  assert.equal(summary.errors, 1);
  assert.equal(summary.meanHiddenTokens, 500, "not diluted toward zero");
  assert.equal(summary.complete, false, "an incomplete arm must say so");
});

test("a failed turn does not fabricate continuity for later turns", async () => {
  const { generate, seen } = fakeModel({ failOnTurn: 2 });
  await runArm({ scenario: SCENARIO, setting: "high", buildPrompt, generate });

  // Turn 3 sees turn 1 only — never a placeholder standing in for turn 2.
  assert.deepEqual(seen.at(-1).prompt.priorOutputs, ["line for turn 1"]);
});

test("arms are only comparable when every arm saw the same inputs", async () => {
  const minimal = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt,
    generate: fakeModel().generate,
  });
  const high = await runArm({
    scenario: SCENARIO,
    setting: "high",
    buildPrompt,
    generate: fakeModel({ hidden: 3000 }).generate,
  });

  assert.equal(assertComparable([minimal, high]), true);

  const shorter = await runArm({
    scenario: { id: "grind", turns: SCENARIO.turns.slice(0, 2) },
    setting: "low",
    buildPrompt,
    generate: fakeModel().generate,
  });
  assert.throws(() => assertComparable([minimal, shorter]), /not comparable/);

  const otherScenario = await runArm({
    scenario: { ...SCENARIO, id: "different" },
    setting: "low",
    buildPrompt,
    generate: fakeModel().generate,
  });
  assert.throws(() => assertComparable([minimal, otherScenario]), /not comparable/);
});

test("two arms sweeping the same setting is a harness bug, not a comparison", async () => {
  const a = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt,
    generate: fakeModel().generate,
  });
  const b = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt,
    generate: fakeModel().generate,
  });

  assert.throws(() => assertComparable([a, b]), /distinct setting/);
});

test("cost comes from reported usage, and separates hidden from visible", async () => {
  const arm = await runArm({
    scenario: SCENARIO,
    setting: "high",
    buildPrompt,
    generate: fakeModel({ hidden: 3000, visible: 60 }).generate,
  });

  const cost = costOf(arm.samples, 9.0);
  assert.equal(cost.hidden, 9000);
  assert.equal(cost.visible, 180);
  assert.equal(cost.billable, 9180);

  // The production finding in one assertion: hidden tokens dominated the bill.
  assert.ok(cost.hiddenShare > 0.97, "hidden share should dominate");
  assert.ok(Math.abs(cost.cost - (9180 * 9.0) / 1e6) < 1e-12);
});

test("a zero-thinking arm bills only what the user can actually see", async () => {
  const arm = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt,
    generate: fakeModel({ hidden: 0, visible: 60 }).generate,
  });

  const cost = costOf(arm.samples, 9.0);
  assert.equal(cost.hidden, 0);
  assert.equal(cost.hiddenShare, 0);
});

test("cost rejects a nonsense price rather than reporting a nonsense number", () => {
  assert.throws(() => costOf([], -1), TypeError);
  assert.throws(() => costOf([], Number.NaN), TypeError);
});

test("summary always reports how many runs it stands on", async () => {
  const arm = await runArm({
    scenario: SCENARIO,
    setting: "minimal",
    buildPrompt,
    generate: fakeModel().generate,
  });

  assert.equal(summarize(arm).runs, 1, "a single run is a sample, not a measurement");
  assert.equal(summarize(arm, { runs: 3 }).runs, 3);
});

test("leak check separates a real leak from a noisy one", () => {
  assert.equal(leakCheck("the answer is MANGO", "MANGO", ["M"]).verdict, "fail");
  assert.equal(leakCheck("the answer is MANGO", "MANGO", []).hard, true);

  // An isolated unrevealed letter is worth a human look, not an automatic fail.
  const soft = leakCheck("try a K next", "WHISK", ["W", "K"]);
  assert.equal(soft.hard, false);
  assert.deepEqual(soft.soft, ["K"]);
  assert.equal(soft.verdict, "review");

  assert.equal(leakCheck("think about breakfast", "WHISK", ["W", "K"]).verdict, "clean");
});

test("the documented false positive is real and is not silently suppressed", () => {
  // "I" as a pronoun trips the letter screen. The screen reports it as review
  // rather than failure precisely because of cases like this one.
  const result = leakCheck("I would try another vowel", "PIANO", ["I"]);
  assert.equal(result.hard, false);
  assert.deepEqual(result.soft, ["I"]);
  assert.equal(result.verdict, "review");
});

test("leak check rejects empty input instead of returning a false clean", () => {
  assert.throws(() => leakCheck("", "MANGO", []), TypeError);
  assert.throws(() => leakCheck("some text", "", []), TypeError);
});
