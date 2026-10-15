# Step 5 S2 scope correction — Mac 51489425

This evidence supersedes the card-whitespace interpretation in `../step5-s2-wrap-20261009/card-space-browser-evidence.json`. The two historical fixtures and PNGs `card-space-normal-browser.png` and `card-space-headline-browser.png` were produced under an earlier authorization misunderstanding. They are withdrawn as acceptance evidence: S2 preserves exact soft-wrap whitespace only for `cjk_word_boundaries=True` subtitle calls. Default progress wrapping and `kinsoku=True` card wrapping now retain the a3e64b4 behavior, and card HTML no longer emits `white-space:pre`.

## Product scope

- `text_units()` again uses the a3e64b4 `\s+` grouping. Subtitle-only `_subtitle_plain_text_units()` separates CRLF/LF/CR and retains other whitespace exactly.
- `wrap_text(..., cjk_word_boundaries=False)` uses the a3e64b4 algorithm. Pending-space accumulation, carrying a separator across a soft break, explicit-line indentation, orphan reflow without `rstrip`, the kinsoku `moved` whitespace, and the preceding-separator width guard execute only in the subtitle branch.
- `template_packaging.py` removes the conditional `white-space:pre` CSS from both normal and `headline_sub` cards. Tests assert neither generated path contains that style.
- The two cache tests compare against resolved expected paths, matching production behavior on macOS `/var` → `/private/var` without changing cache production code.

## Independent baseline oracle

`LegacyWhitespaceDifferentialTests` executes `git show a3e64b4:VideoAutoCut/tools/text_layout.py`, imports that exact module from a temporary directory, and compares its returned line lists with the current default and kinsoku paths. No copy of expected wrapping logic is used in the test.

Coverage is 374 comparisons:

- 7 required categories × 2 modes = 14: the four Mac examples, mixed Chinese/English, U+3000 full-width space, and CRLF.
- 18 deterministic strings × 10 widths × 2 modes = 360, including empty/leading/trailing/double whitespace, tabs, explicit newlines, number-unit text, punctuation, identifiers, and mixed scripts.

## Focused validation

Pinned interpreter:

`D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut\python-3.11.9-embed-amd64\python.exe`

All commands used `PYTHONDONTWRITEBYTECODE=1` and `-I -B -X utf8`:

```text
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_text_layout.py
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_template_packaging.py
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_script_template.py
```

Results:

- `test_text_layout.py`: 43/43 passed, including all 374 a3e64b4 comparisons.
- `test_template_packaging.py`: 17/17 passed.
- `test_script_template.py`: 40/40 passed; N1 still audited 225 generated fixture states.

See `focused-receipt.json` and the adjacent `*.stdout.log` / `*.stderr.log` files. These focused results were captured before publication. No video, package, or upload was produced.
