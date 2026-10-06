#Requires -Version 5.1
<#
.SYNOPSIS
    STIG Tracker GPO agent: executes approved DISA GPO lifecycle jobs in one
    or more Active Directory environments.

.DESCRIPTION
    The tracker decides *what* should happen and records human approvals. This
    agent decides *where* it may happen: GPO selection, link targets, WMI
    filters, and validation computers come only from the local configuration
    file. Any instruction from the tracker that falls outside that allow-list
    is refused.

    Job types (per environment):
      deploy    test        import DISA backups as new GPOs, apply exceptions, link to test OUs
      validate  test        gpupdate + gpresult on validation computers, optional scan script
      stage     production  import DISA backups as new GPOs, apply exceptions, DO NOT link
      release   production  link staged GPOs, unlink the GPOs they replace
      rollback  production  unlink this release and restore the links it replaced

    Run under Windows PowerShell 5.1 with the GroupPolicy (GPMC) module, as an
    account delegated only GPO create/edit rights and link rights on the
    configured OUs (a gMSA is recommended). See README.md.

.PARAMETER ConfigPath
    Path to the agent JSON configuration.

.PARAMETER Once
    Poll each environment once and exit (for Task Scheduler). Without it the
    agent loops every PollSeconds.
#>
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:ProgramData 'StigGpoAgent\agent.config.json'),
    [switch]$Once
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:AgentVersion = '1.1.0'
$script:ManagedPrefix = 'STIG-Tracker managed'
$script:Config = $null
$script:JobLog = New-Object System.Collections.Generic.List[string]
# Link changes made by the running release/deploy attempt (see Set-ReleaseLinks).
$script:LinkProgress = $null
$script:Token = $null
$script:TokenExpires = [DateTime]::MinValue

# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers (unit tested)
# ─────────────────────────────────────────────────────────────────────────────

function ConvertTo-Base64Url {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Format-GpoName {
    param(
        [Parameter(Mandatory)][string]$Format,
        [Parameter(Mandatory)]$Gpo,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$ReleaseId,
        [Parameter(Mandatory)][string]$Environment
    )
    $name = $Format.Replace('{DisplayName}', $Gpo.displayName)
    $name = $name.Replace('{Family}', $Gpo.family)
    $name = $name.Replace('{Label}', $Label)
    $name = $name.Replace('{ReleaseId8}', $ReleaseId.Substring(0, 8))
    $name = $name.Replace('{Environment}', $Environment)
    if ($name.Length -gt 255) { throw "GPO name exceeds 255 characters: $name" }
    $name
}

function New-ManagedMarker {
    param(
        [Parameter(Mandatory)][string]$ReleaseId,
        [Parameter(Mandatory)][string]$Environment,
        [Parameter(Mandatory)][string]$Family,
        [Parameter(Mandatory)][string]$BackupId,
        [Parameter(Mandatory)][string]$Sha256
    )
    "$($script:ManagedPrefix) | release=$ReleaseId | env=$Environment | family=$Family | backup=$BackupId | sha256=$Sha256"
}

function Read-ManagedMarker {
    param([AllowNull()][AllowEmptyString()][string]$Description)
    if (-not $Description -or -not $Description.StartsWith($script:ManagedPrefix)) { return $null }
    $marker = @{}
    foreach ($part in $Description.Split('|')) {
        $kv = $part.Trim().Split('=', 2)
        if ($kv.Count -eq 2) { $marker[$kv[0]] = $kv[1] }
    }
    if (-not $marker.ContainsKey('release') -or -not $marker.ContainsKey('env') -or -not $marker.ContainsKey('family')) { return $null }
    [pscustomobject]$marker
}

function Test-BaselineMatch {
    param([Parameter(Mandatory)]$Baseline, [Parameter(Mandatory)]$Gpo)
    ($Gpo.family -like $Baseline.Match) -or ($Gpo.displayName -like $Baseline.Match)
}

function Test-DnUnderTarget {
    param([Parameter(Mandatory)][string]$DistinguishedName, [Parameter(Mandatory)][string]$Target)
    $dn = $DistinguishedName.Trim().ToLowerInvariant()
    $t = $Target.Trim().ToLowerInvariant()
    ($dn -eq $t) -or $dn.EndsWith(",$t")
}

function ConvertTo-NormalizedGuid {
    param([Parameter(Mandatory)][string]$Id)
    $Id.Trim('{', '}', ' ').ToLowerInvariant()
}

function ConvertFrom-HexString {
    param([Parameter(Mandatory)][string]$Hex)
    $clean = $Hex -replace '[\s,:-]', ''
    if ($clean -notmatch '^([0-9A-Fa-f]{2})*$') { throw "Binary registry values must be hexadecimal bytes (got '$Hex')" }
    $bytes = New-Object byte[] ($clean.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($clean.Substring($i * 2, 2), 16) }
    , $bytes
}

<# Resolves the DISA package entry a deployed GPO was imported from. #>
function Get-SourceGpo {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$Deployed)
    $source = @($Job.gpos | Where-Object { $_.backupId -eq $Deployed.sourceBackupId })
    if ($source.Count -ne 1) { throw "GPO $($Deployed.name) does not come from a backup in $($Job.release.label)" }
    $source[0]
}

<#
    Sets or removes `Key = Value` inside `[Section]` of a GptTmpl.inf, keeping
    every other line untouched. Missing sections/keys are created on "set".
#>
function Set-GptTmplValue {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines,
        [Parameter(Mandatory)][string]$Section,
        [Parameter(Mandatory)][string]$Key,
        [AllowNull()][string]$Value,
        [ValidateSet('set', 'delete')][string]$Action = 'set'
    )
    $out = New-Object System.Collections.Generic.List[string]
    $inSection = $false
    $sectionFound = $false
    $handled = $false
    $header = "[$Section]"
    $keyPattern = '^\s*' + [regex]::Escape($Key) + '\s*='

    for ($i = 0; $i -lt $Lines.Count; $i++) {
        $line = $Lines[$i]
        $isHeader = $line -match '^\s*\[.+\]\s*$'
        if ($isHeader) {
            if ($inSection -and -not $handled -and $Action -eq 'set') {
                $out.Add("$Key = $Value")
                $handled = $true
            }
            $inSection = ($line.Trim() -ieq $header)
            if ($inSection) { $sectionFound = $true }
            $out.Add($line)
            continue
        }
        if ($inSection -and -not $handled -and $line -match $keyPattern) {
            $handled = $true
            if ($Action -eq 'set') { $out.Add("$Key = $Value") }
            continue
        }
        $out.Add($line)
    }
    if ($Action -eq 'set' -and -not $handled) {
        if (-not $sectionFound) { $out.Add($header) }
        $out.Add("$Key = $Value")
    }
    , $out.ToArray()
}

<# Returns `[Section] Key` for every GptTmpl.inf line still carrying a DISA "ADD YOUR ..." placeholder. #>
function Find-GptTmplPlaceholders {
    param([Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines)
    $section = ''
    foreach ($line in $Lines) {
        if ($line -match '^\s*\[(.+)\]\s*$') { $section = $Matches[1]; continue }
        if ($line -match '^\s*([^=]+?)\s*=.*\bADD YOUR\b') { "[$section] $($Matches[1])" }
    }
}

function Get-XmlText {
    param($Node, [string]$Name)
    $child = $Node.SelectSingleNode("*[local-name()='$Name']")
    if ($child) { $child.InnerText } else { $null }
}

<# Parses `gpresult /scope computer /x` output into applied/filtered GPO IDs and CSE errors. #>
function ConvertFrom-GpResultXml {
    param([Parameter(Mandatory)][string]$Xml)
    $doc = New-Object System.Xml.XmlDocument
    $doc.XmlResolver = $null
    $doc.LoadXml($Xml)
    $applied = New-Object System.Collections.Generic.List[string]
    $filtered = New-Object System.Collections.Generic.List[string]
    $errors = New-Object System.Collections.Generic.List[object]

    foreach ($g in $doc.SelectNodes("//*[local-name()='ComputerResults']/*[local-name()='GPO']")) {
        $idNode = $g.SelectSingleNode("*[local-name()='Path']/*[local-name()='Identifier']")
        if (-not $idNode -or $idNode.InnerText -notmatch '^\{?[0-9a-fA-F-]{36}\}?$') { continue }
        $id = ConvertTo-NormalizedGuid $idNode.InnerText
        $isValid = (Get-XmlText $g 'IsValid') -ne 'false'
        $enabled = (Get-XmlText $g 'Enabled') -ne 'false'
        $denied = (Get-XmlText $g 'AccessDenied') -eq 'true'
        $linkStates = @($g.SelectNodes("*[local-name()='Link']/*[local-name()='Enabled']") | ForEach-Object { $_.InnerText })
        $linked = ($linkStates.Count -eq 0) -or ($linkStates -contains 'true')
        if (-not ($isValid -and $enabled -and $linked) -or $denied) { continue }
        if ((Get-XmlText $g 'FilterAllowed') -eq 'false') { $filtered.Add($id) } else { $applied.Add($id) }
    }
    foreach ($e in $doc.SelectNodes("//*[local-name()='ComputerResults']/*[local-name()='ExtensionStatus']")) {
        $code = Get-XmlText $e 'Error'
        if ($code -and $code -ne '0') {
            $errors.Add([pscustomobject]@{ name = [string](Get-XmlText $e 'Name'); code = [string]$code })
        }
    }
    [pscustomobject]@{
        appliedGpoIds   = @($applied | Select-Object -Unique)
        filteredGpoIds  = @($filtered | Select-Object -Unique)
        extensionErrors = $errors.ToArray()
    }
}

<#
    Extracts a ZIP while refusing entries that would escape the destination
    (zip-slip). -IncludePrefix limits extraction to the GPO backup folders the
    job needs, which also keeps DISA's long report paths under MAX_PATH.
#>
function Expand-SafeArchive {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Destination,
        [string[]]$IncludePrefix
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    $root = [IO.Path]::GetFullPath((New-Item -ItemType Directory -Path $Destination -Force).FullName).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($entry in $zip.Entries) {
            if ($IncludePrefix) {
                $wanted = $false
                foreach ($p in $IncludePrefix) { if ($entry.FullName.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)) { $wanted = $true; break } }
                if (-not $wanted) { continue }
            }
            $target = [IO.Path]::GetFullPath((Join-Path $root $entry.FullName))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes the extraction folder: $($entry.FullName)"
            }
            if ($target.Length -ge 260) {
                throw "Extracted path would exceed 260 characters; shorten WorkDirectory: $target"
            }
            if ($entry.FullName.EndsWith('/')) {
                New-Item -ItemType Directory -Path $target -Force | Out-Null
                continue
            }
            New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        }
    }
    finally { $zip.Dispose() }
}

