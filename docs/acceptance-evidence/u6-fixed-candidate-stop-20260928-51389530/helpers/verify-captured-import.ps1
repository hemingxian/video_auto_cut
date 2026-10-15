param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('formal-u6','badshot')]
  [string]$Phase
)

$ErrorActionPreference = 'Stop'

function Get-BytesSha([byte[]]$Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant()
}

function Get-ExactLines([byte[]]$Bytes) {
  $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
  try { $text = $strictUtf8.GetString($Bytes) } catch { throw 'STOP: captured output is not strict UTF-8' }
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
    $rawBytes = $strictUtf8.GetBytes($raw)
    $ordinal += 1
    $result.Add([ordered]@{
      ordinal = $ordinal
      text = $line
      line_ending = $ending
      raw_utf8_base64 = [Convert]::ToBase64String($rawBytes)
      raw_sha256 = Get-BytesSha $rawBytes
    })
  }
  return $result.ToArray()
}

function Get-StringLeaves([object]$Value, [string]$Path = '') {
  if ($null -eq $Value) { return }
  if ($Value -is [string]) {
    [pscustomobject]@{ path = $Path; value = [string]$Value }
    return
  }
  if ($Value -is [Collections.IDictionary]) {
    foreach ($key in $Value.Keys) {
      $childPath = if ($Path) { "$Path.$key" } else { [string]$key }
      Get-StringLeaves -Value $Value[$key] -Path $childPath
    }
    return
  }
  if ($Value -is [Collections.IEnumerable]) {
    $index = 0
    foreach ($item in $Value) {
      Get-StringLeaves -Value $item -Path "$Path[$index]"
      $index += 1
    }
    return
  }
  foreach ($property in $Value.PSObject.Properties) {
    $childPath = if ($Path) { "$Path.$($property.Name)" } else { [string]$property.Name }
    Get-StringLeaves -Value $property.Value -Path $childPath
  }
}
$Audit = [IO.Path]::GetFullPath('D:\autocut\video-auto-cut\VideoAutoCutDesktop\node_modules\.tmp\ui-u6-51388993-314c52f-20260928')
$RawRoot = Join-Path $Audit 'raw-electron-stdout'
$Receipts = Join-Path $Audit 'receipts'
$sequence = if ($Phase -eq 'formal-u6') { 2 } else { 3 }
$metadataFiles = @(Get-ChildItem -LiteralPath $RawRoot -Filter "observer-*-seq-$sequence-child-*-metadata.json" -File)
if ($metadataFiles.Count -ne 1) { throw "STOP: expected one captured child for $Phase sequence $sequence, got $($metadataFiles.Count)" }
$metadata = Get-Content -LiteralPath $metadataFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$metadata.exit_code -ne 2) { throw "STOP: $Phase exit code was $($metadata.exit_code), expected 2" }
$expectedEngineBase = 'videoautocutengine.exe'
if ([string]$metadata.child_executable_basename -ne $expectedEngineBase) {
  throw "STOP: captured child was not the expected engine basename: $($metadata.child_executable_basename)"
}
$stdoutPath = Join-Path $RawRoot ([string]$metadata.stdout.path)
$eventsPath = Join-Path $RawRoot ([string]$metadata.vacut_events.path)
$stderrPath = Join-Path $RawRoot ([string]$metadata.stderr.path)
$stdoutBytes = [IO.File]::ReadAllBytes($stdoutPath)
$stderrBytes = [IO.File]::ReadAllBytes($stderrPath)
$eventBytes = [IO.File]::ReadAllBytes($eventsPath)
if ((Get-BytesSha $stdoutBytes) -ne [string]$metadata.stdout.sha256 -or
    (Get-BytesSha $stderrBytes) -ne [string]$metadata.stderr.sha256 -or
    (Get-BytesSha $eventBytes) -ne [string]$metadata.vacut_events.sha256) {
  throw 'STOP: raw capture SHA does not match observer metadata'
}
$stdoutLines = Get-ExactLines $stdoutBytes
$stderrLines = Get-ExactLines $stderrBytes
$stdoutText = ($stdoutLines | ForEach-Object { $_.text }) -join "`n"
if (-not $stdoutText.Contains('[script] 标准模板导入')) { throw "STOP: $Phase stdout lacks standard-template route marker" }

