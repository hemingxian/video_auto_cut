# 0.5.16 script input step 1 evidence (2026-10-08)

## Scope and revisions

- Candidate branch: `feature/0.5.16-script-input`; pre-commit HEAD: `0a5d8c99d4d5e6268a7ddcc7c5c4db03b5b6c433`.
- Compatibility baseline: `a29d74f8216fa2960b5f4591b1c5b66d428df1f7`.
- The baseline Rust worktree differs from a clean a29 checkout only by the two step-1 golden assertions in `src/incremental.rs`; production sources are a29. Those assertions were also run directly in that worktree.
- Raw command logs are outside the repository in `D:\vac\s516-step1-evidence`.

## Change and red/green result

Step 1 moves the existing spreadsheet contract constants into `VideoAutoCut/tools/script_spec.py`; `script_template.py` imports them. It adds regression coverage only. No save implementation, model call, import workflow, packaging, publishing, or production configuration was changed.

Before the production move, the new contract test failed because `script_spec` did not exist. The byte-compatibility checks are regression tests and were expected to pass before the move; they are not presented as artificial red tests. After the move, the final Python run ran 643 tests: 641 passed, 2 skipped, no failures or errors.

## N1: spreadsheet compatibility

The test archives the complete a29 `VideoAutoCut/tools` and `VideoAutoCut/config` trees with `git archive`; absence or failure of Git fails the test. Candidate and a29 run sequentially against the same physical input. Return code, raw stdout/stderr, report bytes, and plan bytes are compared without key sorting, field removal, or path normalization.

The five repository workbooks were byte-compatible:

- `分镜脚本模板_v1.xlsx`
- `分镜脚本示例_上下料_v1.xlsx`
- `转换演示_v1表格.xlsx`
- `转换演示_md文本.xlsx`
- `示例_食品码垛_v1.xlsx`

All generated workbook states captured after fixture writes and ZIP-member rewrites were also checked. Final result: 39 script-template tests passed, 225 generated fixture states audited, and 7 fill tests passed. The full suite contains these checks.

## N2: Rust cache identity

The same golden assertions ran against a29 production code and the candidate:

- shot render hash: `6e8199ed9d0c7a5e5327cc486417a7be821172046ee0ff5b0466821e8ff0f55d`
- old/template aggregate compose hash: `434b7cb594b3aaa3f826b26d2b5bfd1a21dcfb1de0730d39480a194d90c128ea`

The a29 proof is recorded in `rust-a29-hash-probe.log`; the candidate proof is included in `rust-candidate-final.log`.

## N3: ASS compatibility

The regression test imports the real template plan and supplies a legacy plan, then invokes the a29 and candidate `render_segment.write_combined_ass` paths. Stdout, stderr, and ASS bytes match. A separate deterministic audit probe recorded:

| Input | Input SHA-256 | a29 and candidate ASS SHA-256 |
| --- | --- | --- |
| Template plan | `0f2a869521e8c0b7fb8557ec7898a91eadb0e889548472740fd1f90ba0911222` | `a7939deab74d26f062d2e5684fb5c167c6cda9bb0a97304f003ea152f9524081` |
| Legacy plan | `999e85b9ebddad96931a889c935a2daa10d5b1a6cef30c221489d77458202faa` | `f92c04ff0b1d951fbfd5579fc3fcd6fb273bb28b6c6890a758555b68c66a4d29` |

## N4: real open/save compatibility

The desktop test parses the a29 and candidate TypeScript source with the TypeScript AST, extracts the actual nested `saveShots` function, and executes it with a write-file capture. Each side opens the same legacy fixture through its real `parseShotsJson`, with `shotPlan.dirty` set to `false`, then saves without edits.

The two saved JSON objects are deep-equal. Existing business fields remain equal to the input; the only allowed a29-era changes are `task_revision` increment, `schema_version`, and `material_source_mode`. Neither output adds `script_meta` nor `script_source`. Final desktop output includes `N4 a29 and candidate real open-save paths preserve identical legacy business data`.

## N5: full verification

| Stack | Candidate | a29 baseline | Skip/ignored comparison |
| --- | --- | --- | --- |
| Python | 643 run, 641 passed, 2 skipped | 640 run, 638 passed, 2 skipped | Exact test names and reasons match. Candidate adds the three step-1 tests. |
| Rust | 114 passed, 4 ignored; integration 5 passed | 114 passed, 4 ignored; integration 5 passed | Exact names and reasons match: real task copy; corruption/concurrent producer regression; three-source encode regression; bundled FFmpeg benchmark. |
| Desktop | 420 passed, 2 skipped | 419 passed, 2 skipped | Exact names/reasons match: case-insensitive filename collision on Windows; symlink creation denied by host. Candidate adds N4. |

