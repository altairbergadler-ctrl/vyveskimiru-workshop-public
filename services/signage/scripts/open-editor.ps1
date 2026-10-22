param(
    [int]$Port = 54735,
    [string]$OutputDirectory = (Join-Path (Get-Location) 'output\ai-generations'),
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid local port.' }
$signageOutput = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
$signageScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'render_server.py'))
$signageUrl = "http://127.0.0.1:$Port"

function Get-SignageStatus {
    try {
        $status = Invoke-RestMethod -Uri "$signageUrl/api/config" -TimeoutSec 5
        if ($status.provider -eq 'codex' -and $status.model -eq 'Codex imagegen' -and $status.token) { return $status }
    } catch {}
    return $null
}

$signageListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($signageListener) {
    $signageExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$($signageListener.OwningProcess)"
    $signageCommand = $signageExisting.CommandLine
    $signageOutputPattern = '(?i)(?:^|\s)--output\s+(?:"' + [regex]::Escape($signageOutput) + '"|' + [regex]::Escape($signageOutput) + '(?=\s|$))'
    if (-not $signageCommand -or $signageCommand.IndexOf($signageScript, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $signageCommand -notmatch $signageOutputPattern -or -not (Get-SignageStatus)) {
        throw "Port $Port is occupied by another service or history folder. No process was stopped."
    }
    $signagePid = $signageListener.OwningProcess
} else {
    $signagePython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (-not (Test-Path -LiteralPath $signagePython)) { $signagePython = (Get-Command python -ErrorAction Stop).Source }
    $signageLogs = Join-Path (Split-Path -Parent $signageOutput) 'server'
    New-Item -ItemType Directory -Path $signageLogs -Force | Out-Null
    $signageArguments = '-X utf8 "{0}" --port {1} --output "{2}"' -f $signageScript, $Port, $signageOutput
    $signageProcess = Start-Process -FilePath $signagePython -ArgumentList $signageArguments -WorkingDirectory (Split-Path -Parent $signageOutput) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $signageLogs 'stdout.log') -RedirectStandardError (Join-Path $signageLogs 'stderr.log') -PassThru
    $signagePid = $signageProcess.Id
    Set-Content -LiteralPath (Join-Path $signageLogs 'server.pid') -Value $signagePid -Encoding ascii
    $signageReady = $false
    $signageDeadline = [DateTime]::UtcNow.AddSeconds(20)
    for ($attempt = 0; $attempt -lt 15 -and [DateTime]::UtcNow -lt $signageDeadline; $attempt++) {
        if ($signageProcess.HasExited) { break }
        if (Get-SignageStatus) { $signageReady = $true; break }
        Start-Sleep -Milliseconds 300
        $signageProcess.Refresh()
    }
    if (-not $signageReady) { throw "Server did not become ready. See $signageLogs\stderr.log" }
}
Write-Output "Editor ready: $signageUrl/calibrator.html (PID $signagePid)"
if (-not $NoBrowser) { Start-Process -FilePath "$signageUrl/calibrator.html" }
