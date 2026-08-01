# yapword-voice-eval-case-study

[![CI](https://github.com/abouchard11/yapword-voice-eval-case-study/actions/workflows/ci.yml/badge.svg)](https://github.com/abouchard11/yapword-voice-eval-case-study/actions/workflows/ci.yml)

**Benchmarking a generative character when there's nothing to diff against.**

Yapword is a daily word game with a persistent AI character. A deterministic rules engine owns
the board, the score, and the outcome. The model owns the voice — reactions to each guess,
contextual hints, relationship memory, and the postgame roast.

Roughly 82% of the game's inference bill turned out to be hidden reasoning tokens the player
never sees. Turning that setting down is a one-line change. Knowing whether it broke anything
is the hard part: the thing at risk is whether the character is still funny, and there is no
correct output to compare against.

Extracted and generalized from the production harness of a shipped app — so the design
decisions below aren't hypothetical.

- **Zero runtime dependencies** — plain ESM, Node 20+.
- **Provider-agnostic** — you inject `buildPrompt` and `generate`. Your prompt, your model,
  your transport.
- **Unit-tested** — every invariant carries a test, and both injected functions are fakes in the
  suite, so the failure paths run without a network.

## Public disclosure

This is a sanitized case study and executable reference model, not the production source. The
system prompt, the character definition, credentials, provider wiring, private analytics, and
the real harness are excluded.

## Run it

```bash
npm test       # node --test — no network, no credentials
npm run check  # syntax check + tests
```

## Why the bench walks whole games

The property at risk is a through-line. The character ties guess four back to guess one and
escalates a running joke across the board. A single-shot prompt A/B can't see that, so it would
have cleared a setting that flattens continuity.

Each arm replays a complete game turn by turn against the real prompt builder, feeding every
call the accumulating board state and the model's own prior lines, then the closing roast, at
each setting. Two scenarios pull in opposite directions: a win-grind where one letter stays
misplaced until the final guess, and a loss where the player opens with the same wrong letter
six times.

## What the code enforces

| Invariant | Implementation | Test |
|---|---|---|
| Every arm sees identical inputs | `buildTurnInputs` derives turns once, deterministically, frozen | Same scenario produces identical inputs; inputs are immutable |
| Comparability is checked, not assumed | `assertComparable` rejects mismatched scenarios and turn shapes | Short arm, foreign scenario, and duplicate settings all throw |
| Cross-turn context accumulates in order | `runArm` feeds each call the model's own prior outputs | Turn 3 sees turns 1–2; a mutating prompt builder can't corrupt history |
| A transport failure isn't a bad score | Failed calls become error samples, excluded from the mean | A failed turn leaves `n=2, errors=1` without dragging the mean down |
| A failed turn doesn't invent continuity | Only successful output joins the history | Turn 3 sees turn 1 only — no placeholder for the failed turn 2 |
| Cost comes from reported usage | `costOf` sums provider metadata, splitting hidden from visible | Hidden share exceeds 97% on a high arm, zero on a minimal one |
| Statistics carry their sample size | `summarize` reports `runs`, `n`, `errors`, `complete` | A single run is labelled a sample, not a measurement |
| The leak screen documents its noise | `leakCheck` separates a hard leak from a reviewable flag | The pronoun "I" false positive is asserted rather than tuned away |

## What the sweep found

| Setting | Hidden tokens / game | Visible tokens | Latency | Cost / 1k games |
|---|--:|--:|--:|--:|
| minimal | **0** | 216 | 6.0s | **$0.00** |
| low | 4,065 | 158 | 24.5s | $36.59 |
| medium | 7,945 | 186 | 43.0s | $71.50 |
| high | 8,991 | 195 | 48.8s | $80.92 |

A whole six-turn game produces 170–216 visible tokens. Hidden reasoning was 95–98% of billed
output and 5–10× the latency, and buying it changed the imagery rather than the quality. At zero
thinking the character still built across turns: *"You went from a RANCH to the FAWNS. Your grid
is beginning to look less like a strategy and more like a poorly managed petting zoo."*

Full tables, both scenarios, and side-by-side transcripts are in
[`docs/thinking-floor.md`](docs/thinking-floor.md).

One call is accuracy-sensitive rather than aesthetic: the hint, where the answer is sent to the
model and only the instruction stops a leak. Benchmarked separately across 36 samples, it leaked
nothing at any setting — [`docs/leak-safety.md`](docs/leak-safety.md).

## Limits

- **n is 3 per cell.** Hosted inference isn't bit-reproducible even at low temperature, so every
  figure above is a sample with a spread. `summarize` reports `runs` so a reader can weigh it.
- **One product, one property.** This measures voice continuity under cost pressure. It says
  nothing about correctness, or about safety beyond the hint screen.
- **The aesthetic call is a human's.** The harness automates what's mechanizable: controlled
  inputs, cost, latency, and leak screening. "Is it still funny" goes to a person.

## Related

- [yapoleons-court](https://github.com/abouchard11/yapoleons-court) — the same harness, forked
  and pointed at a different question: rubric fairness under adversarial pressure, with a
  calibration band and a negative control.
- [llm-safety-gate](https://github.com/abouchard11/llm-safety-gate) — a fail-closed publish gate
  extracted from a shipped product, built on the same injectable design.

[Live product](https://yapword.com) ·
[iPhone app](https://apps.apple.com/us/app/yapword-ai-word-game/id6774829903) ·
[Engineering workfolio](https://midnightdev.dev/build-room)

## License

[MIT](LICENSE) © 2026 Alex Bouchard (MidnightDev)
