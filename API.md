# S.L.I.D.E. API contract

Base URL: `https://slide.akios.site/api/v1`. The firmware setup form currently accepts this host and base path only. TLS certificate and hostname validation remain enabled in the ESP32 HTTP client.

Device requests send `Authorization: Bearer <SLIDE_DEVICE_TOKEN>` and `X-SLIDE-Device: <SLIDE_DEVICE_ID>`. Dashboard sign-in uses the operator password over HTTPS and receives a short-lived bearer session token. All user API routes require that token. Responses use `Cache-Control: no-store`.

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

`POST /session` accepts `{ "password": "…" }`. Authenticated routes are `GET /session`, `DELETE /session`, `GET /dashboard`, `GET /readings?range=24h|7d|30d`, `GET /readings.csv`, `GET /alerts`, `POST /alerts/ack`, and `GET|POST /commands`.

Maintenance command kinds are `calibrate_mpu`, `set_test_mode`, `record_adc_endpoint`, `set_tilt_thresholds`, and `set_adc_settings`. Commands target the latest boot, expire after 120 seconds, and are accepted sequentially. Acknowledgment is server-side and does not change the firmware's active/resolved event state.

## Orange Pi integration

1. Install Node.js 22.13 or later and place this service alongside the existing website runtime after reviewing that host's current service and database.
2. Put the site behind the existing HTTPS reverse proxy and forward `/` and `/api/v1/` to the same Node process. Keep Node bound to loopback unless the host's service design requires another private interface.
3. Create a private environment file from `.env.example`. Use a unique dashboard password and a cryptographically random device token of at least 32 bytes. Set the firmware's local ignored `slide_local_secret.h` to the matching device ID/token and a unique 8–16 character setup password.
4. Keep `SLIDE_DATA_DIR` on persistent storage. Back up the SQLite database and verify restore before connecting field hardware.
5. Confirm the public domain, TLS certificate chain, proxy routing, startup/restart policy, firewall, and backup schedule on the Orange Pi. No production service or proxy configuration is included in this source change.

The source defines a 15-second stale-data threshold, a 60-second device-offline threshold, and 30-day reading retention. These are starting operational values. Device time synchronization, HTTPS reachability, Orange Pi deployment, and end-to-end behavior still require field verification.
