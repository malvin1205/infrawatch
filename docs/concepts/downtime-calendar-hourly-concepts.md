# InfraWatch — Hourly Incident Inspector & Downtime Calendar (5 Detailed Concepts)

**Status:** Ready for Review & Implementation Selection  
**Interactive Prototype:** [`docs/concepts/downtime-calendar-hourly-concepts.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/docs/concepts/downtime-calendar-hourly-concepts.html)  
**Design Standard:** UI/UX Pro Max (`Inter` + `JetBrains Mono`, WCAG 4.5:1 Contrast, Dense Observability Standards)

---

## 1. Problem Definition & Operational Friction

When analyzing the existing Availability Modal's Downtime Calendar (e.g. for `Mon, Sep 14`), an infrastructure engineer encounters two primary points of friction:

1. **Chronic Noise vs. Active Incidents:**
   - Out of 16 hosts marked as down, **15 hosts are down 24/7 (`00:00 – 24:00`)** because they are decommissioned, unprovisioned, or undergoing prolonged hardware replacement.
   - Only **1 host (`192.168.9.102`)** experienced an actual transient incident today (`14:15 – 15:45 UTC`).
   - In the incumbent UI, all 16 hosts are dumped into a flat alphabetical table. The operator has to read 16 rows to find the single incident that occurred during their shift.
2. **Missing Time-of-Day Granularity ("Apa aja yang down di jam tertentu"):**
   - The user cannot instantly filter by hour (e.g., *"What broke during the 14:00 deployment window?"*).
   - There is no indication of whether outages were simultaneous cascade failures (e.g. switch flap) or isolated node dropouts.

---

## 2. The 5 Detailed Operational Concepts

Below are the 5 distinct, production-grade interaction concepts implemented in the interactive HTML prototype:

```
+-----------------------------------------------------------------------------------------------+
|  MASTER CALENDAR: Month Grid with Micro 24-Hour Tick Strips & Day SLA Aggregates             |
+-----------------------------------------------------------------------------------------------+
        |                                       |                                       |
        v                                       v                                       v
[Concept 1: NOC Flight Recorder]   [Concept 2: Topology Matrix]   [Concept 3: Continuous Gantt]
 - 24h Dual-Track Scrubber          - Subnet / Rack Grouping       - Synchronized Needle Tracking
 - Stacked Bar (Spike vs Chronic)   - Correlated Incident Card     - Live Concurrency Area Curve
 - Keyboard Arrow Scrubbing (← / →) - Isolated Chronic Section     - Range Zooming
        |                                       |
        v                                       v
[Concept 4: Hourly Split-Card Ledger]  [Concept 5: Segmented Matrix & Drawer]
 - 24h Time-Slot Accordion              - 24 Segmented Hour Pills with Status Pips
 - Steady-state hours collapsed         - Slide-Over Telemetry & Root-Cause Drawer
 - Raw blackbox probe stdout/stderr     - Direct PromQL deep-link & Post-Mortem copy
```

---

### Concept 01: NOC Flight Recorder *(Recommended)*
* **Inspiration:** Datadog NOC Flight Recorder, AWS CloudWatch Metrics Explorer & Video Timeline Scrubbers.
* **Core Interaction:**
  * Displays a master **24-Hour Binned Stacked Bar Rail** across the top (00:00 → 23:00 UTC).
  * Bars visually differentiate between **Red (Active Incident Spikes)** and **Gray (Chronic Baseline Noise)**.
  * An operator can click any hour bar or use the keyboard arrows (`←` / `→`) to scrub hour-by-hour.
  * **Delta State HUD:** Instantly displays:
    * *Hour 14:00 – 15:00 UTC*
    * `+1 New Drops In Hour` | `0 Recovered` | `15 Chronic Baseline`
  * **1-Click "Noise Cancellation" Switch:** Instantly hides the 15 persistent dead hosts with a single click, immediately isolating the 1 active incident host (`192.168.9.102`).
* **Why It’s Effective:** Fastest possible triage workflow. Answers "what happened at 14:00" in under 2 seconds.

---

### Concept 02: Topology Cascade & Root-Cause Matrix
* **Inspiration:** Sentry Distributed Tracing & AWS VPC Network Map.
* **Core Interaction:**
  * Groups targets by **Network Subnet / Switch Rack** (e.g., `192.168.9.0/24 — Core Apps` vs `10.20.0.0/16 — DMZ Edge Gateways`).
  * Each subnet receives its own horizontal 24-hour strip. When hour 14 turns red on Subnet 192.168.9.x, the operator immediately knows the failure was localized to Rack-B.
  * **Incident Focus Banner:** Automatically groups correlated failures under `Incident #INC-9402: Transient Probe Dropout` with cascade start time (`14:15:20 UTC`), MTTR (`1h 30m`), and packet loss rate (`100%`).
  * **Quarantined Chronic Section:** The 15 persistent offline targets are tucked into a quiet, collapsible bottom accordion so they never pollute shift reviews.
* **Why It’s Effective:** Correlates multi-node dropouts to common infrastructure root causes (switches, power, VLANs).

---

### Concept 03: Continuous Zoomable Gantt Swimlanes
* **Inspiration:** Chrome DevTools Performance Profiler & Grafana Trace Timeline.
* **Core Interaction:**
  * A full 24-hour horizontal canvas with an individual horizontal swimlane for each affected host.
  * Active incidents are plotted as bright red duration blocks; chronic hosts are muted gray bars.
  * **Synchronized Cursor Needle:** Moving the mouse over the timeline moves a glowing cyan vertical needle with a floating tooltip: `14:18 UTC · 16 Hosts Down Concurrently`.
  * **Concurrency Area Curve:** Above the swimlanes, a continuous area chart plots concurrent host outages across every minute of the day.
  * **Preset Zoom:** Quick buttons to toggle between `All 24h` and `Afternoon Spike (12h - 18h)`.
* **Why It’s Effective:** The best visualization for understanding concurrent overlap—operators immediately see whether 10 hosts died at the exact same second or sequentially.

---

### Concept 04: Hourly Split-Card Ledger (Audit Trail)
* **Inspiration:** GitHub Actions Audit Log & PagerDuty Timeline.
* **Core Interaction:**
  * Structures the 24 hours of the day into a chronological audit ledger.
  * **Smart Auto-Collapse:** Quiet, steady-state periods with no new alerts are collapsed into compact rows (`00:00 – 13:00 UTC · 13 Quiet Hours · 15 Chronic Baseline`).
  * **Auto-Expanded Incidents:** The hour containing anomalous dropouts (`14:00 – 15:00 UTC`) is highlighted with a critical red border and auto-expanded by default.
  * **Inline Probe Diagnostics:** Expanding an hour shows an embedded terminal log box with exact Blackbox ICMP probe timestamps, HTTP/ICMP status codes, and recovery timestamps.
* **Why It’s Effective:** Ideal for mobile, tablet, or linear post-mortem documentation where operators want to read events sequentially.

---

### Concept 05: Segmented Hourly Matrix & Slide-Over Drawer
* **Inspiration:** Linear Issue Inspector & Cloudflare Analytics Drawer.
* **Core Interaction:**
  * The top of the inspector features **24 Segmented Hour Pills** (`00` to `23`), each with a status dot (gray = chronic baseline only, red = active incident, green = healthy).
  * Clicking any hour pill selects that hour and enables the **"Open Hour Telemetry Drawer"** action.
  * **Slide-Over Drawer:** Smoothly slides in from the right edge containing:
    * Hour SLA %, total down hosts, and new drops.
    * Active Incident breakdown card with failure interval and packet loss details.
    * List of chronic background hosts.
    * Quick buttons to jump to the Prometheus Graph or copy a Markdown Incident Post-Mortem.
* **Why It’s Effective:** Keeps the main page clean while offering deep, unobstructed diagnostics when an operator chooses to drill down.

---

## 3. Comparative Architecture Matrix

| Capability | Concept 01: NOC Flight Recorder (Rec.) | Concept 02: Topology Matrix | Concept 03: Gantt Swimlanes | Concept 04: Audit Ledger | Concept 05: Segmented Drawer |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Interaction** | 24h Scrubber Bar + Keyboard (`←`/`→`) | Subnet Rows + Incident Banner | Scrubbing Vertical Crosshair Needle | Chronological Accordion Cards | 24 Segmented Pills + Slide Drawer |
| **Noise Filtering** | 1-Click "Noise Cancellation" Switch | Quarantined Chronic Accordion | Pinned Spikes / Desaturated Gray | Auto-Collapsed Quiet Hours | Drawer Tab Separation |
| **Delta Insight** | Shows `+1 Drops` & `Recoveries` per hour | Correlated rack/subnet cascade | Minute-by-minute concurrency curve | Terminal log probe stdout/stderr | Drawer telemetry KPI cards |
| **Mobile & Touch** | High (large touch targets) | High (responsive grid) | Moderate (horizontal scroll) | Very High (linear accordion) | High (slide drawer) |
| **Implementation Complexity** | Low-Medium (CSS Grid + Event Listener) | Medium (Grouping Logic by Subnet) | Medium-High (SVG Curve + Needle) | Low (Vanilla CSS Accordion) | Low-Medium (Slide Drawer State) |

---

## 4. How to Test the Prototype in Your Browser

1. Open [`docs/concepts/downtime-calendar-hourly-concepts.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/docs/concepts/downtime-calendar-hourly-concepts.html) in your browser (Chrome / Edge / Firefox).
2. **Explore the 5 Concepts:** Click the 5 concept cards at the top or press keys `1`, `2`, `3`, `4`, or `5` on your keyboard.
3. **In Concept 1 (Flight Recorder):**
   - Click the bar at **hour 14** or use the **`←` / `→` arrow keys** to scrub through hours.
   - Click the **"Mute 24h Chronic Noise"** toggle (or press `N`) to watch the 15 baseline dead hosts disappear, leaving only the active incident.
4. **In Concept 2 (Topology):**
   - See how `192.168.9.0/24` isolates the incident spike while other subnets remain 100% green.
   - Toggle the collapsible chronic section at the bottom.
5. **In Concept 3 (Gantt):**
   - Move your mouse over the swimlanes to see the glowing vertical needle report concurrent downtime in real time.
6. **In Concept 4 (Ledger):**
   - Review the auto-expanded hour 14 card and its terminal probe log.
7. **In Concept 5 (Drawer):**
   - Click any hour pill and click **"Open Hour Telemetry Drawer"** to inspect the slide-over flyout.
8. **Simulate Different Days:**
   - Click **Sep 10** in the top bar to simulate a major 64-host core switch failure.
   - Click **Sep 6** to simulate a weekend 3-host backup flap.
   - Press **`T`** to toggle between Dark Mode and Light Mode.
