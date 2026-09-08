#Requires -Version 7.0
#Requires -RunAsAdministrator
<#
.SYNOPSIS
Install per-user Docker Desktop with the WSL 2 Linux backend.
.DESCRIPTION
Run elevated as YOUR normal Windows account. Enables VirtualMachinePlatform
if needed, installs/updates WSL only when missing or too old, downloads Docker's
official installer and verifies its Authenticode publisher before execution.
Never reboots automatically, accepts Docker's license, starts Docker elevated,
pulls images, changes existing WSL distributions, or adds docker-users members.
Existing Docker installations are left unchanged. Rerun after a requested reboot.
.PARAMETER AddCodexToUserPath
Append the existing standalone Codex current/bin directory to this user's PATH.
Does not install or upgrade Codex, alter machine PATH, or use setx.
.LINK
https://docs.docker.com/desktop/setup/install/windows-install/
.LINK
https://learn.microsoft.com/en-us/windows/wsl/basic-commands
#>
[CmdletBinding()]
param([switch]$AddCodexToUserPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Request-Reboot {
    Write-Warning 'Save your work, restart Windows yourself, then rerun this same script. No restart was initiated.'
}

function Invoke-WslChange {
    param([string[]]$CommandArguments)
    & $script:wslExe @CommandArguments | Out-Host
    $resultCode = $LASTEXITCODE
    if ($resultCode -eq 3010) { return $true }
    if ($resultCode -ne 0) {
        throw "WSL failed (exit $resultCode). Resolve the message above; no Docker installer was run."
    }
    return $false
}

function Invoke-InstallerDism {
    param([string[]]$CommandArguments)
    # Native DISM bypasses the PowerShell DISM module's COM registration issue
    # seen with some MSIX/Store PowerShell installs (PowerShell issue #13866).
    $dismExe = Join-Path $env:SystemRoot 'System32\dism.exe'
    $text = ((& $dismExe /English @CommandArguments 2>&1) -join "`n").Replace([string][char]0, '')
    $resultCode = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $resultCode; Output = $text }
}

function Read-InstallerFeatureState {
    $result = Invoke-InstallerDism -CommandArguments @('/Online', '/Get-FeatureInfo', '/FeatureName:VirtualMachinePlatform')
    if ($result.ExitCode -ne 0) {
        throw "DISM feature query failed (exit $($result.ExitCode)). No Docker installer was run.`n$($result.Output)"
    }
    # /English makes the state field predictable regardless of Windows locale.
    $states = [regex]::Matches($result.Output, '(?im)^[ \t]*State[ \t]*:[ \t]*([^\r\n]+)')
    if ($states.Count -ne 1) { throw "Could not determine VirtualMachinePlatform state from DISM; refusing to guess.`n$($result.Output)" }
    return $states[0].Groups[1].Value.Trim()
}

function Enable-InstallerVirtualMachinePlatform {
    # Return true only when the caller needs to stop and request a reboot.
    $state = Read-InstallerFeatureState
    if ($state -in @('Enable Pending', 'Disable Pending')) { return $true }
    if ($state -eq 'Enabled') { Write-Host 'VirtualMachinePlatform is already enabled.'; return $false }
    if ($state -notin @('Disabled', 'Disabled with Payload Removed', 'Removed')) {
        throw "Unexpected VirtualMachinePlatform state '$state'; refusing to change it."
    }
    Write-Host 'Enabling VirtualMachinePlatform using native DISM (no automatic restart)...'
    $result = Invoke-InstallerDism -CommandArguments @('/Online', '/Enable-Feature', '/FeatureName:VirtualMachinePlatform', '/All', '/NoRestart')
    Write-Host $result.Output
    if ($result.ExitCode -eq 3010) { return $true }
    if ($result.ExitCode -ne 0) { throw "DISM feature enable failed (exit $($result.ExitCode)). No Docker installer was run." }
    $state = Read-InstallerFeatureState
    if ($state -in @('Enable Pending', 'Disable Pending')) { return $true }
    if ($state -ne 'Enabled') { throw "DISM completed but VirtualMachinePlatform is '$state', not enabled." }
    return $false
}

if (-not $IsWindows -or -not [Environment]::Is64BitProcess) {
    throw 'Use 64-bit PowerShell 7 on Windows.'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This installer script targets this machine''s x64 architecture, not ARM64.'
}
$windowsInfo = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
if ([int]$windowsInfo.CurrentBuild -lt 22631 -or $windowsInfo.InstallationType -ne 'Client') {
    throw 'This script targets Windows 11 client build 22631 or newer. Check Docker support before installing elsewhere.'
}
Write-Host "Installing for $([Security.Principal.WindowsIdentity]::GetCurrent().Name), profile $env:USERPROFILE"

