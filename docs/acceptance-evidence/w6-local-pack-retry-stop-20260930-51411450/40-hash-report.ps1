param()

. (Join-Path $PSScriptRoot 'W6.Resume.Common.ps1')

$lock = Read-SourceLock
$state = Read-State
if ($state.worktree_complete -ne $true -or $state.pack_complete -ne $true -or $state.config_copy_deleted -ne $true -or $state.credential_scan_complete -ne $true -or $state.verify_complete -ne $true -or $state.hashes_complete -eq $true) { throw '阶段状态不允许生成总收据' }
if ($state.source_head -ne $lock.source_head -or $state.head_create -ne $lock.source_head -or $state.head_before_pack -ne $lock.source_head -or $state.head_after_verify -ne $lock.source_head) { throw '三次完整源 SHA 不一致' }
Assert-MainLocked $lock 'hash-report'
Assert-IsolatedWorktree $lock 'hash-report' $true
$manifest = Assert-IsolatedManifestMatchesArtifact $lock
$resultPath = Join-Path $script:AuditRoot 'RESULT.json'
$result = Get-Content -LiteralPath $resultPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($result.status -ne 'PASS_READY_FOR_ROOT_REVIEW_NOT_POSTED') { throw 'RESULT 状态不允许生成总收据' }

$reportPath = Join-Path $script:AuditRoot 'REPORT-DATA.json'
$hashPath = Join-Path $script:AuditRoot 'DELIVERY-HASHES.json'
$sidecarPath = Join-Path $script:AuditRoot 'DELIVERY-HASHES.json.sha256'
foreach ($path in @($reportPath,$hashPath,$sidecarPath)) { if (Test-Path -LiteralPath $path) { throw "拒绝覆盖：$path" } }
$protectedSnapshot = @(Get-ProtectedSnapshot)
$report = [ordered]@{
  status='READY_FOR_ROOT_REVIEW_NOT_POSTED'
  instruction=51411450
  source_head=[string]$lock.source_head
  source_head_three_times=@([string]$state.head_create,[string]$state.head_before_pack,[string]$state.head_after_verify)
  worktree=[string]$lock.worktree
  artifact=[ordered]@{ zip=[string]$lock.worktree_zip; zip_sha256=$manifest.sha256; zip_bytes=$manifest.size; manifest=[string]$lock.worktree_manifest; manifest_sha256=$manifest.manifest_sha256 }
  checks=$result.checks
  main_protected=$protectedSnapshot
  main_manifest_unchanged=$true
  committed_package_only=$true
  user_dirty_package_files_copied=$false
  release_config_copy_deleted=$true
  credential_scan_pass=$true
  pack_retry_calls=1
  cleanup_started=$false
  upload_run=$false
  merged_to_master=$false
  posted=$false
  note='Historical runtime labels are not source SHA identifiers. The full source_head above is authoritative.'
}
Write-Json $reportPath $report

$files = @()
foreach ($file in Get-ChildItem -LiteralPath $script:AuditRoot -Force -File | Sort-Object Name) {
  if ($file.FullName -in @($hashPath,$sidecarPath,(Get-StatePath))) { continue }
  $files += [ordered]@{ role='audit_evidence_or_reviewed_script'; path=$file.FullName; bytes=[int64]$file.Length; sha256=Get-Sha256 $file.FullName }
}
$external = @(
  [ordered]@{ role='pkg5_zip'; path=[string]$lock.worktree_zip },
  [ordered]@{ role='pkg5_manifest'; path=[string]$lock.worktree_manifest },
  [ordered]@{ role='isolated_repo_engine'; path=(Join-Path $lock.worktree 'VideoAutoCutApp\target\release\VideoAutoCutEngine.exe') },
  [ordered]@{ role='extracted_package_engine'; path=(Join-Path $script:AuditRoot 'extracted\VideoAutoCut\VideoAutoCutEngine.exe') }
)
foreach ($entry in $external) {
  $item = Get-Item -LiteralPath $entry.path -Force
  $files += [ordered]@{ role=$entry.role; path=$entry.path; bytes=[int64]$item.Length; sha256=Get-Sha256 $entry.path }
}
$receipt = [ordered]@{
  source_head=[string]$lock.source_head
  scope='Every top-level audit evidence/review helper except mutable W6-ISOLATED-STATE.json and this output, plus zip, isolated manifest, isolated repo engine, and extracted engine. No full extracted-tree or base-runtime file-by-file hash gate is added.'
  file_count=$files.Count
  self_hash_sidecar=$sidecarPath
  files=$files
}
Write-Json $hashPath $receipt
$selfSha = Get-Sha256 $hashPath
Write-Utf8NoBom $sidecarPath ("$selfSha  DELIVERY-HASHES.json`n")
Set-StateProperty $state 'delivery_hashes_sha256' $selfSha
Set-StateProperty $state 'hashes_complete' $true
Save-State $state
Write-Output "DELIVERY HASHES PASS：$hashPath"
Write-Output '停止：不得发帖、上传、合并或清理；交 root 复核。'
