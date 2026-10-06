# Pester 3.4+ tests for the agent's offline logic. Run with Windows PowerShell 5.1:
#   powershell.exe -NoProfile -Command "Invoke-Pester agent\gpo\tests"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here '..\StigGpoAgent.ps1')

Describe 'Format-GpoName' {
    $gpo = [pscustomobject]@{ displayName = 'DoD Windows 11 Computer STIG v2r8'; family = 'DoD Windows 11 Computer STIG' }

    It 'substitutes every token' {
        Format-GpoName -Format '{DisplayName} [{Label} {Environment} {ReleaseId8}]' -Gpo $gpo -Label 'October 2026' -ReleaseId '3f2a9c1b-0000-4000-8000-000000000000' -Environment 'test' |
            Should BeExactly 'DoD Windows 11 Computer STIG v2r8 [October 2026 test 3f2a9c1b]'
    }

    It 'refuses names Group Policy cannot store' {
        { Format-GpoName -Format ('x' * 256) -Gpo $gpo -Label 'L' -ReleaseId '12345678-aaaa' -Environment 'test' } | Should Throw
    }
}

Describe 'Managed GPO markers' {
    It 'round-trips the marker written to the GPO description' {
        $text = New-ManagedMarker -ReleaseId 'r1' -Environment 'production' -Family 'DoD WinSvr 2022 MS STIG Comp' -BackupId '{ABC}' -Sha256 'ff'
        $m = Read-ManagedMarker $text
        $m.release | Should Be 'r1'
        $m.env | Should Be 'production'
        $m.family | Should Be 'DoD WinSvr 2022 MS STIG Comp'
    }

    It 'treats ordinary descriptions as unmanaged' {
        Read-ManagedMarker 'Corporate baseline' | Should Be $null
        Read-ManagedMarker '' | Should Be $null
    }
}

Describe 'Test-BaselineMatch' {
    $gpo = [pscustomobject]@{ displayName = 'DoD WinSvr 2022 MS STIG Comp v2r9'; family = 'DoD WinSvr 2022 MS STIG Comp' }
    It 'matches family patterns' { Test-BaselineMatch -Baseline ([pscustomobject]@{ Match = 'DoD WinSvr 2022 MS STIG Comp' }) -Gpo $gpo | Should Be $true }
    It 'matches versioned display names' { Test-BaselineMatch -Baseline ([pscustomobject]@{ Match = '*2022 MS*v2r9' }) -Gpo $gpo | Should Be $true }
    It 'does not cross member server and domain controller baselines' {
        Test-BaselineMatch -Baseline ([pscustomobject]@{ Match = 'DoD WinSvr 2022 DC STIG*' }) -Gpo $gpo | Should Be $false
    }
}

Describe 'Test-DnUnderTarget' {
    It 'accepts the OU itself and its descendants only' {
        Test-DnUnderTarget -DistinguishedName 'CN=WS01,OU=Pilot,OU=Workstations,DC=c,DC=mil' -Target 'OU=Workstations,DC=c,DC=mil' | Should Be $true
        Test-DnUnderTarget -DistinguishedName 'CN=WS01,OU=PilotWorkstations,DC=c,DC=mil' -Target 'OU=Workstations,DC=c,DC=mil' | Should Be $false
    }
}

