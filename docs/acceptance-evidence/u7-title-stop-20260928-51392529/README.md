# U7 single-import title preservation — STOP

This package records a failed U7 acceptance result at source HEAD
`1c307c384a2ffaeed02bf29d5da55b671d3b59ab`. The one GUI import completed and
produced seven shots, but only five of seven authored titles were preserved.
The workflow stopped at that mismatch. Legacy §6.3 comparison, Food E2E, W6,
cleanup, manual retry, and any additional model call were not run.

Observed counts are upload 1, main parse 1, voice review 0, progress-label
review 0, and automatic retry warnings 0. Voice-review 0 is source-derived from
zero start/completion markers, frozen always-marker control flow, and normalize
completion. Label-review 0 is source-derived from the actual title remaining
unchanged by `ensure_progress_labels` plus actual subtitle context/language; it
is not inferred from final `module_label`. The capture lacks a uniform low-level
HTTP-request-start trace, so it cannot independently enumerate invisible
transport attempts beyond workflow markers and retry warnings.

The tracked authored input is
`docs/packaging-test-scripts-2026-09-21/07_表格版_混合_show判定_食品码垛_CN.xlsx`
(SHA-256 `32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e`).
Independent comparison found `card_content` 7/7 exact under placeholder
semantics, `card_hint` 7/7, authored module label 7/7, and title 5/7.

Shot 4 expected `包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径` (length 28,
SHA-256 `2942046a30aa2d0e8937298d9aa0e82c99ed316b14b19fa0ed0d107ede1aeb18`)
but produced `落盘确认` (length 4, SHA-256
`4d715c838a5e1a661d3b7f566e07fd1cc0c8b89642ead70ea8e347fcba7e5822`).
Shot 6 expected `开场` (length 2, SHA-256
`fd0d4b7258c28a997a70287839f0ebb226398443848352c94ebb7738bbd710e9`)
but produced `工位衔接` (length 4, SHA-256
`95c49c3ab00db529cfac25c802fba19b311f7a2de749fd29bf459b6f7539a17d`).
The resulting titles take the values from their rows' authored column-D module
labels. The existing `foreign_values` anti-misalignment branch only warns and
does not correct those values. No original Qwen response was retained, so this
package does not attribute the defect specifically to the model or to compact
result handling. The relevant frozen source is lines 1415–1428 of the importer.

`artifact-manifest.json` records each absolute source, destination, byte count,
and SHA-256. Copies preserve every byte without redaction, trimming, decoding,
or newline normalization. `SHA256SUMS.txt` covers the package; the entire
directory is marked `-text`. If generation fails, its partial directory is
retained for inspection and must not be committed or submitted.

The original STOP receipt contains an older protection field with null values
and is preserved unchanged. Protection status is established by the fresh
`U7-SHUTDOWN.json` receipt and the independent root review.

The main acceptance verifier originally failed with tool-reported exit 1. That
invocation produced no stdout/stderr file, so this package preserves the STOP
receipts that record the result and does not fabricate a verifier log.
