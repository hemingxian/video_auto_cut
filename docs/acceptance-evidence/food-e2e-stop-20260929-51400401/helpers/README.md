# Food Route A helper (51400401)

Static preparation only. Do not run either engine phase before root review.

- `run-plan-only.mts` is derived from `docs/acceptance-tools/run-plan-only.mts` (base SHA-256 `7cf198e65fafb731b869d213e5b4c640072ef602b3c5782fa22dc326408ded35`). It adds fresh-root confinement, one-attempt protection, executable/source locks, and private raw stream evidence. Its current SHA is recorded by the static receipt.
- `prepare_route_a.py` accepts the fresh plan-only `shots.json`. It deep-checks that its only edits are the contract binding fields and the shot-2 U3 subtitle/hint; it requires the fixture-authored shot-8 subtitle/hint unchanged. It creates a fresh nine-shot manifest by copying only the six frozen material identity records.
- `run-formal-route-a.mts` runs the engine exactly once with `--restart-all`. It refuses an existing formal-attempt marker, records the executable path and SHA next to spawn, captures private raw stdout/stderr bytes, and writes a derived redacted log. There is no retry path.

The audit directory is ignored. Production source, production `app.env`, the fixture, the accepted saved plan, and the batch4 manifest are read-only inputs.