if ($AddCodexToUserPath) {
    $codexBin = Join-Path $env:USERPROFILE '.codex\packages\standalone\current\bin'
    if (-not (Test-Path -LiteralPath (Join-Path $codexBin 'codex.exe') -PathType Leaf)) {
        throw "No standalone Codex found at $codexBin. Run as your normal Windows account; no PATH change was made."
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $present = @($entries | Where-Object {
        [Environment]::ExpandEnvironmentVariables($_).Trim().TrimEnd('\') -ieq $codexBin.TrimEnd('\')
    }).Count -gt 0
    if (-not $present) {
        # Preserve the original user PATH verbatim; append only this one entry.
        $separator = if ([string]::IsNullOrEmpty($userPath) -or $userPath.EndsWith(';')) { '' } else { ';' }
        [Environment]::SetEnvironmentVariable('Path', "$userPath$separator$codexBin", 'User')
        Write-Host "Added to USER PATH: $codexBin"
    } else { Write-Host 'Codex is already present in the persisted user PATH.' }
    $env:Path = "$env:Path;$codexBin"
    & (Join-Path $codexBin 'codex.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'The existing Codex executable failed its version check.' }
}

$systemInfo = Get-CimInstance Win32_ComputerSystem
if ($systemInfo.TotalPhysicalMemory -lt 8GB) { throw 'Docker Desktop requires at least 8 GiB RAM.' }
if (-not $systemInfo.HypervisorPresent) {
    $processors = @(Get-CimInstance Win32_Processor)
    if (@($processors | Where-Object { -not $_.VirtualizationFirmwareEnabled -or -not $_.SecondLevelAddressTranslationExtensions }).Count) {
        throw 'Enable CPU virtualization in BIOS/UEFI (or nested virtualization for a VM), then retry.'
    }
}

# Modern WSL 2 requires VirtualMachinePlatform, not the legacy WSL 1 feature.
if (Enable-InstallerVirtualMachinePlatform) { Request-Reboot; return }

$wslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
$versionOutput = ((& $wslExe --version 2>&1) -join "`n").Replace([string][char]0, '')
$versionExit = $LASTEXITCODE
$match = [regex]::Match($versionOutput, '\d+\.\d+\.\d+(?:\.\d+)?')
if ($versionExit -ne 0 -or -not $match.Success) {
    if (Invoke-WslChange -CommandArguments @('--install', '--no-distribution', '--web-download', '--no-launch')) {
        Request-Reboot; return
    }
} elseif ([version]$match.Value -lt [version]'2.1.5') {
    if (Invoke-WslChange -CommandArguments @('--update', '--web-download')) { Request-Reboot; return }
} else { Write-Host "WSL $($match.Value) already meets the prerequisite; no update needed." }

$versionOutput = ((& $wslExe --version 2>&1) -join "`n").Replace([string][char]0, '')
$versionExit = $LASTEXITCODE
$match = [regex]::Match($versionOutput, '\d+\.\d+\.\d+(?:\.\d+)?')
if ($versionExit -ne 0 -or -not $match.Success -or [version]$match.Value -lt [version]'2.1.5') {
    throw "WSL 2.1.5+ could not be verified. A reboot may be required.`n$versionOutput"
}

# Do not silently enable Windows file/server sharing services against policy.
$serverService = Get-Service -Name LanmanServer
if ($serverService.StartType -ne 'Automatic' -or $serverService.Status -ne 'Running') {
    throw 'Docker lists LanmanServer (Server) running with Automatic startup as a prerequisite. Review that service setting with your Windows administrator, then rerun; this script does not change it.'
}

$existingDesktop = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($existingDesktop) {
    Write-Host "Docker Desktop already exists: $existingDesktop. Leaving its configuration and installation unchanged."
} else {
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-docker-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    $installer = Join-Path $downloadRoot 'Docker Desktop Installer.exe'
    try {
        Write-Host 'Downloading the official Docker Desktop x64 installer (large download)...'
        Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
            throw "Installer signature is not valid ($($signature.Status)); refusing to run it."
        }
        $publisher = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($publisher -notin @('Docker Inc', 'Docker Inc.')) {
            throw "Unexpected signed publisher '$publisher'; refusing to run the installer."
        }
        Write-Host "Verified publisher: $publisher. Installing per-user, WSL 2 backend, Linux containers only."
        $installed = Start-Process -FilePath $installer -ArgumentList @('install', '--user', '--quiet', '--backend=wsl-2', '--no-windows-containers') -WindowStyle Hidden -Wait -PassThru
        if ($installed.ExitCode -eq 3010) { Request-Reboot; return }
        if ($installed.ExitCode -ne 0) { throw "Docker installer failed with exit $($installed.ExitCode)." }
        $desktopPath = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktopPath -PathType Leaf)) { throw "Installer exited successfully, but Docker Desktop was not found at $desktopPath." }
    } finally {
        # Delete only the one downloaded file and its now-empty private directory.
        # No recursive removal and no changes to existing Docker data.
        if (Test-Path -LiteralPath $installer -PathType Leaf) { Remove-Item -LiteralPath $installer -Force }
        if (Test-Path -LiteralPath $downloadRoot -PathType Container) { Remove-Item -LiteralPath $downloadRoot }
    }
}

Write-Host @'

Installation is present; engine readiness is NOT yet verified.
1. Close this elevated prompt. Open Docker Desktop from Start as your normal user.
2. Review and accept Docker's license if appropriate; wait for the engine to start.
3. In a fresh normal PowerShell, run: docker info --format '{{.OSType}}'
   The plugin requires the result: linux
4. Fully quit/reopen Claude Code and Codex to pick up PATH changes. If an app
   still inherits an old PATH, sign out of Windows and sign back in.
No container images were downloaded. Image selection for verification is separate.
'@