# ─────────────────────────────────────────────────────────────────────────────
# registry.pol (PReg) and production customization detection (unit tested)
# ─────────────────────────────────────────────────────────────────────────────

$script:RegTypeNames = @{ 1 = 'String'; 2 = 'ExpandString'; 3 = 'Binary'; 4 = 'DWord'; 7 = 'MultiString'; 11 = 'QWord' }
$script:RegTypeIds = @{ String = 1; ExpandString = 2; Binary = 3; DWord = 4; MultiString = 7; QWord = 11 }
$script:SupportedTemplateSections = @(
    'System Access', 'Kerberos Policy', 'Event Audit', 'Privilege Rights', 'Registry Values',
    'Service General Setting', 'Group Membership', 'Application Log', 'Security Log', 'System Log'
)

function Read-PolString {
    param([byte[]]$Bytes, [ref]$Position)
    $start = $Position.Value
    $i = $start
    while ($i + 1 -lt $Bytes.Length -and -not ($Bytes[$i] -eq 0 -and $Bytes[$i + 1] -eq 0)) { $i += 2 }
    $text = [Text.Encoding]::Unicode.GetString($Bytes, $start, $i - $start)
    $Position.Value = $i + 2
    $text
}

function Assert-PolChar {
    param([byte[]]$Bytes, [ref]$Position, [char]$Expected)
    $p = $Position.Value
    if ($p + 1 -ge $Bytes.Length -or [char][BitConverter]::ToUInt16($Bytes, $p) -ne $Expected) {
        throw "registry.pol is malformed: expected '$Expected' at byte $p"
    }
    $Position.Value = $p + 2
}

<# Parses a Group Policy registry.pol file into key/valueName/type/data entries (call as @(Read-RegistryPol ...)). #>
function Read-RegistryPol {
    param([Parameter(Mandatory)][string]$Path)
    $entries = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $b = [IO.File]::ReadAllBytes($Path)
    if ($b.Length -lt 8) { return }
    if ([Text.Encoding]::ASCII.GetString($b, 0, 4) -ne 'PReg') { throw "$Path is not a registry.pol file" }
    $pos = 8
    while ($pos -lt $b.Length) {
        Assert-PolChar $b ([ref]$pos) '['
        $key = Read-PolString $b ([ref]$pos)
        Assert-PolChar $b ([ref]$pos) ';'
        $valueName = Read-PolString $b ([ref]$pos)
        Assert-PolChar $b ([ref]$pos) ';'
        $type = [BitConverter]::ToUInt32($b, $pos); $pos += 4
        Assert-PolChar $b ([ref]$pos) ';'
        $size = [BitConverter]::ToUInt32($b, $pos); $pos += 4
        Assert-PolChar $b ([ref]$pos) ';'
        $data = New-Object byte[] $size
        if ($size) { [Array]::Copy($b, $pos, $data, 0, $size) }
        $pos += $size
        Assert-PolChar $b ([ref]$pos) ']'
        $entries.Add([pscustomobject]@{ key = $key; valueName = $valueName; type = [int]$type; data = $data })
    }
    $entries.ToArray()
}

function Write-RegistryPol {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entries)
    $u = [Text.Encoding]::Unicode
    $ms = New-Object IO.MemoryStream
    $write = { param([byte[]]$x) $ms.Write($x, 0, $x.Length) }
    & $write ([Text.Encoding]::ASCII.GetBytes('PReg'))
    & $write ([BitConverter]::GetBytes([uint32]1))
    foreach ($e in $Entries) {
        & $write $u.GetBytes('[')
        & $write $u.GetBytes("$($e.key)`0")
        & $write $u.GetBytes(';')
        & $write $u.GetBytes("$($e.valueName)`0")
        & $write $u.GetBytes(';')
        & $write ([BitConverter]::GetBytes([uint32]$e.type))
        & $write $u.GetBytes(';')
        & $write ([BitConverter]::GetBytes([uint32]$e.data.Length))
        & $write $u.GetBytes(';')
        if ($e.data.Length) { & $write ([byte[]]$e.data) }
        & $write $u.GetBytes(']')
    }
    [IO.File]::WriteAllBytes($Path, $ms.ToArray())
}

<# Converts registry.pol data to the string form used by tracker exceptions (MultiString uses \0). #>
function ConvertFrom-PolData {
    param([int]$Type, [byte[]]$Data)
    switch ($Type) {
        { $_ -in 1, 2 } { return [Text.Encoding]::Unicode.GetString($Data).TrimEnd([char]0) }
        4 { if ($Data.Length -ge 4) { return [string][BitConverter]::ToUInt32($Data, 0) } else { return '0' } }
        11 { if ($Data.Length -ge 8) { return [string][BitConverter]::ToUInt64($Data, 0) } else { return '0' } }
        7 { return ([Text.Encoding]::Unicode.GetString($Data).TrimEnd([char]0) -split "`0") -join '\0' }
        default { return ([BitConverter]::ToString($Data) -replace '-', '') }
    }
}

function ConvertTo-PolData {
    param([Parameter(Mandatory)][string]$ValueType, [AllowEmptyString()][string]$Value)
    switch ($ValueType) {
        'String' { return , [Text.Encoding]::Unicode.GetBytes("$Value`0") }
        'ExpandString' { return , [Text.Encoding]::Unicode.GetBytes("$Value`0") }
        'DWord' { return , [BitConverter]::GetBytes([uint32]$Value) }
        'QWord' { return , [BitConverter]::GetBytes([uint64]$Value) }
        'MultiString' { return , [Text.Encoding]::Unicode.GetBytes((($Value -split '\\0') -join "`0") + "`0`0") }
        'Binary' { return , (ConvertFrom-HexString $Value) }
        default { throw "Unsupported registry value type $ValueType" }
    }
}

<# Applies registry exceptions to a parsed registry.pol (last exception wins). #>
function Set-RegistryPolExceptions {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entries, [Parameter(Mandatory)][object[]]$Exceptions)
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($e in $Entries) { $list.Add($e) }
    foreach ($x in $Exceptions) {
        $match = { param($e) $e.key -ieq $x.key -and $e.valueName -ieq $x.valueName }
        for ($i = $list.Count - 1; $i -ge 0; $i--) { if (& $match $list[$i]) { $list.RemoveAt($i) } }
        if ($x.action -eq 'set') {
            $list.Add([pscustomobject]@{
                    key = $x.key; valueName = $x.valueName
                    type = $script:RegTypeIds[[string]$x.valueType]; data = (ConvertTo-PolData -ValueType $x.valueType -Value $x.value)
                })
        }
    }
    , $list.ToArray()
}

function ConvertTo-RegistryMap {
    param([AllowNull()][AllowEmptyCollection()][object[]]$Entries)
    $map = @{}
    foreach ($e in @($Entries | Where-Object { $null -ne $_ })) {
        $map["$($e.key)|$($e.valueName)".ToLowerInvariant()] = [pscustomobject]@{
            key = $e.key; valueName = $e.valueName; type = $e.type; value = (ConvertFrom-PolData -Type $e.type -Data $e.data)
        }
    }
    $map
}

<# Parses GptTmpl.inf into key=value settings plus raw (non key=value) lines per section. #>
function ConvertFrom-GptTmpl {
    param([AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines)
    $settings = @{}
    $raw = @{}
    $section = ''
    foreach ($line in @($Lines)) {
        if ($line -match '^\s*\[(.+)\]\s*$') { $section = $Matches[1].Trim(); continue }
        if (-not $line.Trim() -or $section -in 'Unicode', 'Version') { continue }
        if ($line -match '^\s*([^=]+?)\s*=\s*(.*?)\s*$') {
            $settings["$section|$($Matches[1])".ToLowerInvariant()] = [pscustomobject]@{ section = $section; key = $Matches[1]; value = $Matches[2] }
        }
        else {
            if (-not $raw.ContainsKey($section)) { $raw[$section] = New-Object System.Collections.Generic.List[string] }
            $raw[$section].Add($line.Trim())
        }
    }
    @{ settings = $settings; raw = $raw }
}

function Read-GptTmplFile {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return ConvertFrom-GptTmpl -Lines @() }
    ConvertFrom-GptTmpl -Lines ([IO.File]::ReadAllLines($Path, [Text.Encoding]::Unicode))
}