$allOutputText = (($stdoutLines + $stderrLines) | ForEach-Object { $_.text }) -join "`n"
$forbiddenPatterns = [ordered]@{
  ai_upload = '(?i)AI\s*上传脚本文件'
  ai_parse = '(?i)AI\s*解析脚本文件'
  qwen = '(?i)qwen'
  dashscope = '(?i)dashscope'
  bailian = '百炼'
  model_api_or_name = '(?i)(model[_ -]?(?:api|name)|\b(?:gpt|deepseek|claude|gemini)[-_][a-z0-9.:-]+)'
}
$forbiddenHits = [Collections.Generic.List[object]]::new()
foreach ($entry in $forbiddenPatterns.GetEnumerator()) {
  foreach ($line in ($stdoutLines + $stderrLines)) {
    if ([regex]::IsMatch([string]$line.text, [string]$entry.Value)) {
      $forbiddenHits.Add([ordered]@{ rule = [string]$entry.Key; stream_line = [int]$line.ordinal; text = [string]$line.text })
    }
  }
}
if ($forbiddenHits.Count -ne 0) {
  throw "STOP: $Phase contains $($forbiddenHits.Count) forbidden model-path/model-name log matches"
}

$aiLines = @($stdoutLines | Where-Object { ([string]$_.text).IndexOf('AI', [StringComparison]::Ordinal) -ge 0 })
$ordinaryAiLines = @($aiLines | Where-Object { -not ([string]$_.text).StartsWith('VACUT_EVENT:', [StringComparison]::Ordinal) })
$eventAiLines = @($aiLines | Where-Object { ([string]$_.text).StartsWith('VACUT_EVENT:', [StringComparison]::Ordinal) })
$fixedAiPattern = '^\[script\] 标准模板导入 ai_suggested: (?<cell>[A-Z]+[0-9]+) 制作字段为 AI 建议$'
$allowedOrdinaryAiLines = @($ordinaryAiLines | Where-Object { [regex]::IsMatch([string]$_.text, $fixedAiPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) })
$unexpectedOrdinaryAiLines = @($ordinaryAiLines | Where-Object { -not [regex]::IsMatch([string]$_.text, $fixedAiPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant) })
$expectedAiSuggestedCount = if ($Phase -eq 'formal-u6') { 43 } else { 0 }
if ($unexpectedOrdinaryAiLines.Count -ne 0 -or $allowedOrdinaryAiLines.Count -ne $expectedAiSuggestedCount) {
  throw "STOP: $Phase ordinary AI line gate mismatch: allowed=$($allowedOrdinaryAiLines.Count), expected=$expectedAiSuggestedCount, unexpected=$($unexpectedOrdinaryAiLines.Count)"
}
$eventLines = Get-ExactLines $eventBytes
$eventText = ($eventLines | ForEach-Object { $_.text }) -join "`n"
$eventRecords = @()
foreach ($line in $eventLines) {
  if (([string]$line.text).StartsWith('VACUT_EVENT:', [StringComparison]::Ordinal)) {
    $eventRecords += [pscustomobject]@{
      line = $line
      payload = (([string]$line.text).Substring('VACUT_EVENT:'.Length) | ConvertFrom-Json)
    }
  }
}
$scriptImports = @($eventRecords | Where-Object { $null -ne $_.payload.scriptImport })
if ($scriptImports.Count -ne 1) { throw "STOP: expected one scriptImport event for $Phase, got $($scriptImports.Count)" }
$report = $scriptImports[0].payload.scriptImport
$eventCaptureAiLines = @($eventLines | Where-Object { ([string]$_.text).IndexOf('AI', [StringComparison]::Ordinal) -ge 0 })
$expectedEventAiLineCount = if ($Phase -eq 'formal-u6') { 1 } else { 0 }
if ($eventAiLines.Count -ne $expectedEventAiLineCount -or $eventCaptureAiLines.Count -ne $expectedEventAiLineCount) {
  throw "STOP: $Phase event AI line count mismatch: stdout=$($eventAiLines.Count), event_capture=$($eventCaptureAiLines.Count), expected=$expectedEventAiLineCount"
}
if ($expectedEventAiLineCount -eq 1) {
  if ([string]$eventAiLines[0].raw_sha256 -ne [string]$eventCaptureAiLines[0].raw_sha256 -or
      [string]$eventCaptureAiLines[0].raw_sha256 -ne [string]$scriptImports[0].line.raw_sha256) {
    throw 'STOP: the sole event AI line is not the sole scriptImport event line in both raw captures'
  }
}
$eventAiStringLeaves = @(Get-StringLeaves -Value $scriptImports[0].payload | Where-Object {
  ([string]$_.value).IndexOf('AI', [StringComparison]::Ordinal) -ge 0
})
$expectedEventAiStringCount = if ($Phase -eq 'formal-u6') { 43 } else { 0 }
if ($eventAiStringLeaves.Count -ne $expectedEventAiStringCount) {
  throw "STOP: $Phase event literal-AI string count mismatch: actual=$($eventAiStringLeaves.Count), expected=$expectedEventAiStringCount"
}
foreach ($leaf in $eventAiStringLeaves) {
  $pathMatch = [regex]::Match([string]$leaf.path, '^scriptImport\.warnings\[(?<index>\d+)\]\.message$')
  if (-not $pathMatch.Success) { throw "STOP: event contains literal AI outside an ai_suggested warning message: $($leaf.path)" }
  $warningIndex = [int]$pathMatch.Groups['index'].Value
  $warning = @($report.warnings)[$warningIndex]
  if ([string]$warning.code -ne 'ai_suggested' -or [string]$leaf.value -ne '制作字段为 AI 建议') {
    throw "STOP: event AI message is not the exact allowed ai_suggested text at warning index $warningIndex"
  }
}
if ($Phase -eq 'formal-u6') {
  if ([string]$report.route -ne 'template' -or [string]$report.format -ne 'VAC-SB-1' -or [int]$report.shots -ne 8) {
    throw 'STOP: formal U6 route/format/shot count mismatch'
  }
  if (@($report.blocked).Count -ne 2 -or @($report.warnings).Count -ne 53) {
    throw "STOP: formal U6 report count mismatch: blocked=$(@($report.blocked).Count), warnings=$(@($report.warnings).Count)"
  }
  $warningCounts = @{}
  foreach ($warning in @($report.warnings)) {
    $code = [string]$warning.code
    if (-not $warningCounts.ContainsKey($code)) { $warningCounts[$code] = 0 }
    $warningCounts[$code] += 1
  }
  $expectedWarningCounts = [ordered]@{ ai_suggested = 43; status_pending = 8; status_note = 2 }
  if ($warningCounts.Count -ne $expectedWarningCounts.Count) { throw 'STOP: formal U6 warning code set mismatch' }
  foreach ($entry in $expectedWarningCounts.GetEnumerator()) {
    if ([int]$warningCounts[$entry.Key] -ne [int]$entry.Value) {
      throw "STOP: formal U6 warning count mismatch for $($entry.Key): $($warningCounts[$entry.Key])"
    }
  }
  $ordinaryAiCells = @($allowedOrdinaryAiLines | ForEach-Object {
    [regex]::Match([string]$_.text, $fixedAiPattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant).Groups['cell'].Value
  } | Sort-Object)
  $eventAiCells = @($report.warnings | Where-Object { [string]$_.code -eq 'ai_suggested' } | ForEach-Object { [string]$_.cell } | Sort-Object)
  if (($ordinaryAiCells -join "`n") -ne ($eventAiCells -join "`n")) {
    throw 'STOP: ordinary ai_suggested log cell multiset does not match event ai_suggested warning cell multiset'
  }
  $blockedFacts = @($report.blocked | ForEach-Object { "$(($_.cell))|$(($_.shot))|$(($_.column))|$(($_.code))" })
  foreach ($required in @('I9|8|口播|text_cell_pending','K9|8|上屏文字|text_cell_pending')) {
    if ($blockedFacts -notcontains $required) { throw "STOP: formal U6 event lacks blocked fact $required" }
  }
} else {
  if ([string]$report.route -ne 'template' -or [string]$report.format -ne 'VAC-SB-1' -or [int]$report.shots -ne 1) {
    throw 'STOP: badshot route/format/shot count mismatch'
  }
  $blocked = @($report.blocked)
  if ($blocked.Count -ne 1 -or [string]$blocked[0].code -ne 'shot_no_invalid' -or [string]$blocked[0].cell -ne 'A2' -or [int]$blocked[0].shot -ne -1 -or [string]$blocked[0].column -ne '镜号') {
    throw 'STOP: badshot event lacks the exact A2/-1/镜号/shot_no_invalid blocked item'
  }
}
$Candidate = 'D:\Video Edit\VideoAutoCut-step4-audit\44959b4-20260924-envprep\runtime\44959b4-envprep\VideoAutoCut'
$serializedCandidate = $Candidate.Replace('\', '\\')
$candidatePythonMarker = $serializedCandidate + '\\python-3.11.9-embed-amd64\\python.exe'
$candidateScriptMarker = $serializedCandidate + '\\tools\\normalize_script.py'
if (-not $stdoutText.Contains($candidatePythonMarker, [StringComparison]::OrdinalIgnoreCase) -or
    -not $stdoutText.Contains($candidateScriptMarker, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'STOP: stdout command provenance does not contain the Candidate Python and normalize_script.py paths'
}
$currentBeforePath = Join-Path $Receipts "current-before-$Phase.json"
if (-not (Test-Path -LiteralPath $currentBeforePath -PathType Leaf)) { throw "STOP: missing pre-import current receipt for $Phase" }
$currentBefore = Get-Content -LiteralPath $currentBeforePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([IO.Path]::GetFullPath([string]$currentBefore.path) -ne $Candidate) { throw 'STOP: pre-import current receipt does not point to Candidate' }

$secretPattern = '(?i)(authorization\s*:|bearer\s+[a-z0-9._-]+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])'
foreach ($line in $aiLines) {
  if ([regex]::IsMatch([string]$line.text, $secretPattern)) { throw 'STOP: an AI line appears to contain credential material; do not export it' }
}
$aiLineReceipt = [ordered]@{
  schema = 'vacut-u6-ai-line-inventory/v1'
  phase = $Phase
  source_stdout_path = $stdoutPath
  source_stdout_sha256 = [string]$metadata.stdout.sha256
  exact_preservation = 'text plus line ending plus raw UTF-8 base64 and per-line SHA-256'
  all_ai_line_count = $aiLines.Count
  ordinary_ai_line_count = $ordinaryAiLines.Count
  fixed_ai_suggested_count = $allowedOrdinaryAiLines.Count
  unexpected_ordinary_ai_line_count = $unexpectedOrdinaryAiLines.Count
  event_ai_line_count = $eventAiLines.Count
  event_literal_ai_string_count = $eventAiStringLeaves.Count
  lines = $aiLines
  secret_pattern_matches = 0
}
$aiLineReceiptPath = Join-Path $Receipts "ai-lines-$Phase.json"
[IO.File]::WriteAllText($aiLineReceiptPath, (($aiLineReceipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt = [ordered]@{
  schema = 'vacut-u6-captured-import-check/v1'
  phase = $Phase
  checked_at = (Get-Date).ToUniversalTime().ToString('o')
  pass = $true
  sequence = $sequence
  metadata_path = $metadataFiles[0].FullName
  metadata_sha256 = (Get-FileHash -LiteralPath $metadataFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  exit_code = [int]$metadata.exit_code
  stdout = [ordered]@{ path = $stdoutPath; sha256 = [string]$metadata.stdout.sha256; bytes = [int64]$metadata.stdout.bytes }
  stderr = [ordered]@{ path = $stderrPath; sha256 = [string]$metadata.stderr.sha256; bytes = [int64]$metadata.stderr.bytes }
  events = [ordered]@{ path = $eventsPath; sha256 = [string]$metadata.vacut_events.sha256; lines = [int]$metadata.vacut_events.lines }
  standard_template_marker = $true
  forbidden_model_path_or_name_markers = $forbiddenHits.Count
  ai_lines = [ordered]@{
    inventory_path = $aiLineReceiptPath
    inventory_sha256 = (Get-FileHash -LiteralPath $aiLineReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    all = $aiLines.Count
    ordinary = $ordinaryAiLines.Count
    fixed_ai_suggested = $allowedOrdinaryAiLines.Count
    unexpected_ordinary = $unexpectedOrdinaryAiLines.Count
    event = $eventAiLines.Count
  }
  candidate_provenance = [ordered]@{
    current_runtime_path = [string]$currentBefore.path
    captured_child_executable_basename = [string]$metadata.child_executable_basename
    candidate_python_path_in_stdout = $true
    candidate_normalize_script_path_in_stdout = $true
  }
  script_import_event_count = $scriptImports.Count
  report = [ordered]@{
    route = [string]$report.route
    format = [string]$report.format
    shots = [int]$report.shots
    blocked = @($report.blocked).Count
    warnings = @($report.warnings).Count
    warning_codes = if ($Phase -eq 'formal-u6') { [ordered]@{ ai_suggested = 43; status_pending = 8; status_note = 2 } } else { @{} }
  }
}
$receiptPath = Join-Path $Receipts "captured-import-$Phase.json"
[IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
$receipt | ConvertTo-Json -Depth 8
