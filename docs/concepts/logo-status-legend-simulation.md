# InfraWatch — Status Legend in Logo · Concept Exploration & Simulation

**Status:** Design Exploration / Simulation Phase  
**Artifact:** [`docs/concepts/logo-status-legend-simulation.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/docs/concepts/logo-status-legend-simulation.html)  
**Goal:** Relocate the static status legend row from under the filter bar into an interactive reveal directly within the InfraWatch logo/wordmark.

---

## 1. Context & Motivation

Currently, the status legend sits as a permanent row beneath the host filter bar:

```html
<div class="host-legend" id="hostLegend">
  <span class="hl-item"><span class="hl-swatch hl-up"></span>Online</span>
  <span class="hl-item"><span class="hl-swatch hl-slow"></span>Slow</span>
  <span class="hl-item"><span class="hl-swatch hl-down"></span>Down — needs acknowledging</span>
  <span class="hl-item"><span class="hl-swatch hl-acked"></span>Down — acknowledged <span class="hl-mark">✓</span></span>
  <span class="hl-item"><span class="hl-swatch hl-supp"></span>Down — caused by parent</span>
  <span class="hl-item"><span class="hl-swatch hl-maint"></span>Maintenance</span>
  <span class="hl-item"><span class="hl-swatch hl-nodata"></span>No probe data</span>
</div>
```

### Operational Problems of the Current Static Bar:
1. **Permanent Vertical Screen Real Estate:** Consumes ~30px vertical height across the entire viewport. On high-density NOC wallboards and laptop displays, this pushes the bottom row of host cards below the fold.
2. **Low-Frequency Reference vs Permanent Cost:** Once operators know the basic colors (green = up, red = down), they do not need the legend in view 100% of the time. However, when complex edge-case states appear (such as purple parent-suppressed vs maroon acknowledged down vs dashed maintenance), immediate and authoritative access to the reference key is vital.
3. **The Opportunity:** The InfraWatch logo mark itself is a 2×2 grid of four rounded squares representing monitored nodes. Moving the status reference directly into the brand mark provides a natural semantic home for fleet health telemetry.

---

## 2. Three Creative Concept Variants

All three variants are fully simulated in [`docs/concepts/logo-status-legend-simulation.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/docs/concepts/logo-status-legend-simulation.html) with real CSS tokens, authentic typography, and interactive controls.

### Variant A: "Tactical Radar Sweep & Precision HUD Panel" *(Recommended)*
* **Philosophy:** High-speed telemetry instrument. Utilitarian, crisp, minimum cognitive friction. Inspired by Linear and Datadog command centers.
* **Logo Hover Animation:**
  * Sequential clockwise telemetry radar ping across the 4 nodes (`node-1` → `node-2` → `node-4` → `node-3`).
  * Each node briefly illuminates with an accent cyan glow (`filter: drop-shadow(0 0 5px #38BDF8)`) in a 1.2s continuous loop.
  * Subtle hover container glow and micro-indicator chevron.
* **Click-to-Reveal Transition:**
  * High-velocity spring drop anchored directly under the logo (`cubic-bezier(0.16, 1, 0.3, 1)` over **180ms**).
  * Closes with a reverse collapse in **140ms**.
* **Legend Layout:**
  * 2-column precision tactical grid.
  * Column 1: Core Health (`Online`, `Slow`) & Direct Outages (`Down — needs ack`, `Down — acked ✓`).
  * Column 2: Cascades & Inactive (`Down — parent`, `Maintenance`, `No probe data`).
  * Each item includes monospace telemetry tags (`UP · OK`, `>500ms`, `ALERT`, `CLAIMED`, `CASCADE`, `WINDOW`, `DISCONNECTED`).
* **Tradeoff & Why It Fits:**
  * *Pros:* Snappiest feel (180ms). Minimal visual travel for the eye. Zero operator fatigue even during stressful incidents.
  * *Cons:* Less ornamental than a full morph, but maximizes operational efficiency.

---

### Variant B: "Status Matrix Morph & Floating Capsule Ribbon"
* **Philosophy:** The logo *is* the monitoring fleet. Connects the 4 nodes of the brand mark to the actual status palette.
* **Logo Hover Animation:**
  * The 4 square nodes smoothly shift from monochrome cyan to the system's core status colors:
    * Node 1: Green (`#22C55E` Online)
    * Node 2: Amber (`#ffd500` Warning)
    * Node 3: Red (`#EF4444` Critical Down)
    * Node 4: Purple (`#a855f7` Suppressed / Acked)
  * A delicate expanding sonar ring pulse radiates outward from the logo center.
* **Click-to-Reveal Transition:**
  * Unfolds an aerodynamic horizontal floating capsule ribbon with a glassmorphism blur backdrop (`cubic-bezier(0.2, 0.8, 0.2, 1)` over **240ms**).