function Get-NormalizedTemplateValue {
    param([string]$Section, [string]$Value)
    if ($Section -in 'Privilege Rights', 'Group Membership') {
        return ((@($Value -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object) -join ',')
    }
    $Value.Trim()
}

function Get-GpoFileHashes {
    param([Parameter(Mandatory)][string]$BackupFolder)
    $root = Join-Path $BackupFolder 'DomainSysvol\GPO'
    $map = @{}
    if (-not (Test-Path -LiteralPath $root)) { return $map }
    foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File) {
        $rel = $f.FullName.Substring($root.Length + 1)
        if ($rel -match '\\registry\.pol$' -or $rel -match '\\GptTmpl\.inf$' -or $rel -match '\.cmtx$') { continue }
        $map[$rel.ToLowerInvariant()] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    }
    $map
}

<# Every customization carries every field so StrictMode never meets a missing property. #>
function New-Customization {
    param(
        [Parameter(Mandatory)][string]$Family, [Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$SourceGpoName, [bool]$BaselineKnown = $true,
        $Hive = $null, $Key = $null, $ValueName = $null, $ValueType = $null, $Value = $null,
        $Section = $null, $SettingKey = $null, $SettingValue = $null
    )
    [pscustomobject]@{
        gpoFamily = $Family; kind = $Kind; action = $Action
        hive = $Hive; key = $Key; valueName = $ValueName; valueType = $ValueType; value = $Value
        section = $Section; settingKey = $SettingKey; settingValue = $SettingValue
        sourceGpoName = $SourceGpoName; baselineKnown = $BaselineKnown
    }
}

<#
    Three-way comparison of GPO backups:
      Base   — the DISA backup the production GPO was imported from
      Ours   — a backup of the GPO live in production today
      Theirs — the new DISA backup
    Ours vs. Base is the local customization. It is dropped when Theirs already
    matches it (DISA adopted the same value). Differences the tracker cannot
    express as an exception are reported as unsupported.
#>
function Compare-GpoBackups {
    param(
        [Parameter(Mandatory)][string]$BaseFolder,
        [Parameter(Mandatory)][string]$OursFolder,
        [Parameter(Mandatory)][string]$TheirsFolder,
        [Parameter(Mandatory)][string]$Family,
        [Parameter(Mandatory)][string]$SourceGpoName,
        [bool]$BaselineKnown = $true
    )
    $custom = New-Object System.Collections.Generic.List[object]
    $unsupported = New-Object System.Collections.Generic.List[object]
    $note = { param($detail) $unsupported.Add([pscustomobject]@{ gpoFamily = $Family; gpoName = $SourceGpoName; detail = $detail }) }

    foreach ($scope in @(@{ hive = 'HKLM'; dir = 'Machine' }, @{ hive = 'HKCU'; dir = 'User' })) {
        $rel = "DomainSysvol\GPO\$($scope.dir)\registry.pol"
        $base = ConvertTo-RegistryMap @(Read-RegistryPol (Join-Path $BaseFolder $rel))
        $ours = ConvertTo-RegistryMap @(Read-RegistryPol (Join-Path $OursFolder $rel))
        $theirs = ConvertTo-RegistryMap @(Read-RegistryPol (Join-Path $TheirsFolder $rel))
        foreach ($id in @(@($base.Keys) + @($ours.Keys) | Select-Object -Unique)) {
            $b = $base[$id]; $o = $ours[$id]; $t = $theirs[$id]
            if ($o -and (-not $b -or $o.type -ne $b.type -or $o.value -cne $b.value)) {
                if ($t -and $t.type -eq $o.type -and $t.value -ceq $o.value) { continue }
                if (-not $script:RegTypeNames.ContainsKey([int]$o.type)) {
                    & $note "$($scope.hive)\$($o.key)\$($o.valueName) uses registry type $($o.type), which cannot be carried forward"
                    continue
                }
                $custom.Add((New-Customization -Family $Family -Kind registry -Action set -SourceGpoName $SourceGpoName -BaselineKnown $BaselineKnown `
                            -Hive $scope.hive -Key $o.key -ValueName $o.valueName -ValueType $script:RegTypeNames[[int]$o.type] -Value $o.value))
            }
            elseif ($b -and -not $o -and $t) {
                $custom.Add((New-Customization -Family $Family -Kind registry -Action delete -SourceGpoName $SourceGpoName -BaselineKnown $BaselineKnown `
                            -Hive $scope.hive -Key $b.key -ValueName $b.valueName))
            }
        }
    }

    $inf = 'DomainSysvol\GPO\Machine\microsoft\windows nt\SecEdit\GptTmpl.inf'
    $theirsInf = Join-Path $TheirsFolder $inf
    $base = Read-GptTmplFile (Join-Path $BaseFolder $inf)
    $ours = Read-GptTmplFile (Join-Path $OursFolder $inf)
    $theirs = Read-GptTmplFile $theirsInf
    foreach ($id in @(@($base.settings.Keys) + @($ours.settings.Keys) | Select-Object -Unique)) {
        $b = $base.settings[$id]; $o = $ours.settings[$id]; $t = $theirs.settings[$id]
        $section = if ($o) { $o.section } else { $b.section }
        $oursNorm = if ($o) { Get-NormalizedTemplateValue $section $o.value } else { $null }
        $changed = $o -and (-not $b -or $oursNorm -cne (Get-NormalizedTemplateValue $section $b.value))
        $removed = $b -and -not $o -and $t
        if (-not ($changed -or $removed)) { continue }
        if ($changed -and $t -and (Get-NormalizedTemplateValue $section $t.value) -ceq $oursNorm) { continue }
        $label = if ($o) { $o.key } else { $b.key }
        if ($section -notin $script:SupportedTemplateSections) {
            & $note "[$section] $label differs and that section cannot be carried forward"
            continue
        }
        if (-not (Test-Path -LiteralPath $theirsInf)) {
            & $note "[$section] $label is customized but the new DISA GPO has no security template to apply it to"
            continue
        }
        $custom.Add((New-Customization -Family $Family -Kind securityTemplate -Action $(if ($changed) { 'set' } else { 'delete' }) `
                    -SourceGpoName $SourceGpoName -BaselineKnown $BaselineKnown `
                    -Section $section -SettingKey $label -SettingValue $(if ($changed) { $o.value } else { $null })))
    }
    foreach ($section in @(@($base.raw.Keys) + @($ours.raw.Keys) | Select-Object -Unique)) {
        $bl = @($base.raw[$section] | Sort-Object) -join "`n"
        $ol = @($ours.raw[$section] | Sort-Object) -join "`n"
        if ($bl -cne $ol) { & $note "[$section] entries differ (registry/file permissions are not carried forward)" }
    }

    $baseFiles = Get-GpoFileHashes $BaseFolder
    $oursFiles = Get-GpoFileHashes $OursFolder
    foreach ($f in @(@($baseFiles.Keys) + @($oursFiles.Keys) | Select-Object -Unique)) {
        if ($baseFiles[$f] -ne $oursFiles[$f]) {
            $what = if ($f -like '*audit.csv') { 'Advanced audit policy (audit.csv)' } else { $f }
            & $note "$what differs from the DISA baseline and is not carried forward automatically"
        }
    }
    @{ customizations = $custom.ToArray(); unsupported = $unsupported.ToArray() }
}

# ─────────────────────────────────────────────────────────────────────────────
# Configuration and logging
# ─────────────────────────────────────────────────────────────────────────────

function Write-AgentLog {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
    $line = '{0:u} [{1}] {2}' -f (Get-Date).ToUniversalTime(), $Level, $Message
    if ($script:JobLog.Count -lt 500) { $script:JobLog.Add($line) }
    if ($script:Config) {
        $dir = Join-Path $script:Config.WorkDirectory 'logs'
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -LiteralPath (Join-Path $dir ('agent-{0:yyyyMMdd}.log' -f (Get-Date))) -Value $line -Encoding UTF8
    }
    Write-Verbose $line
    if ($Level -ne 'INFO') { Write-Warning $Message }
}

function Read-AgentConfig {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Configuration not found: $Path" }
    $cfg = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    foreach ($required in 'TrackerUrl', 'Auth', 'Environments') {
        if (-not $cfg.PSObject.Properties[$required]) { throw "Configuration is missing $required" }
    }
    if ($cfg.TrackerUrl -notmatch '^https://') { throw 'TrackerUrl must use https://' }
    if (-not $cfg.PSObject.Properties['WorkDirectory']) {
        $cfg | Add-Member -NotePropertyName WorkDirectory -NotePropertyValue (Join-Path $env:ProgramData 'StigGpoAgent')
    }
    if (-not $cfg.PSObject.Properties['PollSeconds']) { $cfg | Add-Member -NotePropertyName PollSeconds -NotePropertyValue 300 }
    $names = @{}
    foreach ($e in @($cfg.Environments)) {
        if ($e.Name -notin 'test', 'production') { throw "Environment Name must be 'test' or 'production' (got '$($e.Name)')" }
        if ($names.ContainsKey($e.Name)) { throw "Environment '$($e.Name)' is configured twice" }
        $names[$e.Name] = $true
        if (-not $e.Domain) { throw "Environment '$($e.Name)' needs Domain" }
        if (-not $e.PSObject.Properties['GpoNameFormat'] -or -not $e.GpoNameFormat) {
            $format = if ($e.Name -eq 'test') { '{DisplayName} [{Label} TEST]' } else { '{DisplayName} [{Label}]' }
            $e | Add-Member -NotePropertyName GpoNameFormat -NotePropertyValue $format -Force
        }
        if (-not @($e.Baselines).Count) { throw "Environment '$($e.Name)' has no Baselines" }
        foreach ($b in @($e.Baselines)) {
            if (-not $b.Match) { throw "A baseline in '$($e.Name)' has no Match pattern" }
            if (-not @($b.LinkTargets).Count) { throw "Baseline '$($b.Match)' in '$($e.Name)' has no LinkTargets" }
            foreach ($t in @($b.LinkTargets)) {
                if ($t -notmatch '^(OU|DC)=') { throw "Link target '$t' must be an OU or domain distinguished name" }
            }
        }
    }
    $cfg
}

function Get-GpParams {
    param([Parameter(Mandatory)]$EnvConfig)
    $p = @{ Domain = $EnvConfig.Domain }
    if ($EnvConfig.PSObject.Properties['Server'] -and $EnvConfig.Server) { $p.Server = $EnvConfig.Server }
    $p
}

# ─────────────────────────────────────────────────────────────────────────────
# Tracker API
# ─────────────────────────────────────────────────────────────────────────────

function Get-ArcManagedIdentityToken {
    param([Parameter(Mandatory)][string]$Resource)
    $uri = 'http://localhost:40342/metadata/identity/oauth2/token?api-version=2020-06-01&resource=' + [uri]::EscapeDataString($Resource)
    $challenge = $null
    try {
        Invoke-WebRequest -Uri $uri -Headers @{ Metadata = 'true' } -UseBasicParsing | Out-Null
    }
    catch {
        $response = $_.Exception.Response
        if ($response) { $challenge = $response.Headers['WWW-Authenticate'] }
    }
    if (-not $challenge -or $challenge -notmatch 'Basic realm=(.+)$') {
        throw 'The Azure Arc identity endpoint did not issue a challenge; is the Connected Machine agent installed?'
    }
    $keyPath = $Matches[1].Trim()
    $secret = Get-Content -LiteralPath $keyPath -Raw
    Invoke-RestMethod -Uri $uri -Headers @{ Metadata = 'true'; Authorization = "Basic $secret" } -UseBasicParsing
}

function Get-CertificateToken {
    param([Parameter(Mandatory)]$Auth)
    $authority = if ($Auth.PSObject.Properties['Authority'] -and $Auth.Authority) { $Auth.Authority.TrimEnd('/') } else { 'https://login.microsoftonline.com' }
    $tokenEndpoint = "$authority/$($Auth.TenantId)/oauth2/v2.0/token"
    $cert = Get-Item -LiteralPath ("Cert:\LocalMachine\My\{0}" -f $Auth.CertificateThumbprint)
    if (-not $cert.HasPrivateKey) { throw 'The agent certificate has no accessible private key' }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = @{ alg = 'RS256'; typ = 'JWT'; x5t = (ConvertTo-Base64Url $cert.GetCertHash()) } | ConvertTo-Json -Compress
    $claims = @{ aud = $tokenEndpoint; iss = $Auth.ClientId; sub = $Auth.ClientId; jti = [guid]::NewGuid().ToString(); nbf = $now; exp = $now + 600 } | ConvertTo-Json -Compress
    $unsigned = (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($header))) + '.' + (ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims)))
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
    $signature = $rsa.SignData([Text.Encoding]::ASCII.GetBytes($unsigned), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    Invoke-RestMethod -Method Post -Uri $tokenEndpoint -UseBasicParsing -ContentType 'application/x-www-form-urlencoded' -Body @{
        client_id             = $Auth.ClientId
        scope                 = $Auth.Scope
        grant_type            = 'client_credentials'
        client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        client_assertion      = "$unsigned.$(ConvertTo-Base64Url $signature)"
    }
}

