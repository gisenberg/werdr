#requires -Version 7.2
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installer = Join-Path $PSScriptRoot 'install-windows-server.ps1'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('werdr-installer-test-' + [Guid]::NewGuid().ToString('N'))
$savedLocal = $env:LOCALAPPDATA
$savedArchitecture = $env:PROCESSOR_ARCHITECTURE
$savedOverrides = @{}
foreach ($name in @('HERDR_SOCKET_PATH', 'HERDR_CLIENT_SOCKET_PATH', 'HERDR_SESSION')) {
    $savedOverrides[$name] = [Environment]::GetEnvironmentVariable($name)
}
$global:werdrInstallerTest = @{ outputs = [Collections.Generic.HashSet[string]]::new(); nested = $false; timeout = $false; killed = $false }
function Get-ScheduledTask {
    param($TaskName)
    $name = $TaskName.Substring('Werdr Herdr Server '.Length)
    [pscustomobject]@{
        State = 'Running'
        Description = 'Managed by werdr/install-windows-server.ps1; owns the ' + $name + ' session only.'
        Actions = @([pscustomobject]@{ Execute = $global:werdrInstallerTest.binary; Arguments = '--session ' + $name + ' server' })
    }
}
function Start-Sleep { param($Seconds) }
function Start-Process {
    param($FilePath, $ArgumentList, [switch]$PassThru, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError)
    if (-not $global:werdrInstallerTest.outputs.Add($RedirectStandardOutput)) { throw 'Readiness output path reused across installer invocations' }
    if ($RedirectStandardOutput -eq $RedirectStandardError) { throw 'Readiness streams share a path' }
    [IO.File]::WriteAllText($RedirectStandardOutput, '{"result":{"snapshot":{}},"error":null}')
    [IO.File]::WriteAllText($RedirectStandardError, '')
    # Keep the first invocation alive while another session is prepared.
    if (-not $global:werdrInstallerTest.nested -and -not $global:werdrInstallerTest.timeout) {
        $global:werdrInstallerTest.nested = $true
        & $installer -Session 'fixture-inner' | Out-Null
        if (-not (Test-Path -LiteralPath $RedirectStandardOutput)) { throw 'Nested installer removed another invocation output' }
    }
    $process = [pscustomobject]@{ ExitCode = 0 }
    $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return (-not $global:werdrInstallerTest.timeout -or $global:werdrInstallerTest.killed) }
    $process | Add-Member ScriptMethod Kill { $global:werdrInstallerTest.killed = $true }
    $process | Add-Member ScriptMethod Dispose { }
    return $process
}
try {
    $env:LOCALAPPDATA = $fixture
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'
    $release = Join-Path $fixture 'werdr/herdr/0.8.2-preview.2026-09-06-9e9bc8a14466'
    New-Item -ItemType Directory -Path $release -Force | Out-Null
    $global:werdrInstallerTest.binary = Join-Path $release 'herdr.exe'
    [IO.File]::WriteAllText($global:werdrInstallerTest.binary, 'fixture only, never executed')
    [IO.File]::WriteAllText((Join-Path $release '.archive-sha256'), '991abaf23ef7008a6ef91e6c0dbc6caac7f8bfebe9d14e54294ccc6b5352d99e')
    & $installer -Session 'fixture-outer' | Out-Null
    if ($global:werdrInstallerTest.outputs.Count -ne 2) { throw 'Nested test did not exercise two readiness probes' }
    foreach ($path in $global:werdrInstallerTest.outputs) {
        if (Test-Path -LiteralPath $path) { throw 'Successful installer leaked readiness output' }
    }
    $global:werdrInstallerTest.timeout = $true
    $failed = $false
    try { & $installer -Session 'fixture-timeout' | Out-Null } catch {
        if ($_.Exception.Message -ne 'Herdr API readiness probe timed out.') { throw }
        $failed = $true
    }
    if (-not $failed -or -not $global:werdrInstallerTest.killed) { throw 'Timed-out readiness probe was not stopped' }
    foreach ($path in $global:werdrInstallerTest.outputs) {
        if (Test-Path -LiteralPath (Split-Path $path)) { throw 'Installer leaked readiness directory' }
    }
    Write-Output 'PASS: overlapping readiness probes have isolated paths and clean success/timeout output.'
} finally {
    $env:LOCALAPPDATA = $savedLocal
    $env:PROCESSOR_ARCHITECTURE = $savedArchitecture
    foreach ($entry in $savedOverrides.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value) }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
