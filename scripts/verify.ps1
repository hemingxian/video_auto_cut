[CmdletBinding()]
param(
    [string]$PythonExe,
    [switch]$SkipPython,
    [switch]$SkipWeb,
    [switch]$SkipRust,
    [switch]$SkipDesktop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PythonCompileExclude = '(^|[\\/])(animation_agent[\\/]official|material_gen[\\/](hyperframes|remotion))([\\/]|$)'

function Invoke-Step {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [scriptblock]$Action
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

function Resolve-Python {
    if ($PythonExe) {
        $command = Get-Command $PythonExe -ErrorAction Stop
        return @{ Path = $command.Source; Prefix = @() }
    }

    $embeddedPython = Join-Path $RepositoryRoot "VideoAutoCut/python-3.11.9-embed-amd64/python.exe"
    if (Test-Path -LiteralPath $embeddedPython) {
        return @{ Path = $embeddedPython; Prefix = @() }
    }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        & $python.Source --version *> $null
        if ($LASTEXITCODE -eq 0) {
            return @{ Path = $python.Source; Prefix = @() }
        }
    }

    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($launcher) {
        return @{ Path = $launcher.Source; Prefix = @("-3") }
    }

    throw "Python 3 was not found. Pass its path with -PythonExe."
}

function Invoke-Python {
    param(
        [Parameter(Mandatory)]
        [hashtable]$Runtime,
        [Parameter(ValueFromRemainingArguments)]
        [string[]]$Arguments
    )

    $pythonArguments = @($Runtime.Prefix) + $Arguments
    & $Runtime.Path @pythonArguments
}

Push-Location $RepositoryRoot
try {
    if (-not $SkipPython) {
        $python = Resolve-Python
        Invoke-Step "Python syntax" {
            Invoke-Python $python -m compileall -q -x $PythonCompileExclude VideoAutoCut/tools
        }
        if (Test-Path -LiteralPath "VideoAutoCut/tests") {
            Invoke-Step "Python tests" {
                Invoke-Python $python -m unittest discover -s VideoAutoCut/tests -p "test_*.py"
            }
        }
    }

    if (-not $SkipWeb) {
        Invoke-Step "Website JavaScript syntax" {
            node --check VideoAutoCutWeb/assets/site.js
        }
        Invoke-Step "Website tests" {
            node --test VideoAutoCutWeb/tests/site.test.mjs
        }
    }

    if (-not $SkipRust) {
        Push-Location "VideoAutoCutApp"
        try {
            Invoke-Step "Rust formatting" { cargo fmt --check }
            Invoke-Step "Rust Clippy" { cargo clippy --all-targets --all-features -- -D warnings }
            Invoke-Step "Rust tests" { cargo test --all-targets --all-features }
        }
        finally {
            Pop-Location
        }
    }

    if (-not $SkipDesktop) {
        Push-Location "VideoAutoCutDesktop"
        try {
            Invoke-Step "Desktop tests" { npm test }
            Invoke-Step "Desktop lint" { npm run lint }
            Invoke-Step "Desktop build" { npm run build }
            Invoke-Step "Desktop packaging scripts" { npm run build:scripts }
        }
        finally {
            Pop-Location
        }
    }

    Write-Host "`nAll requested checks passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
