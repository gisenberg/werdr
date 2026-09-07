[CmdletBinding()]
param([ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$Session = 'werdr')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '0.8.2-preview.2026-09-06-9e9bc8a14466'
$url = 'https://github.com/herdrdev/herdr/releases/download/preview-2026-09-06-9e9bc8a14466/herdr-windows-x86_64.zip'
$digest = '991abaf23ef7008a6ef91e6c0dbc6caac7f8bfebe9d14e54294ccc6b5352d99e'
$base = Join-Path $env:LOCALAPPDATA 'werdr\herdr'
$release = Join-Path $base $version
$binary = Join-Path $release 'herdr.exe'
$taskName = if ($Session -eq 'werdr') { 'Werdr Herdr Server' } else { 'Werdr Herdr Server ' + $Session }
$description = 'Managed by werdr/install-windows-server.ps1; owns the ' + $Session + ' session only.'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This release requires x64 Windows.' }
New-Item -ItemType Directory -Force -Path $base | Out-Null
if (-not (Test-Path $release)) {
    $staging = Join-Path $base ('.install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        $archive = Join-Path $staging 'herdr.zip'
        Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $digest) { throw 'Herdr release checksum mismatch.' }
        $unpacked = Join-Path $staging 'release'
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        if (-not (Test-Path (Join-Path $unpacked 'herdr.exe'))) { throw 'Release does not contain herdr.exe.' }
        Set-Content -LiteralPath (Join-Path $unpacked '.archive-sha256') -Value $digest
        Move-Item -LiteralPath $unpacked -Destination $release
    } finally { Remove-Item -LiteralPath $staging -Recurse -Force }
}
if (-not (Test-Path $binary) -or (Get-Content -LiteralPath (Join-Path $release '.archive-sha256') -Raw).Trim() -ne $digest) { throw 'Existing managed release is incomplete or unrecognized.' }
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Description -ne $description -or $existing.Actions.Execute -ne $binary)) { throw 'Existing task differs; a live-runtime upgrade requires an explicit handoff.' }
if (-not $existing) {
    $action = New-ScheduledTaskAction -Execute $binary -Argument ('--session ' + $Session + ' server') -WorkingDirectory $env:USERPROFILE
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description | Out-Null
    } catch [Microsoft.Management.Infrastructure.CimException] {
        if ($_.Exception.Message -notmatch 'Access is denied') { throw }
        # Unprivileged desktop accounts can supervise their own logon-session task.
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description | Out-Null
        Write-Output 'HERDR_SUPERVISION user-logon (startup registration requires elevation)'
    }
}
if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
# Never let an enclosing agent pane's implicit Herdr target leak into the readiness probe.
foreach ($name in @('HERDR_SOCKET_PATH','HERDR_CLIENT_SOCKET_PATH','HERDR_SESSION')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    $output = Join-Path $base '.readiness.json'
    $errorLog = Join-Path $base '.readiness-error.txt'
    $probe = Start-Process -FilePath $binary -ArgumentList ('--session ' + $Session + ' api snapshot') -PassThru -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errorLog
    if (-not $probe.WaitForExit(10000)) { $probe.Kill(); throw 'Herdr API readiness probe timed out.' }
    if ($probe.ExitCode -eq 0) { $snapshot = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json; if ($snapshot.result -and -not $snapshot.error) { $ready = $true; break } }
}
if (-not $ready) { Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime,LastTaskResult; throw 'Herdr did not become ready.' }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
Write-Output "HERDR_INSTALL_OK $version"
