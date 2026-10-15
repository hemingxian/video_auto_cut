# W6 local pack retry — STOP (51411450)

## Result

The one authorized `npm run release:pack:runtime` retry was consumed exactly once from detached source `4c6fb40ff7371e73a0d0daa4c9ef0606610afc21`. The npm command exited 0 and completed the archive, but the wrapper exited 1 while deleting the copied, ignored local release configuration. The package has therefore **not** completed verification and is **not claimed deliverable**.

No second pack call was made. Scripts 30 and 40 were not run. Upload, publish, merge, and cleanup did not start.

## Pack facts

- Archive: `D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCutDesktop\runtime-release\VideoAutoCut-runtime-0.5.15-agent-trial-pkg5.zip`
- Bytes: `669984472`
- SHA-256: `662882deedd897b04043b2cb78ff1a40c17fcfd09cfd80885ace3e1dfd5002f5`
- Manifest: `D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCutDesktop\runtime-release\manifest.json`, 433 bytes, SHA-256 `c80642c7370fe4a310a30ab1ea3b8852093b7986dd8cd67f8588ace69c1bda0c`.
- Actual rebuilt engine SHA-256: `eadea1955d1aed3543de74fd647ede7f2e1638ae903b9bd056213e2e75ea9085`.
- Frozen expected engine SHA-256: `be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf`.
- The engine hashes differ. No difference investigation was performed.

## Configuration-copy cleanup

The copied file was verified as the fixed isolated-worktree target, 337 bytes, SHA-256 `d3edd445ad45bda688a736b6b80f60d3399a0d44cc7a4843b9b26ad5d8f9d04c`, equal to the main source configuration, read-only, and not a reparse point. The wrapper's `File.Delete` reported `Access denied`. No cause investigation was performed.

The subsequently authorized exact `Remove-Item -LiteralPath <fixed target> -Force` action was rejected before execution by the command policy. No alternate deletion mechanism was attempted. The isolated configuration copy still exists; the main source configuration was not modified. The evidence records only file identity metadata and the tool error, never configuration content.

## Verification boundary

The package-content, ZIP-entry, packaged dependency, credential-absence, extracted-engine, and final hash gates were not run. In particular, no claim is made that the archive excludes the configuration or its credentials. The evidence directory itself is scanned in memory against the nonempty credential values from the main configuration; the scan emits counts only.

The isolated worktree remains detached at the frozen source with an empty normal Git status. The main worktree retains only the two protected user package-file modifications.

The npm pack command completed successfully, while the wrapper/state sequence did not complete. Verify script 30 and hash script 40 each ran zero times. The six protected main files matched their before hashes after STOP (6/6).
