# Data Model — Azure STIG Dashboard

All entities are TypeORM-managed in Postgres unless noted. Primary keys are
ULIDs (`id` column, `varchar(26)`). Timestamps are `timestamptz` UTC. Audit
columns (`createdAt`, `updatedAt`) are present on every mutable table; the
`AuditLog` table replaces row-level soft-delete tracking — entities are
either active, retired, or hard-deleted only via migrations.

## Entity Relationship Overview

```text
Tenant 1───* Collection 1───* CollectionAsset *───1 Asset
Collection 1───* RoleBinding *───1 User
Collection 1───* Exception *───* ExceptionTarget *───1 Asset
                                ExceptionTarget *───1 Rule
Asset 1───* Scan 1───* Finding *───1 Rule
Rule *───1 BenchmarkVersion *───1 Benchmark
ContentPack 1───* BenchmarkVersion
Mapping *───1 Rule
Finding 1───0..1 POAM
Every state-changing operation ───* AuditLog
```

## Entities

### Tenant
- `id` (ULID, PK)
- `entraTenantId` (uuid, unique) — the Entra tenant the app authenticates against
- `displayName` (text)
- `createdAt`, `updatedAt`

### User
- `id` (ULID, PK)
- `entraObjectId` (uuid, unique)
- `upn` (text)
- `displayName` (text)
- `lastSignInAt` (timestamptz)
- *Note*: Users are created on first successful sign-in.

### Collection
- `id` (ULID, PK)
- `tenantId` (FK → Tenant)
- `name` (text), `description` (text)
- `selectionMode` (enum: `Tag`, `Explicit`)
- `tagRule` (jsonb, nullable) — e.g., `{ "all": [{ "tag":"env", "eq":"prod" }] }`
- `createdAt`, `updatedAt`, `retiredAt` (nullable)

### Asset
- `id` (ULID, PK)
- `tenantId` (FK)
- `azureResourceId` (text, unique within tenant) — full ARM ID
- `subscriptionId`, `resourceGroup`, `region`
- `resourceType` (enum: `AzureVm`, `ArcMachine`, `Aks`, `ArcK8s`, `AppService`, `SqlDb`, `StorageAccount`, `KeyVault`, `Other`)
- `displayName`, `hostname`, `fqdn`, `primaryIp`, `primaryMac` (nullable)
- `os` (jsonb, nullable: `{ family, version, edition, kernel }`)
- `roles` (text[]) — e.g., `IIS`, `DomainController`, `WebApp`
- `techAreas` (text[]) — derived for applicability
- `tags` (jsonb)
- `lifecycle` (enum: `Active`, `Stale`, `Retired`)
- `lastSeenAt`, `retiredAt` (nullable), `createdAt`, `updatedAt`

### CollectionAsset (join)
- `collectionId` (FK), `assetId` (FK), `addedBy` (FK User), `addedAt`
- PK: (`collectionId`, `assetId`)

### Benchmark
- `id` (ULID, PK)
- `disaTitle` (text) — e.g., `Microsoft Windows Server 2022 STIG`
- `family` (text) — e.g., `OS-Windows`, `Database`, `Container`
- `applicability` (jsonb) — declarative predicate over Asset metadata

### BenchmarkVersion
- `id` (ULID, PK)
- `benchmarkId` (FK)
- `version` (text), `release` (text), `releaseDate` (date)
- `sourceUri` (text), `sha256` (char(64))
- `contentPackId` (FK ContentPack)
- `activatedAt` (nullable) — null until admin activates
- Unique: (`benchmarkId`, `version`, `release`)

### Rule
- `id` (ULID, PK)
- `benchmarkVersionId` (FK)
- `vulnNum` (text) — e.g., `V-220697`
- `ruleId` (text) — e.g., `SV-220697r569186_rule`
- `title` (text)
- `severity` (enum: `CAT_I`, `CAT_II`, `CAT_III`)
- `cciRefs` (text[])
- `nistControls` (text[])
- `checkContent` (text)
- `fixText` (text)
- `applicability` (jsonb) — predicate against Asset metadata/roles
- Unique: (`benchmarkVersionId`, `vulnNum`)

### Mapping
- `id` (ULID, PK)
- `ruleId` (FK)
- `signalSource` (enum: `MC_AuditPackage`, `Policy`, `Defender`, `ResourceGraph`, `Arm`, `Manual`)
- `selector` (jsonb) — opaque to DB; interpreted by evaluator
- `precedence` (smallint) — lower wins on conflict
- `notes` (text)

### ContentPack
- `id` (ULID, PK)
- `pulledAt` (timestamptz)
- `manifestUri` (text), `manifestSha256` (char(64))
- `verifiedBy` (text) — signing authority
- `state` (enum: `Pending`, `Active`, `Rejected`)
- `diffSummary` (jsonb) — added/changed/removed Rule counts per Benchmark

### Scan
- `id` (ULID, PK)
- `assetId` (FK)
- `benchmarkVersionId` (FK)
- `triggeredBy` (FK User, nullable for scheduled)
- `trigger` (enum: `Manual`, `Scheduled`, `ContentRefresh`, `Import`)
- `state` (enum: `Queued`, `Evaluating`, `Evaluated`, `Failed`, `PartiallyEvaluated`)
- `startedAt`, `completedAt`, `evaluator` (text)
- `failureReason` (text, nullable)
- `correlationId` (uuid)

