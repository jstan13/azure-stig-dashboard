# Verifying a STIG Dashboard release

Every tagged release of this project (`vX.Y.Z`) publishes signed container
images to **GitHub Container Registry** and attaches a pre-built
`azuredeploy.json` to the GitHub Release.

Before you click **Deploy to Azure** in production, you can independently
verify three things:

1. **The image was built by this repository's GitHub Actions** — not by a
   third party with stolen credentials. (Sigstore / cosign keyless signing.)
2. **The ARM template references the exact image digest from the release** —
   not a mutable tag that could be silently swapped.
3. **You can audit what's inside the image** — full SBOM (Software Bill of
   Materials, SPDX format) is attached as an attestation.

You only need a browser (Azure Cloud Shell at <https://shell.azure.com>) — no
local installs.

---

## 1. Verify image signatures with cosign

Cosign is pre-installed in Cloud Shell. Replace `<digest>` with the value
shown in the release notes.

```bash
# Backend image
cosign verify \
  --certificate-identity-regexp 'https://github\.com/jstan13/azure-stig-dashboard/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/jstan13/stig-backend@sha256:<digest>

# Frontend image
cosign verify \
  --certificate-identity-regexp 'https://github\.com/jstan13/azure-stig-dashboard/.+' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/jstan13/stig-frontend@sha256:<digest>
```

A successful verification prints the certificate's `Subject` (the workflow
file that built the image) and `Issuer`
(`https://token.actions.githubusercontent.com`). If the image was tampered
with after release, the digest will not match and cosign will fail loudly.

## 2. Confirm the ARM template uses the same digest

Open the `azuredeploy.json` attached to the GitHub Release and search for
`backendImage` and `frontendImage` in the `parameters` block. Their
`defaultValue` must equal the digest you just verified.

If you want to use your own mirror (e.g. an internal Azure Container
Registry), download the image, push to your registry, and override the
`backendImage` / `frontendImage` parameters in the deployment wizard.

## 3. Inspect the SBOM

The SBOM is attached as a cosign attestation in SPDX JSON format.

```bash
# Pulls the SBOM attached to the image
cosign download attestation \
  ghcr.io/jstan13/stig-backend@sha256:<digest> \
  | jq -r '.payload' | base64 -d \
  | jq '.predicate' > backend-sbom.spdx.json

# Quick view of every package the image ships with
jq '.packages[] | "\(.name)@\(.versionInfo)"' backend-sbom.spdx.json
```

## 4. Reproduce the build

The image's build provenance attestation (also cosign-attached) tells you the
exact Git commit, workflow run ID, and builder image. If you want to
reproduce the build yourself:

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/jstan13/azure-stig-dashboard.git
cd azure-stig-dashboard
docker build -f backend/Dockerfile -t my-stig-backend .
docker build -f frontend/Dockerfile -t my-stig-frontend .
```

The digest of your local build should match the release digest when built on
the same platform (linux/amd64) with the same Docker version. Small
differences in timestamps may produce different digests; the SBOM is the
authoritative source of "what's inside."

---

## Why digest pinning matters

Container tags (`:latest`, `:v1.0.0`) are mutable — whoever owns the
registry namespace can push a new image under the same tag at any time.
**SHA-256 digests are content-addressed**: changing one byte changes the
digest. This template pins images by digest so a compromised maintainer
account or registry cannot push code into your deployment without you
explicitly upgrading.

## Reporting a vulnerability

If you discover a problem with a published release, please file an issue at
<https://github.com/jstan13/azure-stig-dashboard/issues> and do **not**
deploy that release.
