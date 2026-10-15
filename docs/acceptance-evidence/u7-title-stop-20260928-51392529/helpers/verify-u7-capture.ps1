param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(2)]
  [int]$Sequence
)

$ErrorActionPreference = 'Stop'

function Get-BytesSha([byte[]]$Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}
function Get-ExactLines([byte[]]$Bytes) {
  $strict = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $strict.GetString($Bytes) } catch { throw 'STOP: captured output is not strict UTF-8' }
  $result = [Collections.Generic.List[object]]::new()
  $matches = [regex]::Matches($text, '[^\r\n]*(?:\r\n|\n|\r|$)')
  $ordinal = 0
  foreach ($match in $matches) {
    if ($match.Length -eq 0) { continue }
    $raw = [string]$match.Value
    $ending = 'none'
    $line = $raw
    if ($raw.EndsWith("`r`n")) { $ending = 'CRLF'; $line = $raw.Substring(0, $raw.Length - 2) }
    elseif ($raw.EndsWith("`n")) { $ending = 'LF'; $line = $raw.Substring(0, $raw.Length - 1) }
    elseif ($raw.EndsWith("`r")) { $ending = 'CR'; $line = $raw.Substring(0, $raw.Length - 1) }
    $rawBytes = $strict.GetBytes($raw)
    $ordinal += 1
    $result.Add([ordered]@{ ordinal = $ordinal; text = $line; line_ending = $ending; raw_utf8_base64 = [Convert]::ToBase64String($rawBytes); raw_sha256 = Get-BytesSha $rawBytes })
  }
  return $result.ToArray()
}
function Get-TextLanguage([string]$Text) {
  $han = [regex]::Matches(($Text ?? ''), '[\u3400-\u9fff]').Count
  $words = [regex]::Matches(($Text ?? ''), "[A-Za-z]+(?:['’-][A-Za-z]+)*").Count
  if ($han -gt 0 -and $han -ge $words) { return 'zh' }
  if ($words -gt 0) { return 'en' }
  return ''
}
function Get-CleanLabel([string]$Text, [int]$Index) {
  $value = ($Text ?? '').Trim()
  if (-not $value) { return "模块$Index" }
  foreach ($separator in @('：', ':')) {
    $position = $value.IndexOf($separator, [StringComparison]::Ordinal)
    if ($position -ge 0) {
      $prefix = $value.Substring(0, $position)
      if ($prefix.Length -le 12) { $value = $value.Substring($position + $separator.Length).Trim() }
      break
    }
  }
  foreach ($separator in @('，', ',', '；', ';', '。')) {
    $position = $value.IndexOf($separator, [StringComparison]::Ordinal)
    if ($position -ge 0) { $value = $value.Substring(0, $position).Trim(); break }
  }
  if ($value) { return $value }
  return "模块$Index"
}
function Test-LabelMatchesLanguage([string]$Label, [string]$Language, [string]$Context) {
  if ([string]::IsNullOrWhiteSpace($Label)) { return $false }
  if (-not $Language) { return $true }
  if ($Language -eq 'zh') {
    if ([regex]::IsMatch($Label, '[\u3400-\u9fff]')) { return $true }
    return [regex]::IsMatch($Label, '^[A-Za-z0-9][A-Za-z0-9._/+\-]*$') -and
      $Context.Contains($Label, [StringComparison]::Ordinal) -and
      ($Label -ceq $Label.ToUpperInvariant() -or [regex]::IsMatch($Label, '[0-9]'))
  }
  return [regex]::IsMatch($Label, '[A-Za-z]') -and -not [regex]::IsMatch($Label, '[\u3400-\u9fff]')
}

$Repo = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut')
$Audit = Join-Path $Repo 'VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928'
$Phase = Join-Path $Audit 'phase-51391241-u7-1c307c3'
$RawRoot = Join-Path $Phase 'raw-electron-stdout'
$Receipts = Join-Path $Phase 'receipts'
$Candidate = [IO.Path]::GetFullPath('D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut')
$Input = Join-Path $Repo 'docs\packaging-test-scripts-2026-09-21\07_表格版_混合_show判定_食品码垛_CN.xlsx'
$ExpectedInputSha = '32928ce140c3d8b25ad0b5ac482896b3698417f7de8401920c9129c3b030697e'
$ExpectedTitles = @(
  '来料到位是第一道关',
  '袋料和箱体要分开核对',
  '镜头B',
  '包装落到托盘以后还要核对排列方向垛层边缘和抓具退出的路径',
  '换型准备',
  '开场',
  '欢迎带着包装形态来试'
)