### Finding
- `id` (ULID, PK)
- `scanId` (FK), `assetId` (FK), `ruleId` (FK)
- `benchmarkVersionId` (FK) — denormalized for query performance
- `status` (enum: `Open`, `NotAFinding`, `Not_Applicable`, `Not_Reviewed`)
- `severityOverride` (enum CAT_*, nullable)
- `findingDetails` (text)
- `comments` (text)
- `evidence` (jsonb) — raw signal payload + selector trace
- `mappingChain` (jsonb) — `{ source, vulnNum, ruleId, cciRefs, nistControls, benchmarkSha256 }`
- `producedAt` (timestamptz)
- `lastEditedBy` (FK User, nullable), `lastEditedAt` (timestamptz, nullable)
- Indexes: (`assetId`, `ruleId`, `producedAt DESC`), (`scanId`)

### Exception
- `id` (ULID, PK)
- `collectionId` (FK)
- `requestedBy` (FK User), `approvedBy` (FK User, nullable)
- `state` (enum: `Pending`, `Approved`, `Rejected`, `Expired`, `Revoked`)
- `justification` (text), `expiresAt` (timestamptz)
- `createdAt`, `decidedAt` (nullable)

### ExceptionTarget (join)
- `exceptionId` (FK), `assetId` (FK, nullable), `ruleId` (FK)
- A null `assetId` means "all assets in the collection"

### POAM
- `id` (ULID, PK)
- `findingId` (FK, unique while open)
- `assignedTo` (FK User)
- `targetDate` (date)
- `milestones` (jsonb)
- `state` (enum: `Open`, `Closed`, `Overdue`)
- `closedAt` (nullable), `closeReason` (text, nullable)

### AuditLog (append-only)
- `id` (ULID, PK)
- `actorUserId` (FK, nullable for system actors)
- `actorRole` (text)
- `action` (text) — e.g., `Finding.UpdateStatus`, `Export.Generate`
- `entityType` (text), `entityId` (text)
- `before` (jsonb, nullable), `after` (jsonb, nullable)
- `result` (enum: `Success`, `Denied`, `Error`)
- `correlationId` (uuid)
- `sourceIp` (inet)
- `occurredAt`, `recordedAt`
- *No update or delete code path. Inserts only.*
- Indexes: (`occurredAt DESC`), (`entityType`, `entityId`), (`actorUserId`, `occurredAt DESC`)

### RoleBinding
- `id` (ULID, PK)
- `userId` (FK), `collectionId` (FK)
- `role` (enum: `admin`, `operator`, `auditor`)
- `grantedBy` (FK User), `grantedAt`, `revokedAt` (nullable)
- Unique while active: (`userId`, `collectionId`, `role`) where `revokedAt IS NULL`

## State Machines

### Asset.lifecycle

```text
   discover               > 24h no-signal              soft-delete
[ Active ] ───────► [ Active ] ────────────────► [ Stale ] ─────────► [ Retired ]
                          ▲                            │
                          └────── re-discover ─────────┘
```

### Scan.state

```text
[ Queued ] ──► [ Evaluating ] ──► [ Evaluated ]
                     │     │
                     │     └──► [ PartiallyEvaluated ]  (some Rules failed)
                     └────────► [ Failed ]
```

### Exception.state

```text
[ Pending ] ──approve──► [ Approved ] ─expiresAt──► [ Expired ]
     │                          │
     ├──reject──► [ Rejected ]  └──revoke──► [ Revoked ]
```

### POAM.state

```text
[ Open ] ──evidence-clean──► [ Closed ]
   │
   └─targetDate passed──► [ Overdue ] ──evidence-clean──► [ Closed ]
```

### Finding.status (governed by evaluators and explicit user actions)

```text
producer (evaluator/import) sets initial status
user with operator/admin role can transition with audit
exceptions transition to Not_Applicable while active
content refresh does NOT mutate prior findings; produces new ones in next Scan
```

## Validation Rules (enforced in service layer)

- A Finding MUST reference a Rule belonging to a `BenchmarkVersion` whose
  `activatedAt IS NOT NULL` *at the time of Scan creation*.
- A Mapping MUST exist for any signalSource→Rule used to produce an automated
  Finding; absence yields `Not_Reviewed` with `MANUAL_REVIEW_REQUIRED`.
- Export endpoints MUST refuse to render a Finding whose `mappingChain` is
  incomplete (any of `vulnNum`, `ruleId`, `benchmarkSha256` missing).
- An Exception MUST have at least one ExceptionTarget; expiresAt MUST be in
  the future at create time.
- A RoleBinding's `revokedAt`, once set, MUST NOT be cleared (a re-grant
  creates a new RoleBinding).
- AuditLog rows MUST NOT be modified; the service layer emits only inserts.

## Indexing & Partitioning

- `Finding` partitioned monthly on `producedAt` to keep query plans bounded
  at 2M-row MVP cap.
- `AuditLog` partitioned monthly on `occurredAt`; old partitions detached and
  archived to Blob after 7 years.
- BTree indexes on FK columns; GIN on `Asset.tags`, `Rule.cciRefs`,
  `Rule.nistControls` for fast filtering.
