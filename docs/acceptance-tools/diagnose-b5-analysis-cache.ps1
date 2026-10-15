param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$EmbeddedPython,
    [Parameter(Mandatory = $true)][string]$AuditDir
)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$EmbeddedPython = (Resolve-Path -LiteralPath $EmbeddedPython).Path
$RepositoryRoot = Split-Path -Parent $SourceRoot
$VersionedHelper = Join-Path $RepositoryRoot 'docs\acceptance-tools\diagnose-b5-analysis-cache.py'
if (-not (Test-Path -LiteralPath $VersionedHelper -PathType Leaf)) {
    throw "Missing versioned diagnostic helper: $VersionedHelper"
}

New-Item -ItemType Directory -Force -Path $AuditDir | Out-Null
$Helper = Join-Path $AuditDir 'diagnose-b5-analysis-cache.py'
Copy-Item -LiteralPath $VersionedHelper -Destination $Helper -Force
$HelperHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Helper).Hash
Set-Content -LiteralPath (Join-Path $AuditDir 'diagnose-b5-analysis-cache.sha256.txt') -Value $HelperHash -Encoding ASCII

$OriginalErrorActionPreference = $ErrorActionPreference
$AggregateExit = 0
foreach ($Mode in @('mixed', 'isolated')) {
    $Log = Join-Path $AuditDir "B5-$Mode-real-integrations.log"
    $ExitCode = Join-Path $AuditDir "B5-$Mode-real-integrations.exitcode.txt"
    $Command = Join-Path $AuditDir "B5-$Mode-real-integrations.command.txt"
    $Json = Join-Path $AuditDir "B5-$Mode-real-integrations.json"
    @($EmbeddedPython, '-X', 'utf8', $Helper, $SourceRoot, $Mode, $Json) |
        ConvertTo-Json | Set-Content -LiteralPath $Command -Encoding UTF8
    try {
        # Windows PowerShell 5 may promote native stderr to an ErrorRecord when
        # ErrorActionPreference is Stop. Keep the complete native log and rc.
        $ErrorActionPreference = 'Continue'
        & $EmbeddedPython -X utf8 $Helper $SourceRoot $Mode $Json *> $Log
        $Code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $OriginalErrorActionPreference
    }
    Set-Content -LiteralPath $ExitCode -Value $Code -Encoding ASCII
    if ($Code -ne 0) { $AggregateExit = 1 }
}

Get-ChildItem -LiteralPath $AuditDir -Filter 'B5-*-real-integrations*' |
    Select-Object Name, Length, LastWriteTime
exit $AggregateExit
