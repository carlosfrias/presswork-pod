# Evals

Behavioral regression tests for the most expensive failure modes in the agent pipeline.

## Layout

Eval specs live **inside the workspace whose code they exercise**, so they run under that workspace's existing Vitest config (correct module resolution for `@presswork/shared`, no test-runner duplication):

| Surface | Spec location |
|---|---|
| Copywriter prompt + compliance gate | `packages/listing/evals/copywriter/` |

This top-level `evals/` directory is the discoverability surface. New eval surfaces should add a row above and link to their workspace location.

## Why these are eval-shaped, not unit-shaped

Eval cases pin **behavior across fixed inputs**, with the model response replayed from a captured baseline. Unit tests pin code-level invariants; evals pin end-to-end behavior on representative scenarios. A prompt change that drifts the model's output won't trip a unit test but will trip the captured-response eval the next time the live capture is refreshed.

## Running

```bash
# Replayed mode (default — fast, deterministic, CI-safe):
npm test --workspace=packages/listing -- evals

# Live mode (hits the real Anthropic API to refresh captures):
EVAL_LIVE=1 npm test --workspace=packages/listing -- evals
```

The replayed mode uses the JSON text saved in each spec's `__captures__/` directory. CI runs only the replayed mode.

## Adding a fixture

1. Create `packages/listing/evals/<surface>/fixtures/<case>.json` describing the input (`brief`, `design`, expectations).
2. Run with `EVAL_LIVE=1` once to write the corresponding `__captures__/<case>.json`.
3. Run the replayed mode to confirm the case is now stable.
4. Commit fixture + capture together.

If a future capture drifts (because the prompt changed intentionally), delete the capture and rerun `EVAL_LIVE=1` — review the diff before committing.

## Prompt snapshot

Each surface also snapshots the prompt source text. A prompt edit that's intentional needs `vitest --update` to refresh the snapshot, which forces an explicit review during code review.