Describe 'Set-GptTmplValue' {
    $inf = @('[Unicode]', 'Unicode=yes', '[Privilege Rights]', 'SeDenyNetworkLogonRight = *S-1-5-32-546', 'SeBackupPrivilege = *S-1-5-32-544', '[Version]', 'signature="$CHICAGO$"')

    It 'replaces an existing key in the right section only' {
        $out = Set-GptTmplValue -Lines $inf -Section 'Privilege Rights' -Key 'SeBackupPrivilege' -Value '*S-1-5-32-544,*S-1-5-32-551'
        $out -contains 'SeBackupPrivilege = *S-1-5-32-544,*S-1-5-32-551' | Should Be $true
        @($out | Where-Object { $_ -like 'SeBackupPrivilege*' }).Count | Should Be 1
        $out.Count | Should Be $inf.Count
    }

    It 'adds a missing key inside the section, before the next header' {
        $out = Set-GptTmplValue -Lines $inf -Section 'Privilege Rights' -Key 'SeShutdownPrivilege' -Value '*S-1-5-32-544'
        [array]::IndexOf($out, 'SeShutdownPrivilege = *S-1-5-32-544') | Should Be 5
    }

    It 'creates a missing section' {
        $out = Set-GptTmplValue -Lines $inf -Section 'System Access' -Key 'LockoutBadCount' -Value '5'
        $out[-2] | Should Be '[System Access]'
        $out[-1] | Should Be 'LockoutBadCount = 5'
    }

    It 'removes a key' {
        $out = Set-GptTmplValue -Lines $inf -Section 'Privilege Rights' -Key 'SeDenyNetworkLogonRight' -Value $null -Action delete
        @($out | Where-Object { $_ -like 'SeDenyNetworkLogonRight*' }).Count | Should Be 0
        $out.Count | Should Be ($inf.Count - 1)
    }
}

Describe 'Find-GptTmplPlaceholders' {
    It 'finds DISA placeholders that would fail SID resolution on clients' {
        $lines = @('[Privilege Rights]', 'SeDenyNetworkLogonRight = *S-1-5-114,*S-1-5-32-546,ADD YOUR ENTERPRISE ADMINS,ADD YOUR DOMAIN ADMINS', 'SeBackupPrivilege = *S-1-5-32-544')
        @(Find-GptTmplPlaceholders -Lines $lines) | Should Be @('[Privilege Rights] SeDenyNetworkLogonRight')
    }

    It 'is clean once an exception supplies real accounts' {
        $lines = Set-GptTmplValue -Lines @('[Privilege Rights]', 'SeDenyNetworkLogonRight = ADD YOUR DOMAIN ADMINS') -Section 'Privilege Rights' -Key 'SeDenyNetworkLogonRight' -Value '*S-1-5-32-546'
        @(Find-GptTmplPlaceholders -Lines $lines).Count | Should Be 0
    }

    It 'tolerates blank lines found in real templates' {
        $lines = @('[Unicode]', '', '[Privilege Rights]', '', 'SeTcbPrivilege = ADD YOUR ADMINS', '')
        @(Find-GptTmplPlaceholders -Lines $lines) | Should Be @('[Privilege Rights] SeTcbPrivilege')
        (Set-GptTmplValue -Lines $lines -Section 'Privilege Rights' -Key 'SeTcbPrivilege' -Value '').Count | Should Be 6
    }
}

Describe 'ConvertFrom-GpResultXml' {
    $xml = @'
<?xml version="1.0" encoding="utf-16"?>
<Rsop xmlns="http://www.microsoft.com/GroupPolicy/Rsop">
  <ComputerResults>
    <GPO><Name>Applied</Name><Path><Identifier xmlns="http://www.microsoft.com/GroupPolicy/Types">{11111111-1111-1111-1111-111111111111}</Identifier></Path>
      <Enabled>true</Enabled><IsValid>true</IsValid><FilterAllowed>true</FilterAllowed><AccessDenied>false</AccessDenied>
      <Link><SOMPath>c.mil/Pilot</SOMPath><Enabled>true</Enabled></Link></GPO>
    <GPO><Name>Filtered</Name><Path><Identifier xmlns="http://www.microsoft.com/GroupPolicy/Types">{22222222-2222-2222-2222-222222222222}</Identifier></Path>
      <Enabled>true</Enabled><IsValid>true</IsValid><FilterAllowed>false</FilterAllowed><AccessDenied>false</AccessDenied>
      <Link><Enabled>true</Enabled></Link></GPO>
    <GPO><Name>Denied</Name><Path><Identifier xmlns="http://www.microsoft.com/GroupPolicy/Types">{33333333-3333-3333-3333-333333333333}</Identifier></Path>
      <Enabled>true</Enabled><IsValid>true</IsValid><FilterAllowed>true</FilterAllowed><AccessDenied>true</AccessDenied></GPO>
    <GPO><Name>Local Group Policy</Name><Path><Identifier xmlns="http://www.microsoft.com/GroupPolicy/Types">LocalGPO</Identifier></Path></GPO>
    <ExtensionStatus><Name>Registry</Name><Error>0</Error></ExtensionStatus>
    <ExtensionStatus><Name>Security</Name><Error>1332</Error></ExtensionStatus>
  </ComputerResults>
</Rsop>
'@
    $r = ConvertFrom-GpResultXml -Xml $xml

    It 'lists applied GPOs by normalized ID' { @($r.appliedGpoIds) | Should Be @('11111111-1111-1111-1111-111111111111') }
    It 'separates WMI/security-filtered GPOs' { @($r.filteredGpoIds) | Should Be @('22222222-2222-2222-2222-222222222222') }
    It 'treats access-denied GPOs as not applied' {
        ($r.appliedGpoIds + $r.filteredGpoIds) -contains '33333333-3333-3333-3333-333333333333' | Should Be $false
    }
    It 'reports client-side extension errors' {
        @($r.extensionErrors).Count | Should Be 1
        $r.extensionErrors[0].name | Should Be 'Security'
        $r.extensionErrors[0].code | Should Be '1332'
    }
}

