# S.L.I.D.E. — Monitoring Dashboard UI Redesign

**Document type:** UI/UX design and implementation specification
**Scope:** Monitoring dashboard, Alerts popup, and transient alert/notification toasts
**Reference:** Approved dashboard mockups, including the latest Alerts modal concept
**Goal:** Make S.L.I.D.E. a simple, readable, sensor-first landslide monitoring interface.

> **Implementation boundary:** This document specifies a visual and interaction redesign. Preserve all working sensor acquisition, risk calculation, storage, alert generation, and SMS-delivery functionality. Do not replace real data with hardcoded values.

## 1. Core design principles

- **Sensor data first.** The four main sensor cards must be immediately visible and easy to scan.
- **Minimal navigation.** Remove duplicate routes and widgets that do not help a user monitor conditions.
- **Alerts on demand.** Do not display an Alerts panel inside the dashboard. Clicking **Alerts** in the sidebar opens a modal over the dashboard.
- **Timely notifications.** New alert events may surface as compact toasts without interrupting monitoring. Toasts supplement the Alerts popup; they do not replace the complete alert history.
- **Clear status.** Use readable text, icons, and restrained color to communicate warning levels; never rely on color alone.
- **Real data and honest timestamps.** Show live readings only when available, along with the actual last-successful-update time and connectivity state.
- **Responsive design.** Usable on laptop screens and mobile phones.

## 2. Page layout

```text
┌──────────────────────┬─────────────────────────────────────────────────────┐
│  S.L.I.D.E.          │  Station location              Last updated         │
│  Field Monitor       │  Monitoring Dashboard                               │
│                      │  Real-time slope and environmental conditions       │
│  ▣ Overview          │                                                     │
│  ♧ Alerts  (2)       │  [Soil moisture]  [Ground tilt]  [Rain intensity]    │
│  ◷ History           │  [Temperature + humidity] (cards wrap responsively)│
│  ⌖ Monitoring Sites  │                                                     │
│                      │  ┌─────────────────────────────────────────────┐    │
│                      │  │ Conditions over time       [24H][7D][30D] │    │
│                      │  │                                             │    │
│                      │  │         Sensor history chart                │    │
│                      │  │                                             │    │
│  ⚙ System Settings   │  └─────────────────────────────────────────────┘    │
└──────────────────────┴─────────────────────────────────────────────────────┘
```

On desktop, display **four equal-width sensor cards in one row** when space permits. On tablet, use a two-column grid. On phone, use one or two columns depending on legibility.

### Sidebar

Keep only:

1. **Overview** — monitoring dashboard (default view).
2. **Alerts** — opens an overlay popup; show an accurate unread/active alert count if available.
3. **History** — existing historical readings/events view.
4. **Monitoring Sites** — existing site selection or site overview.
5. **System Settings** — at the bottom of the sidebar.

**Remove the Sensors navigation button entirely.** Sensor readings are already the primary content of the Overview page; a redundant menu item increases navigation effort. Preserve any separate technical sensor configuration functionality under System Settings *if it already exists*.

### Header

- Small station/location label (e.g., `Iligan City · Brgy. Dalipuga · Station 04`).
- Heading: **Monitoring Dashboard**.
- Optional subtle description: `Real-time slope conditions and environmental data`.
- Actual **Last updated** time. Add a compact connection indicator (`Live`, `Delayed`, or `Offline`) if supported by the data pipeline.
- Remove unnecessary duplicate toolbars, status banners, and action buttons from the main header unless they perform a critical, authorized operation.

## 3. Sensor cards — primary dashboard focus

Keep the cards visually consistent: compact icon, label, **large reading with unit**, small status chip, and one lightweight trend/progress indicator where historical samples exist.

| Card | Primary value | Secondary information | Visual treatment |
|---|---|---|---|
| **Soil Moisture** | Moisture `%` | Configured watch threshold; recent change if available | Amber progress bar with threshold marker |
| **Ground Tilt** | Angle `°` | Calibrated baseline; change over defined period | Green trend sparkline |
| **Rain Intensity** | Rainfall `mm/h` | Accumulated rainfall for a stated time window | Blue trend sparkline |
| **Temperature** | Temperature `°C` | Relative humidity `%`; sensor connection health if available | Subtle red trend sparkline; humidity inside the same card |

**Do not create a separate Humidity card** unless the data becomes operationally important enough to justify more screen space.

