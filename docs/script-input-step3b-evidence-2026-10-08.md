# Script input 0.5.16 step 3b evidence

## Scope and baseline

Step 3b is based on `dfe947ec9ca5d7e0df3eecf23c7812b3ca97c57a`. It adds the optional
`--voice-script-body` path without changing the no-option contract. The implementation consists of six
files:

- `VideoAutoCut/tools/normalize_script.py`
- `VideoAutoCut/tools/optimize_queries.py`
- `VideoAutoCut/tools/script_organize.py`
- `VideoAutoCut/tools/script_voice.py`
- `VideoAutoCut/tools/prompts/script_parse_voice_script.md`
- `VideoAutoCut/tests/test_voice_script.py`

The original seven-file candidate remains untouched in `D:/vac/s516-step1@fd3f1e2`. This implementation
was migrated into the detached `D:/vac/s516-step3b` worktree, so the organizer fixes already present in
`dfe947e` remain intact.

## Behavior

The option reads the confirmed voice body as UTF-8 (BOM accepted) or GB18030 and records the SHA-256 of
the original bytes. The body is placed directly in the dedicated prompt; the original script file is not
uploaded. One model parse is allowed and deliberately uses `http_attempts=1`, so voice-script mode makes
only one HTTP attempt and does not use the ordinary retry default. `voice_start` markers must match the body
in order under the specified whitespace-only normalization. The deterministic slicer then derives every
`voice_text`; an independent final concatenation gate blocks output unless all slices reproduce the body.
The mode deliberately skips the ordinary voice/subtitle and progress-label (chapter-label language) model
reviews. This is an intentional tradeoff: the confirmed body stays authoritative and the mode avoids extra
model calls, while chapter-label language is not separately rechecked in this path.

The confirmed body file is also passed as `script_organize.organize(..., evidence_path=voice_body_path)`,
so `card_content`, `card_hint`, and `material_source` are checked against the same confirmed body rather
than the original file. `subtitle` is always absent/empty. No real upload, model, or HTTP request was made
during acceptance; all tests use fixed fixtures and mocks.

`optimize_queries.call_qwen` accepts optional `http_attempts`. When it is supplied, the value reaches
`urlopen_with_retry(attempts=...)`; when omitted, the keyword is not passed. The unchanged `common.py`
therefore continues to use `VIDEOAUTO_HTTP_RETRIES` (default 5) and its existing delay behavior. This is a
mocked parameter-chain compatibility proof, not a real HTTP retry experiment.

## V1–V12

| Gate | Evidence |
| --- | --- |
| V1 | Nine fixed shots slice and concatenate to the confirmed body exactly; recorded spans are exact. |
| V2 | Internal deletion, insertion, or changed character in `voice_start` blocks with `voice_start_not_found`. |
| V3 | A first marker that does not start at the first non-whitespace character, or reversed markers, blocks with `voice_start_out_of_order`. |
| V4 | Whitespace, line-break, and full-width-space differences pass. |
| V5 | Punctuation width changes block; punctuation is not normalized away. |
| V6 | A separately injected wrong slice is caught by the final `voice_script_mismatch` concatenation gate. |
| V7a | Standard xlsx/md use fixed dfe `normalize_script.py`; on the same input/output path, dfe no-option and candidate no-option JSON bytes and stdout are identical. With the option, plan bytes remain identical and `voice_script_ignored` is emitted. |
| V7b | Ordinary AI paths export the complete fixed dfe tools tree and run it separately from candidate tools. Both the no-review and voice-review fixtures use the same input/output path; JSON bytes and stdout are identical. |
| V8 | `voice_mode=verbatim`, raw body SHA, per-shot `field_origin.voice_text=script`, no AI voice suggestion, and empty/absent subtitle are asserted. |
| V9 | Missing body blocks with exit 2, exact `voice_script_missing` in `VACUT_EVENT`, and no output fallback. |
| V10 | Exactly one main parse and no upload/reviews; explicit `http_attempts=1` reaches `urlopen_with_retry`, while omission preserves the old default keyword path. |
| V11 | UTF-8 BOM, CRLF, and GB18030 bodies decode; the stored SHA is over the untouched raw bytes. |
| V12 | A four-character first-shot marker (`大家好。`) passes and slices both shots exactly; a first marker that extends into shot 2 is blocked with `voice_start_out_of_order`, a `VACUT_EVENT` failure, and an overlap-specific message. True reversed order still reports `顺序倒置`. |

All blocking tests assert exit 2, `workflowStatus=failed`, and the exact blocked code in `VACUT_EVENT`.
Focused `test_voice_script` plus `test_script_organize` ran 26 tests and passed after the V12 narrow fix.

## Prompt audit

Rule 4 before comment 51476093 was:

> 4. subtitle、card_content、card_hint、material_source 一律留空。不得从口播正文生成字幕、上屏文字、卡片提示、素材路径或取段时间。

The authorized replacement is:

> 4. subtitle 一律留空。card_content、card_hint、material_source 只逐字摘取确认后口播正文中明写的内容；没有明写则留空，禁止从叙述推断或生成，禁止编造路径或取段时间。

For the short-shot fix, rules 2–3 before comment 51485020 were:

