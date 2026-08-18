# Security Policy

Thanks for helping keep this project and its users safe.

This project is a STIG compliance tracker. Deployments read security findings out of
customer Azure tenants and produce audit artefacts, so vulnerabilities here can have
real consequences for the people running it. Reports are genuinely welcome.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security problem.**

Report it privately through GitHub:

> **[Report a vulnerability](https://github.com/jstan13/azure-stig-dashboard/security/advisories/new)**
> (repo → **Security** tab → **Report a vulnerability**)

This opens a private advisory that only you and the maintainers can see. GitHub notifies
the maintainers automatically, and the whole discussion, fix, and CVE request happen in
that one private thread.

If private reporting is unavailable to you for any reason, open a public issue containing
**only** the words "security report — please make contact" and no technical detail, and a
maintainer will arrange a private channel.

### What to include

The more of this you can provide, the faster it gets fixed:

- What kind of issue it is (authentication bypass, injection, privilege escalation, secret
  exposure, supply-chain, etc.)
- The affected version or release tag, and the affected file(s) or endpoint(s)
- Step-by-step reproduction instructions, and a proof-of-concept if you have one
- What an attacker gains — the impact, and any preconditions (do they need a valid login?
  which role: `auditor`, `operator`, `admin`?)
- Whether you are willing to be credited in the advisory, and under what name

Write in whatever detail you like. A rough report is far better than no report.

### What to expect

This project is maintained by a very small number of people, so responses are
best-effort rather than contractual:

1. **Acknowledgement** — you get a reply in the private advisory confirming it was received.
2. **Triage** — the maintainers confirm or dispute the finding and agree a severity with you.
3. **Fix** — a patch is developed in a private fork attached to the advisory.
4. **Release** — a new tagged release ships the fix.
5. **Disclosure** — the advisory is published, a CVE is requested where appropriate, and
   you are credited unless you asked otherwise.

Please give the maintainers a reasonable opportunity to ship a fix before disclosing
publicly. Coordinated disclosure is appreciated and reporters are always credited.

## Supported versions

Only the **latest published release** receives security fixes. There are no long-term
support branches. If you are running an older tag, upgrade before reporting.

| Version | Supported |
|---|---|
| Latest release on the [Releases page](https://github.com/jstan13/azure-stig-dashboard/releases) | Yes |
| Anything older | No — please upgrade |
| `main` branch | Yes, report anything you find |

## Scope

### In scope

- The backend API (`backend/`) — authentication, the `admin`/`operator`/`auditor` RBAC
  model, the audit trail, input handling, and the connectors that talk to Azure
- The frontend SPA (`frontend/`) — MSAL configuration, XSS, token handling
- The scheduler Functions (`functions/`)
- Export logic (`backend/src/exporters/`) — including CSV/formula injection in generated
  `.ckl`, `.cklb`, CSV, and JSON artefacts, and any way to produce a checklist that
  misrepresents the true compliance state
- The infrastructure templates (`infra/`) — insecure defaults, over-broad RBAC role
  assignments, secrets exposed in outputs or app settings, public network exposure
- The release supply chain (`.github/workflows/release.yml`) — image signing, digest
  pinning, and anything that would let an attacker get unsigned or unexpected code into
  a published release
- The helper scripts in `scripts/`, particularly the Entra app registration and
  role-granting logic

### Out of scope

- Misconfiguration of **your own** Azure tenant or Entra app registration. This project
  deploys into your subscription; how you scope its permissions afterwards is yours to own.
  (If a *default* we ship is insecure, that **is** in scope — please report it.)
- Findings that require an attacker to already hold `admin` in the dashboard, or
  Owner/Contributor on the Azure subscription
- Vulnerabilities in Azure platform services themselves — report those to
  [Microsoft MSRC](https://msrc.microsoft.com/report)
- Missing hardening headers, TLS configuration opinions, or automated-scanner output with
  no demonstrated impact
- Denial of service through sheer volume of requests
- Social engineering, phishing, or physical attacks against maintainers or users
- Anything found by attacking a deployment you do not own or have written permission to test

## Safe harbour

If you make a good-faith effort to comply with this policy while researching a
vulnerability, the maintainers will not pursue or support any action against you, and will
treat your research as authorised. Good faith means: only test against deployments you own
or are explicitly permitted to test, avoid privacy violations and data destruction, do not
exfiltrate more data than is needed to prove the issue, and give us a chance to fix things
before going public.

## Verifying what you deploy

Every release ships container images pinned to immutable `@sha256` digests and signed with
Sigstore cosign (keyless, GitHub OIDC). You can verify signatures, SBOMs, and build
provenance before you deploy anything — see
[docs/verifying-releases.md](docs/verifying-releases.md).

If a signature does **not** verify, treat it as a security incident and report it through
the private advisory link above.

## Handling secrets in reports

Please redact real values before sending. Never include live client secrets, database
passwords, access tokens, or real STIG findings from a production system. Placeholders and
screenshots with sensitive regions blanked are fine, and are enough to reproduce nearly
every class of issue.

If you believe a secret has been committed to this repository, report it privately and do
not include the secret itself in the report — just the file path and commit.
