# STIG Tracker GPO agent

The agent executes approved DISA GPO lifecycle jobs inside your Active Directory
domains. The tracker records reviews and decides whether testing passed; the
agent does the Group Policy work and enforces a local allow-list of which GPOs it
may import and which OUs it may link.

| Job | Environment | Action |
|---|---|---|
| `survey` | production | Read-only: back up each live production GPO the release replaces and report how it differs from its original DISA backup |
| `deploy` | test | Import selected DISA backups as new GPOs, apply exceptions, upload reports, link to test OUs |
| `validate` | test | `gpupdate` + `gpresult` on validation computers, optional scan script |
| `stage` | production | Re-survey, import the same backups and exceptions, upload reports, link each GPO **disabled** above the live GPO it replaces |
| `release` | production | Enable the staged links; unlink the GPOs they replace |
| `rollback` | production | Unlink the release; restore replaced links |

## Requirements

- Windows Server with **Windows PowerShell 5.1** and **RSAT: Group Policy
  Management Tools** (`GroupPolicy` module).
- Outbound HTTPS to the tracker API and to Microsoft Entra ID.
- For validation: WinRM access from the agent host to each validation computer.
- A **group managed service account** per environment, delegated only:
  - permission to create GPOs (*Group Policy Creator Owners* or delegated in GPMC),
  - **read** on the existing production GPOs the survey backs up,
  - **Link GPOs** on each OU listed in the configuration (production staging
    creates disabled links, so the production account needs this before release),
  - read on the agent certificate's private key,
  - (test) remote management on validation computers.

  Do **not** use Domain Admins.

## Setup

1. **Create the agent identities** (one per environment, different certificates).
   Generate a certificate on each agent host, export the public `.cer`, then:

   ```powershell
   $cert = New-SelfSignedCertificate -Subject 'CN=stig-gpo-agent-test' -CertStoreLocation Cert:\LocalMachine\My `
       -KeyExportPolicy NonExportable -KeySpec Signature -KeyLength 3072 -NotAfter (Get-Date).AddYears(1)
   Export-Certificate -Cert $cert -FilePath .\gpo-agent-test.cer
   # Grant the gMSA read access to the private key (certlm.msc > Manage Private Keys).

   ./scripts/register-gpo-agent.ps1 -ApiAppId <dashboard-client-id> -Environment test `
       -CertificatePath .\gpo-agent-test.cer -CloudEnvironment AzureUSGovernment
   ```

   The script adds the application-only roles `gpo-agent-test` and
   `gpo-agent-production` to the dashboard API (if missing) and grants the agent
   only its environment's role. On an Azure Arc-enabled server you can instead
   grant the role to the machine's managed identity and set `"Mode": "ArcManagedIdentity"`.

2. **Write the configuration** from [agent.config.example.json](agent.config.example.json).

   | Setting | Meaning |
   |---|---|
   | `Environments[].Name` | `test` or `production`; the token must hold the matching role |
   | `Domain`, `Server` | Target domain and preferred domain controller |
   | `GpoNameFormat` | Tokens: `{DisplayName}`, `{Family}`, `{Label}`, `{Environment}`, `{ReleaseId8}`. Defaults: `{DisplayName} [{Label} TEST]` and `{DisplayName} [{Label}]` |
   | `Baselines[].Match` | Wildcard matched against the DISA GPO family (e.g. `DoD WinSvr 2022 MS STIG Comp`) or display name |
   | `Baselines[].LinkTargets` | OUs this baseline links to. These are the **only** targets the agent will ever modify |
   | `Baselines[].WmiFilter` | Existing WMI filter to attach (DISA ships `.mof` files in the package) |
   | `Baselines[].ReplaceLinksMatching` | Names of GPOs you deployed before adopting the agent, unlinked (and restorable) on first release |
   | `MigrationTable` | Optional `.migtable` passed to `Import-GPO` |
   | `ValidationComputers` | Test computers in the linked OUs; required for a test pass |
   | `ValidationScript` | Optional script called as `& script -ComputerName -GpoIds -GpoNames`, returning `[pscustomobject]@{ Passed = $true; Summary = '...' }` |
   | `AllowDisaPlaceholders` | Leave `false`; see below |

   A baseline that no longer matches any GPO in a new package fails the job, so
   a product DISA retired or renamed gets a human decision instead of silently
   disappearing.