function Get-AccessToken {
    if ($script:Token -and (Get-Date) -lt $script:TokenExpires) { return $script:Token }
    $auth = $script:Config.Auth
    $mode = if ($auth.PSObject.Properties['Mode']) { $auth.Mode } else { 'Certificate' }
    if ($mode -eq 'ArcManagedIdentity') {
        $resource = $auth.Scope -replace '/\.default$', ''
        $response = Get-ArcManagedIdentityToken -Resource $resource
    }
    else {
        $response = Get-CertificateToken -Auth $auth
    }
    $script:Token = $response.access_token
    $script:TokenExpires = (Get-Date).AddSeconds([int]$response.expires_in - 300)
    $script:Token
}

function Invoke-TrackerApi {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body,
        [string]$OutFile
    )
    $uri = $script:Config.TrackerUrl.TrimEnd('/') + $Path
    $headers = @{ Authorization = "Bearer $(Get-AccessToken)" }
    if ($OutFile) {
        Invoke-WebRequest -Method Get -Uri $uri -Headers $headers -OutFile $OutFile -UseBasicParsing | Out-Null
        return
    }
    $params = @{ Method = $Method; Uri = $uri; Headers = $headers; UseBasicParsing = $true }
    if ($null -ne $Body) {
        # Send UTF-8 bytes; Windows PowerShell would otherwise encode string bodies as ISO-8859-1.
        $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress))
        $params.ContentType = 'application/json; charset=utf-8'
    }
    Invoke-RestMethod @params
}

function Send-Heartbeat {
    param([Parameter(Mandatory)]$Job)
    try {
        Invoke-TrackerApi -Method POST -Path "/api/gpo/agent/jobs/$($Job.job.id)/heartbeat" -Body @{ environment = $Job.job.environment } | Out-Null
    }
    catch { Write-AgentLog "Heartbeat failed: $($_.Exception.Message)" 'WARN' }
}

# ─────────────────────────────────────────────────────────────────────────────
# Group Policy operations
# ─────────────────────────────────────────────────────────────────────────────

function Get-ExtractRoot {
    # Short path: DISA backup paths are long and Windows PowerShell 5.1 is limited to MAX_PATH.
    Join-Path $script:Config.WorkDirectory 'p'
}

<#
    Returns a local, hash-verified copy of a release package. Packages are kept
    in WorkDirectory\archive because DISA removes old packages, and the survey
    needs the exact package each production GPO was imported from.
#>
function Get-ReleaseArchive {
    param([Parameter(Mandatory)]$Ref)
    $archive = Join-Path $script:Config.WorkDirectory 'archive'
    New-Item -ItemType Directory -Path $archive -Force | Out-Null
    $expected = $Ref.sourceHash.ToLowerInvariant()
    $path = Join-Path $archive "$($expected.Substring(0, 16)).zip"
    if (Test-Path -LiteralPath $path) {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expected) { return $path }
        Remove-Item -LiteralPath $path -Force
    }
    $temp = "$path.download"
    Write-AgentLog "Downloading the $($Ref.label) package from the tracker"
    Invoke-TrackerApi -Method GET -Path $Ref.packageUrl -OutFile $temp
    $hash = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $expected) {
        Remove-Item -LiteralPath $temp -Force
        throw "Package hash $hash does not match the approved hash $expected for $($Ref.label)"
    }
    Move-Item -LiteralPath $temp -Destination $path -Force
    Write-AgentLog "Package $($Ref.label) SHA-256 verified ($hash)"
    # Keep about three years of quarterly packages.
    Get-ChildItem -LiteralPath $archive -Filter '*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 12 |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    $path
}

<# Extracts only the given backup directories of a release into WorkDirectory\p\<Tag>. #>
function Expand-ReleaseBackups {
    param([Parameter(Mandatory)]$Ref, [Parameter(Mandatory)][string[]]$BackupDirectories, [Parameter(Mandatory)][string]$Tag)
    $zip = Get-ReleaseArchive -Ref $Ref
    $dir = Join-Path (Get-ExtractRoot) $Tag
    $prefixes = @($BackupDirectories | ForEach-Object { $_.TrimEnd('/') + '/' } | Select-Object -Unique)
    Expand-SafeArchive -Path $zip -Destination $dir -IncludePrefix $prefixes
    $dir
}

function Get-BackupFolder {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)]$Gpo)
    $folder = Join-Path (Join-Path $Root ($Gpo.backupDirectory -replace '/', '\')) $Gpo.backupId
    if (-not (Test-Path -LiteralPath $folder)) { throw "Backup folder missing from package: $folder" }
    $folder
}

function Get-PackageFolder {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)][object[]]$Selected)
    Expand-ReleaseBackups -Ref $Job.release -BackupDirectories @($Selected | ForEach-Object { $_.backupDirectory }) -Tag 'new'
}

function Get-SelectedGpos {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    $selected = @{}
    foreach ($b in @($EnvConfig.Baselines)) {
        $hits = @($Job.gpos | Where-Object { Test-BaselineMatch -Baseline $b -Gpo $_ })
        if ($hits.Count -eq 0) {
            throw "Baseline '$($b.Match)' matches no GPO in $($Job.release.label). Update the agent configuration if DISA renamed or retired it."
        }
        foreach ($g in $hits) { $selected[$g.backupId] = $g }
    }
    @($selected.Values)
}