$metadataFiles = @(Get-ChildItem -LiteralPath $RawRoot -Filter "observer-*-seq-$Sequence-child-*-metadata.json" -File)
if ($metadataFiles.Count -ne 1) { throw "STOP: expected one U7 captured child at sequence $Sequence, got $($metadataFiles.Count)" }
$allMetadata = @(Get-ChildItem -LiteralPath $RawRoot -Filter 'observer-*-metadata.json' -File)
if ($allMetadata.Count -ne 2) { throw "STOP: expected help plus one GUI import and no manual retry, got $($allMetadata.Count) captured children" }
$metadata = Get-Content -LiteralPath $metadataFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$metadata.exit_code -ne 0) { throw "STOP: U7 engine exit was $($metadata.exit_code), expected 0" }
if ([string]$metadata.child_executable_basename -ne 'videoautocutengine.exe') { throw 'STOP: captured child is not the Candidate engine basename' }

$stdoutPath = Join-Path $RawRoot ([string]$metadata.stdout.path)
$stderrPath = Join-Path $RawRoot ([string]$metadata.stderr.path)
$eventsPath = Join-Path $RawRoot ([string]$metadata.vacut_events.path)
$stdoutBytes = [IO.File]::ReadAllBytes($stdoutPath)
$stderrBytes = [IO.File]::ReadAllBytes($stderrPath)
$eventBytes = [IO.File]::ReadAllBytes($eventsPath)
if ((Get-BytesSha $stdoutBytes) -ne [string]$metadata.stdout.sha256 -or (Get-BytesSha $stderrBytes) -ne [string]$metadata.stderr.sha256 -or (Get-BytesSha $eventBytes) -ne [string]$metadata.vacut_events.sha256) { throw 'STOP: captured stream hash differs from observer metadata' }
$stdoutLines = @(Get-ExactLines $stdoutBytes)
$stderrLines = @(Get-ExactLines $stderrBytes)
$eventLines = @(Get-ExactLines $eventBytes)
$stderrNonempty = @($stderrLines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.text) })
if ($stderrNonempty.Count -ne 0) { throw "STOP: U7 stderr has $($stderrNonempty.Count) non-empty lines" }