3. **Install** (as an administrator on the agent host):

   ```powershell
   .\Install-StigGpoAgent.ps1 -ServiceAccount 'CONTOSO\gmsa-stiggpo-test$' -ConfigPath .\agent.config.json
   ```

   This copies the agent to `C:\Program Files\StigGpoAgent`, writes the config to
   `C:\ProgramData\StigGpoAgent` (writable only by administrators), and registers
   a scheduled task that runs every 5 minutes. Logs are in
   `C:\ProgramData\StigGpoAgent\logs`, and each job's log is also stored in the
   tracker. Sign the script and use an `AllSigned` policy if your baseline requires it.

## Customizations already in production

When a package is discovered, the production agent surveys every GPO currently
linked (enabled) on the configured production OUs for the families it manages:
earlier releases it created, or pre-agent GPOs named in `ReplaceLinksMatching`.
For each one it compares three backups:

- **base** — the DISA backup the production GPO was imported from (from the
  agent's local package archive, `WorkDirectory\archive`, or the tracker),
- **ours** — `Backup-GPO` of the production GPO today,
- **theirs** — the new DISA backup.

Changes from base to ours in `registry.pol` (Administrative Templates and other
registry policy) and `GptTmpl.inf` (account policy, user rights, security
options, event log, restricted groups) are reported to the tracker, which turns
them into exceptions — approved automatically or held for review, per
**Settings → GPO releases**. A change DISA has since adopted is dropped. If the
production GPO's original DISA release is unknown, the new DISA GPO is used as
the baseline and every difference waits for human approval.

Differences the agent cannot reproduce — advanced audit policy (`audit.csv`),
Group Policy Preferences, scripts, registry/file permissions, or different
customizations on two live GPOs of the same family — are listed as *not carried
forward* and must be acknowledged before production release.

Staging re-runs the survey. If production was edited after the release was
reviewed, the tracker records the new customizations and blocks production
approval until the release is restarted, so test always validates what
production will receive.

## Staged production links

Staging links each new GPO to its production OUs with the link **disabled**,
directly above the live GPO it will replace. In GPMC you can compare the two
side by side (including with *Group Policy Results/Modeling*) before approving.
Release enables the new links and removes the old ones. Disabled links left by a
staged release that was rejected or superseded are removed at the next staging.

## Upgrading from agent 1.0

Agent 1.1 is required by tracker releases that include the production survey;
a 1.0 agent cannot complete `stage` jobs. Copy the new `StigGpoAgent.ps1` over
the installed one (or re-run `Install-StigGpoAgent.ps1`). No configuration
changes are needed.

## Exceptions and DISA placeholders

DISA's Windows GPOs contain user-rights entries such as
`SeDenyNetworkLogonRight = *S-1-5-114,*S-1-5-32-546,ADD YOUR ENTERPRISE ADMINS,ADD YOUR DOMAIN ADMINS`.
The agent refuses to import a GPO while any `ADD YOUR` placeholder remains,
naming each setting. In **GPO Releases → Exceptions**, add one *security setting*
exception per entry for that GPO family, for example:

| Field | Value |
|---|---|
| GPO | `DoD WinSvr 2022 MS STIG Comp` |
| Section | `Privilege Rights` |
| Setting | `SeDenyNetworkLogonRight` |
| Value | `*S-1-5-114,*S-1-5-32-546,*S-1-5-21-<forest>-519,*S-1-5-21-<domain>-512` |

Once approved, an exception applies to every later release of that family.
Registry exceptions are written into the backup's `registry.pol` before import
(or applied with `Set-GPRegistryValue` when the backup has no registry policy);
security-template exceptions edit the backup's `GptTmpl.inf` before import.

## How the agent stays inside its lane

- It imports only GPOs that match its `Baselines`, from an archive whose SHA-256
  equals the approved hash.
- It refuses to import into an existing GPO unless that GPO's description marks
  it as created by the same release and environment (safe retries).
- It links only GPOs it created for the current release and environment, only to
  `LinkTargets` in its own config, and only replaces links to its own earlier
  releases of the same family or names you listed in `ReplaceLinksMatching`.
- Rollback instructions from the tracker are checked against the same allow-list.
- Downloads are refused unless the agent holds an active import job for that release.

## Tests

```powershell
powershell.exe -NoProfile -Command "Invoke-Pester agent\gpo\tests"
```
