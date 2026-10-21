# S.L.I.D.E. hosted dashboard

This repository serves the S.L.I.D.E. monitoring website and its same-origin device API. The hosted website is the only monitoring dashboard. The ESP32 provides a protected Wi-Fi and endpoint setup page only.

The application targets the team's Orange Pi Zero 3 and `https://slide.akios.site`. The Node service binds to `127.0.0.1` by default; the existing TLS reverse proxy should route the website and `/api/v1/` requests to this service. This repository does not configure or deploy that production proxy.

## Run locally

Use Node.js 22.13 or newer. Copy `.env.example` to a private `.env`, replace both placeholder secrets with independently generated values, and configure the matching device ID/token in the firmware's ignored `src/slide_local_secret.h`.

```sh
npm start
```

The service listens on `http://127.0.0.1:8080` by default and creates `data/slide.sqlite` on first start. Open the service URL and sign in with `SLIDE_DASHBOARD_PASSWORD`. Never commit `.env`, `data/`, or a firmware secret header. See [API.md](API.md) for routes, payloads, and Orange Pi integration requirements.

## Storage and delivery behavior

- SQLite stores device state, readings, events, acknowledgments, and commands. Readings older than 30 days are pruned as new telemetry arrives.
- The ESP32 sends current telemetry every five seconds and coalesces it during outages rather than building an unbounded backlog.
- Event delivery uses a separate 24-entry RAM queue from the 12-item display history. It coalesces queued revisions per event, retries with capped jittered backoff, reports retry/drop counts, drops and counts the oldest queued event on overflow, and loses queued events on reboot.
- Commands are bound to the device's current boot ID and expire after 120 seconds. Only one pending maintenance command is accepted at a time.
- Dashboard API responses and controls are not cached by the service worker. The cached PWA shell can open offline, but it does not show cached sensor values as live.

## Important limitation

The backend and API contract in this repository are the integration implementation for the workflow. They have not been installed on the Orange Pi or verified against the live domain. Preserve the existing host service and database while preparing a staging deployment; production routing and backups require the server owner to apply the documented configuration.

S.L.I.D.E. reports experimental sensor conditions; it does not predict landslides.
