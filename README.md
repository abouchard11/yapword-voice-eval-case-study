# Yapword: Benchmarking Subjective Model Output Against a Config Change

**~82% of inference spend was invisible. Removing it entirely cost nothing measurable.**

[Live product](https://yapword.com) ·
[iPhone app](https://apps.apple.com/us/app/yapword-ai-word-game/id6774829903) ·
[Engineering workfolio](https://midnightdev.dev/build-room)

> **Generate boldly. Validate cheaply. Kill ruthlessly. Scale what survives.**

My operating rule is simple: models propose and challenge; explicit authority
boundaries, human confirmation, and machine-checkable invariants decide what
ships.

Yapword is a daily word game with a persistent generative character. A
deterministic rules engine owns the board, the score, and the outcome. The model
owns the voice — reactions, hints, relationship memory, and the postgame roast.

Most of the inference bill was being spent on hidden reasoning tokens the player
never sees. The obvious fix — turn the thinking down — was untestable, because
the thing it might break has no reference implementation:

> **There is no correct output to diff against. "Is it funny" has no oracle.**

So the problem is not "lower the setting." It is **build a grader you can trust
for a property that cannot be checked automatically**, then let it decide.

## Public disclosure

This is a **sanitized engineering case study and executable reference model**,
not the private production source. It preserves the measurement design that
matters while withholding the system prompt, the character, credentials,
provider wiring, private analytics, and the production harness itself.

The prompt is the moat. It does not appear here, and the reference model takes
`buildPrompt` and `generate` as **injected functions** — which is also why every
failure path in this repo is reachable in a unit test with no network.

## What the code proves

| Invariant | Reference implementation | Test |
|---|---|---|
| Every arm sees byte-identical inputs | `buildTurnInputs` derives turns once, deterministically, frozen | Same scenario produces identical inputs; inputs are immutable |
| The comparison is asserted, not assumed | `assertComparable` rejects mismatched scenarios or turn shapes | Short arm, foreign scenario, and duplicate settings all throw |
| Cross-turn context accumulates truthfully | `runArm` feeds each call the model's own prior outputs, in order | Turn 3 sees turns 1–2; a mutating prompt builder cannot corrupt history |
| A transport failure is never a bad score | Failed calls become error samples, excluded from the mean | A failed turn leaves `n=2, errors=1` and does not dilute the mean toward zero |
| A failed turn does not fabricate continuity | Only successful output joins the history | Turn 3 sees turn 1 only — no placeholder for the failed turn 2 |
| Cost is derived, not estimated | `costOf` sums provider-reported usage and splits hidden from visible | Hidden share exceeds 97% on a high-thinking arm; zero on a minimal one |
| Statistics carry their own sample size | `summarize` always reports `runs`, `n`, `errors`, `complete` | A single run is labelled a sample, not a measurement |
| The safety screen documents its own noise | `leakCheck` separates a hard leak from a reviewable flag | The pronoun "I" false positive is asserted, not suppressed |

## Why a multi-turn bench, not a prompt A/B

The property under test is a **through-line**: the character ties turn 4 back to
turn 1 and tells the story the whole board is writing. A single-shot comparison
would have measured the wrong thing and cleared a setting that quietly destroys
continuity.

So the bench walks whole games turn by turn, feeding each call the accumulating
board state **and the model's own prior lines**, then the closing roast — at each
setting. That is the only arrangement where the thing that might break is
actually exercised.

## The finding

| Setting | Hidden tokens / game | Visible tokens | Latency | Cost / 1k games |
|---|--:|--:|--:|--:|
| minimal | **0** | 216 | 6.0s | **$0.00** |
| low | 4,065 | 158 | 24.5s | $36.59 |
| medium | 7,945 | 186 | 43.0s | $71.50 |
| high | 8,991 | 195 | 48.8s | $80.92 |

Visible output is ~170–216 tokens for an entire six-turn game. Hidden reasoning
was **95–98% of billed output tokens** — and buying it changed the imagery, not
the quality. Full tables, transcripts, and the loss-arc scenario are in
[`docs/thinking-floor.md`](docs/thinking-floor.md).

The accuracy-sensitive call — the one where the answer is sent to the model and
only the instruction stops a leak — was benchmarked separately across 36 samples
and leaked nothing at any setting. See
[`docs/leak-safety.md`](docs/leak-safety.md).

## What this does not claim

- **The grader is a human ear, deliberately.** The harness automates everything
  that is mechanizable — cost, latency, leak screening, controlled inputs — and
  routes the subjective judgment to a person. Pretending otherwise would be the
  dishonest part.
- **n is small.** Confirmation ran at 3 samples per cell. Hosted inference is not
  bit-reproducible at low temperature, so every figure above is a sample with a
  spread, not a point value. The summary type refuses to hide this.
- **One product, one property.** This measures voice continuity under cost
  pressure. It says nothing about correctness, safety beyond the leak screen, or
  any property it was not pointed at.

## Run it

```bash
npm test       # node --test, no network, no credentials
npm run check  # syntax check + tests
```

## Related

- [yapoleons-court](https://github.com/abouchard11/yapoleons-court) — the same
  harness lineage, forked and re-pointed at a different question: rubric fairness
  under adversarial pressure, with a calibration band and a negative control.
- [llm-safety-gate](https://github.com/abouchard11/llm-safety-gate) — a
  fail-closed publish gate extracted from a shipped product, same injectable
  design.

## License

[MIT](LICENSE) © 2026 Alex Bouchard (MidnightDev)
