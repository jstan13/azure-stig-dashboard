<#
.SYNOPSIS
    Regenerate the NIST SP 800-53 Rev. 5 -> Azure Policy mapping overlay from the
    live, authoritative Microsoft built-in regulatory-compliance initiative.

.DESCRIPTION
    The STIG Tracker maps STIG rules to Azure Policy/Defender transitively:
        STIG rule -> CCI -> NIST 800-53 control <- Azure Policy definition

    The "NIST 800-53 control <- Azure Policy definition" half is published by
    Microsoft as the built-in policySetDefinition "NIST SP 800-53 Rev. 5"
    (GUID 179d1daa-458f-4e47-8086-2a68d0d6c38f). Every policy reference in that
    initiative is tagged, in its metadata, with the NIST control(s) it addresses.

    This script reads that initiative, joins each contained policy definition to
    its NIST control id(s), and writes a JSON overlay consumed by
    backend/src/data/controlMappingSeeder.ts (loadNistRegistry):

        backend/src/data/nistAzurePolicyMap.generated.json

    Because the GUIDs come straight from Azure, they are guaranteed to match the
    policyDefinitionIds the scan orchestrator sees at runtime -- no hand-typed,
    drift-prone identifiers.

.PARAMETER OutFile
    Output path for the generated overlay JSON.

.PARAMETER InitiativeName
    Built-in initiative (policySetDefinition) name/GUID. Defaults to the NIST
    SP 800-53 Rev. 5 built-in.

.EXAMPLE
    ./scripts/build-nist-policy-map.ps1
    # then rebuild mappings:
    #   POST /api/controls/mappings/rebuild

.NOTES
    Requires: Azure CLI (az), authenticated (az login) with reader access.
#>
[CmdletBinding()]
param(
    [string]$OutFile = "$PSScriptRoot/../backend/src/data/nistAzurePolicyMap.generated.json",
    [string]$InitiativeName = '179d1daa-458f-4e47-8086-2a68d0d6c38f'
)

$ErrorActionPreference = 'Stop'

function Test-AzCli {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI (az) is not installed or not on PATH. Install from https://aka.ms/azure-cli.'
    }
    try { az account show --only-show-errors 1>$null 2>$null }
    catch { throw 'Not logged in to Azure. Run: az login' }
}

Write-Host '[build-nist-policy-map] Verifying Azure CLI...' -ForegroundColor Cyan
Test-AzCli

Write-Host "[build-nist-policy-map] Fetching built-in initiative $InitiativeName ..." -ForegroundColor Cyan
$initiativeJson = az policy set-definition show --name $InitiativeName --only-show-errors 2>$null
if (-not $initiativeJson) {
    throw "Could not retrieve initiative '$InitiativeName'. Confirm the name/GUID and your permissions."
}
$initiative = $initiativeJson | ConvertFrom-Json

# Map NIST control id -> array of policy refs.
$map = @{}

# Cache policy definition display names to avoid repeat lookups.
$nameCache = @{}

foreach ($ref in $initiative.policyDefinitions) {
    $policyId = $ref.policyDefinitionId
    if (-not $policyId) { continue }

    # NIST control ids are carried in the reference groupNames, which point at
    # the initiative's policyDefinitionGroups (each named like "NIST_SP_800-53_R5_AC-2").
    $controlIds = @()
    foreach ($g in @($ref.groupNames)) {
        if ($g -match '([A-Z]{2}-\d+(?:\s*\(\d+\))?)') {
            $controlIds += ($Matches[1] -replace '\s', '')
        }
    }
    if ($controlIds.Count -eq 0) { continue }

    # Resolve a friendly name (best-effort).
    $displayName = $nameCache[$policyId]
    if (-not $displayName) {
        try {
            $guid = ($policyId -split '/')[-1]
            $def = az policy definition show --name $guid --only-show-errors 2>$null | ConvertFrom-Json
            $displayName = $def.displayName
        } catch { $displayName = $guid }
        $nameCache[$policyId] = $displayName
    }

    foreach ($cid in ($controlIds | Select-Object -Unique)) {
        if (-not $map.ContainsKey($cid)) { $map[$cid] = New-Object System.Collections.ArrayList }
        $null = $map[$cid].Add([ordered]@{
            sourceType = 'azure-policy'
            sourceId   = $policyId
            sourceName = $displayName
            confidence = 1
            notes      = "Authoritative: NIST SP 800-53 R5 built-in initiative ($InitiativeName)"
        })
    }
}

if ($map.Keys.Count -eq 0) {
    throw 'No NIST control groupings were found in the initiative. The schema may have changed; inspect the initiative manually.'
}

$ordered = [ordered]@{}
foreach ($k in ($map.Keys | Sort-Object)) { $ordered[$k] = $map[$k] }

$json = $ordered | ConvertTo-Json -Depth 6
$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$json | Set-Content -Path $OutFile -Encoding UTF8

Write-Host "[build-nist-policy-map] Wrote $($map.Keys.Count) NIST control(s) to $OutFile" -ForegroundColor Green
Write-Host '[build-nist-policy-map] Next: trigger a STIG re-import or POST /api/controls/mappings/rebuild' -ForegroundColor Yellow