function Set-SecurityTemplateExceptions {
    param([Parameter(Mandatory)][string]$BackupFolder, [Parameter(Mandatory)]$Gpo, $Exceptions, [switch]$AllowPlaceholders)
    $mine = @($Exceptions | Where-Object { $_.kind -eq 'securityTemplate' -and $_.gpoFamily -eq $Gpo.family })
    $inf = Join-Path $BackupFolder 'DomainSysvol\GPO\Machine\microsoft\windows nt\SecEdit\GptTmpl.inf'
    if (-not (Test-Path -LiteralPath $inf)) {
        if ($mine.Count) { throw "$($Gpo.displayName) has no security template, so security template exceptions cannot be applied" }
        return
    }
    $lines = [IO.File]::ReadAllLines($inf, [Text.Encoding]::Unicode)
    foreach ($e in $mine) {
        $lines = Set-GptTmplValue -Lines $lines -Section $e.section -Key $e.settingKey -Value $e.settingValue -Action $e.action
        Write-AgentLog "Exception $($e.id): [$($e.section)] $($e.settingKey) $($e.action) on $($Gpo.displayName)"
    }
    $placeholders = @(Find-GptTmplPlaceholders -Lines $lines)
    if ($placeholders.Count -and -not $AllowPlaceholders) {
        throw ("$($Gpo.displayName) still contains DISA 'ADD YOUR ...' placeholders in $($placeholders -join '; '). " +
            "Add an approved security template exception for each with your organization's accounts or SIDs.")
    }
    if ($mine.Count) { [IO.File]::WriteAllLines($inf, $lines, [Text.Encoding]::Unicode) }
}

function Set-RegistryExceptions {
    param([Parameter(Mandatory)]$GpoObject, [Parameter(Mandatory)]$Gpo, [object[]]$Exceptions, [Parameter(Mandatory)][hashtable]$GpParams)
    foreach ($e in @($Exceptions)) {
        $key = "$($e.hive)\$($e.key)"
        if ($e.action -eq 'delete') {
            try {
                Remove-GPRegistryValue -Guid $GpoObject.Id -Key $key -ValueName $e.valueName @GpParams | Out-Null
            }
            catch { Write-AgentLog "Exception $($e.id): $key\$($e.valueName) was not present in $($Gpo.displayName)" 'WARN' }
        }
        else {
            $value = $e.value
            if ($e.valueType -in 'DWord', 'QWord') { $value = [long]$e.value }
            elseif ($e.valueType -eq 'MultiString') { $value = [string[]]($e.value -split '\\0') }
            elseif ($e.valueType -eq 'Binary') { $value = ConvertFrom-HexString $e.value }
            Set-GPRegistryValue -Guid $GpoObject.Id -Key $key -ValueName $e.valueName -Type $e.valueType -Value $value @GpParams | Out-Null
        }
        Write-AgentLog "Exception $($e.id): $key\$($e.valueName) $($e.action) on $($Gpo.displayName)"
    }
}

<#
    Writes registry exceptions into the backup's registry.pol before import so
    the GPO is created in its final state. A registry.pol without entries may
    not have the registry extension registered on the GPO, so those exceptions
    are returned for Set-GPRegistryValue after import instead.
#>
function Set-RegistryPolBackupExceptions {
    param([Parameter(Mandatory)][string]$BackupFolder, [Parameter(Mandatory)]$Gpo, $Exceptions)
    $deferred = New-Object System.Collections.Generic.List[object]
    $mine = @($Exceptions | Where-Object { $_.kind -eq 'registry' -and $_.gpoFamily -eq $Gpo.family })
    foreach ($scope in @(@{ hive = 'HKLM'; dir = 'Machine' }, @{ hive = 'HKCU'; dir = 'User' })) {
        $forHive = @($mine | Where-Object { $_.hive -eq $scope.hive })
        if (-not $forHive.Count) { continue }
        $pol = Join-Path $BackupFolder "DomainSysvol\GPO\$($scope.dir)\registry.pol"
        $entries = @(Read-RegistryPol $pol)
        if (-not $entries.Count) { foreach ($e in $forHive) { $deferred.Add($e) }; continue }
        Write-RegistryPol -Path $pol -Entries (Set-RegistryPolExceptions -Entries $entries -Exceptions $forHive)
        foreach ($e in $forHive) { Write-AgentLog "Exception $($e.id): $($e.hive)\$($e.key)\$($e.valueName) $($e.action) on $($Gpo.displayName)" }
    }
    , $deferred.ToArray()
}

function Set-GpoWmiFilter {
    param([Parameter(Mandatory)]$GpoObject, [Parameter(Mandatory)][string]$FilterName, [Parameter(Mandatory)]$EnvConfig)
    $domain = New-Object Microsoft.GroupPolicy.GPDomain($EnvConfig.Domain)
    $filter = @($domain.SearchWmiFilters((New-Object Microsoft.GroupPolicy.GPSearchCriteria)) | Where-Object { $_.Name -eq $FilterName })
    if ($filter.Count -ne 1) { throw "WMI filter '$FilterName' was not found exactly once in $($EnvConfig.Domain)" }
    $GpoObject.WmiFilter = $filter[0]
}

<# Imports every selected DISA backup into a new managed GPO and uploads its settings report. #>
function Import-ReleaseGpos {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    Import-Module GroupPolicy -ErrorAction Stop
    $gp = Get-GpParams $EnvConfig
    $envName = $Job.job.environment
    $selected = Get-SelectedGpos -Job $Job -EnvConfig $EnvConfig
    $root = Get-PackageFolder -Job $Job -Selected $selected
    $deployed = New-Object System.Collections.Generic.List[object]

    foreach ($g in $selected) {
        $name = Format-GpoName -Format $EnvConfig.GpoNameFormat -Gpo $g -Label $Job.release.label -ReleaseId $Job.release.id -Environment $envName
        $backupPath = Join-Path $root ($g.backupDirectory -replace '/', '\')
        $backupFolder = Get-BackupFolder -Root $root -Gpo $g

        $existing = Get-GPO -Name $name @gp -ErrorAction SilentlyContinue
        if ($existing) {
            $marker = Read-ManagedMarker $existing.Description
            if (-not $marker -or $marker.release -ne $Job.release.id -or $marker.env -ne $envName) {
                throw "A GPO named '$name' already exists and is not this release's $envName GPO. Rename it or add {ReleaseId8} to GpoNameFormat."
            }
            Write-AgentLog "Re-importing into existing $name (retry)"
        }

        $allowPlaceholders = [bool]($EnvConfig.PSObject.Properties['AllowDisaPlaceholders'] -and $EnvConfig.AllowDisaPlaceholders)
        Set-SecurityTemplateExceptions -BackupFolder $backupFolder -Gpo $g -Exceptions $Job.exceptions -AllowPlaceholders:$allowPlaceholders
        $deferred = Set-RegistryPolBackupExceptions -BackupFolder $backupFolder -Gpo $g -Exceptions $Job.exceptions
        $importParams = @{ BackupId = $g.backupId; Path = $backupPath; TargetName = $name; CreateIfNeeded = $true }
        if ($EnvConfig.PSObject.Properties['MigrationTable'] -and $EnvConfig.MigrationTable) { $importParams.MigrationTable = $EnvConfig.MigrationTable }
        $gpo = Import-GPO @importParams @gp
        $gpo.Description = New-ManagedMarker -ReleaseId $Job.release.id -Environment $envName -Family $g.family -BackupId $g.backupId -Sha256 $Job.release.sourceHash
        if ($deferred.Count) { Set-RegistryExceptions -GpoObject $gpo -Gpo $g -Exceptions $deferred -GpParams $gp }

        $baseline = @($EnvConfig.Baselines | Where-Object { Test-BaselineMatch -Baseline $_ -Gpo $g } | Where-Object { $_.PSObject.Properties['WmiFilter'] -and $_.WmiFilter } | Select-Object -First 1)
        if ($baseline.Count) { Set-GpoWmiFilter -GpoObject $gpo -FilterName $baseline[0].WmiFilter -EnvConfig $EnvConfig }

        $report = Get-GPOReport -Guid $gpo.Id -ReportType Xml @gp
        Invoke-TrackerApi -Method POST -Path "/api/gpo/agent/jobs/$($Job.job.id)/reports" -Body @{
            environment = $envName; gpoId = "{$($gpo.Id)}"; gpoName = $name; sourceBackupId = $g.backupId; reportXml = $report
        } | Out-Null
        Write-AgentLog "Imported $name ({$($gpo.Id)}) from $($g.displayName)"
        $deployed.Add([pscustomobject]@{ id = "{$($gpo.Id)}"; name = $name; sourceBackupId = $g.backupId; family = $g.family })
        Send-Heartbeat $Job
    }
    , $deployed.ToArray()
}

function Assert-ManagedGpo {
    param([Parameter(Mandatory)]$Deployed, [Parameter(Mandatory)]$Job, [Parameter(Mandatory)][hashtable]$GpParams)
    $gpo = Get-GPO -Guid (ConvertTo-NormalizedGuid $Deployed.id) @GpParams
    $marker = Read-ManagedMarker $gpo.Description
    if (-not $marker -or $marker.release -ne $Job.release.id -or $marker.env -ne $Job.job.environment) {
        throw "GPO $($Deployed.id) is not the $($Job.job.environment) GPO created for $($Job.release.label); refusing to link it"
    }
    $gpo
}

<#
    Reverts the link changes made by the current attempt. Anything that cannot
    be reverted stays in $script:LinkProgress so the tracker records it and a
    rollback can finish the job.
#>
function Undo-LinkChanges {
    param([Parameter(Mandatory)][hashtable]$GpParams)
    $progress = $script:LinkProgress
    if (-not $progress) { return }
    $stillCreated = New-Object System.Collections.Generic.List[object]
    $stillEnabled = New-Object System.Collections.Generic.List[object]
    $stillRemoved = New-Object System.Collections.Generic.List[object]
    foreach ($c in $progress.created) {
        try {
            Remove-GPLink -Guid (ConvertTo-NormalizedGuid $c.gpoId) -Target $c.target @GpParams | Out-Null
            Write-AgentLog "Undo: unlinked $($c.gpoName) from $($c.target)"
        }
        catch { $stillCreated.Add($c); Write-AgentLog "Undo failed for new link $($c.gpoName) on $($c.target): $($_.Exception.Message)" 'WARN' }
    }
    foreach ($c in $progress.enabled) {
        try {
            Set-GPLink -Guid (ConvertTo-NormalizedGuid $c.gpoId) -Target $c.target -LinkEnabled No @GpParams | Out-Null
            Write-AgentLog "Undo: disabled $($c.gpoName) on $($c.target) again"
        }
        catch { $stillEnabled.Add($c); Write-AgentLog "Undo failed for enabled link $($c.gpoName) on $($c.target): $($_.Exception.Message)" 'WARN' }
    }
    foreach ($r in @($progress.removed | Sort-Object order)) {
        try {
            $restore = @{
                Guid = (ConvertTo-NormalizedGuid $r.gpoId); Target = $r.target
                LinkEnabled = $(if ($r.enabled) { 'Yes' } else { 'No' }); Enforced = $(if ($r.enforced) { 'Yes' } else { 'No' })
            }
            if ($r.order) { $restore.Order = [int]$r.order }
            New-GPLink @restore @GpParams | Out-Null
            Write-AgentLog "Undo: restored $($r.gpoName) on $($r.target)"
        }
        catch { $stillRemoved.Add($r); Write-AgentLog "Undo failed for replaced link $($r.gpoName) on $($r.target): $($_.Exception.Message)" 'WARN' }
    }
    $progress.created = $stillCreated
    $progress.enabled = $stillEnabled
    $progress.removed = $stillRemoved
}

<# Links on a target that point at GPOs of the same family this release supersedes. #>
function Get-ReplaceableLinks {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Existing, [Parameter(Mandatory)]$Gpo, [Parameter(Mandatory)]$Deployed,
        [Parameter(Mandatory)]$Baseline, [Parameter(Mandatory)]$Job, [Parameter(Mandatory)][hashtable]$GpParams)
    $live = New-Object System.Collections.Generic.List[object]
    $stale = New-Object System.Collections.Generic.List[object]
    foreach ($l in $Existing) {
        if ($l.GpoId -eq $Gpo.Id) { continue }
        $other = Get-GPO -Guid $l.GpoId @GpParams -ErrorAction SilentlyContinue
        if (-not $other) { continue }
        $marker = Read-ManagedMarker $other.Description
        $managedPeer = $marker -and $marker.env -eq $Job.job.environment -and $marker.family -eq $Deployed.family -and $marker.release -ne $Job.release.id
        $legacy = $false
        if (-not $marker -and $Baseline.PSObject.Properties['ReplaceLinksMatching']) {
            foreach ($pattern in @($Baseline.ReplaceLinksMatching)) { if ($other.DisplayName -like $pattern) { $legacy = $true } }
        }
        if (-not ($managedPeer -or $legacy)) { continue }
        # Disabled links of other managed releases are leftovers from staging that never went live.
        if ($managedPeer -and -not $l.Enabled) { $stale.Add($l) } else { $live.Add($l) }
    }
    @{ live = $live.ToArray(); stale = $stale.ToArray() }
}

