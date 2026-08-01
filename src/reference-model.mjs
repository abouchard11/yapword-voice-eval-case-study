// A sanitized reference model for benchmarking subjective model output against a
// configuration change, when there is no reference implementation to grade against.
//
// The production system this is drawn from measures a generative character's voice
// across a multi-turn game while sweeping an inference setting. The interesting part
// is not the character — it is that "is the output good?" has no oracle, so the
// harness has to earn its trust structurally instead.
//
// Nothing here contains the production prompt, the character, provider wiring, or
// credentials. `buildPrompt` and `generate` are injected by the caller, which is the
// same reason this file is testable without a network.

export const ARM_ERROR = Object.freeze({
  CALL_FAILED: "call_failed",
});

function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

// ── Controlled inputs ────────────────────────────────────────────────────────
// Each turn's input is derived deterministically from the scenario. Two arms
// running the same scenario must see byte-identical turn inputs; the only thing
// allowed to differ between arms is the swept setting. Everything downstream
// depends on that, so it is computed once and shared rather than rebuilt per arm.

export function buildTurnInputs(scenario) {
  if (!scenario || !Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    throw new TypeError("scenario.turns must be a non-empty array");
  }
  requireNonEmpty(scenario.id, "scenario.id");

  return scenario.turns.map((turn, index) => {
    requireNonEmpty(turn.state, `turns[${index}].state`);
    return Object.freeze({
      index,
      turnNumber: index + 1,
      state: turn.state,
      // The accumulated world state as of this turn. Bounded, and produced by
      // deterministic code — never by the model.
      context: turn.context ?? "",
    });
  });
}

// ── One arm of the sweep ─────────────────────────────────────────────────────
// Walks the scenario turn by turn. Each call receives the accumulating context
// AND the model's own prior outputs, because the property under test is a
// through-line across turns, not a single-shot response. A one-shot bench would
// measure the wrong thing entirely.
//
// A failed call is recorded as an error sample. It is NEVER coerced to a zero
// score or silently dropped — see `summarize`, which excludes errors from the
// mean and reports n separately. Counting a transport failure as a bad response
// is the fastest way to make a benchmark lie.

export async function runArm({ scenario, setting, buildPrompt, generate }) {
  requireFunction(buildPrompt, "buildPrompt");
  requireFunction(generate, "generate");
  requireNonEmpty(setting, "setting");

  const inputs = buildTurnInputs(scenario);
  const priorOutputs = [];
  const samples = [];

  for (const input of inputs) {
    const prompt = buildPrompt({
      state: input.state,
      turnNumber: input.turnNumber,
      context: input.context,
      // A copy — a prompt builder must not be able to mutate the running history.
      priorOutputs: [...priorOutputs],
    });

    let result;
    try {
      result = await generate({ prompt, setting });
    } catch (cause) {
      samples.push(
        Object.freeze({
          scenarioId: scenario.id,
          setting,
          turnNumber: input.turnNumber,
          ok: false,
          error: ARM_ERROR.CALL_FAILED,
          reason: cause?.message ?? String(cause),
        }),
      );
      continue;
    }

    samples.push(
      Object.freeze({
        scenarioId: scenario.id,
        setting,
        turnNumber: input.turnNumber,
        ok: true,
        text: result.text,
        usage: Object.freeze({
          hidden: Number(result.usage?.hidden ?? 0),
          visible: Number(result.usage?.visible ?? 0),
        }),
        latencyMs: Number(result.latencyMs ?? 0),
      }),
    );

    // Only successful output joins the history. A failed turn must not leave a
    // hole that later turns silently paper over with fabricated continuity.
    if (result.text) priorOutputs.push(result.text);
  }

  return Object.freeze({ scenarioId: scenario.id, setting, samples });
}

// ── The controlled-comparison invariant ──────────────────────────────────────
// The whole comparison rests on every arm having seen identical inputs. This
// asserts it rather than assuming it, because a drifted harness produces a
// confident number that means nothing.

