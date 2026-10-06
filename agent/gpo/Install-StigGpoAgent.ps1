#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the STIG Tracker GPO agent as a scheduled task.

.DESCRIPTION
    Copies StigGpoAgent.ps1 to -InstallPath, locks down the configuration and
    work folders, and registers a task that polls the tracker every
    -IntervalMinutes. Run it once per agent host (or once per environment if
    test and production use separate hosts/identities).

.PARAMETER ServiceAccount
    Account the task runs as. A group managed service account is strongly
    recommended, e.g. 'CONTOSO\gmsa-stiggpo$'. It needs: GPO creation rights
    (Group Policy Creator Owners or delegated), "Link GPOs" on each configured
    OU, read access to the agent certificate's private key, and WinRM access to
    validation computers (test environment).

.EXAMPLE
    .\Install-StigGpoAgent.ps1 -ServiceAccount 'CONTOSO\gmsa-stiggpo$' -ConfigPath .\agent.config.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ServiceAccount,
    [Parameter(Mandatory)][string]$ConfigPath,
    [string]$InstallPath = (Join-Path $env:ProgramFiles 'StigGpoAgent'),
    [string]$DataPath = (Join-Path $env:ProgramData 'StigGpoAgent'),
    [ValidateRange(1, 1440)][int]$IntervalMinutes = 5,
    [string]$TaskName = 'STIG Tracker GPO Agent'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable GroupPolicy)) {
    throw 'The GroupPolicy module is missing. Install RSAT: Group Policy Management Tools first.'
}

# Validate before installing so a broken config never reaches the task. Pass
# -ConfigPath through so dot-sourcing does not rebind it to the agent's default.
. (Join-Path $PSScriptRoot 'StigGpoAgent.ps1') -ConfigPath $ConfigPath
$null = Read-AgentConfig -Path $ConfigPath

if ($ServiceAccount.EndsWith('$')) { $logonType = 'Password' }
elseif ($ServiceAccount -in 'SYSTEM', 'NT AUTHORITY\SYSTEM') { $logonType = 'ServiceAccount' }
else { throw 'Run the agent as a group managed service account (DOMAIN\name$) so no password is stored.' }

New-Item -ItemType Directory -Path $InstallPath, $DataPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'StigGpoAgent.ps1') -Destination $InstallPath -Force
$installedConfig = Join-Path $DataPath 'agent.config.json'
Copy-Item -LiteralPath $ConfigPath -Destination $installedConfig -Force

# Only administrators and SYSTEM may change what the agent executes or which
# OUs it may touch; the service account may only read config and write logs.
function Set-FolderAcl([string]$Path, [string]$Rights) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach ($id in 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', $inherit, 'None', 'Allow')))
    }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ServiceAccount, $Rights, $inherit, 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}
Set-FolderAcl $InstallPath 'ReadAndExecute'
Set-FolderAcl $DataPath 'Modify'
$configAcl = Get-Acl -LiteralPath $installedConfig
$configAcl.SetAccessRuleProtection($true, $false)
foreach ($id in 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM') {
    $configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow')))
}
$configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ServiceAccount, 'Read', 'Allow')))
Set-Acl -LiteralPath $installedConfig -AclObject $configAcl

$script = Join-Path $InstallPath 'StigGpoAgent.ps1'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$script`" -ConfigPath `"$installedConfig`" -Once"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId $ServiceAccount -LogonType $logonType -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Registered '$TaskName' to run every $IntervalMinutes minute(s) as $ServiceAccount."
Write-Host "Logs: $(Join-Path $DataPath 'logs')"