$stdoutText = ($stdoutLines | ForEach-Object { $_.text }) -join "`n"
$candidateSerialized = $Candidate.Replace('\', '\\')
if (-not $stdoutText.Contains($candidateSerialized + '\\python-3.11.9-embed-amd64\\python.exe', [StringComparison]::OrdinalIgnoreCase) -or -not $stdoutText.Contains($candidateSerialized + '\\tools\\normalize_script.py', [StringComparison]::OrdinalIgnoreCase)) { throw 'STOP: stdout lacks Candidate Python/normalize_script provenance' }
if (-not $stdoutText.Contains($Input, [StringComparison]::OrdinalIgnoreCase)) { throw 'STOP: stdout lacks the exact frozen U7 input path' }
if ($stdoutText.Contains('[script] 标准模板导入', [StringComparison]::Ordinal)) { throw 'STOP: U7 non-template input unexpectedly used the template route' }

$uploadStart = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 上传脚本文件:', [StringComparison]::Ordinal) })
$uploadComplete = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 脚本文件上传完成:', [StringComparison]::Ordinal) })
$parseStart = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 解析脚本文件:', [StringComparison]::Ordinal) })
$parseComplete = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 脚本规范化完成:', [StringComparison]::Ordinal) })
$voiceReviewStart = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 复核口播字幕:', [StringComparison]::Ordinal) })
$voiceReviewComplete = @($stdoutLines | Where-Object { ([string]$_.text).StartsWith('AI 口播字幕复核完成:', [StringComparison]::Ordinal) })
if ($uploadStart.Count -ne 1 -or $uploadComplete.Count -ne 1 -or $parseStart.Count -ne 1 -or $parseComplete.Count -ne 1) { throw 'STOP: U7 upload/parse marker count mismatch' }
if ($voiceReviewStart.Count -gt 1 -or $voiceReviewComplete.Count -ne $voiceReviewStart.Count) { throw 'STOP: U7 voice/subtitle review marker count mismatch' }

$retryPattern = '^\[警告\] (?<label>Qwen 文件上传|Qwen 脚本文件解析|Qwen 口播字幕复核|Qwen 章节标签语言复核) (?:HTTP .+|网络连接失败：.+)，[0-9.]+ 秒后重试 (?<attempt>[0-9]+)/(?<total>[0-9]+)\.\.\.$'
$retryLines = [Collections.Generic.List[object]]::new()
foreach ($line in $stdoutLines) {
  $match = [regex]::Match([string]$line.text, $retryPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  if ($match.Success) {
    $retryLines.Add([ordered]@{ label = $match.Groups['label'].Value; attempt = [int]$match.Groups['attempt'].Value; total = [int]$match.Groups['total'].Value; ordinal = [int]$line.ordinal; line_ending = [string]$line.line_ending; raw_utf8_base64 = [string]$line.raw_utf8_base64; raw_sha256 = [string]$line.raw_sha256 })
  }
}
$uploadRetries = @($retryLines | Where-Object { $_.label -eq 'Qwen 文件上传' })
$parseRetries = @($retryLines | Where-Object { $_.label -eq 'Qwen 脚本文件解析' })
$voiceRetries = @($retryLines | Where-Object { $_.label -eq 'Qwen 口播字幕复核' })
$labelRetries = @($retryLines | Where-Object { $_.label -eq 'Qwen 章节标签语言复核' })
if ($voiceRetries.Count -gt 0 -and $voiceReviewStart.Count -eq 0) { throw 'STOP: voice-review retry line exists without an actual review stage marker' }

$retryOrdinals = @($retryLines | ForEach-Object { [int]$_.ordinal })
$modelFailureLines = @($stdoutLines | Where-Object {
  $text = [string]$_.text
  $isRecognizedRetry = $retryOrdinals -contains [int]$_.ordinal
  -not $isRecognizedRetry -and (
    $text.StartsWith('[警告] 章节标签复核失败', [StringComparison]::Ordinal) -or
    $text.StartsWith('[警告] 部分章节标签未通过语言复核', [StringComparison]::Ordinal) -or
    [regex]::IsMatch($text, '(?i)(Qwen|AI|模型|章节标签).*(失败|错误|异常|\berror\b|\bfailed\b|\bfailure\b)')
  )
})
if ($modelFailureLines.Count -ne 0) { throw "STOP: U7 stdout contains $($modelFailureLines.Count) non-retry model failure/error lines" }

$shotsMarkers = @($stdoutLines | Where-Object { [regex]::IsMatch([string]$_.text, '^已生成分镜:\s*.+shots\.json\s*$') })
if ($shotsMarkers.Count -ne 1) { throw "STOP: expected one final shots path marker, got $($shotsMarkers.Count)" }
$shotsPath = [regex]::Match([string]$shotsMarkers[0].text, '^已生成分镜:\s*(?<path>.+shots\.json)\s*$').Groups['path'].Value
if (-not (Test-Path -LiteralPath $shotsPath -PathType Leaf)) { throw "STOP: final shots.json is missing: $shotsPath" }
$shotsBytes = [IO.File]::ReadAllBytes($shotsPath)
$strict = [Text.UTF8Encoding]::new($false, $true)
$plan = $strict.GetString($shotsBytes) | ConvertFrom-Json
$shots = @($plan.shots)
if ($shots.Count -ne 7) { throw "STOP: U7 final plan has $($shots.Count) shots, expected 7" }
for ($i = 0; $i -lt $ExpectedTitles.Count; $i++) {
  if ([string]$shots[$i].title -ne $ExpectedTitles[$i]) { throw "STOP: authored title mismatch at shot $($i + 1)" }
}
$shotContexts = @($shots | ForEach-Object {
  $subtitle = ([string]($_.subtitle ?? '')).Trim()
  $voice = ([string]($_.voice_text ?? '')).Trim()
  if ($subtitle) { $subtitle } else { $voice }
})
$overallLanguage = Get-TextLanguage (($shotContexts -join ' '))
$progressPredicates = [Collections.Generic.List[object]]::new()
for ($i = 0; $i -lt $shots.Count; $i++) {
  $context = [string]$shotContexts[$i]
  $language = Get-TextLanguage $context
  if (-not $language) { $language = $overallLanguage }
  $cleanTitle = Get-CleanLabel ([string]$shots[$i].title) ($i + 1)
  $titleMatches = Test-LabelMatchesLanguage $cleanTitle $language $context
  $contextPresent = -not [string]::IsNullOrWhiteSpace($context)
  $languagePresent = -not [string]::IsNullOrWhiteSpace($language)
  $wouldEnterPendingWithoutValidModuleLabel = (-not $titleMatches) -and $contextPresent -and $languagePresent
  $progressPredicates.Add([ordered]@{
    shot = $i + 1
    context_source = if (-not [string]::IsNullOrWhiteSpace([string]($shots[$i].subtitle ?? ''))) { 'subtitle' } else { 'voice_text' }
    context_sha256 = Get-BytesSha ([Text.UTF8Encoding]::new($false).GetBytes($context))
    context_present = $contextPresent
    language = $language
    language_present = $languagePresent
    authored_title = [string]$shots[$i].title
    clean_authored_title = $cleanTitle
    authored_title_matches_language = $titleMatches
    would_enter_pending_without_valid_module_label = $wouldEnterPendingWithoutValidModuleLabel
    pending_excluded = -not $wouldEnterPendingWithoutValidModuleLabel
  })
}
$progressPending = @($progressPredicates | Where-Object { -not [bool]$_.pending_excluded })
$progressPredicateReceipt = [ordered]@{
  schema = 'vacut-u7-progress-label-predicate/v1'
  source = 'frozen progress_labels.py predicate reproduced against actual final post-review shots and restored authored titles'
  overall_language = $overallLanguage
  shots = $progressPredicates.ToArray()
  pending_count_upper_bound = $progressPending.Count
  zero_call_proven = ($progressPending.Count -eq 0)
}
$progressPredicatePath = Join-Path $Receipts 'progress-label-predicate-u7.json'
[IO.File]::WriteAllText($progressPredicatePath, (($progressPredicateReceipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
if ($progressPending.Count -ne 0) { throw "STOP: actual context/language/title predicates do not prove progress-label pending=0; receipt preserved at $progressPredicatePath" }
if ($labelRetries.Count -ne 0) { throw 'STOP: progress-label HTTP retry contradicts source-derived pending=0' }

$modelLogicalStages = 1 + $voiceReviewStart.Count
$modelHttpAttempts = 1 + $parseRetries.Count + $voiceReviewStart.Count + $voiceRetries.Count
$fileUploadRequests = 1 + $uploadRetries.Count
$sourceFiles = @('normalize_script.py','progress_labels.py','optimize_queries.py','common.py')
$sourceReceipt = foreach ($name in $sourceFiles) {
  $path = Join-Path $Candidate ('tools\' + $name)
  [ordered]@{ path = $path; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$receipt = [ordered]@{
  schema = 'vacut-u7-phase-51391241-capture/v1'
  checked_at = (Get-Date).ToUniversalTime().ToString('o')
  pass = $true
  gui_import_clicks = 1
  manual_retries = 0
  sequence = $Sequence
  metadata = [ordered]@{ path = $metadataFiles[0].FullName; sha256 = (Get-FileHash -LiteralPath $metadataFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant(); exit_code = [int]$metadata.exit_code }
  streams = [ordered]@{
    stdout = [ordered]@{ path = $stdoutPath; bytes = $stdoutBytes.Length; sha256 = Get-BytesSha $stdoutBytes }
    stderr = [ordered]@{ path = $stderrPath; bytes = $stderrBytes.Length; sha256 = Get-BytesSha $stderrBytes; nonempty_lines = 0 }
    events = [ordered]@{ path = $eventsPath; bytes = $eventBytes.Length; sha256 = Get-BytesSha $eventBytes; lines = [int]$metadata.vacut_events.lines }
  }
  input = [ordered]@{ path = $Input; sha256 = $ExpectedInputSha; route = 'non-template' }
  final_plan = [ordered]@{ path = $shotsPath; bytes = $shotsBytes.Length; sha256 = Get-BytesSha $shotsBytes; shots = 7; authored_titles_exact = $true }
  calls = [ordered]@{
    file_upload = [ordered]@{ logical_operations = 1; http_requests = $fileUploadRequests; automatic_retries = $uploadRetries.Count; counted_as_model = $false }
    qwen = [ordered]@{
      logical_stages = $modelLogicalStages
      http_attempts = $modelHttpAttempts
      parse = [ordered]@{ logical = 1; model = 'qwen-long'; automatic_retries = $parseRetries.Count; http_attempts = 1 + $parseRetries.Count; evidence = 'source control flow plus one parse start/completion pair' }
      voice_subtitle_review = [ordered]@{ logical = $voiceReviewStart.Count; model = if ($voiceReviewStart.Count) { 'qwen-long' } else { $null }; automatic_retries = $voiceRetries.Count; http_attempts = $voiceReviewStart.Count + $voiceRetries.Count; evidence = 'actual start/completion markers plus retry lines' }
      progress_label_review = [ordered]@{ logical = 0; http_attempts = 0; evidence = 'source-derived from actual per-shot subtitle/voice context, language, restored authored title, clean_label, and label_matches_language predicates'; predicate_receipt = $progressPredicatePath; predicate_receipt_sha256 = (Get-FileHash -LiteralPath $progressPredicatePath -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    retry_lines = $retryLines.ToArray()
  }
  source_derivation = [ordered]@{ files = $sourceReceipt; progress_pending = 0; per_shot_predicates = $progressPredicates.ToArray(); model_failure_or_error_lines = 0; low_level_limit = 'Successful chat-completion requests have no dedicated request-start log; parse and conditional review counts combine actual stage markers with frozen source control flow. Automatic retry attempts use the exact emitted retry lines.' }
}
[IO.File]::WriteAllText((Join-Path $Receipts 'captured-import-u7.json'), (($receipt | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 12