Example values in the design references (`78%`, `1.8°`, `4.2 mm/h`, `27.4°C`, `84%`) are **illustrative only**, not verified live data.

### Card states

- **Normal/Stable:** Calm green or neutral status styling.
- **Watch:** Amber, clearly named warning level.
- **Elevated/Critical:** Stronger warning treatment only when supported by the actual configured decision rules.
- **No data/Offline:** Display an explicit unavailable state (`—` and `No recent reading`) rather than an invented value or misleading `Normal` label.

Status badges and threshold markers must come from the project's actual monitoring logic and calibrated thresholds. Do **not** embed the reference image's 70% soil-moisture threshold as a universal landslide safety limit.

## 4. Conditions over time

Use **one full-width chart card** directly beneath the sensor cards. Do not place an alert panel beside it.

- Title: **Conditions over time**.
- Period selector: `24H`, `7D`, `30D`.
- Default period: `24H`.
- Display actual timestamped sensor history, including gaps in data.
- Keep gridlines light and labels concise; add accessible tooltips on hover/focus.
- Use consistent series colors: soil moisture = dark green; rainfall = blue; tilt = amber.
- **Important:** Moisture (%), rain intensity (mm/h), and ground tilt (°) have incompatible units and ranges. Do not deceptively plot them against one unlabelled shared numerical axis. Prefer selecting one metric at a time, using clearly identified independent axes, or normalized traces with an explicit explanation. A single-metric selector is the cleanest initial implementation.
- Show an empty state when history has not yet been recorded.

## 5. Alerts popup — clicking the sidebar Alerts button

### Trigger and overlay behavior

When the user clicks **Alerts**:

1. Keep the Overview dashboard mounted underneath.
2. Dim the main page with a translucent backdrop.
3. Open a **centered white modal** over the dashboard.
4. Visually highlight the **Alerts** sidebar item while the popup is open.
5. Do not navigate to a new page just to display recent alerts.
6. Do not embed an Alerts panel inside Overview.

### Popup structure

```text
             ┌─────────────────────────────────────────────┐
             │ Alerts                                  [×] │
             │ Recent system notifications                 │
             ├─────────────────────────────────────────────┤
             │ ⚠  10:18 AM                                │
             │    Moisture threshold crossed               │
             │    Reading exceeds configured watch level.  │
             ├─────────────────────────────────────────────┤
             │ ☁  6:42 AM                                 │
             │    Heavy rainfall recorded                  │
             │    Rainfall warning event details.          │
             ├─────────────────────────────────────────────┤
             │ ✓  Yesterday                                │
             │    Daily system check passed                │
             │    Monitoring health event details.         │
             ├─────────────────────────────────────────────┤
             │                                    [Close]  │
             └─────────────────────────────────────────────┘
```

### Modal content

- **Title:** `Alerts`
- **Subtitle:** `Recent system notifications`
- **Close control:** `×` in the top-right.
- **List:** newest relevant alert first, with a simple severity icon, actual timestamp, concise alert title, and one short description.
- **Separators:** thin and muted, no heavy colored containers for each alert.
- **Bottom action:** `Close`. A `View all alerts` action is **optional** only if a meaningful complete alerts view already exists; avoid redundant controls.
- **No alerts state:** `No recent alerts` (not an empty white dialog).
- **Loading/error states:** show these explicitly; never fabricate success or notifications.

**Important distinction:** A UI alert appearing in this popup does not, by itself, establish that an SMS was sent. Only show delivery status such as `SMS sent` if it is backed by a real modem/delivery result. The existing SMS-only remote-warning workflow remains unchanged.

### Interaction rules

- Open with a click/tap on **Alerts**.
- Close with the **×** button, the **Close** button, or the `Escape` key.
- Optionally allow clicking outside to dismiss, provided it does not interfere with accessibility.
- Move keyboard focus into the modal when opened; trap focus inside while open; return focus to the Alerts button when closed.
- Give the modal appropriate accessible semantics (`role="dialog"`, `aria-modal="true"`, accessible title).
- Preserve background chart state and selected time window after closing.
- On small screens, use a near-full-width dialog with a scrollable alert list and reachable close control.

## 6. Alert and notification toasts

### Purpose

Use a toast only for a newly received event or the result of a direct user action. Examples include:

- A configured soil-moisture watch threshold was crossed.
- Heavy rainfall was recorded.
- Ground movement entered an elevated state.
- A connection was lost or restored.
- Settings were saved or a manual refresh failed.