export function assertComparable(arms) {
  if (!Array.isArray(arms) || arms.length < 2) {
    throw new TypeError("assertComparable requires at least two arms");
  }

  const [first, ...rest] = arms;
  const shape = (arm) => arm.samples.map((s) => s.turnNumber).join(",");
  const reference = shape(first);

  for (const arm of rest) {
    if (arm.scenarioId !== first.scenarioId) {
      throw new Error(
        `Arms are not comparable: scenario ${arm.scenarioId} vs ${first.scenarioId}`,
      );
    }
    if (shape(arm) !== reference) {
      throw new Error(
        `Arms are not comparable: turn shape ${shape(arm)} vs ${reference}`,
      );
    }
  }

  const settings = new Set(arms.map((a) => a.setting));
  if (settings.size !== arms.length) {
    throw new Error("Each arm must sweep a distinct setting");
  }

  return true;
}

// ── Cost, derived rather than estimated ──────────────────────────────────────
// Computed from the usage the provider actually reported. The hidden/visible
// split matters: in the production finding, hidden tokens were the overwhelming
// majority of billed output while contributing nothing a user could see.

export function costOf(samples, pricePerMillionTokens) {
  if (!Number.isFinite(pricePerMillionTokens) || pricePerMillionTokens < 0) {
    throw new TypeError("pricePerMillionTokens must be a non-negative number");
  }

  const ok = samples.filter((s) => s.ok);
  const hidden = ok.reduce((sum, s) => sum + s.usage.hidden, 0);
  const visible = ok.reduce((sum, s) => sum + s.usage.visible, 0);
  const billable = hidden + visible;

  return Object.freeze({
    hidden,
    visible,
    billable,
    hiddenShare: billable === 0 ? 0 : hidden / billable,
    cost: (billable * pricePerMillionTokens) / 1_000_000,
  });
}

// ── Summary that cannot quietly launder failures ─────────────────────────────
// Reports n alongside every statistic, and never lets an errored call enter the
// mean. Hosted inference is not bit-reproducible, so a single run is a sample,
// not a measurement — `runs` is surfaced so a reader can judge the weight.

export function summarize(arm, { runs = 1 } = {}) {
  const ok = arm.samples.filter((s) => s.ok);
  const failed = arm.samples.filter((s) => !s.ok);
  const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  return Object.freeze({
    setting: arm.setting,
    runs,
    n: ok.length,
    errors: failed.length,
    meanHiddenTokens: mean(ok.map((s) => s.usage.hidden)),
    meanVisibleTokens: mean(ok.map((s) => s.usage.visible)),
    meanLatencyMs: mean(ok.map((s) => s.latencyMs)),
    // Explicitly surfaced so a caller cannot mistake a mostly-failed arm for a
    // clean one by reading only the means.
    complete: failed.length === 0,
  });
}

// ── Leak check, with its own noise documented ────────────────────────────────
// One call in the production system is accuracy-sensitive: the answer is sent to
// the model and only the instruction stops it leaking. This is a cheap heuristic
// screen, not a proof.
//
// HARD  — the whole answer appears. Treat as a failure.
// SOFT  — an unrevealed letter appears as an isolated token. Treat as REVIEW,
//         not failure: single letters that are also English words ("I", "A")
//         flag constantly on innocent text. A screen that cries wolf gets
//         switched off, so its false-positive mode is part of its contract.

export function leakCheck(text, answer, unrevealedLetters = []) {
  requireNonEmpty(text, "text");
  requireNonEmpty(answer, "answer");

  const upper = text.toUpperCase();
  const hard = new RegExp(`\\b${answer.toUpperCase()}\\b`).test(upper);
  const soft = unrevealedLetters.filter((letter) =>
    new RegExp(`(^|[^A-Z])${letter.toUpperCase()}([^A-Z]|$)`).test(upper),
  );

  return Object.freeze({
    hard,
    soft,
    verdict: hard ? "fail" : soft.length > 0 ? "review" : "clean",
  });
}
