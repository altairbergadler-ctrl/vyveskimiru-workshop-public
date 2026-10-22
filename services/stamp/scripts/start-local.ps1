param([int]$Port = 8187, [switch]$NoBrowser, [switch]$CopyPassword)
$ErrorActionPreference = 'Stop'
$stampRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stampRuntime = Join-Path $stampRoot '.runtime'
$stampPython = Join-Path $stampRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $stampPython)) {
    $stampBasePython = (Get-Command python -ErrorAction Stop).Source
    & $stampBasePython -m venv (Join-Path $stampRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать окружение Python.' }
    & $stampPython -m pip install -r (Join-Path $stampRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось установить зависимости.' }
}
$stampEnvFile = Join-Path $stampRoot '.env'
if (-not (Test-Path -LiteralPath $stampEnvFile)) {
    $stampRandomBytes = New-Object byte[] 32
    $stampGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $stampGenerator.GetBytes($stampRandomBytes)
    $stampGenerator.Dispose()
    $stampPassword = [Convert]::ToBase64String($stampRandomBytes)
    $stampEnvText = [IO.File]::ReadAllText((Join-Path $stampRoot '.env.example')).Replace('REPLACE_WITH_RANDOM_PASSWORD', $stampPassword)
    [IO.File]::WriteAllText($stampEnvFile, $stampEnvText, (New-Object Text.UTF8Encoding($false)))
}
$stampValues = @{}
foreach ($stampLine in [IO.File]::ReadAllLines($stampEnvFile)) {
    if ($stampLine -match '^([A-Z_]+)=(.*)$') { $stampValues[$Matches[1]] = $Matches[2] }
}
if (-not $stampValues.APP_PASSWORD -or $stampValues.APP_PASSWORD.Length -lt 16 -or $stampValues.APP_PASSWORD -eq 'REPLACE_WITH_RANDOM_PASSWORD') {
    throw 'Задайте случайный APP_PASSWORD длиной от 16 символов в приватном .env.'
}
if ($CopyPassword) { Set-Clipboard -Value $stampValues.APP_PASSWORD }
$stampUrl = "http://127.0.0.1:$Port/"
$stampExisting = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($stampExisting) {
    if (-not (Test-Path -LiteralPath (Join-Path $stampRuntime 'service.json'))) { throw "Порт $Port занят другим процессом." }
    $stampSaved = Get-Content -LiteralPath (Join-Path $stampRuntime 'service.json') -Raw | ConvertFrom-Json
    if ($stampExisting.OwningProcess -notcontains $stampSaved.pid) {
        $stampServer = Get-CimInstance Win32_Process -Filter "ProcessId = $($stampExisting[0].OwningProcess)"
        if ($stampServer.ParentProcessId -ne $stampSaved.pid -or $stampServer.CommandLine -notmatch '-m uvicorn app\.main:app' -or $stampServer.CommandLine -notmatch "--port $Port(?: |$)") { throw "Порт $Port занят другим процессом." }
    }
} else {
    New-Item -ItemType Directory -Path $stampRuntime -Force | Out-Null
    $stampSavedEnv = @{}
    $stampValues.DATA_DIR = Join-Path $stampRoot 'data'
    $stampValues.APP_BASE_PATH = ''
    $stampValues.COOKIE_SECURE = 'false'
    $stampValues.JOB_TTL_SECONDS = '0'
    try {
        foreach ($stampKey in $stampValues.Keys) {
            $stampSavedEnv[$stampKey] = [Environment]::GetEnvironmentVariable($stampKey, 'Process')
            [Environment]::SetEnvironmentVariable($stampKey, $stampValues[$stampKey], 'Process')
        }
        $stampProcess = Start-Process -FilePath $stampPython -ArgumentList @('-m','uvicorn','app.main:app','--host','127.0.0.1','--port',"$Port",'--workers','1','--no-proxy-headers') -WorkingDirectory $stampRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stampRuntime 'server.log') -RedirectStandardError (Join-Path $stampRuntime 'server-error.log') -PassThru
        @{pid=$stampProcess.Id; port=$Port; root=$stampRoot; started=$stampProcess.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stampRuntime 'service.json') -Encoding UTF8
    } finally {
        foreach ($stampKey in $stampSavedEnv.Keys) { [Environment]::SetEnvironmentVariable($stampKey, $stampSavedEnv[$stampKey], 'Process') }
    }
}
$stampHealthy = $false
for ($stampAttempt = 0; $stampAttempt -lt 30; $stampAttempt++) {
    try {
        $stampHealth = Invoke-RestMethod -Uri ($stampUrl + 'health') -TimeoutSec 2
        if ($stampHealth.status -eq 'ok') { $stampHealthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 300
}
if (-not $stampHealthy) { throw 'Сервис не запустился. Проверьте .runtime/server-error.log.' }
Write-Host "Оттиск работает: $stampUrl"
Write-Host "Логин: $($stampValues.APP_USERNAME). Пароль хранится в приватном .env."
if ($CopyPassword) { Write-Host 'Пароль скопирован в буфер обмена: вставьте его в поле входа.' }
if (-not $NoBrowser) { Start-Process $stampUrl }
