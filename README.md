# S.L.I.D.E. dashboard

The primary dashboard and device API are deployed on Vercel at `https://slide.akios.site`. Dashboard source files live at the repository root; `npm run build` copies only the public app files into `dist/`, which Vercel serves alongside `/api/v1/*` Node.js Functions backed by Neon Postgres. [vercel.json](vercel.json) defines the build and output settings so the Vercel UI build settings do not need manual changes.

The Orange Pi Node service in `server/app.mjs` remains available as a manual backup. It uses a separate SQLite database and does not automatically receive Vercel's telemetry, alerts, or commands. Existing SQLite data is left untouched; importing or synchronizing it to Postgres must be handled separately.

## Vercel setup

1. Import `Ced-i3/slidedashboard1` as a Vercel project with the repository root selected as its Root Directory. `vercel.json` runs `npm run build` and selects the generated `dist` directory, so no framework, build-command, or output-directory UI edits are required. The Root Directory must already be the repository root; Vercel controls that setting separately.
2. Install a Postgres storage integration from the Vercel Marketplace, such as Neon, and connect it to the project. The Vercel Function requires the integration's pooled Postgres URL in `DATABASE_URL`.
3. Add these server-only environment variables to the Vercel project for Production and any environment where the ESP32 will connect:
   - `SLIDE_DEVICE_ID`: the configured device identifier.
   - `SLIDE_DEVICE_TOKEN`: a random token of at least 32 bytes, matching the firmware's private local secret header.
   - `SLIDE_DASHBOARD_PASSWORD`: a unique password of at least 20 bytes.
4. Redeploy after connecting the database and setting the variables. The build produces `dist/index.html`; a missing API configuration returns `503 api_not_configured` until those settings exist.
5. Attach `slide.akios.site` to the production deployment and make the deployment public if the dashboard is intended for public access. The API still requires dashboard or device authentication.

Do not commit database URLs, dashboard passwords, device tokens, or firmware secret headers. Keep the Neon connection string in Vercel's encrypted environment-variable settings.

## Local Orange Pi backup service

Use Node.js 22.13 or newer. Copy `.env.example` to a private `.env`, replace the placeholders, and configure the matching device ID/token in the firmware's ignored `src/slide_local_secret.h`.

```sh
npm start
```

The service listens on `http://127.0.0.1:8080` by default and creates `data/slide.sqlite` on first start. Set `SLIDE_DATA_DIR` to a persistent path before using it as a backup. Never commit `.env`, `data/`, or a firmware secret header. API routes and payloads are described in [API.md](API.md).

This backup service is independent from the Vercel database. Switching the public domain or the firmware API endpoint to the Orange Pi does not restore Vercel's stored data unless a separate database backup or synchronization process is configured.

## Data and device behavior

- The Vercel API stores device state, readings, alerts, acknowledgments, commands, and dashboard sessions in Postgres. It prunes readings older than 30 days as new telemetry arrives.
- The Orange Pi backup stores the same API contract in SQLite when run independently.
- The ESP32 sends current telemetry every five seconds and coalesces it during outages rather than building an unbounded backlog.
- Event delivery uses a separate 24-entry RAM queue from the 12-item display history. It coalesces queued revisions per event, retries with capped jittered backoff, reports retry/drop counts, drops and counts the oldest queued event on overflow, and loses queued events on reboot.
- Commands are bound to the device's current boot ID and expire after 120 seconds. Only one pending maintenance command is accepted at a time.
- Dashboard API responses and controls are not cached by the service worker. The PWA shell can open offline, but it does not show cached sensor values as live.

## Verification

```sh
npm run check
npm test
```

The tests exercise the local Orange Pi SQLite API. A real Vercel API check requires a connected Neon database and the Vercel environment variables above. Device hardware, Vercel deployment, Orange Pi failover, and data synchronization have not been verified by these local checks.

S.L.I.D.E. reports experimental sensor conditions; it does not predict landslides.
