# Unifying BERintake and BER_APP data

**Status:** design + cloud-side implementation in progress
**Last updated:** 2026-07-01

## Problem

Two systems each own a database, and we want every BER assessment to correspond
to exactly one intake record ("every BER taken belongs to one line in the
BERintake database").

| | **BERintake** | **BER_APP** |
|---|---|---|
| Runtime | AWS serverless (cloud, always online) | Native Rust desktop **+ Android tablet, offline-first** |
| Store | **DynamoDB** `JobsTable` — PK `jobId` (UUID), GSIs `token-index`, `status-index` | **Local SQLite** `bers.db`, table `ber(id, name, date_assessed, data_json)` |
| Role | Intake / CRM funnel: client → quote → book → pay → sign | Field survey tool: geometry, storeys, DEAP model |
| Networking | HTTP API + Lambdas | None today — works with zero connectivity |

## Decision: do NOT merge into one physical database

They live in different runtime worlds. DynamoDB is a cloud service; BER_APP runs
on a tablet inside a house that may have no signal. Forcing either onto the
other's technology breaks a core requirement (BER_APP loses offline; BERintake
loses serverless shared state). A single physical DB is the wrong target.

Instead we **unify the identity and add a sync/handoff**:

- **`JobsTable` is the canonical registry** — the single "one line per BER".
- **The tablet's SQLite is an offline working copy** of that line.
- They share one UUID: **`ber.id == jobId`**. The 1:1 relationship then holds by
  primary key, not by convention.

```
┌─ BERintake (cloud, source of truth) ──────────────────────┐
│  DynamoDB JobsTable row  (jobId = the one canonical line)  │
│    status: … → confirmed → pulled → assessed              │
│    berSeed:  { address, eircode, lat, lng,                │  ── seed down ──┐
│               satelliteImageKey, … }                       │                 │
│    ber:      { s3Prefix, ratingResult, completedAt, … }    │  ◀─ sync up ──┐ │
│  S3 BerArtifactsBucket  bers/{jobId}/{satellite.jpg,       │               │ │
│                          data.json, photos/*}              │               │ │
└────────────────────────────────────────────────────────────┘               │ │
                                                                              │ │
┌─ BER_APP (tablet, offline-first) ─────────────────────────┐                 │ │
│  SQLite ber.id  ==  jobId   (same UUID — 1:1 by PK)        │ ◀───────────────┘ │
│  + sync queue, drains when connectivity returns           │ ──────────────────┘
└────────────────────────────────────────────────────────────┘
```

The codebases were already designed for this:
- BERintake `Job.berSeed` is commented *"what BER_APP eventually pulls and seeds
  into its local SQLite `ber` row"* — previously a stub, now populated.
- BERintake `JobStatus` already has `confirmed` ("ready for the assessor") and
  `pulled` ("synced into BER_APP on the tablet").
- BER_APP `Ber.address`, `Ber.eircode`, `Ber.site_satellite_image` are all
  documented *"POPULATED EXTERNALLY … not by this app."*

## Connectivity & durability decisions (confirmed with owner)

- **Tablet connectivity: intermittent.** Offline-first stays; a sync queue on the
  tablet drains pulls/pushes whenever a connection is available.
- **Result storage: S3 blob + DynamoDB summary.** The full `data_json` and photos
  go to S3 keyed by `jobId`; `JobsTable` keeps a pointer + summary. The cloud
  becomes the durable record of completed BERs.

## Lifecycle (JobStatus)

```
pending_review → quote_sent → quoted → booked → paid → signed → confirmed
                                                                    │
                                        (tablet pulls the seed)  →  pulled
                                        (assessment synced back) →  assessed
```

## Satellite image at intake

**Requirement:** when the client commits — i.e. submits the full booking form
(the `book` step, status → `booked`) — fetch a satellite image for its eircode,
zoomed so the frame contains the eircode point **+ 50 m in every direction**
(a 100 m box). We wait for booking (not job creation) so we only spend a
geocode + static-map call on real, committed jobs, not on every lead.

**Provider: Google** — reused. BERintake already has `GOOGLE_MAPS_API_KEY` wired
(used for eircode → service-zone geocoding in `pricing.ts`). Eircode is a
licensed dataset that free geocoders (OSM/Nominatim) cover poorly in Ireland, so
Google is the only single vendor that geocodes eircodes reliably. At intake
volume (tens–hundreds/month) this sits inside Google's free tier — effectively
€0. The fetch lives behind `src/shared/satellite.ts` so swapping to
Mapbox/Tailte-Éireann GeoHive later is a one-file change.

**Flow (best-effort, never blocks the booking):**
`book.ts` (after the slot is booked and status → `booked`) →
`seedBerFromEircode(job)` → geocode eircode (lat/lng + formatted address) →
compute zoom for a 100 m frame at that latitude → fetch Google Static Maps
`maptype=satellite` JPEG → upload to `s3://…/bers/{jobId}/satellite.jpg` →
write `berSeed`. `book.ts` is idempotent (early-returns if already booked), so
the seed is fetched once.