* **Legend Layout:**
  * Horizontal ribbon of compact pill chips with individual status dots.
  * Sits neatly tucked beneath the topnav.
* **Tradeoff & Why It Fits:**
  * *Pros:* Very high delight; brilliant semantic link between the brand mark and fleet health colors.
  * *Cons:* Multi-color hover can attract peripheral attention during unrelated mouse movement across the navigation bar.

---

### Variant C: "Aerospace HUD Flyout & Tiered Monolith"
* **Philosophy:** Deep observability reference card. Complete operational transparency for multi-tiered NOC teams.
* **Logo Hover Animation:**
  * Ambient "reactor core" radial breathing aura sweeps behind the mark.
  * Brand mark scales by 1.06x with an illuminated `KEY` micro-badge appearing next to the wordmark.
* **Click-to-Reveal Transition:**
  * 3D perspective tilt drop (`perspective(700px) rotateX(-5deg) → rotateX(0deg)` over **260ms**).
* **Legend Layout:**
  * Grouped into 3 logical operational tiers:
    1. `01 · Operational & Degraded` (Online, Slow)
    2. `02 · Active Incidents` (Down — needs ack, Down — acked ✓, Down — parent)
    3. `03 · Scheduled & Inactive` (Maintenance, No probe data)
  * Full two-line descriptions for every state explaining root causes (e.g. parent suppression vs acked sound silence).
* **Tradeoff & Why It Fits:**
  * *Pros:* Completely eliminates operator confusion regarding complex alert states.
  * *Cons:* Larger footprint (380px wide); slightly slower reveal (260ms).

---

## 3. Comparative Matrix

| Feature | Variant A: Tactical HUD (Rec.) | Variant B: Matrix Ribbon | Variant C: Tiered Monolith |
| :--- | :--- | :--- | :--- |
| **Hover Animation** | Clockwise 4-node radar sweep | Quadrant color spectrum + sonar | Reactor core breathing aura |
| **Reveal Style** | Fast spring drop (180ms) | Horizontal capsule unfold (240ms) | 3D perspective tilt (260ms) |
| **Reverse Close** | Instant smooth ease (140ms) | Pill squeeze (170ms) | Upward fold (180ms) |
| **Layout** | 2-column precision grid | Horizontal flex ribbon | 3-tier glossary with descriptions |
| **NOC Ergonomics** | ⭐⭐⭐⭐⭐ Snappy, glance-and-go | ⭐⭐⭐⭐ Compact height, wide width | ⭐⭐⭐⭐⭐ Rich context, larger card |
| **Dismissal Triggers** | Logo click, Click outside, Esc | Logo click, Click outside, Esc, [x] | Logo click, Click outside, Esc |
| **Grid Interaction** | Hovering item dims non-matching hosts | Hovering item dims non-matching hosts | Hovering item dims non-matching hosts |

---

## 4. How to View and Test the Simulation

You can open the simulation directly in any modern browser:

```bash
# Path to file:
c:\Users\dimi\Downloads\infra-monitoring-stack-v3\docs\concepts\logo-status-legend-simulation.html
```

Or run a local preview server:
```powershell
python -m http.server 8089 --directory c:\Users\dimi\Downloads\infra-monitoring-stack-v3\docs\concepts
# Open http://localhost:8089/logo-status-legend-simulation.html
```

### Simulation Features Built In:
1. **Variant Selector**: Switch between Variant A, Variant B, and Variant C with one click.
2. **Speed Multipliers**: Inspect animations at `1.0x (Normal)`, `0.5x (Slow-Mo)`, or `0.25x (Super Slow-Mo)`.
3. **Compare Side-by-Side**: Toggle all 3 variants into a single view to compare hover and reveal motions simultaneously.
4. **Theme Toggle**: Test contrast in both **Dark Mode** and **Light Mode**.
5. **Interactive Host Grid Dimming**: Hovering any legend swatch dims non-matching hosts in the simulated dashboard below, validating real-world NOC utility.
6. **Telemetry Banner**: Shows live event logs for mouse clicks, outside clicks, and `Escape` key events.

---

## 5. Next Steps (Upon Direction Selection)

Once a variant is chosen:
1. Wire the selected interaction and HTML markup into [`alarm/templates/partials/_topnav.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/alarm/templates/partials/_topnav.html) under `.topnav-brand`.
2. Add the corresponding CSS classes and keyframes into [`alarm/static/css/parts/nav.css`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/alarm/static/css/parts/nav.css).
3. Remove the static `.host-legend` element from [`alarm/templates/partials/_dashboard.html`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/alarm/templates/partials/_dashboard.html).
4. Wire lightweight event listeners (toggle, click outside, `Escape` key) into [`alarm/static/js/main.js`](file:///c:/Users/dimi/Downloads/infra-monitoring-stack-v3/alarm/static/js/main.js).