<#
    Mode Activate (test deploy, production release): link each GPO enabled at
    the position of the link it replaces, then remove the replaced link.
    Mode Stage (production staging): link each GPO *disabled*, directly above
    the live GPO it will replace, so both can be compared in GPMC; nothing that
    applies to computers changes.
    Either way, disabled links left by earlier unreleased stagings of the same
    family are cleaned up. On failure every change made by this attempt is
    reverted before the error propagates.
#>
function Set-ReleaseLinks {
    param(
        [Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig, [Parameter(Mandatory)][object[]]$Deployed,
        [ValidateSet('Activate', 'Stage')][string]$Mode = 'Activate'
    )
    $gp = Get-GpParams $EnvConfig
    $enable = $Mode -eq 'Activate'
    $links = New-Object System.Collections.Generic.List[object]
    $script:LinkProgress = @{
        created = New-Object System.Collections.Generic.List[object]
        enabled = New-Object System.Collections.Generic.List[object]
        removed = New-Object System.Collections.Generic.List[object]
    }

    try {
        foreach ($b in @($EnvConfig.Baselines)) {
            $mine = @($Deployed | Where-Object { Test-BaselineMatch -Baseline $b -Gpo (Get-SourceGpo -Job $Job -Deployed $_) })
            foreach ($d in $mine) {
                $gpo = Assert-ManagedGpo -Deployed $d -Job $Job -GpParams $gp
                foreach ($target in @($b.LinkTargets)) {
                    $existing = @((Get-GPInheritance -Target $target @gp).GpoLinks)
                    $found = Get-ReplaceableLinks -Existing $existing -Gpo $gpo -Deployed $d -Baseline $b -Job $Job -GpParams $gp
                    foreach ($s in $found.stale) {
                        Remove-GPLink -Guid $s.GpoId -Target $target @gp | Out-Null
                        Write-AgentLog "Removed stale staged link $($s.DisplayName) from $target"
                    }
                    $desired = if ($found.live.Count) { ($found.live | Measure-Object -Property Order -Minimum).Minimum } else { $null }
                    $current = @((Get-GPInheritance -Target $target @gp).GpoLinks | Where-Object { $_.GpoId -eq $gpo.Id })
                    $record = [pscustomobject]@{ target = $target; gpoId = $d.id; gpoName = $d.name; order = $null; enabled = $enable; enforced = $false }
                    if (-not $current.Count) {
                        $newLink = @{ Guid = $gpo.Id; Target = $target; LinkEnabled = $(if ($enable) { 'Yes' } else { 'No' }) }
                        if ($desired) { $newLink.Order = $desired }
                        New-GPLink @newLink @gp | Out-Null
                        $script:LinkProgress.created.Add($record)
                        Write-AgentLog "Linked $($d.name) to $target ($(if ($enable) { 'enabled' } else { 'disabled for review' }))"
                    }
                    else {
                        if ($desired -and $current[0].Order -gt $desired) {
                            Set-GPLink -Guid $gpo.Id -Target $target -Order $desired @gp | Out-Null
                        }
                        if ($enable -and -not $current[0].Enabled) {
                            Set-GPLink -Guid $gpo.Id -Target $target -LinkEnabled Yes @gp | Out-Null
                            $script:LinkProgress.enabled.Add($record)
                            Write-AgentLog "Enabled staged link $($d.name) on $target"
                        }
                        elseif (-not $enable -and $current[0].Enabled) {
                            Set-GPLink -Guid $gpo.Id -Target $target -LinkEnabled No @gp | Out-Null
                        }
                    }
                    if ($enable) {
                        foreach ($r in $found.live) {
                            Remove-GPLink -Guid $r.GpoId -Target $target @gp | Out-Null
                            $script:LinkProgress.removed.Add([pscustomobject]@{
                                    target = $target; gpoId = "{$($r.GpoId)}"; gpoName = $r.DisplayName
                                    order = [int]$r.Order; enabled = [bool]$r.Enabled; enforced = [bool]$r.Enforced
                                })
                            Write-AgentLog "Unlinked replaced GPO $($r.DisplayName) from $target"
                        }
                    }
                    $now = @((Get-GPInheritance -Target $target @gp).GpoLinks | Where-Object { $_.GpoId -eq $gpo.Id })
                    $record.order = if ($now.Count) { [int]$now[0].Order } else { $null }
                    $links.Add($record)
                }
            }
        }
    }
    catch {
        $failure = $_
        Write-AgentLog "Linking failed; reverting this attempt's link changes" 'WARN'
        Undo-LinkChanges -GpParams $gp
        throw $failure
    }
    $result = @{ links = $links.ToArray(); previousLinks = $script:LinkProgress.removed.ToArray() }
    $script:LinkProgress = $null
    $result
}

function Get-AllowedTargets {
    param([Parameter(Mandatory)]$EnvConfig)
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($b in @($EnvConfig.Baselines)) { foreach ($t in @($b.LinkTargets)) { [void]$set.Add($t) } }
    , $set
}

function Invoke-Rollback {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    Import-Module GroupPolicy -ErrorAction Stop
    $gp = Get-GpParams $EnvConfig
    $allowed = Get-AllowedTargets $EnvConfig
    $deployment = $Job.deployment
    if (-not $deployment) { throw 'The tracker sent no production deployment to roll back' }

    foreach ($l in @($deployment.links)) {
        if (-not $allowed.Contains($l.target)) { throw "Refusing to modify non-configured target $($l.target)" }
        $gpo = Get-GPO -Guid (ConvertTo-NormalizedGuid $l.gpoId) @gp -ErrorAction SilentlyContinue
        $marker = if ($gpo) { Read-ManagedMarker $gpo.Description } else { $null }
        if (-not $marker -or $marker.release -ne $Job.release.id) { throw "Link $($l.gpoName) on $($l.target) is not this release's GPO" }
        $present = @((Get-GPInheritance -Target $l.target @gp).GpoLinks | Where-Object { $_.GpoId -eq $gpo.Id })
        if ($present.Count) {
            Remove-GPLink -Guid $gpo.Id -Target $l.target @gp | Out-Null
            Write-AgentLog "Unlinked $($l.gpoName) from $($l.target)"
        }
    }
    foreach ($p in @($deployment.previousLinks | Sort-Object order)) {
        if (-not $allowed.Contains($p.target)) { throw "Refusing to modify non-configured target $($p.target)" }
        $gpo = Get-GPO -Guid (ConvertTo-NormalizedGuid $p.gpoId) @gp -ErrorAction SilentlyContinue
        if (-not $gpo) { Write-AgentLog "Previous GPO $($p.gpoName) no longer exists; cannot restore its link" 'WARN'; continue }
        $present = @((Get-GPInheritance -Target $p.target @gp).GpoLinks | Where-Object { $_.GpoId -eq $gpo.Id })
        if ($present.Count) { continue }
        $restore = @{ Guid = $gpo.Id; Target = $p.target; LinkEnabled = $(if ($p.enabled) { 'Yes' } else { 'No' }); Enforced = $(if ($p.enforced) { 'Yes' } else { 'No' }) }
        if ($p.order) { $restore.Order = [int]$p.order }
        New-GPLink @restore @gp | Out-Null
        Write-AgentLog "Restored link $($p.gpoName) on $($p.target)"
    }
    @{}
}

function Get-ComputerDn {
    param([Parameter(Mandatory)][string]$Computer, [Parameter(Mandatory)]$EnvConfig)
    $short = $Computer.Split('.')[0]
    if ($short -notmatch '^[A-Za-z0-9-]{1,15}$') { throw "'$Computer' is not a valid computer name" }
    $root = 'LDAP://' + $(if ($EnvConfig.PSObject.Properties['Server'] -and $EnvConfig.Server) { "$($EnvConfig.Server)/" } else { "$($EnvConfig.Domain)/" }) +
        (($EnvConfig.Domain.Split('.') | ForEach-Object { "DC=$_" }) -join ',')
    $searcher = New-Object DirectoryServices.DirectorySearcher([ADSI]$root)
    $searcher.Filter = "(&(objectCategory=computer)(sAMAccountName=$short`$))"
    $result = $searcher.FindOne()
    if (-not $result) { throw "Computer account $short not found in $($EnvConfig.Domain)" }
    [string]$result.Properties['distinguishedname'][0]
}

function Invoke-Validation {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    $deployment = $Job.deployment
    if (-not $deployment -or -not @($deployment.gpos).Count) { throw 'The tracker sent no test deployment to validate' }
    $computers = @()
    if ($EnvConfig.PSObject.Properties['ValidationComputers']) { $computers = @($EnvConfig.ValidationComputers) }
    $timeout = if ($EnvConfig.PSObject.Properties['GpUpdateTimeoutSeconds']) { [int]$EnvConfig.GpUpdateTimeoutSeconds } else { 300 }
    $script = if ($EnvConfig.PSObject.Properties['ValidationScript']) { $EnvConfig.ValidationScript } else { $null }
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($computer in $computers) {
        $entry = [ordered]@{
            name = $computer; reachable = $false; error = $null; distinguishedName = $null
            expectedGpoIds = @(); appliedGpoIds = @(); filteredGpoIds = @(); missingGpoIds = @(); extensionErrors = @(); script = $null
        }
        try {
            $dn = Get-ComputerDn -Computer $computer -EnvConfig $EnvConfig
            $entry.distinguishedName = $dn
            $expected = @($deployment.links | Where-Object { Test-DnUnderTarget -DistinguishedName $dn -Target $_.target } | ForEach-Object { $_.gpoId } | Select-Object -Unique)
            $entry.expectedGpoIds = $expected

            Write-AgentLog "Refreshing Group Policy on $computer"
            $xml = Invoke-Command -ComputerName $computer -ErrorAction Stop -ArgumentList $timeout -ScriptBlock {
                param($Wait)
                & gpupdate.exe /target:computer /force "/wait:$Wait" | Out-Null
                $path = Join-Path $env:TEMP ('stig-gpresult-{0}.xml' -f [guid]::NewGuid())
                & gpresult.exe /scope computer /x $path /f | Out-Null
                try { Get-Content -LiteralPath $path -Raw } finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
            }
            $rsop = ConvertFrom-GpResultXml -Xml ([string]$xml)
            $entry.reachable = $true
            $entry.appliedGpoIds = $rsop.appliedGpoIds
            $entry.filteredGpoIds = $rsop.filteredGpoIds
            $entry.extensionErrors = $rsop.extensionErrors
            $entry.missingGpoIds = @($expected | Where-Object {
                    $id = ConvertTo-NormalizedGuid $_
                    ($rsop.appliedGpoIds -notcontains $id) -and ($rsop.filteredGpoIds -notcontains $id)
                })

            if ($script) {
                try {
                    $outcome = & $script -ComputerName $computer -GpoIds @($deployment.gpos | ForEach-Object { $_.id }) -GpoNames @($deployment.gpos | ForEach-Object { $_.name })
                    if ($null -eq $outcome -or -not $outcome.PSObject.Properties['Passed']) {
                        $entry.script = @{ passed = $false; summary = 'Validation script returned no Passed property' }
                    }
                    else {
                        $summary = if ($outcome.PSObject.Properties['Summary']) { [string]$outcome.Summary } else { $null }
                        $entry.script = @{ passed = [bool]$outcome.Passed; summary = $summary }
                    }
                }
                catch {
                    # A broken compliance check must block the release, never pass it.
                    $entry.script = @{ passed = $false; summary = "Validation script error: $($_.Exception.Message)" }
                }
            }
        }
        catch {
            $entry.error = $_.Exception.Message
            Write-AgentLog "Validation on ${computer}: $($entry.error)" 'WARN'
        }
        $results.Add([pscustomobject]$entry)
        Send-Heartbeat $Job
    }
    @{ validation = @{ collectedAt = (Get-Date).ToUniversalTime().ToString('o'); computers = $results.ToArray() } }
}

<#
    Finds the GPOs currently *live* (enabled links) on the configured production
    OUs for each family this release deploys: earlier managed releases, or
    pre-agent GPOs named in ReplaceLinksMatching.
#>
function Find-CurrentProductionGpos {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig, [Parameter(Mandatory)][object[]]$Selected, [Parameter(Mandatory)][hashtable]$GpParams)
    $found = @{}
    foreach ($b in @($EnvConfig.Baselines)) {
        $families = @($Selected | Where-Object { Test-BaselineMatch -Baseline $b -Gpo $_ })
        foreach ($target in @($b.LinkTargets)) {
            foreach ($l in @((Get-GPInheritance -Target $target @GpParams).GpoLinks | Where-Object { $_.Enabled })) {
                $other = Get-GPO -Guid $l.GpoId @GpParams -ErrorAction SilentlyContinue
                if (-not $other) { continue }
                $marker = Read-ManagedMarker $other.Description
                foreach ($fam in $families) {
                    $isPeer = $marker -and $marker.env -eq 'production' -and $marker.family -eq $fam.family -and $marker.release -ne $Job.release.id
                    $isLegacy = $false
                    if (-not $marker -and $b.PSObject.Properties['ReplaceLinksMatching']) {
                        foreach ($p in @($b.ReplaceLinksMatching)) { if ($other.DisplayName -like $p) { $isLegacy = $true } }
                        # One legacy GPO must not be attributed to several families of a multi-GPO baseline.
                        if ($isLegacy -and $families.Count -gt 1 -and ($other.DisplayName -replace '\s+v\d+\s*r\d+\s*$', '') -ne $fam.family) { $isLegacy = $false }
                    }
                    if ($isPeer -or $isLegacy) {
                        $found["$($fam.family)|$($other.Id)"] = [pscustomobject]@{ family = $fam.family; gpo = $other; marker = $marker }
                    }
                }
            }
        }
    }
    @($found.Values)
}

