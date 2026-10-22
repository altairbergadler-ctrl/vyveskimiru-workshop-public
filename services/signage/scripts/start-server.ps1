param([int]$Port = 54735, [string]$OutputDirectory = (Join-Path (Get-Location) 'output\ai-generations'))
$ErrorActionPreference = 'Stop'
$signagePython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path -LiteralPath $signagePython)) {
    $signagePython = (Get-Command python -ErrorAction Stop).Source
}
$signageServer = Join-Path $PSScriptRoot 'render_server.py'
& $signagePython $signageServer --port $Port --output $OutputDirectory
