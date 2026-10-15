param()

. (Join-Path $PSScriptRoot 'W6.Resume.Common.ps1')

$lock = Read-SourceLock
$state = Read-State
if ($state.worktree_complete -ne $true -or $state.pack_complete -ne $true -or $state.verify_complete -eq $true) { throw 'pack 未完成或 verify 已完成' }
if ($state.source_head -ne $lock.source_head -or $state.head_create -ne $lock.source_head -or $state.head_before_pack -ne $lock.source_head) { throw '前两次完整源 SHA 不一致' }
Assert-MainLocked $lock 'verify-entry'
Assert-IsolatedWorktree $lock 'verify-entry' $true
if (Test-Path -LiteralPath (Join-Path $lock.worktree 'VideoAutoCutDesktop\release-upload.local.json')) { throw '隔离配置副本在 verify 前仍存在' }
$deleteReceipt = Get-Content -LiteralPath (Join-Path $script:AuditRoot 'config-copy-delete.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($deleteReceipt.pack_exit_code -ne 0 -or $deleteReceipt.deleted_after_pack_success -ne $true -or $deleteReceipt.target_absent_after_delete -ne $true) { throw '配置副本删除收据未通过' }
if ((Get-Sha256 $lock.worktree_zip) -ne $state.pack_zip_sha256) { throw 'pkg5 在 pack 后变化' }
$probeRecords = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\records\_probe_w6.txt'
$probeCache = Join-Path $lock.worktree 'VideoAutoCut\tools\material_gen\hyperframes\node_modules\.cache\_probe_w6.txt'
if (Test-Path -LiteralPath $probeRecords) { throw "历史 records 探针仍存在：$probeRecords" }
if (Test-Path -LiteralPath $probeCache) { throw "历史 cache 探针仍存在：$probeCache" }

$basePython = Join-Path $script:BaseRuntime 'python-3.11.9-embed-amd64\python.exe'
if (-not (Test-Path -LiteralPath $basePython -PathType Leaf)) { throw "底包嵌入 Python 缺失：$basePython" }
$extractRoot = Join-Path $script:AuditRoot 'extracted'
$packageRoot = Join-Path $extractRoot 'VideoAutoCut'
if (Test-Path -LiteralPath $extractRoot) { throw "解压目标已存在：$extractRoot" }
Invoke-LoggedNative -FilePath $basePython -ArgumentList @('-X','utf8',(Join-Path $script:AuditRoot 'w6_extract_zip_isolated.py'),[string]$lock.worktree_zip,$extractRoot) -LogPath (Join-Path $script:AuditRoot 'extract.log') -Label 'safe isolated pkg5 extract' -WorkingDirectory $script:AuditRoot | Out-Null
if (-not (Test-Path -LiteralPath $packageRoot -PathType Container)) { throw '解压后缺 VideoAutoCut 根' }

$contentsJson = Join-Path $script:AuditRoot 'pkg5-contents.json'
$checker = Join-Path $lock.worktree 'docs\acceptance-tools\check_pkg_contents.py'
Invoke-LoggedNative -FilePath $basePython -ArgumentList @('-X','utf8',$checker,'--repo',[string]$lock.worktree,'--head',[string]$lock.source_head,'--pkg',$packageRoot,'--json',$contentsJson) -LogPath (Join-Path $script:AuditRoot 'pkg5-contents.log') -Label 'full directory content check' -WorkingDirectory $lock.worktree | Out-Null
$contents = Get-Content -LiteralPath $contentsJson -Raw -Encoding utf8 | ConvertFrom-Json
$mismatch = 0; $missing = 0
foreach ($section in $contents.sections.PSObject.Properties) { $mismatch += @($section.Value.mismatch).Count; $missing += @($section.Value.missing).Count }
$forbidden = @($contents.forbidden).Count
if (($mismatch + $missing + $forbidden) -ne 0) { throw "全目录核对失败：mismatch=$mismatch missing=$missing forbidden=$forbidden" }

$zipJson = Join-Path $script:AuditRoot 'zip-entry-gate.json'
Invoke-LoggedNative -FilePath $basePython -ArgumentList @('-X','utf8',(Join-Path $script:AuditRoot 'w6_zip_gate_isolated.py'),[string]$lock.worktree_zip,$zipJson) -LogPath (Join-Path $script:AuditRoot 'zip-entry-gate.log') -Label 'zip entry exclusion gate' -WorkingDirectory $script:AuditRoot | Out-Null
$zipGate = Get-Content -LiteralPath $zipJson -Raw -Encoding utf8 | ConvertFrom-Json
if ($zipGate.probe_match_count -ne 0 -or $zipGate.excluded_rule_match_count -ne 0 -or $zipGate.outside_runtime_count -ne 0) { throw 'zip gate 收据包含命中' }

$packagePython = Join-Path $packageRoot 'python-3.11.9-embed-amd64\python.exe'
$piAgentDir = Join-Path $script:AuditRoot 'pi-coding-agent-empty'
if (-not (Test-Path -LiteralPath $piAgentDir -PathType Container) -or @(Get-ChildItem -LiteralPath $piAgentDir -Force).Count -ne 0) { throw 'PI_CODING_AGENT_DIR 缺失或非空' }
$env:PI_CODING_AGENT_DIR = $piAgentDir
Invoke-LoggedNative -FilePath $packagePython -ArgumentList @('-X','utf8',(Join-Path $packageRoot 'tools\material_gen\pi\install_pi.py'),'--check') -LogPath (Join-Path $script:AuditRoot 'pkg-pi-check.log') -Label 'package Pi check' -WorkingDirectory $packageRoot | Out-Null
Invoke-LoggedNative -FilePath $packagePython -ArgumentList @('-X','utf8',(Join-Path $packageRoot 'tools\material_gen\hyperframes\install_hyperframes.py'),'--check','--runtime-root',$packageRoot) -LogPath (Join-Path $script:AuditRoot 'pkg-hyperframes-check.log') -Label 'package HyperFrames check' -WorkingDirectory $packageRoot | Out-Null

$credentialJson = Join-Path $script:AuditRoot 'credential-scan.json'
$mainConfig = Join-Path $script:RepoRoot 'VideoAutoCutDesktop\release-upload.local.json'
Invoke-LoggedNative -FilePath $basePython -ArgumentList @('-X','utf8',(Join-Path $script:AuditRoot 'scan_release_credentials.py'),$mainConfig,[string]$lock.worktree_zip,$extractRoot,$script:AuditRoot,$credentialJson) -LogPath (Join-Path $script:AuditRoot 'credential-scan.log') -Label 'release credential absence scan' -WorkingDirectory $script:AuditRoot | Out-Null
$credentialScan = Get-Content -LiteralPath $credentialJson -Raw -Encoding utf8 | ConvertFrom-Json
if ($credentialScan.pass -ne $true -or $credentialScan.forbidden_entry_count -ne 0 -or $credentialScan.credential_match_count -ne 0) { throw 'release config/credential 扫描未通过' }

$expectedEngine = 'be8efb22c57738627e595d8406baa87e0f953ca0058fb399a54ca34cd2916adf'
$repoEngine = Join-Path $lock.worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe'
$packageEngine = Join-Path $packageRoot 'VideoAutoCutEngine.exe'
$repoEngineSha = Get-Sha256 $repoEngine; $packageEngineSha = Get-Sha256 $packageEngine
if ($repoEngineSha -ne $expectedEngine -or $packageEngineSha -ne $expectedEngine) { throw "引擎 SHA 不符：repo=$repoEngineSha package=$packageEngineSha" }
$manifest = Assert-IsolatedManifestMatchesArtifact $lock
Assert-MainLocked $lock 'verify-exit'
Assert-IsolatedWorktree $lock 'verify-exit' $true
$head3 = Get-WorktreeGitScalar $lock @('rev-parse','HEAD')
if ($head3 -ne $state.head_create -or $head3 -ne $state.head_before_pack -or $head3 -ne $lock.source_head) { throw '三次完整源 SHA 不一致' }
$protectedAfter = @(Get-ProtectedSnapshot)
Write-Json (Join-Path $script:AuditRoot 'protected-main-after.json') $protectedAfter
$artifact = [ordered]@{
  status='PASS_READY_FOR_ROOT_REVIEW_NOT_POSTED'
  source=[ordered]@{ lock=[string]$lock.source_head; head_create=[string]$state.head_create; head_before_pack=[string]$state.head_before_pack; head_after_verify=$head3; all_three_equal=$true }
  zip=[ordered]@{ path=[string]$lock.worktree_zip; bytes=[int64](Get-Item -LiteralPath $lock.worktree_zip).Length; sha256=Get-Sha256 $lock.worktree_zip }
  manifest=[ordered]@{ path=[string]$lock.worktree_manifest; bytes=[int64](Get-Item -LiteralPath $lock.worktree_manifest).Length; sha256=$manifest.manifest_sha256; latest=$manifest.latest; artifact_sha256=$manifest.sha256 }
  engines=[ordered]@{ expected=$expectedEngine; isolated_repo=$repoEngineSha; extracted_package=$packageEngineSha }
  checks=[ordered]@{ mismatch=$mismatch; missing=$missing; forbidden=$forbidden; extra_tools=@($contents.extra_tools).Count; probe_matches=[int]$zipGate.probe_match_count; excluded_matches=[int]$zipGate.excluded_rule_match_count; outside_runtime=[int]$zipGate.outside_runtime_count; package_pi=0; package_hyperframes=0; release_config_entries=[int]$credentialScan.forbidden_entry_count; credential_matches=[int]$credentialScan.credential_match_count; credential_scan_pass=$true; probes_created_this_retry=$false }
  protection=[ordered]@{ main_six_unchanged=$true; isolated_manifest_only=$true }
  upload_run=$false; merged_to_master=$false; posted=$false
}
Write-Json (Join-Path $script:AuditRoot 'artifact-receipt.json') $artifact
Write-Json (Join-Path $script:AuditRoot 'RESULT.json') $artifact
Set-StateProperty $state 'head_after_verify' $head3
Set-StateProperty $state 'credential_scan_complete' $true
Set-StateProperty $state 'verify_complete' $true
Save-State $state
Write-Output 'VERIFY PASS：结果尚未发帖；下一阶段单独运行 40-hash-report.ps1。'
