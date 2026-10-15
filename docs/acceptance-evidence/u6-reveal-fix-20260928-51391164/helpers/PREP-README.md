# 51391164 U6 reveal-fix revalidation preparation

Ignored audit helpers only. At this review point the app has not been started, no file has been imported, no model has been called, and the prior isolated state has not been modified.

## Fixed identities

- Source/fix HEAD: 5893f7dc76bc87faa7c7907327807fb8893acb3d.
- Parent: 25fcd892e6ada40e2498e28e5aff9b7af26a0f71.
- Reused isolation root: VideoAutoCutDesktop/node_modules/.tmp/ui-u6-51388993-314c52f-20260928.
- New evidence phase: phase-51391164-5893f7d; old phase/raw/receipts are never overwritten.
- Reused state roots: prior user-data, data, config, appdata, temp, output, and pi-agent.
- Reused current.json SHA-256: 4f4d6dbe81e1e852715f1cc6eead62ff02b81c2d094d5213a339f4f2b703af21; version 3715aa42c0b71894dd62e0df28900b380aa5a43a.
- Frozen Candidate engine SHA-256: be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf.
- Formal U6 input SHA-256: 64d23f4889081c0239f396db40a4ef18744779232376eeba90d96c5d1ff48b63.
- Synthetic bad-shot input SHA-256: 81a76914dc7131ca818a545816c0b8dc8b71406c1653bc2c96228ff8f9acb761.

## Fixed Electron build

The start helper reuses the already validated build and refuses any byte change. It does not rebuild after launch authorization.

- dist-electron/main.js: 815d197af161b2e3051c67d0865645e29a35e80f45238260cb13a1bf15bbaad2
- dist-electron/preload.cjs: c61441a295d607b838767b45ff40aff3093df5e8658b7632677c345ead8ec836
- dist-electron/ipc-handlers.js: a4e27d3f0974e9da97e6ffb787023167bae7e582c66eece92322315ac58ad0ef
- dist-electron/script-reveal.js: 3e656a28571af9af52ca3873e49485ccec8b77ad4d4b81a618f3b3f86ee9eb15

## Sequence after root review

1. Run prepare-phase-51391164.ps1. It validates HEAD/status, protected hashes, Candidate/tools, inputs, existing persistence, free ports, current.json, and fixed build bytes. It creates only the new phase directories and copies these helpers.
2. Start start-phase-51391164.ps1 hidden. Both manifest aliases exist only in this process and point to the no-listener loopback URL http://127.0.0.1:9/runtime/manifest.json. No app.env write occurs. The observer performs one zero-import --help preflight.
3. Run the runtime gate with -Phase queue-folder -ExpectedClosedChildren 1, then inspect the native queue.
4. If the old failed queue is present, attempt its folder button exactly once. Because the new reveal allowlist is populated only by a successful task:start in the current main process, a persisted renderer-only card that cannot be authenticated is an immediate STOP; it is not grounds for a reimport.
5. If the old queue is absent, the instruction permits exactly one formal U6 import. Gate immediately before the click with -Phase formal-u6 -ExpectedClosedChildren 1; validate capture sequence 2, capture the two blocked details, click the folder button once, and capture Explorer selecting the frozen workbook.
6. Only after the formal folder behavior passes, gate bad-shot with expected closed children 1 or 2 according to whether formal was imported. Import the original bad-shot fixture once; validate actual sequence 2 or 3 and capture A2/-1/镜号.
7. Any mismatch is a STOP. No retry, input edit, gate edit, update click, Generate, or model call is allowed during U6.

The capture verifier retains the accepted outer engine exit 1 / inner normalize exit 2 contract, exact template warning and blocked facts, and zero-model markers.

U7 is not executed in this phase. After U6 succeeds and its evidence is committed, one GUI import click is authorized; default internal review and automatic HTTP retry behavior may run, all attempts must be counted, and no manual retry is permitted.