Describe 'registry.pol' {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('stig-pol-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $work | Out-Null
    $pol = Join-Path $work 'registry.pol'

    It 'round-trips every supported value type' {
        $entries = @(
            [pscustomobject]@{ key = 'Software\Policies\Microsoft\Edge'; valueName = 'SmartScreenEnabled'; type = 4; data = (ConvertTo-PolData DWord '1') }
            [pscustomobject]@{ key = 'Software\Policies\Microsoft\Edge'; valueName = 'HomepageLocation'; type = 1; data = (ConvertTo-PolData String 'https://intranet') }
            [pscustomobject]@{ key = 'Software\Policies\X'; valueName = 'List'; type = 7; data = (ConvertTo-PolData MultiString 'a\0b') }
            [pscustomobject]@{ key = 'Software\Policies\X'; valueName = 'Big'; type = 11; data = (ConvertTo-PolData QWord '5000000000') }
            [pscustomobject]@{ key = 'Software\Policies\X'; valueName = 'Blob'; type = 3; data = (ConvertTo-PolData Binary '0A0B') }
            [pscustomobject]@{ key = 'Software\Policies\X'; valueName = '**del.Old'; type = 1; data = (ConvertTo-PolData String ' ') }
        )
        Write-RegistryPol -Path $pol -Entries $entries
        $read = Read-RegistryPol $pol
        $read.Count | Should Be 6
        (ConvertFrom-PolData $read[0].type $read[0].data) | Should Be '1'
        (ConvertFrom-PolData $read[1].type $read[1].data) | Should Be 'https://intranet'
        (ConvertFrom-PolData $read[2].type $read[2].data) | Should Be 'a\0b'
        (ConvertFrom-PolData $read[3].type $read[3].data) | Should Be '5000000000'
        (ConvertFrom-PolData $read[4].type $read[4].data) | Should Be '0A0B'
        $read[5].valueName | Should Be '**del.Old'
    }

    It 'treats a header-only file as empty' {
        [IO.File]::WriteAllBytes($pol, [byte[]](0x50, 0x52, 0x65, 0x67, 1, 0, 0, 0))
        @(Read-RegistryPol $pol).Count | Should Be 0
    }

    It 'rejects files that are not registry.pol' {
        [IO.File]::WriteAllBytes($pol, [Text.Encoding]::ASCII.GetBytes('not a policy file'))
        { Read-RegistryPol $pol } | Should Throw
    }

    It 'applies set and delete exceptions, last one winning' {
        $entries = @(
            [pscustomobject]@{ key = 'Software\A'; valueName = 'Keep'; type = 4; data = (ConvertTo-PolData DWord '1') }
            [pscustomobject]@{ key = 'Software\A'; valueName = 'Drop'; type = 4; data = (ConvertTo-PolData DWord '1') }
        )
        $out = Set-RegistryPolExceptions -Entries $entries -Exceptions @(
            [pscustomobject]@{ key = 'software\a'; valueName = 'drop'; action = 'delete' }
            [pscustomobject]@{ key = 'Software\A'; valueName = 'Keep'; action = 'set'; valueType = 'DWord'; value = '0' }
            [pscustomobject]@{ key = 'Software\A'; valueName = 'New'; action = 'set'; valueType = 'String'; value = 'x' }
        )
        $map = ConvertTo-RegistryMap $out
        $map.Count | Should Be 2
        $map['software\a|keep'].value | Should Be '0'
        $map['software\a|new'].value | Should Be 'x'
    }

    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Compare-GpoBackups' {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('stig-cmp-' + [guid]::NewGuid())

    function New-TestBackup([string]$Name, [hashtable]$Reg, [string[]]$Inf, [hashtable]$Files) {
        $folder = Join-Path $work $Name
        $machine = Join-Path $folder 'DomainSysvol\GPO\Machine'
        New-Item -ItemType Directory -Path (Join-Path $machine 'microsoft\windows nt\SecEdit') -Force | Out-Null
        $entries = @($Reg.Keys | Sort-Object | ForEach-Object {
                $k, $v = $_ -split '\|'
                [pscustomobject]@{ key = $k; valueName = $v; type = 4; data = (ConvertTo-PolData DWord ([string]$Reg[$_])) }
            })
        Write-RegistryPol -Path (Join-Path $machine 'registry.pol') -Entries $entries
        [IO.File]::WriteAllLines((Join-Path $machine 'microsoft\windows nt\SecEdit\GptTmpl.inf'), $Inf, [Text.Encoding]::Unicode)
        foreach ($f in @($Files.Keys)) {
            $p = Join-Path $machine $f
            New-Item -ItemType Directory -Path (Split-Path $p -Parent) -Force | Out-Null
            Set-Content -LiteralPath $p -Value $Files[$f]
        }
        $folder
    }

    $infBase = @('[Unicode]', 'Unicode=yes', '[System Access]', 'LockoutBadCount = 3', 'MinimumPasswordAge = 1',
        '[Privilege Rights]', 'SeDenyNetworkLogonRight = *S-1-5-114,ADD YOUR DOMAIN ADMINS', '[Registry Keys]', '"MACHINE\SOFTWARE\X",0,"D:P(A;;GA;;;SY)"')
    $audit = @{ 'microsoft\windows nt\Audit\audit.csv' = 'Machine Name,Policy Target,Subcategory' }
    $base = New-TestBackup 'base' @{ 'Software\P|A' = 1; 'Software\P|B' = 1; 'Software\P|C' = 1; 'Software\P|D' = 1 } $infBase $audit
    $ours = New-TestBackup 'ours' @{ 'Software\P|A' = 0; 'Software\P|B' = 1; 'Software\P|D' = 7; 'Software\P|Local' = 9 } @(
        '[Unicode]', 'Unicode=yes', '[System Access]', 'LockoutBadCount = 5', 'MinimumPasswordAge = 1',
        '[Privilege Rights]', 'SeDenyNetworkLogonRight = *S-1-5-21-1-512,*S-1-5-114', '[Registry Keys]', '"MACHINE\SOFTWARE\X",0,"D:P(A;;GA;;;BA)"') @{ 'microsoft\windows nt\Audit\audit.csv' = 'changed' }
    # DISA independently moved D to 7 in the new release, so that local value is no longer a deviation.
    $theirs = New-TestBackup 'theirs' @{ 'Software\P|A' = 1; 'Software\P|B' = 2; 'Software\P|C' = 1; 'Software\P|D' = 7 } $infBase $audit

    $r = Compare-GpoBackups -BaseFolder $base -OursFolder $ours -TheirsFolder $theirs -Family 'DoD Test STIG Comp' -SourceGpoName 'DoD Test STIG Comp v1r1'
    $byId = @{}
    foreach ($c in $r.customizations) { $byId["$($c.kind)|$($c.action)|$(if ($c.kind -eq 'registry') { $c.valueName } else { $c.settingKey })"] = $c }

    It 'carries changed and added registry values' {
        $byId['registry|set|A'].value | Should Be '0'
        $byId['registry|set|Local'].valueType | Should Be 'DWord'
        $byId['registry|set|Local'].hive | Should Be 'HKLM'
    }
    It 'carries removed registry values as deletes' { $byId.ContainsKey('registry|delete|C') | Should Be $true }
    It 'ignores values production did not change, even if DISA did' { $byId.Keys -match '\|B$' | Should BeNullOrEmpty }
    It 'drops customizations DISA has since adopted' { $byId.Keys -match '\|D$' | Should BeNullOrEmpty }
    It 'carries security template changes, including filled-in placeholders' {
        $byId['securityTemplate|set|LockoutBadCount'].settingValue | Should Be '5'
        $byId['securityTemplate|set|SeDenyNetworkLogonRight'].section | Should Be 'Privilege Rights'
        $byId.ContainsKey('securityTemplate|set|MinimumPasswordAge') | Should Be $false
    }
    It 'reports differences it cannot carry forward' {
        $details = @($r.unsupported | ForEach-Object { $_.detail }) -join "`n"
        $details | Should Match 'Registry Keys'
        $details | Should Match 'audit\.csv'
        @($r.customizations).Count | Should Be 5
    }
    It 'marks customizations against an unknown baseline' {
        $u = Compare-GpoBackups -BaseFolder $theirs -OursFolder $ours -TheirsFolder $theirs -Family 'F' -SourceGpoName 'Legacy' -BaselineKnown $false
        @($u.customizations | Where-Object { $_.baselineKnown }).Count | Should Be 0
    }
    It 'gives every customization every field (StrictMode-safe)' {
        $names = 'gpoFamily', 'kind', 'action', 'hive', 'key', 'valueName', 'valueType', 'value', 'section', 'settingKey', 'settingValue', 'sourceGpoName', 'baselineKnown'
        foreach ($c in $r.customizations) {
            foreach ($n in $names) { [bool]$c.PSObject.Properties[$n] | Should Be $true }
        }
    }

    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Set-ReleaseLinks' {
    # A tiny in-memory GPMC: links per target, ordered (Order 1 = highest precedence).
    $script:Links = @{}
    $script:Gpos = @{}
    function Get-GPInheritance { param($Target, $Domain, $Server) [pscustomobject]@{ GpoLinks = @($script:Links[$Target]) } }
    function Get-GPO { param($Guid, $Domain, $Server) $script:Gpos[([guid]$Guid).ToString()] }
    function New-GPLink { param($Guid, $Target, $LinkEnabled, $Enforced, $Order, $Domain, $Server) }
    function Set-GPLink { param($Guid, $Target, $LinkEnabled, $Order, $Domain, $Server) }
    function Remove-GPLink { param($Guid, $Target, $Domain, $Server) }
    function Sync-Order($t) { $i = 1; foreach ($l in $script:Links[$t]) { $l.Order = $i; $i++ } }
    Mock New-GPLink {
        $list = New-Object System.Collections.Generic.List[object]
        foreach ($l in @($script:Links[$Target])) { $list.Add($l) }
        $link = [pscustomobject]@{ GpoId = [guid]$Guid; DisplayName = $script:Gpos[([guid]$Guid).ToString()].DisplayName; Enabled = ($LinkEnabled -eq 'Yes'); Enforced = $false; Order = 0 }
        if ($Order) { $list.Insert([int]$Order - 1, $link) } else { $list.Add($link) }
        $script:Links[$Target] = $list.ToArray(); Sync-Order $Target
    }
    Mock Set-GPLink {
        $l = @($script:Links[$Target] | Where-Object { $_.GpoId -eq [guid]$Guid })[0]
        if ($LinkEnabled) { $l.Enabled = ($LinkEnabled -eq 'Yes') }
    }
    Mock Remove-GPLink { $script:Links[$Target] = @($script:Links[$Target] | Where-Object { $_.GpoId -ne [guid]$Guid }); Sync-Order $Target }

    $releaseId = '3f2a9c1b-0000-4000-8000-000000000001'
    $oldId = [guid]'11111111-1111-1111-1111-111111111111'
    $newId = [guid]'22222222-2222-2222-2222-222222222222'
    $fam = 'DoD WinSvr 2022 MS STIG Comp'
    $script:Gpos[$oldId.ToString()] = [pscustomobject]@{ Id = $oldId; DisplayName = 'Old'; Description = (New-ManagedMarker -ReleaseId 'old-release' -Environment production -Family $fam -BackupId '{A}' -Sha256 'x') }
    $script:Gpos[$newId.ToString()] = [pscustomobject]@{ Id = $newId; DisplayName = 'New'; Description = (New-ManagedMarker -ReleaseId $releaseId -Environment production -Family $fam -BackupId '{B}' -Sha256 'y') }
    $job = [pscustomobject]@{
        job = [pscustomobject]@{ environment = 'production' }
        release = [pscustomobject]@{ id = $releaseId; label = 'October 2026' }
        gpos = @([pscustomobject]@{ backupId = '{B}'; displayName = "$fam v2r9"; family = $fam; backupDirectory = 'x' })
    }
    $deployed = @([pscustomobject]@{ id = "{$newId}"; name = 'New'; sourceBackupId = '{B}'; family = $fam })
    $cfg = [pscustomobject]@{ Domain = 'c.mil'; Baselines = @([pscustomobject]@{ Match = $fam; LinkTargets = @('OU=Servers,DC=c,DC=mil', 'OU=Empty,DC=c,DC=mil') }) }
    $script:Links['OU=Servers,DC=c,DC=mil'] = @([pscustomobject]@{ GpoId = $oldId; DisplayName = 'Old'; Enabled = $true; Enforced = $false; Order = 1 })
    $script:Links['OU=Empty,DC=c,DC=mil'] = @()

    It 'stages disabled links above the live GPO, including on an OU with no links' {
        $r = Set-ReleaseLinks -Job $job -EnvConfig $cfg -Deployed $deployed -Mode Stage
        $servers = $script:Links['OU=Servers,DC=c,DC=mil']
        $servers.Count | Should Be 2
        $servers[0].GpoId | Should Be $newId
        $servers[0].Enabled | Should Be $false
        $servers[1].GpoId | Should Be $oldId
        $servers[1].Enabled | Should Be $true
        @($script:Links['OU=Empty,DC=c,DC=mil']).Count | Should Be 1
        @($script:Links['OU=Empty,DC=c,DC=mil'])[0].Enabled | Should Be $false
        @($r.previousLinks).Count | Should Be 0
        @($r.links | Where-Object { $_.enabled }).Count | Should Be 0
    }

    It 'release enables the staged link at the old position and unlinks the old GPO' {
        $r = Set-ReleaseLinks -Job $job -EnvConfig $cfg -Deployed $deployed -Mode Activate
        $servers = @($script:Links['OU=Servers,DC=c,DC=mil'])
        $servers.Count | Should Be 1
        $servers[0].GpoId | Should Be $newId
        $servers[0].Enabled | Should Be $true
        $servers[0].Order | Should Be 1
        @($r.previousLinks).Count | Should Be 1
        $r.previousLinks[0].gpoName | Should Be 'Old'
        @($r.links | Where-Object { -not $_.enabled }).Count | Should Be 0
    }
}

Describe 'Undo-LinkChanges' {
    function Remove-GPLink { param($Guid, $Target, $Domain, $Server) }
    function New-GPLink { param($Guid, $Target, $LinkEnabled, $Enforced, $Order, $Domain, $Server) }
    function Set-GPLink { param($Guid, $Target, $LinkEnabled, $Order, $Domain, $Server) }
    Mock Remove-GPLink {}
    Mock Set-GPLink {}
    Mock New-GPLink { if ($Target -like 'OU=B*') { throw 'Access denied' } }

    It 'reverts what it can and keeps only what it could not' {
        $created = New-Object System.Collections.Generic.List[object]
        $created.Add([pscustomobject]@{ target = 'OU=A,DC=c,DC=mil'; gpoId = '{11111111-1111-1111-1111-111111111111}'; gpoName = 'New'; order = $null; enabled = $true; enforced = $false })
        $removed = New-Object System.Collections.Generic.List[object]
        $removed.Add([pscustomobject]@{ target = 'OU=A,DC=c,DC=mil'; gpoId = '{22222222-2222-2222-2222-222222222222}'; gpoName = 'Old A'; order = 1; enabled = $true; enforced = $false })
        $removed.Add([pscustomobject]@{ target = 'OU=B,DC=c,DC=mil'; gpoId = '{33333333-3333-3333-3333-333333333333}'; gpoName = 'Old B'; order = 2; enabled = $true; enforced = $true })
        $enabled = New-Object System.Collections.Generic.List[object]
        $enabled.Add([pscustomobject]@{ target = 'OU=C,DC=c,DC=mil'; gpoId = '{44444444-4444-4444-4444-444444444444}'; gpoName = 'Staged'; order = 1; enabled = $true; enforced = $false })
        $script:LinkProgress = @{ created = $created; enabled = $enabled; removed = $removed }

        Undo-LinkChanges -GpParams @{ Domain = 'c.mil' }

        $script:LinkProgress.created.Count | Should Be 0
        $script:LinkProgress.enabled.Count | Should Be 0
        $script:LinkProgress.removed.Count | Should Be 1
        $script:LinkProgress.removed[0].gpoName | Should Be 'Old B'
        Assert-MockCalled Set-GPLink -Times 1 -Exactly -ParameterFilter { $Target -eq 'OU=C,DC=c,DC=mil' -and $LinkEnabled -eq 'No' }
        Assert-MockCalled Remove-GPLink -Times 1 -Exactly
        Assert-MockCalled New-GPLink -Times 2 -Exactly
        Assert-MockCalled New-GPLink -Times 1 -Exactly -ParameterFilter { $Target -eq 'OU=A,DC=c,DC=mil' -and $Order -eq 1 -and $LinkEnabled -eq 'Yes' }
    }
}

Describe 'Expand-SafeArchive' {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $work = Join-Path ([IO.Path]::GetTempPath()) ('stig-agent-test-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $work | Out-Null

    function New-TestZip([string]$Path, [string[]]$Entries) {
        $stream = [IO.File]::Open($Path, 'Create')
        $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
        foreach ($e in $Entries) {
            $w = New-Object IO.StreamWriter($zip.CreateEntry($e).Open())
            $w.Write('x'); $w.Dispose()
        }
        $zip.Dispose(); $stream.Dispose()
    }

    It 'extracts nested GPO backups' {
        $zipPath = Join-Path $work 'ok.zip'
        New-TestZip $zipPath @('DoD X v1r1/GPOs/{A}/bkupInfo.xml')
        Expand-SafeArchive -Path $zipPath -Destination (Join-Path $work 'ok')
        Test-Path (Join-Path $work 'ok\DoD X v1r1\GPOs\{A}\bkupInfo.xml') | Should Be $true
    }

    It 'refuses entries that escape the destination' {
        $zipPath = Join-Path $work 'evil.zip'
        New-TestZip $zipPath @('../../evil.txt')
        { Expand-SafeArchive -Path $zipPath -Destination (Join-Path $work 'evil') } | Should Throw
    }

    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Read-AgentConfig' {
    $path = Join-Path ([IO.Path]::GetTempPath()) ('stig-agent-config-' + [guid]::NewGuid() + '.json')

    It 'applies environment-specific GPO name defaults' {
        @{
            TrackerUrl = 'https://tracker.example.mil'; Auth = @{ Mode = 'Certificate' }
            Environments = @(
                @{ Name = 'test'; Domain = 't.example.mil'; Baselines = @(@{ Match = 'DoD*'; LinkTargets = @('OU=Pilot,DC=t,DC=example,DC=mil') }) }
            )
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path
        $cfg = Read-AgentConfig -Path $path
        $cfg.Environments[0].GpoNameFormat | Should Be '{DisplayName} [{Label} TEST]'
    }

    It 'rejects plain-HTTP trackers and non-DN link targets' {
        @{ TrackerUrl = 'http://tracker'; Auth = @{}; Environments = @() } | ConvertTo-Json | Set-Content -LiteralPath $path
        { Read-AgentConfig -Path $path } | Should Throw
        @{
            TrackerUrl = 'https://tracker'; Auth = @{}
            Environments = @(@{ Name = 'production'; Domain = 'p'; Baselines = @(@{ Match = 'DoD*'; LinkTargets = @('Workstations') }) })
        } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path
        { Read-AgentConfig -Path $path } | Should Throw
    }

    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}
