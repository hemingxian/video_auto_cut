# Step 5 S2 wrapping evidence

This directory contains offline single-frame and text receipts only. No final video was rendered.

## Subtitle frames

- Real food task, shot 8: [before](food08-before.png) / [after](food08-after.png), with [before ASS](food08-before.ass) / [after ASS](food08-after.ass). The old break is `托盘规/格`; the new break is `托盘/规格`.
- Targeted reproduction: [before](targeted-before.png) / [after](targeted-after.png), with [before ASS](targeted-before.ass) / [after ASS](targeted-after.ass). This is an unpunctuated long-sentence reproduction fixture over the real shot-8 background, not another customer shot.
- Exact visible-line joins, codepoint assertions, U+0020 counts, dimensions, and file hashes: [subtitle-evidence.json](subtitle-evidence.json).

Both frame pairs are 1920×1080 PNGs. FFmpeg/libass produced one frame per ASS file using the same source and time point within each pair. The food shot-8 after frame also reuses the real card overlay. Production output was read only.

## Tokenizer supply chain and cache

- Vendoring source, retained-file list, byte sizes, and SHA-256: [JIEBA-0.42.1.md](../../../VideoAutoCut/tools/_vendor/JIEBA-0.42.1.md).
- Preserved MIT license: [LICENSE](../../../VideoAutoCut/tools/_vendor/jieba/LICENSE).
- Two-process cold/warm result and cache-policy receipt: [jieba-cache-and-vendor.json](jieba-cache-and-vendor.json).
- Raw benchmark outputs: [cold stdout](jieba-cold.stdout.json), [cold stderr](jieba-cold.stderr.log), [warm stdout](jieba-warm.stdout.json), [warm stderr](jieba-warm.stderr.log).

The benchmark used two fresh embedded-Python processes with `-I -B -X utf8`, a single newly-created isolated workspace, and no user-cache deletion. Cold load was 364.077 ms; warm disk-cache load was 331.593 ms.

## Focused verification

All commands used the pinned embedded Python with `PYTHONDONTWRITEBYTECODE=1`:

```text
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_text_layout.py
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_template_packaging.py
python.exe -I -B -X utf8 -m unittest discover -s VideoAutoCut/tests -p test_script_template.py
```

Results are recorded in [focused-exits.json](focused-exits.json) and the adjacent `final-*.stdout.log` / `final-*.stderr.log` files: 41 + 18 + 40 tests passed. The script-template run retained the N1 audit of 225 generated fixture states.

The former food ASS byte-for-byte N3 assertion was replaced under Mac instruction 51487839. The new independent semantic oracle checks all nine food subtitle/card paths: exact pre-display codepoints, exact legacy removal of punctuation immediately before trailing line whitespace, preserved whitespace suffixes, and real generated HTML text. The separate legacy-plan byte compatibility assertion remains.

## Conditional card-space browser evidence

The first WIP applied `white-space:pre` to every card and caused 25 unchanged HTML byte baselines to fail (5 packaging-agent and 20 script-card-fields assertions). Those assertions were not changed. The final implementation emits the style only when an actual wrapped line has leading, trailing, or consecutive U+0020; ordinary card HTML stays byte-compatible.

- Chrome-rendered normal card fixture: [PNG](card-space-normal-browser.png).
- Chrome-rendered `headline_sub` fixture: [PNG](card-space-headline-browser.png).
- Production-source provenance, computed `white-space: pre`, DOM `textContent` equality, U+0020 counts, and PNG hashes: [card-space-browser-evidence.json](card-space-browser-evidence.json).

The HTML files used for browser probing were temporary and are intentionally not included. Evidence-only instrumentation supplied a no-op GSAP object and forced opacity to 1 for the static screenshots; the generated text and production whitespace CSS were unchanged.

The two suites that exposed the over-broad CSS were rerun unchanged with the same embedded interpreter: `test_packaging_agent.py` passed 32 tests with 1 existing skip, and `test_script_card_fields.py` passed 193 tests with 1 existing skip. See `regression-packaging-agent.*.log` and `regression-script-card-fields.*.log`.