<# Resolves the DISA backup a production GPO was imported from. #>
function Resolve-GpoBaseline {
    param([Parameter(Mandatory)]$Current, [Parameter(Mandatory)]$Job)
    $known = @($Job.knownReleases)
    if ($Current.marker) {
        $rel = @($known | Where-Object { $_.id -eq $Current.marker.release }) | Select-Object -First 1
        if ($rel) {
            $g = @($rel.gpos | Where-Object { $_.backupId -ieq $Current.marker.backup }) | Select-Object -First 1
            if ($g) { return [pscustomobject]@{ ref = $rel; gpo = $g; kind = 'release'; label = $rel.label } }
        }
    }
    foreach ($rel in $known) {
        $g = @($rel.gpos | Where-Object { $_.displayName -ieq $Current.gpo.DisplayName }) | Select-Object -First 1
        if ($g) { return [pscustomobject]@{ ref = $rel; gpo = $g; kind = 'package'; label = $rel.label } }
    }
    $null
}

<#
    Read-only. Backs up every live production GPO this release would replace
    and reports how it differs from the DISA backup it came from.
#>
function Invoke-ProductionSurvey {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    if ($Job.job.environment -ne 'production') { throw 'Surveys run only in production' }
    Import-Module GroupPolicy -ErrorAction Stop
    $gp = Get-GpParams $EnvConfig
    $selected = Get-SelectedGpos -Job $Job -EnvConfig $EnvConfig
    $newRoot = Expand-ReleaseBackups -Ref $Job.release -BackupDirectories @($selected | ForEach-Object { $_.backupDirectory }) -Tag 'n'
    $backupRoot = Join-Path $script:Config.WorkDirectory 's'
    if (Test-Path -LiteralPath $backupRoot) { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    $gpos = New-Object System.Collections.Generic.List[object]
    $custom = New-Object System.Collections.Generic.List[object]
    $unsupported = New-Object System.Collections.Generic.List[object]
    $current = Find-CurrentProductionGpos -Job $Job -EnvConfig $EnvConfig -Selected $selected -GpParams $gp
    $baseIndex = 0

    foreach ($group in @($current | Group-Object family)) {
        $theirsGpo = @($selected | Where-Object { $_.family -eq $group.Name })[0]
        $theirsFolder = Get-BackupFolder -Root $newRoot -Gpo $theirsGpo
        $perGpo = New-Object System.Collections.Generic.List[object]
        foreach ($cur in $group.Group) {
            $backup = Backup-GPO -Guid $cur.gpo.Id -Path $backupRoot @gp
            $oursFolder = Join-Path $backupRoot "{$($backup.Id)}"
            $base = Resolve-GpoBaseline -Current $cur -Job $Job
            if ($base) {
                $baseIndex += 1
                $baseRoot = Expand-ReleaseBackups -Ref $base.ref -BackupDirectories @($base.gpo.backupDirectory) -Tag "b$baseIndex"
                $baseFolder = Get-BackupFolder -Root $baseRoot -Gpo $base.gpo
            }
            else {
                # Unknown origin: compare with the new DISA GPO and let a human sort DISA changes from local ones.
                $baseFolder = $theirsFolder
            }
            $cmp = Compare-GpoBackups -BaseFolder $baseFolder -OursFolder $oursFolder -TheirsFolder $theirsFolder `
                -Family $group.Name -SourceGpoName $cur.gpo.DisplayName -BaselineKnown ([bool]$base)
            $perGpo.Add($cmp)
            foreach ($u in $cmp.unsupported) { $unsupported.Add($u) }
            $gpos.Add([pscustomobject]@{
                    gpoFamily = $group.Name; gpoId = "{$($cur.gpo.Id)}"; gpoName = $cur.gpo.DisplayName
                    baseline = $(if ($base) { $base.kind } else { 'unknown' }); baselineLabel = $(if ($base) { $base.label } else { $null })
                })
            Write-AgentLog "Surveyed $($cur.gpo.DisplayName): $(@($cmp.customizations).Count) customization(s) vs $(if ($base) { "DISA $($base.label)" } else { 'unknown baseline' })"
            Send-Heartbeat $Job
        }
        # Several live GPOs of one family: only customizations they all share can be carried into one new GPO.
        $sig = { param($c) "$($c.kind)|$($c.action)|$($c.hive)|$($c.key)|$($c.valueName)|$($c.valueType)|$($c.value)|$($c.section)|$($c.settingKey)|$($c.settingValue)".ToLowerInvariant() }
        foreach ($c in @($perGpo[0].customizations)) {
            $s = & $sig $c
            $shared = @($perGpo | Where-Object { @($_.customizations | Where-Object { (& $sig $_) -eq $s }).Count -gt 0 }).Count -eq $perGpo.Count
            if ($shared) { $custom.Add($c) }
        }
        if ($perGpo.Count -gt 1) {
            foreach ($cmp in $perGpo) {
                foreach ($c in @($cmp.customizations)) {
                    $s = & $sig $c
                    if (-not @($custom | Where-Object { (& $sig $_) -eq $s }).Count) {
                        $unsupported.Add([pscustomobject]@{
                                gpoFamily = $group.Name; gpoName = $c.sourceGpoName
                                detail = "$(if ($c.kind -eq 'registry') { "$($c.hive)\$($c.key)\$($c.valueName)" } else { "[$($c.section)] $($c.settingKey)" }) differs between live production GPOs of this family; consolidate them first"
                            })
                    }
                }
            }
        }
    }
    @{
        survey = @{
            surveyedAt = (Get-Date).ToUniversalTime().ToString('o')
            gpos = $gpos.ToArray(); customizations = $custom.ToArray(); unsupported = $unsupported.ToArray()
        }
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# Job dispatch
# ─────────────────────────────────────────────────────────────────────────────

function Invoke-GpoJob {
    param([Parameter(Mandatory)]$Job, [Parameter(Mandatory)]$EnvConfig)
    Import-Module GroupPolicy -ErrorAction Stop
    switch ($Job.job.type) {
        'deploy' {
            if ($Job.job.environment -ne 'test') { throw 'deploy jobs run only in test' }
            $deployed = Import-ReleaseGpos -Job $Job -EnvConfig $EnvConfig
            $linked = Set-ReleaseLinks -Job $Job -EnvConfig $EnvConfig -Deployed $deployed
            return @{ gpos = $deployed; links = $linked.links; previousLinks = $linked.previousLinks }
        }
        'validate' { return Invoke-Validation -Job $Job -EnvConfig $EnvConfig }
        'survey' { return Invoke-ProductionSurvey -Job $Job -EnvConfig $EnvConfig }
        'stage' {
            if ($Job.job.environment -ne 'production') { throw 'stage jobs run only in production' }
            # Re-survey first: production may have been edited since the release was reviewed.
            $survey = Invoke-ProductionSurvey -Job $Job -EnvConfig $EnvConfig
            $deployed = Import-ReleaseGpos -Job $Job -EnvConfig $EnvConfig
            $linked = Set-ReleaseLinks -Job $Job -EnvConfig $EnvConfig -Deployed $deployed -Mode Stage
            return @{ gpos = $deployed; links = $linked.links; previousLinks = @(); survey = $survey.survey }
        }
        'release' {
            if (-not $Job.deployment) { throw 'The tracker sent no staged production GPOs' }
            # Final guard: refuse to change production links if production drifted since staging.
            $survey = Invoke-ProductionSurvey -Job $Job -EnvConfig $EnvConfig
            $check = Invoke-TrackerApi -Method POST -Path "/api/gpo/agent/jobs/$($Job.job.id)/precheck" -Body @{
                environment = $Job.job.environment; survey = $survey.survey
            }
            if (-not $check.ok) { throw "Production changed since staging; no links were changed: $(@($check.reasons) -join '; ')" }
            Write-AgentLog 'Production unchanged since staging; enabling the staged links'
            $linked = Set-ReleaseLinks -Job $Job -EnvConfig $EnvConfig -Deployed @($Job.deployment.gpos) -Mode Activate
            return @{ links = $linked.links; previousLinks = $linked.previousLinks }
        }
        'rollback' { return Invoke-Rollback -Job $Job -EnvConfig $EnvConfig }
        default { throw "Unsupported job type $($Job.job.type)" }
    }
}

function Invoke-EnvironmentPoll {
    param([Parameter(Mandatory)]$EnvConfig)
    $job = Invoke-TrackerApi -Method POST -Path '/api/gpo/agent/jobs/claim' -Body @{
        environment = $EnvConfig.Name; hostname = $env:COMPUTERNAME; version = $script:AgentVersion
    }
    if (-not $job -or -not $job.PSObject.Properties['job']) { return $false }

    $script:JobLog.Clear()
    $script:LinkProgress = $null
    Write-AgentLog "Claimed $($job.job.type) job $($job.job.id) for $($job.release.label) in $($EnvConfig.Name) (attempt $($job.job.attempt))"
    $completion = @{ environment = $EnvConfig.Name; success = $false }
    try {
        $result = Invoke-GpoJob -Job $job -EnvConfig $EnvConfig
        foreach ($k in $result.Keys) { $completion[$k] = $result[$k] }
        $completion.success = $true
        Write-AgentLog "Job $($job.job.id) completed"
    }
    catch {
        $completion.error = $_.Exception.Message
        $progress = $script:LinkProgress
        if ($progress -and ($progress.created.Count -or $progress.enabled.Count -or $progress.removed.Count)) {
            # Report link changes that could not be undone so the tracker can roll them back.
            $completion.links = @($progress.created.ToArray()) + @($progress.enabled.ToArray())
            $completion.previousLinks = $progress.removed.ToArray()
            Write-AgentLog "$($progress.created.Count + $progress.enabled.Count + $progress.removed.Count) link change(s) could not be reverted; recorded for rollback" 'ERROR'
        }
        Write-AgentLog "Job $($job.job.id) failed: $($_.Exception.Message)" 'ERROR'
    }
    finally {
        foreach ($temp in (Get-ExtractRoot), (Join-Path $script:Config.WorkDirectory 's')) {
            if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    $completion.log = $script:JobLog.ToArray()
    $response = Invoke-TrackerApi -Method POST -Path "/api/gpo/agent/jobs/$($job.job.id)/complete" -Body $completion
    Write-AgentLog "Tracker recorded release status: $($response.releaseStatus)"
    $true
}

function Start-StigGpoAgent {
    param([Parameter(Mandatory)][string]$ConfigPath, [switch]$Once)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $script:Config = Read-AgentConfig -Path $ConfigPath
    New-Item -ItemType Directory -Path $script:Config.WorkDirectory -Force | Out-Null
    Write-AgentLog "STIG Tracker GPO agent $($script:AgentVersion) starting for: $((@($script:Config.Environments) | ForEach-Object { $_.Name }) -join ', ')"
    do {
        foreach ($envConfig in @($script:Config.Environments)) {
            try {
                # Drain the queue so a test pass and its validation do not wait a poll cycle each.
                while (Invoke-EnvironmentPoll -EnvConfig $envConfig) { }
            }
            catch { Write-AgentLog "Polling $($envConfig.Name) failed: $($_.Exception.Message)" 'ERROR' }
        }
        if ($Once) { break }
        Start-Sleep -Seconds ([int]$script:Config.PollSeconds)
    } while ($true)
}

if ($MyInvocation.InvocationName -ne '.') {
    Start-StigGpoAgent -ConfigPath $ConfigPath -Once:$Once
}
