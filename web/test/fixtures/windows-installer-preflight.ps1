param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('werdr-installer-preflight-' + [Guid]::NewGuid().ToString('N'))
$previousAppData = $env:LOCALAPPDATA
$session = 'repro-installer-preflight'
$version = '0.8.2-preview.2026-09-06-9e9bc8a14466'
$digest = '991abaf23ef7008a6ef91e6c0dbc6caac7f8bfebe9d14e54294ccc6b5352d99e'
$global:WerdrPreflightStarts = 0
$global:WerdrPreflightQueries = 0
$global:WerdrPreflightTask = $null
# Intercept every external effect. No scheduled task or executable may run.
function Get-ScheduledTask { param($TaskName) $global:WerdrPreflightQueries++; return $global:WerdrPreflightTask }
function Start-ScheduledTask { param($TaskName) $global:WerdrPreflightStarts++; throw 'UNSAFE_TASK_START' }
function Register-ScheduledTask { throw 'UNEXPECTED_TASK_REGISTRATION' }
function Start-Process { throw 'UNEXPECTED_PROCESS_START' }
function Invoke-WebRequest { throw 'UNEXPECTED_DOWNLOAD' }
try {
    $env:LOCALAPPDATA = $testRoot
    $release = Join-Path $testRoot ('werdr\herdr\' + $version)
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    $binary = Join-Path $release 'herdr.exe'
    Set-Content -LiteralPath $binary -Value 'not executable: preflight fixture only'
    Set-Content -LiteralPath (Join-Path $release '.archive-sha256') -Value $digest
    foreach ($scenario in @('different-session', 'session-case', 'missing-arguments', 'extra-action', 'no-actions', 'different-executable', 'different-description', 'matching-task')) {
        $action = [pscustomobject]@{ Execute = $binary; Arguments = '--session ' + $session + ' server' }
        $global:WerdrPreflightTask = [pscustomobject]@{
            Description = 'Managed by werdr/install-windows-server.ps1; owns the ' + $session + ' session only.'
            Actions = @($action)
            State = 'Ready'
        }
        if ($scenario -eq 'different-session') { $action.Arguments = '--session unrelated-user-session server' }
        if ($scenario -eq 'session-case') { $action.Arguments = '--session ' + $session.ToUpperInvariant() + ' server' }
        if ($scenario -eq 'missing-arguments') { $action.Arguments = '' }
        if ($scenario -eq 'extra-action') { $global:WerdrPreflightTask.Actions = @($action, $action) }
        if ($scenario -eq 'no-actions') { $global:WerdrPreflightTask.Actions = @() }
        if ($scenario -eq 'different-executable') { $action.Execute = Join-Path $testRoot 'other.exe' }
        if ($scenario -eq 'different-description') { $global:WerdrPreflightTask.Description = 'Not owned by this installer' }
        $global:WerdrPreflightStarts = 0
        $failure = $null
        try { & $Installer -Session $session } catch { $failure = $_.Exception.Message }
        if ($scenario -eq 'matching-task') {
            if ($global:WerdrPreflightStarts -ne 1 -or $failure -ne 'UNSAFE_TASK_START') { throw 'Matching task did not pass preflight' }
        } elseif ($global:WerdrPreflightStarts -ne 0 -or $failure -notlike '*Existing task differs*') { throw "Unsafe preflight for ${scenario}: starts=$global:WerdrPreflightStarts; failure=$failure" }
        Write-Output "PASS_TASK_PREFLIGHT:$scenario"
    }
    foreach ($scenario in @('missing-binary', 'missing-receipt', 'wrong-receipt')) {
        Set-Content -LiteralPath $binary -Value 'not executable: preflight fixture only'
        Set-Content -LiteralPath (Join-Path $release '.archive-sha256') -Value $digest
        if ($scenario -eq 'missing-binary') { Remove-Item -LiteralPath $binary }
        if ($scenario -eq 'missing-receipt') { Remove-Item -LiteralPath (Join-Path $release '.archive-sha256') -Force }
        if ($scenario -eq 'wrong-receipt') { Set-Content -LiteralPath (Join-Path $release '.archive-sha256') -Value 'wrong digest' }
        $global:WerdrPreflightQueries = 0
        $failure = $null
        try { & $Installer -Session $session } catch { $failure = $_.Exception.Message }
        if (-not $failure -or $global:WerdrPreflightQueries -ne 0) { throw "Partial release reached task inspection: $scenario" }
        Write-Output "PASS_RELEASE_PREFLIGHT:$scenario"
    }
} finally {
    $env:LOCALAPPDATA = $previousAppData
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
