$ErrorActionPreference = 'Stop'
$stampRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stampStateFile = Join-Path $stampRoot '.runtime\service.json'
if (-not (Test-Path -LiteralPath $stampStateFile)) { Write-Host 'Локальный сервис не запущен.'; exit }
$stampState = Get-Content -LiteralPath $stampStateFile -Raw | ConvertFrom-Json
$stampProcess = Get-Process -Id $stampState.pid -ErrorAction SilentlyContinue
if ($stampProcess) {
    $stampExpectedPython = [IO.Path]::GetFullPath((Join-Path $stampRoot '.venv\Scripts\python.exe'))
    if ($stampProcess.Path -ne $stampExpectedPython -or [Math]::Abs(($stampProcess.StartTime.ToUniversalTime() - [DateTime]::Parse($stampState.started).ToUniversalTime()).TotalSeconds) -gt 2) {
        throw 'PID принадлежит другому процессу. Остановка отменена.'
    }
    # Windows venv python.exe can be a redirector: Uvicorn listens in its child.
    # Stop only the verified Uvicorn child, then its verified launcher process.
    $stampChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($stampProcess.Id)" | Where-Object { $_.CommandLine -match '-m uvicorn app\.main:app' -and $_.CommandLine -match "--port $($stampState.port)(?: |$)" })
    foreach ($stampChild in $stampChildren) { Stop-Process -Id $stampChild.ProcessId -ErrorAction SilentlyContinue }
    Stop-Process -Id $stampProcess.Id -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $stampStateFile
Write-Host 'Сервис остановлен. Документы, результаты и оттиски сохранены.'