Do not show a toast every time the dashboard polls or receives an unchanged reading. Do not use toasts for information that must remain visible until acknowledged; persistent critical conditions must also appear in the dashboard state and Alerts popup.

### Visual structure

```text
                                      ┌──────────────────────────────┐
                                      │ ⚠  Moisture watch level     │
                                      │    Reading crossed the       │
                                      │    configured threshold.     │
                                      │    10:18 AM   [View alerts] ×│
                                      └──────────────────────────────┘
```

Each toast contains:

- A compact severity icon.
- A short, specific title.
- One concise line of supporting detail when needed.
- The event time in the station's configured timezone.
- An optional **View alerts** action that opens the Alerts modal.
- A clearly labelled dismiss control.

Use the existing white card language with a restrained status indicator. Avoid full-surface saturated colors, oversized icons, glass effects, and large shadows.

### Variants

| Variant | Use | Treatment |
|---|---|---|
| **Info** | Synchronization or neutral system information | Blue icon/accent and explicit `Information` context where needed |
| **Success** | Connection restored or a user action completed | Green icon/accent with concise confirmation |
| **Watch** | Threshold or rainfall watch event | Amber warning icon/accent and named `Watch` state |
| **Critical** | High-severity condition backed by monitoring rules | Red icon/accent, explicit `Critical` label, and persistent representation elsewhere |
| **Error** | Refresh, storage, or communication failure | Red error icon/accent with a useful recovery message |

Color must never be the only severity cue. Pair it with an icon and plain-language status text.

### Placement and stacking

- Desktop/laptop: place the toast region at the top-right of the main content, below the header, without covering the last-updated indicator.
- Tablet: use the top-right with a maximum width that leaves dashboard context visible.
- Phone: use a near-full-width toast below the top header and safe-area inset. Do not cover browser controls, the navigation trigger, or the most recent primary sensor reading.
- Show no more than **three** simultaneous toasts. Add new toasts at the top and remove the oldest non-critical toast when the stack is full.
- Use consistent 8–12px spacing between stacked notices.

### Timing and lifecycle

- Info and success: dismiss automatically after approximately **4 seconds**.
- Watch: dismiss automatically after approximately **7 seconds**, unless the user is interacting with it.
- Critical and error: remain until dismissed or the underlying condition is explicitly resolved; do not rely on a short timeout.
- Pause the timeout while the toast has keyboard focus or the pointer is over it.
- Preserve events in the Alerts popup/history after their toast disappears.
- Deduplicate repeated events using an event identifier or a stable combination of type, station, and active incident. Update the existing toast instead of producing a flood of duplicates.

### Interaction rules

- **View alerts** opens the Alerts modal and focuses the matching event when possible.
- The dismiss control removes only the toast; it does not acknowledge, resolve, or delete the underlying alert.
- A toast generated from a user action may offer a relevant retry action, but destructive actions must not execute from an auto-dismissing toast.
- Closing a toast must not change dashboard filters, the selected chart period, or alert state.

### Accessibility

- Render all toasts inside a dedicated, consistently positioned toast region.
- Use `role="status"` or an `aria-live="polite"` region for info/success messages.
- Use `role="alert"` or `aria-live="assertive"` only for genuinely urgent watch/critical/error events; avoid repeatedly interrupting screen-reader users.
- Ensure every dismiss button has an accessible name such as `Dismiss moisture alert`.
- Keep actions reachable by keyboard and preserve a logical focus order.
- Do not automatically move keyboard focus into a toast.
- Respect `prefers-reduced-motion`; use a simple fade or no transition instead of sliding motion.

### Data integrity and safety

- Toast content must be derived from real alert/event data, not directly from an unvalidated raw reading in the presentation layer.
- Use the same severity, timestamp, station, and message source as the Alerts popup to prevent conflicting information.
- A displayed UI toast does **not** prove that an SMS was sent. Show SMS delivery status only when backed by a modem or delivery result.
- If the client reconnects after being offline, do not replay every historical event as a new toast. Show a concise synchronization result and place recovered events in the Alerts popup/history.

### Suggested component contract

Adapt this shape to the project's existing language and framework instead of introducing a new library solely for toasts:

```ts
type ToastNotification = {
  id: string;
  eventId?: string;
  variant: 'info' | 'success' | 'watch' | 'critical' | 'error';
  title: string;
  message?: string;
  occurredAt: string;
  stationId?: string;
  persistent?: boolean;
  action?: {
    label: string;
    alertId?: string;
  };
};
```

