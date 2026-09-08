#Requires -Version 7.0
# Tests only the parsed function definitions with fake DISM responses.
# Never executes the installer body, requests elevation, or changes Windows.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '..\scripts\install-docker-windows.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -in @('Read-InstallerFeatureState', 'Enable-InstallerVirtualMachinePlatform')
}, $false))
if ($functions.Count -ne 2) { throw 'Missing DISM helper definitions.' }
foreach ($definition in $functions) { . ([scriptblock]::Create($definition.Extent.Text)) }

function Invoke-InstallerDism {
    param([string[]]$CommandArguments)
    $script:requests.Add($CommandArguments)
    if ($script:responses.Count -eq 0) { throw 'Unexpected DISM call.' }
    return $script:responses.Dequeue()
}
function Response([string]$State = 'Enabled', [int]$ExitCode = 0) {
    return [pscustomobject]@{ ExitCode = $ExitCode; Output = "Feature Name : VirtualMachinePlatform`r`nState : $State`r`n" }
}
function Check-Scenario {
    param([string]$Name, [object[]]$Results, [bool]$Reboot = $false, [string]$ErrorPattern = '')
    $script:responses = [Collections.Generic.Queue[object]]::new()
    foreach ($result in $Results) { $script:responses.Enqueue($result) }
    $script:requests = [Collections.Generic.List[object]]::new()
    $caught = $null; $actual = $null
    try { $actual = Enable-InstallerVirtualMachinePlatform } catch { $caught = $_ }
    if ($ErrorPattern) {
        if (-not $caught -or $caught.Exception.Message -notmatch $ErrorPattern) { throw "$Name failed: expected error $ErrorPattern; got $caught" }
    } elseif ($caught -or $actual -isnot [bool] -or $actual -ne $Reboot) { throw "$Name failed: reboot=$actual; error=$caught" }
    if ($script:responses.Count) { throw "$Name did not consume the expected responses." }
    foreach ($request in $script:requests) {
        if ('/FeatureName:VirtualMachinePlatform' -notin $request) { throw 'Unexpected feature target.' }
        if ('/Enable-Feature' -in $request -and '/NoRestart' -notin $request) { throw 'Automatic restart not prevented.' }
    }
    Write-Host "PASS: $Name"
}

Check-Scenario -Name 'already enabled: no mutation' -Results @((Response))
Check-Scenario -Name 'enable pending: reboot first' -Results @((Response 'Enable Pending')) -Reboot $true
Check-Scenario -Name 'disable pending: reboot first' -Results @((Response 'Disable Pending')) -Reboot $true
Check-Scenario -Name 'enable and verify' -Results @((Response 'Disabled'), (Response), (Response))
Check-Scenario -Name '3010 requires reboot' -Results @((Response 'Disabled'), (Response '' 3010)) -Reboot $true
Check-Scenario -Name 'success with pending state requires reboot' -Results @((Response 'Disabled'), (Response), (Response 'Enable Pending')) -Reboot $true
Check-Scenario -Name 'query failure stops' -Results @((Response '' 740)) -ErrorPattern 'query failed'
Check-Scenario -Name 'enable failure stops' -Results @((Response 'Disabled'), (Response '' 50)) -ErrorPattern 'enable failed'
Check-Scenario -Name 'unknown state stops' -Results @((Response 'Unexpected')) -ErrorPattern 'Unexpected VirtualMachinePlatform state'
Check-Scenario -Name 'missing state stops' -Results @([pscustomobject]@{ ExitCode = 0; Output = 'No state present' }) -ErrorPattern 'refusing to guess'
Check-Scenario -Name 'unchanged state stops' -Results @((Response 'Disabled'), (Response), (Response 'Disabled')) -ErrorPattern 'not enabled'

$commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true))
if (@($commands | Where-Object { $_.GetCommandName() -in @('Get-WindowsOptionalFeature', 'Enable-WindowsOptionalFeature') }).Count) {
    throw 'Installer still uses a PowerShell DISM cmdlet.'
}
Write-Host 'All 11 scenarios and syntax checks passed. No native DISM or installer execution occurred.'
