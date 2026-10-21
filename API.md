# S.L.I.D.E. API contract

Base URL: `https://slide.akios.site/api/v1`. The firmware setup form currently accepts this host and base path only. TLS certificate and hostname validation remain enabled in the ESP32 HTTP client. Vercel serves the dashboard and Node.js API Function; the primary API persists data in Postgres through the Vercel Marketplace integration.

Device requests send `Authorization: Bearer <SLIDE_DEVICE_TOKEN>` and `X-SLIDE-Device: <SLIDE_DEVICE_ID>`. Dashboard routes are public: anyone can read station data, acknowledge alerts, view command history, and queue maintenance commands. Device ingestion and command polling still require the private device token. Responses use `Cache-Control: no-store`.

## Device routes

| Method and path | Purpose |
|---|---|
| `POST /device/verify` | Verify device identity and credentials before the firmware saves a new Wi-Fi configuration or closes setup mode. |
| `POST /device/telemetry` | Store the latest sensor, health, calibration, settings, and GPS snapshot. The firmware posts about every five seconds. |
| `POST /device/alerts` | Insert or revise one experimental event using its boot-scoped ID and monotonic revision. |
| `GET /device/commands?boot_id=<id>` | Return unexpired maintenance commands targeted to the active boot. |
| `POST /device/commands/result` | Complete a delivered command as `succeeded` or `failed`. |

Every JSON object uses `schema_version: 1` and the configured `device_id`. A `boot_id` is a random 24-character hexadecimal value generated at firmware startup. Telemetry carries an increasing sequence number, device uptime, and a UTC observation time when SNTP is available. GPS can be `FRESH`, `LAST_KNOWN`, or `UNAVAILABLE`; unavailable coordinates are JSON `null`.

Telemetry contains:

- `readings`: raw soil/rain ADC values, calibrated relative wetness percentages, temperature/humidity, acceleration/gyro vectors, pitch/roll, and relative tilt. Missing sensor data is `null`.
- `health`: `mpu`, `soil`, `rain`, and `dht11` states (`ONLINE`, `OFFLINE`, `ERROR`, `INITIALIZING`), plus baseline and TEST MODE booleans.
- `gps`: fix state, coordinates, satellite count, and fix age.
- `calibration`: baseline status/reason, gyro bias, and per-sensor dry/wet calibration.
- `settings`: current tilt thresholds/durations and ADC thresholds/durations/enabled flags.
- `delivery`: bounded event-queue depth (maximum 24), discarded-event count, event retry count, and last accepted-upload uptime. Queue loss is reported, and queued events are RAM-only across reboot.

Alert envelopes include `event_id`, `revision`, observation uptime, and `occurred_at`; `event` carries actual firmware severity, sensor, measured/threshold values, duration, resolved/simulated state, and event-time GPS. Queued revisions for one event coalesce to the newest state until delivery. Repeated delivery of the same ID/revision is idempotent. Older revisions receive `409`.

Device authentication or validation failures receive `401` or `400`; oversized JSON receives `413`. The API accepts telemetry duplicates idempotently and rejects out-of-order sequence numbers for the same boot.

## Dashboard routes

Public dashboard routes are `GET /dashboard`, `GET /readings?range=24h|7d|30d`, `GET /readings.csv`, `GET /alerts`, `POST /alerts/ack`, and `GET|POST /commands`. There is no dashboard password or session route.

Maintenance command kinds are `calibrate_mpu`, `set_test_mode`, `record_adc_endpoint`, `set_tilt_thresholds`, and `set_adc_settings`. Commands target the latest boot, expire after 120 seconds, and are accepted sequentially. Acknowledgment is server-side and does not change the firmware's active/resolved event state.

The website now evaluates browser alerts from `GET /dashboard` using raw pitch/roll and soil/rain ADC values. Fresh telemetry and ONLINE sensor health are required; `baseline_calibrated` and `test_mode` are not prerequisites. Browser thresholds are stored per station/browser and saving them queues no maintenance command. Browser events and their acknowledgments last for the page session; existing firmware `/alerts` and `/commands` API behavior is preserved.

## Vercel primary deployment

1. Import `Ced-i3/slidedashboard1` with the repository root as the Root Directory. The dashboard source is at the repository root; `vercel.json` runs its build script to create `dist`, while `api/v1/[...path].mjs` handles API routes. Build and output settings come from the repository, but Root Directory remains a Vercel project setting.
2. Connect a Postgres storage integration from the Vercel Marketplace, such as Neon. Set its pooled connection string as `DATABASE_URL` in the Vercel project.
3. Set `SLIDE_DEVICE_ID` and `SLIDE_DEVICE_TOKEN` as server-only Vercel environment variables. The device token must match the private firmware configuration; never expose it in frontend code. No dashboard password is needed.
4. Attach `slide.akios.site` to the production deployment and redeploy. On its first successful API request, the function creates the required tables if they do not exist. It returns `503 api_not_configured` when required database or credential settings are absent.

The API uses persistent Postgres tables for device state, readings, alerts, and commands. This is required because Vercel Function filesystems are not durable application storage. Dashboard data and controls are public, including GPS coordinates and the ability to change device settings.

## Orange Pi backup service

The `server/app.mjs` service remains an independently runnable SQLite implementation for manual recovery. Run it with Node.js 22.13 or later, provide a private environment file from `.env.example`, and place `SLIDE_DATA_DIR` on persistent storage. Keep its SQLite database backed up separately.

The Orange Pi SQLite database is not automatically synchronized with the Vercel Postgres database. Existing SQLite records are not migrated by this source change. A recovery cutover that needs the latest Vercel records requires a separate export/restore or replication procedure before changing DNS or the firmware endpoint.

The API defines a 15-second stale-data threshold, a 60-second device-offline threshold, and 30-day reading retention. These are starting operational values. Device time synchronization, Vercel/Neon configuration, Orange Pi recovery, and end-to-end device behavior still require deployment and field verification.