The toast provider/manager should expose a small API to add, update, deduplicate, and dismiss notifications. Keep alert acknowledgement and SMS delivery logic outside the toast component.

## 7. Visual direction

| UI element | Preferred direction |
|---|---|
| Sidebar | Deep forest green with subtle S.L.I.D.E. branding |
| Main background | Off-white / very pale gray-green |
| Sensor/chart cards | White surfaces, gentle shadow, rounded corners |
| Typography | Modern sans serif, high contrast, clear hierarchy |
| Accent colors | Green (normal), amber (watch), blue (rain/info), red (high severity only) |
| Charts | Thin lines, restrained grid, no visual noise |
| Popup | White dialog, light separators, dimmed backdrop |
| Toasts | Compact white notices, restrained severity accent, clear dismiss/action controls |
| Spacing | Consistent padding and gaps; prioritize legibility over decoration |

Keep decorative landscape motifs subtle. Avoid excessive gradients, many different badge styles, and unnecessarily large icons.

## 8. Implementation constraints

1. **UI/UX changes only:** Do not break or rewrite sensor polling, event processing, backend routes, firmware integration, thresholds, historical storage, or SMS dispatch.
2. Reuse the existing framework, design system, components, routes, and APIs where possible.
3. Render real sensor values and alerts from the existing data source. Demo/sample data must be clearly marked as demo.
4. Handle connectivity dropouts and stale readings explicitly.
5. Use an accurate timezone for displayed event times (the relevant station-local time, for example Philippine time), consistently across dashboard and modal.
6. Ensure chart data has matching units and properly labeled axes.
7. Verify desktop and mobile layouts, modal keyboard usability, and contrast.
8. Remove the standalone Sensors navigation item without deleting data access that other views rely on.
9. Subscribe the toast system to the existing alert/event source. Do not duplicate threshold evaluation inside UI components.
10. Clean up alert subscriptions and timers when components unmount or reconnect.

## 9. Acceptance checklist

- [ ] `Sensors` button no longer appears in the left sidebar.
- [ ] Four primary sensor cards appear on Overview.
- [ ] Temperature card contains humidity.
- [ ] Sensor values, statuses, trends, and thresholds use real project data/configuration.
- [ ] Full-width historical chart replaces the dashboard's recent-alerts panel.
- [ ] Chart range selector works (`24H`, `7D`, `30D`).
- [ ] Different chart units are represented correctly and clearly.
- [ ] Clicking **Alerts** opens a modal over the dashboard.
- [ ] Alert modal displays real events, with accurate times and severity.
- [ ] Alert dialog closes with `×`, `Close`, and `Escape`.
- [ ] Closing the alert modal preserves the dashboard state.
- [ ] No fake `SMS sent` claims appear in the UI.
- [ ] Offline, empty, and loading states are understandable.
- [ ] Responsive and keyboard-accessible behavior works.
- [ ] New real alert events can produce severity-appropriate toasts.
- [ ] Toasts are deduplicated and limited to three visible notices.
- [ ] Info/success/watch timeouts follow the specification; persistent critical/error notices do not disappear prematurely.
- [ ] Toast dismissal does not acknowledge or delete the source alert.
- [ ] `View alerts` opens the Alerts modal and preserves dashboard state.
- [ ] Toast announcements and controls are usable with keyboard and assistive technology.
- [ ] Reconnection does not flood the screen with historical toasts.
- [ ] All existing working monitoring and SMS behavior remains unchanged.

## 10. Suggested instruction for a coding assistant

> Inspect the existing S.L.I.D.E. frontend and identify its pages, components, data bindings, styles, alert handling, and event-subscription lifecycle before making changes. Implement the UI redesign described in this Markdown specification. Remove the Sensors sidebar navigation item, prioritize four real-data sensor cards and one full-width historical chart, and make the sidebar Alerts item open an accessible popup modal over the Overview dashboard. Add a reusable, accessible toast system driven by the same real alert/event source; deduplicate repeated events, cap the visible stack at three, and make `View alerts` open the modal. Do not add an alerts panel inside Overview or evaluate safety thresholds inside presentation components. Preserve existing backend functionality, alert rules, station configuration, historical data, and SMS delivery. Reuse the project's current stack. Do not replace working logic with mock data. Report the files changed, behavior tested, and any remaining risks.

---

**Design intent:** A monitoring operator should open S.L.I.D.E., immediately see current sensor conditions, inspect trends if needed, and open Alerts only when they want details.
