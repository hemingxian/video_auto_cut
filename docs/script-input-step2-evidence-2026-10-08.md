# 0.5.16 script input step 2 evidence (2026-10-08)

## Scope

Candidate branch `feature/0.5.16-script-input` started step 2 at `363f5f1bc7f4fb9fd5d0eeadd17174d0372845f8`. This step adds deterministic standard Markdown import only. It does not add organized AI import, voice-script mode, UI changes, packaging, publishing, or production configuration changes. Raw logs are in `D:\vac\s516-step2-evidence`.

## Implementation

- `script_markdown.py` uses the standard library for UTF-8/BOM/GB18030 decoding, fenced-code exclusion, detection, parsing, validation, `--check`, report output, and plan output.
- A template-version key inside `## 项目信息` makes the file a fail-closed standard-carrier candidate. Any value other than `VAC-SB-1`, including blank and arbitrary text, is blocked and never falls through to AI.
- Markdown and Excel use the same `script_spec` constants and the same extracted `script_template.build_shot` function. The Excel caller passes its already parsed `duration` and `duration_raw`; N1 proves its bytes did not change.
- `normalize_script.main` checks Markdown after Excel detection and before any upload or AI call. A blocked Markdown report emits the existing `VACUT_EVENT`, exits 2, and neither creates nor overwrites the requested plan output.

## M1–M7

Eight test methods implement the seven requirements; M2 has separate structural and output-safety methods:

| Requirement | Test method | Evidence |
| --- | --- | --- |
| M1 | `test_m1_detects_only_marked_md_or_txt_and_cli_is_silent_for_unmarked` | `.md`/`.txt`, silent unmarked result, and fenced fake marker ignored. |
| M2 | `test_m2_wrong_versions_and_all_structural_errors_are_blocked_with_lines` | Wrong/blank/arbitrary versions, malformed headings, skipped numbering, duplicate fields, aggregate errors, line locations. |
| M2 | `test_m2_blocked_cli_writes_report_but_never_creates_or_overwrites_plan` | Exit 2 writes diagnostics but preserves an existing plan. |
| M3 | `test_m3_multiline_bold_colons_crlf_bom_and_gb18030` | Multiline termination, key-only bold stripping, value colons/spaces, CRLF, BOM, GB18030, fenced fake shot exclusion. |
| M4 | `test_m4_ai_suggestions_warn_for_production_and_block_body_or_duration` | Production warnings; title, voice, subtitle, card text, and duration block even when `AI建议` is the first status line; exact value-line location. |
| M5 | `test_m5_unknown_keys_are_preserved_as_extra_columns` | Unknown key/value preserved in `extra_columns` with a warning. |
| M6 | `test_m6_repository_markdown_and_xlsx_are_deep_equal_except_listed_carrier_fields` | Repository `.md` and `.xlsx` deep-equal after removing only §4.2's listed carrier/source/cell differences and the known XLSX `项目` key. |
| M7 | `test_m7_standard_markdown_normalization_never_uploads_or_calls_models_or_urlopen` | Upload, main/secondary Qwen paths, progress review, card verification, query optimization, retry URL opener, and raw `urlopen` are guarded and called zero times; blocked main output is preserved/absent. |

Final targeted result: 8 tests passed.

## Repository dry-run

| File | Exit | Shots | Blocked | Warnings | Plan |
| --- | ---: | ---: | ---: | ---: | --- |
| `示例_食品码垛_v1.md` | 0 | 9 | 0 | 9 | written |
| `负例1_镜号跳号_应阻断.md` | 2 | 9 | 1 (`shot_no_invalid`) | 9 | not written |
| `负例2_字段重复_应阻断.md` | 2 | 9 | 1 (`duplicate_field`) | 9 | not written |
| `负例3_正文待确认_应阻断.md` | 2 | 9 | 1 (`text_cell_pending`) | 10 | not written |
| `提醒例_制作字段待确认_可导入.md` | 0 | 9 | 0 | 11 | written |
| `分镜脚本模板_v1.md` | 2 | 0 | 1 (`no_shots`) | 0 | not written |

The example and negatives 1 and 2 each contain nine authored `status_note` warnings. Negative 3 contains eight `status_note`, one `status_pending`, and one production `ai_suggested` warning, for ten warnings total; its body suggestion is the required block. The reminder example contains eight `status_note`, one `status_pending`, and two `ai_suggested` warnings, for eleven total. In those two files an AI line replaces one authored note, so the counts are not nine common notes plus extra warnings. The `status_note` entries are expected authored content, not parser errors.

## Non-regression and full suites

- N1: all five repository XLSX files and 225 generated fixture states remain byte-identical to a29; the final Python full run includes this audit.
- N2: Rust cache golden assertions remain unchanged and pass.
- N3: the existing template/legacy ASS byte comparison remains unchanged and passes.
- N4: the real a29/candidate open-save test passes. Per review 51473526, its prior source-SHA equality assertion was removed; the before state required identical extracted function source, while the after state compares the two actual saved JSON objects and preserves the business-field and no-`script_meta`/no-`script_source` assertions. This avoids coupling behavior acceptance to implementation text. The existing `createHash` import remains because the pre-existing checkpoint fixture still uses it for `plan_hash`.
- N5 Python: 651 run, 649 passed, 2 skipped, no failures or errors. The two skip names and reasons are unchanged from step 1.
- N5 Rust: 114 passed, 4 ignored; integration 5 passed. The ignored names and reasons are unchanged from step 1.
- N5 Desktop: 422 run, 420 passed, 2 skipped, no failures. The two skip names and reasons are unchanged from step 1.

The complete baseline skip/ignored names and reasons are recorded in the [step 1 evidence](script-input-step1-evidence-2026-10-08.md). Step 2 has no new skip or ignored test.

`cargo fmt --check` and `git diff --check` pass. Rust clippy reports the same nine step-1/a29 diagnostics. Desktop lint reports the same ten errors and one warning at the same files, positions, and rules; no new lint diagnostic was introduced.

The final commands were:

```text
python.exe -m unittest discover -s VideoAutoCut/tests -v
cargo test --all-targets --all-features
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
npm test
npm run lint
git diff --check
```
