# U7 actual offline verification handoff

Do not run until the one real U7 GUI import has completed, its engine capture is
complete, and the supplied raw files are immutable. Electron may remain open
for final review and is naturally closed later before the legacy copy. This helper reads artifacts only and never starts the app,
engine, legacy UI, import path, network, or a model.

Inputs: frozen XLSX, final `shots.json`, exact raw stdout/stderr byte captures,
all child metadata JSON files, and the frozen row-6 authored-field oracle
`D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\w2-3715aa4-20260924-134913-prep\expected-author-fields\row-6.strict-validation.json`
(SHA `e8d132ead6801bf7b6ecda1ec1bd5169695a9969c281ea4b810353cc03d72cf0`).
Record every input SHA. The oracle must contain exactly rows 1 through 7 in
order before any zip comparison occurs.

The helper verifies seven final shots and compares title/card_content/card_hint
presence and UTF-8 hashes against the frozen oracle. Explicit show-like fields
are recorded when present; otherwise card visibility is labelled as an
inference from authored card_content presence, never a directly observed show
field. Visual UI evidence remains required.

Raw stream markers inventory the single upload/main parse, optional paired
voice/subtitle review, normalization completion, retry warning line positions,
and label-review warnings. Missing markers remain evidence gaps, never inferred
zero. Retry lines require human attribution from adjacent raw context; the
helper does not guess. Successful low-level HTTP attempts have no universal
request-start log and are disclosed separately.

Progress-label zero never uses final `module_label`, because that field may have
already been written by review. It applies a frozen equivalent of
`common.clean_label` to the strictly verified authored title, then evaluates it
against actual `subtitle || voice_text` context and language. Empty context or
language is also excluded by production pending filtering. Only when every shot
is excluded this way does the receipt derive label-review calls as zero;
otherwise the count is unknown/evidence-gap for root, not a product failure.

Voice-review marker counts are literal. `1/1` proves one logical call. `0/0`
with normalization completion derives zero from frozen control flow because the
call is always preceded by the start marker. Any unmatched endpoint is unknown;
multiple markers are an error. Raw streams must decode as strict UTF-8, with no
replacement characters masking invalid bytes.

After the offline receipt, the designated UI operator still supplies the §6.3
side-by-side current/legacy screenshots. The legacy `1bc0fdb` drawer must show
the same existing run without another import, template block, or subtitle box.
No incompatibility, migration, or missing log may trigger another import or
model call.