The seed also folds in the client's booking-form details (`seedFromDetails`),
mapping the free-form `keyDetails` onto typed fields: `yearBuilt →
constructionYear`, plus `propertyType`, `heatingSystem`, `windowYear`,
`doorYear`, `extensions[]`, `insulation{walls,roof,floor,notes}`, `mprn`,
`reason`, and the client-entered `address` (preferred over the geocoded one).
The form does not capture storeys / floor-area / bedrooms, so those stay for the
assessor. The assessor confirms/overrides everything on-site.

**Zoom math:** `metersPerPixel = 156543.03392 · cos(lat) / 2^zoom`. Pick the
largest integer zoom whose image still spans ≥ 100 m across, so the box is fully
contained with a small margin. At Ireland's latitude a 640×640 `scale=2` image
lands on zoom 20 (~114 m across, ~9 cm/px). Computed per-request, not hardcoded.

**Cost note:** because generation is triggered at booking (not at lead creation),
only committed jobs cost a geocode + static-map call — leads that never book cost
nothing. If needed the call site can move later still (e.g. to `paid`/`confirmed`)
by relocating the single `seedBerFromEircode(job)` call.

## S3 layout

```
s3://<BerArtifactsBucket>/bers/{jobId}/
    satellite.jpg      # written at intake by BERintake
    data.json          # full Ber data_json, pushed by the tablet on completion
    photos/{photoId}.jpg
```

Private bucket, SSE-S3, all public access blocked. The tablet never gets bucket
credentials — it uploads via short-lived **presigned PUT URLs** minted per job.

## Cloud API (BERintake) — surveyor endpoints

All under `/surveyor/*`, authenticated by a shared `x-surveyor-key` header
(param `SurveyorAccessKey`, same pattern as the existing partner key). Keyed by
`jobId` (the tablet's native id), not the client `token`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/surveyor/jobs?status=confirmed` | List BERs ready to assess (uses `status-index`) + their seeds |
| GET | `/surveyor/jobs/{jobId}` | One job's seed + presigned GET for its satellite image |
| POST | `/surveyor/jobs/{jobId}/ber/presign` | Mint presigned PUT URLs for `data.json` + photos; flips status → `pulled` |
| POST | `/surveyor/jobs/{jobId}/ber/complete` | Attach `{ ratingResult, summary }`; flips status → `assessed` |

## Tablet side (BER_APP)

Respecting the `check-boundaries.sh` rule (DB/`rusqlite` only inside
`src/engine/`), the network client (blocking `ureq`, matching the app's
threads-not-async model) also lives in `src/engine/` as the I/O boundary.

### Import (pull) — DONE ✅

`src/engine/sync.rs` — a `SyncWorker` modeled on `PersistenceWriter`: its own DB
connection + `ureq` client on a dedicated `ber-sync` thread. Spawned in
`bootstrap()` only when configured; pulls once on startup and on
`trigger_import()`.

- `SyncConfig::load` — reads `$BER_SYNC_URL` / `$BER_SYNC_KEY`, else
  `data_dir/sync.json` (`{ "baseUrl": "...", "apiKey": "..." }`). Unconfigured →
  worker not spawned, app fully offline. (`Paths::sync_config_file()`.)
- `import_confirmed` — `GET /surveyor/jobs?status=confirmed`, skips jobs already
  present locally (by `ber.id == jobId`), then for each new one:
  `GET /surveyor/jobs/{jobId}` → build a `Ber` with `id = jobId`, `address`,
  `eircode`, `number_of_storeys`; download the presigned satellite JPEG into the
  photos dir and set `site_satellite_image`; `BerRepository::upsert`.
- Controller surface: `attach_sync`, `sync_now()`, `sync_status()`.

**To enable on a tablet:** drop a `sync.json` next to `bers.db` with the API base
URL and the `SurveyorAccessKey`, or set the two env vars.

### Import — remaining polish

- Map the richer seed fields (propertyType, heatingSystem, extensions, window/
  door years, insulation, constructionYear) into the `Ber` model — needs the
  `ConstructionPhases` / systems sub-struct mapping. Currently ignored on import
  (they stay in the cloud record for the assessor).
- A UI affordance: a "Sync now" button + status line (wire `sync_now()` /
  `sync_status()` into `BerApp::update`, the same per-frame spot that drains
  photo jobs).

### Export (push) — TODO (next increment)

On finish → serialize `data_json`, gather photos → `POST
/surveyor/jobs/{jobId}/ber/presign` → PUT to S3 → `POST …/ber/complete`. Add a
`sync_state` table (last-pushed revision / dirty flag) in `BerRepository`, and
drive pushes off the autosave/idle path.

Nothing here removes offline capability; sync is additive.

## Build order

1. **Cloud** (this phase): S3 bucket → satellite fetch + berSeed writer →
   statuses + `ber` result field → surveyor endpoints. Testable with `curl` /
   `sam local`.
2. **Tablet**: engine sync module (import → export → queue).
3. **Config wiring**: surveyor key + API base URL on the tablet.

## Open items

- Provision `SurveyorAccessKey` (a strong shared secret) at deploy.
- Confirm Google Static Maps API is enabled on the existing key's project
  (Geocoding already is).
- Decide photo count / size ceiling per BER for presign batching.
- BER_APP: add the sync module + a `sync_op` migration (phase 2).
</content>
</invoke>