> 2. 每镜只返回 voice_start：该镜在确认正文中开头连续 8–20 个字，必须逐字照抄；空白和换行可保留或省略，标点、全半角、数字写法不得变化。
>
> 3. 第 1 镜 voice_start 必须从正文第一个非空白字符开始；后续 voice_start 必须按正文顺序出现。

The authorized replacement is:

> 2. 每镜只返回 voice_start：该镜在确认正文中开头连续 8–20 个字；本镜口播不足 8 字时照抄本镜全部，不得延伸到下一镜。必须逐字照抄；空白和换行可保留或省略，标点、全半角、数字写法不得变化。
>
> 3. 第 1 镜 voice_start 必须从正文第一个非空白字符开始；后续 voice_start 必须按正文顺序出现，且各镜摘录不得重叠。

The narrow fix did not rerun the full Python, Rust, or Desktop suites because Mac explicitly allowed the
focused scope when only the prompt, `script_voice.py`, and its test changed. The focused 26-test run is the
relevant regression surface; no real model, upload, or HTTP request was made.

The complete prompt is the tracked
[`script_parse_voice_script.md`](../VideoAutoCut/tools/prompts/script_parse_voice_script.md). In the original
step 3b migration, rules 1–3 and 5–7 were unchanged. The 2026-10-09 short-shot fix changes only rules 2–3;
rules 1 and 4–7 remain unchanged by that fix.

## 2026-10-08 original 848aee6 N1–N5 full verification (not rerun for the 2026-10-09 narrow fix)

- N1: the final Python run audited the five checked-in XLSX files plus 225 generated fixture states
  against `a29d74f`; all passed. The same run collected 676 tests, with 674 passed and 2 skipped, no
  failures or errors.
- N2: `cargo test --all-targets --all-features` passed: unit 114 passed / 4 ignored and integration
  5 passed; the existing incremental-cache golden was not modified.
- N3: fixed template and legacy plans were run through the a29 and candidate ASS generators. Template
  output was 5,335 bytes on both sides with SHA-256
  `a7939deab74d26f062d2e5684fb5c167c6cda9bb0a97304f003ea152f9524081`; legacy output was 1,733
  bytes on both sides with SHA-256
  `f92c04ff0b1d951fbfd5579fc3fcd6fb273bb28b6c6890a758555b68c66a4d29`. Both pairs are byte-equal.
  This is an ASS generation probe, not a real render.
  The isolated a29 worktree was verified first: all 50 tracked Python files beneath
  `VideoAutoCut/tools` matched their a29 blobs, the worktree was clean, and `render_segment` imported
  from that verified worktree.
- N4: Desktop's real a29/candidate open-and-`saveShots` deep-equality regression passed; it retains old
  business fields and does not persist `script_meta` or `script_source`.
- N5: Python 676 run / 674 passed / 2 skipped; Rust 119 passed / 4 ignored; Desktop 422 run / 420
  passed / 2 skipped. All three commands exited 0 with no failure. Candidate initially had no
  `node_modules`, so one Desktop environment-preparation command failed before tests started; the accepted
  isolated dependency junction was then used for the final run and removed afterward.

The two Python skips are unchanged from a29:

- `test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition`
- `test_script_card_fields.ScriptLayoutRenderTests.test_real_hyperframes_lint_accepts_the_headline_card`

Both retain the existing missing HyperFrames runtime-component reason. Step 3b adds no skip.

Rust's four ignored names/reasons remain the a29 set: real task copy; corruption/concurrent producer
regression; three-source encode regression; and bundled FFmpeg benchmark. Desktop's two skips remain the
case-insensitive Windows filename collision and host-denied symlink tests. `baseline-validation.json`
records equal skip/ignored names and no additions.

Raw candidate evidence is in `D:/vac/s516-step3b-evidence-51476093/`. The final focused and Python-full
logs were persisted there with command and exit receipts. Earlier system-Python and pre-final runs existed
only in Codex tool output: the system interpreter collected 668 tests but failed two imports because
`click` and `dotenv` were absent; an initial 24-test focused run and a pre-final 675-test embedded-Python
run were later superseded. They have honest summary receipts only and are not presented as raw logs or
formal acceptance.

No real model, upload, production configuration, package, render, or step 4 action was performed as part
of this evidence.

## 2026-10-09 short-shot acceptance

The narrow fix was validated with the existing embedded Python interpreter from worktree root using these
two exact focused commands:

```text
D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.15\VideoAutoCut\python-3.11.9-embed-amd64\python.exe -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_voice_script.py
D:\Video Edit\VideoAutoCut\workspace\runtime\0.5.15\VideoAutoCut\python-3.11.9-embed-amd64\python.exe -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_script_organize.py
```

The accepted run passed 14 `test_voice_script` tests and 12 `test_script_organize` tests, 26 total. Raw
logs, exit receipts, prompt snapshots, hashes, and the local reply draft are in
`D:/vac/s516-step3b-short-voice-evidence-51485020/`.

Before that accepted run, one collected V12 development run had one test failure because its successful
branch left an output file that the following blocked branch's helper mistook for new output. Production
had blocked correctly; only test isolation was fixed by removing the successful branch's output before the
blocked branch. Separately, two command attempts used a module-name entry point that was not importable by
the embedded interpreter; both failed with `ModuleNotFoundError: tests` before collecting tests. These
early raw logs were visible only in Codex tool output and were not saved, so they are disclosed in the raw
evidence summary and are not reconstructed or presented as acceptance logs.