Candidate `npm run build` and `npm run build:scripts` both passed. `cargo fmt --check` passed. `git diff --check` passed.

The complete Python skip list on both revisions is:

- `test_packaging_agent.PagedCompositionTests.test_real_hyperframes_lint_accepts_the_paged_composition` — `没有 HyperFrames 运行组件，跳过真 lint：模板包装缺少运行组件：内置 Node、HyperFrames 0.7.3、GSAP 3.14.2、Chrome Headless Shell。请修复运行环境，或在画面样式中关闭模板包装后重试。`
- `test_script_card_fields.ScriptLayoutRenderTests.test_real_hyperframes_lint_accepts_the_headline_card` — the same missing-component reason.

The complete Rust ignored list on both revisions is:

- `final_video::tests::real_task_copy_composes_from_legacy_and_recorded_paths` — `requires VIDEOAUTO_TEST_RUNTIME, VIDEOAUTO_TEST_RUN and a new VIDEOAUTO_TEST_OUTPUT directory`
- `normalization_cache::tests::real_corruption_source_config_changes_and_parallel_producers_are_verified` — `Requires bundled FFmpeg/ffprobe; corruption and concurrent producer regression`
- `normalization_cache::tests::real_three_sources_two_shots_and_new_task_encode_only_three_times` — `Requires bundled FFmpeg/ffprobe; isolated real-media regression, no models or user data`
- `video_encoder::tests::bundled_ffmpeg_benchmark_smoke` — `requires the bundled FFmpeg and may use local GPU hardware`

The complete Desktop skip list on both revisions is:

- `rejects a case-insensitive collision when it is a different physical file` — `A case-insensitive Windows file system cannot create both test names`
- `rejects symbolic-link files instead of following them` — `The host does not permit file symlinks: Error: EPERM: operation not permitted, symlink '<temporary real.mp4>' -> '<temporary linked.mp4>'` (only the randomized temporary-directory component differs between runs).

The same Rust 1.98 clippy command reports the same nine pre-existing diagnostics on both revisions: `final_video.rs:273` (`collapsible_if`), `incremental.rs:525` (`too_many_arguments`), `incremental.rs:666` (`collapsible_if`), `main.rs:352`, `507`, and `624` (`collapsible_if`), and `main.rs:771`, `846`, and `881` (`needless_borrow`). The same desktop lint command reports the same ten errors and one warning on both revisions, with identical file, line, column, and rule after normalizing the worktree root and diagnostic padding whitespace. These baseline failures were not changed or suppressed.

The Desktop diagnostics on each revision are:

| File | Line:column | Severity | Rule |
| --- | --- | --- | --- |
| `src/App.tsx` | `58:47` | error | `react-hooks/set-state-in-effect` |
| `src/motion-filter-preview.tsx` | `31:10` | error | `react-refresh/only-export-components` |
| `src/motion-filter-preview.tsx` | `72:10` | error | `react-refresh/only-export-components` |
| `src/pages/materials/MaterialDeleteDialog.tsx` | `85:10` | error | `react-hooks/set-state-in-effect` |
| `src/pages/materials/MaterialMediaPlayer.tsx` | `43:5` | error | `react-hooks/set-state-in-effect` |
| `src/pages/materials/MaterialMoveDialog.tsx` | `60:10` | error | `react-hooks/set-state-in-effect` |
| `src/pages/materials/PublicMaterialDialog.tsx` | `58:10` | error | `react-hooks/set-state-in-effect` |
| `src/pages/materials/PublicMaterialDialog.tsx` | `59:6` | warning | `react-hooks/exhaustive-deps` |
| `src/pages/materials/useMaterialsLibrary.ts` | `163:10` | error | `react-hooks/set-state-in-effect` |
| `src/pages/start/ScriptFilesDialog.tsx` | `53:7` | error | `react-hooks/set-state-in-effect` |
| `src/pages/start/ShotEditorDrawer.tsx` | `114:33` | error | `react-hooks/set-state-in-effect` |

## Commands

All commands used the repository's existing environments.

```text
python.exe -m unittest discover -s VideoAutoCut/tests -v
cargo test --all-targets --all-features
cargo clippy --all-targets --all-features -- -D warnings
npm test
npm run build
npm run build:scripts
npm run lint
git diff --check
```
