# Step 2 bold-field parser fix evidence (2026-10-08)

## Scope

This is the review-requested follow-up to step 2 commit `17859965906957d1f7d31e9ff02e5ada87176203`. It changes only `VideoAutoCut/tools/script_markdown.py`, its existing M3/M6 tests, and this evidence file. It does not begin step 3 or change AI, UI, packaging, rendering, or configuration behavior. Raw evidence is in `D:\vac\s516-step2-fix-evidence`.

## Before and after

The exact parser from `1785996` was extracted with Python AST from `git show` and executed against the same inputs as the candidate. The UTF-8 JSON records are `before-1785996-field-parser.json` and `after-candidate-field-parser.json`.

Before, `- **口播：** 这是口播` parsed as key `口播` and value `** 这是口播`; the no-space and half-width-colon forms had the same stray closing marker. `- **模板版本：** VAC-SB-1` similarly produced value `** VAC-SB-1`.

After the fix, all of these produce clean keys and values:

- full-width or half-width colon inside the bold key;
- a space or no space before the value;
- the previously supported `- **口播** ：内容` and half-width form, including whitespace before the colon;
- bold project-information keys such as `- **模板版本：** VAC-SB-1`.

Only key markup is consumed. `- **口播：** 这是**口播**` preserves the value as `这是**口播**`, and an ordinary key whose value begins with bold text (`- 口播：**开头**正文`) preserves `**开头**正文` exactly.

## Tests

M3 now directly covers the issue's `口播` and `字幕` forms with full-width/half-width colons, spacing variants, the old outside-colon form, bold project information, internal value bold, and a non-bold key whose value begins with `**`. It asserts final `voice_text`, `subtitle`, title, and project information values.

M6 additionally sends both repository examples (`示例_食品码垛_v1.xlsx` and `.md`) through the production `normalize_script.main()` entry. Upload, primary and review model calls, query optimization, card verification, retry networking, and raw `urlopen` are all mocked to raise; every call count remains zero. The two final output files are deep-equal after removing only the differences listed in specification §4.2. No additional field or path is excluded.

Targeted result: all 8 `test_script_markdown.py` methods pass.

## Regression result

- Final Python: 651 run, 649 passed, 2 skipped, no failures or errors.
- N1 inside that run: all five repository XLSX files and 225 generated fixture states remain byte-identical to a29.
- N2/N3 assertions remain unchanged and pass in this fix's current Rust/Python full runs.
- N4 and the current Desktop full suite pass: 420 passed, 2 skipped.
- Current Rust full suite: 114 passed, 4 ignored; integration 5 passed.
- Skip/ignored names and reasons remain those recorded in the [step 2 evidence](script-input-step2-evidence-2026-10-08.md), with no new skip.

The final logs are `python-final-after-compat.log`, `rust-final.log`, and `desktop-final.log`. `git diff --check` and Python compilation pass. The protected main-workspace package files remain unchanged.
