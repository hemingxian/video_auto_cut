# Validation of the limited U6 state fix

Fix commit: `d34557036205c36e97e6e2f006d2cede329a7e2c`.

The confirmed pre-fix run has 18 tests, 17 passes and one failure: the actual
subscription hook drops the real U6 report after output, a stale ref overwrite,
and immediate close. The initial pre-fix run also exposed an error in the new
oracle harness's serialization of own keys with undefined values. That harness
error was corrected before the confirmed run; existing assertions were not
weakened.

After the fix, both focused modules have 19 passes, no failures and no skips.
The full desktop suite has 415 tests, 413 passes, no failures and two unchanged
Windows skips. The build and TypeScript checks passed; changed-file lint had
zero errors and warnings. The decoder test covers every split boundary of the
real approximately 14 KB event fixture committed with the fix.

The non-template oracle was independently sampled from the exact b980 Git
blob of the original hook in a separate process. Root verified its source
bytes, 20 own keys, two undefined own keys and all values against the fixture.
`baseline-oracle-comparison.json` records that comparison.

These tests establish the stale-ref interleaving and the fix's behavior. They
do not establish the complete scheduling trace of the previous live UI
failure, and the later real GUI import did not use the required runtime.
The GUI acceptance remains unpassed.

Text copies use UTF-8/LF. `source-hashes.json` records both original audit
hashes and published copy hashes; no tests were rerun during evidence export.
