# Downtime Calendar — replacing the 24-Hour Outage Rail

**Status:** Awaiting pick
**Prototype:** [`downtime-rail-alternatives.html`](downtime-rail-alternatives.html) — opens straight from disk, no server, no external assets
**Data:** real, frozen from `availability_buckets` for `blackbox-ping-internal`, Sep 8–15 2026
(`_downtime_rail_alternatives_data.json`, inlined into the HTML). Verified against Prometheus at
`192.168.9.16:9090` — fleet aggregate matches to 0.00 pp, per-host downtime to 0s.

---

## 1. Why the current rail fails

The rail encodes a **level** (hosts down that hour). On this fleet the level is a chronic floor:
16 of ~19 affected hosts are permanently dead, so the bar is 16 tall every hour and a real
incident adds +1.

```
day          hosts  per-hour "hosts down" — what the rail draws         spread  changed hrs
2026-09-11    19   16 16 16 17 16 16 16 16 17 17 16 16 16 16 16 …      16-17     3/24
2026-09-12    16   16 16 16 16 16 16 16 16 16 16 16 16 16 16 16 …      16-16     0/24
2026-09-13    16   16 16 16 16 16 16 16 16 16 16 16 16 16 16 16 …      16-16     0/24
2026-09-14    16   16 16 16 16 16 15 15 15 15 15 15 15 15 15 15 …      15-16     1/24
2026-09-10    64   22 18 18 17 32 31 25 28 17 16 16 16 16 16 16 …      16-32     9/24
```

**4 of 6 full days are a flat wall.** Concept 01 in the original deck solved this with the
stacked spike/chronic split and the mute toggle; building it "without the chronic noise"
removed the mechanism but not the noise.

Secondary weaknesses: 24 numbers across 1200px is thin; a 3-minute flap and a 59-minute outage
draw identically; and it never answers *which* hosts, or *did they fail together*.

---

## 2. The three candidates

All three read from the **same** derivation the shipping code uses
(`_calendarEventHours`, incl. `carried_in` / `still_down`), so what looks better in the
prototype will look the same wired up.

### A — Delta Strip · *change, not level*
Zero axis. Up = hosts dropped, down = hosts recovered. A permanently-down host contributes
**exactly zero**, so the chronic floor disappears structurally — no toggle, no "chronic"
classification, nothing to label. Absolute level survives as a faint context sparkline behind
the axis. Click a bucket to scope the table to hosts that *changed* in that hour.

* Cheapest: reuses the `dropped`/`recovered` series already verified against Prometheus.
* Answers *when*. Does not answer *which* or *together*.

### B — Host × Hour Matrix · *which, and together?*
Rows = hosts, columns = hours, cell shade = fraction of that hour down. Sorted by first state
change, so movers rise and the dead hosts fold into one collapsed line. A vertical stripe is a
common cause.

* Densest. Subsumes the table — one artifact instead of rail + chips + rows.
* Most work; restructures the panel.

### C — Incident Ledger · *no hour grid at all*
Drops starting within a tolerance window cluster into incidents on a continuous axis. Being
unbucketed, it has no bucket-edge artifacts at all.

* Costs a tuning knob (the prototype exposes it as a slider — move it and watch the count change).
* Degrades on uncorrelated flaps.

---

## 3. What the prototype reports on real days

The prototype scores each view per day. Verbatim:

| day | Current rail | A · Delta Strip | B · Matrix | C · Ledger |
| :-- | :-- | :-- | :-- | :-- |
| **Sep 11** (typical: 3 real incidents) | `WEAK — only 2 distinct bar heights` | `3 hours carry a state change` | `3 movers above the chronic block` | `4 incidents instead of 24 bars` |
| **Sep 13** (nothing happened) | `FLAT — one bar height all day, zero signal` | `FLAT LINE — and that is the correct answer` | `no movers — every affected host was down all day` | `no incidents — only the chronic band` |
| **Sep 10** (storm, 64 hosts) | `8 distinct bar heights` | `9 hours carry a state change` | `55 movers — a big day, expect to scroll` | `45 incidents — clustering degraded, worse than 24 bars` |

Read the Sep 10 row honestly: it is the one day the **current rail works**, and the one day
**C falls over** — 45 cards is worse than the 24 bars it replaced. Raising tolerance to 1800s
gets it to 14, still not good. B scrolls but stays correct. A holds on all three days.

---

## 4. Recommendation

**A**, then B if the panel should become one widget.

A fixes the measured defect for the least code, needs no server change, and the table below
already answers "which" once scoped. B is strictly more capable — it is the only candidate
that answers correlation — but it is ~4–5× the work and replaces the host table.

C is the one I'd drop: it is the most elegant on a quiet fleet and the worst on a bad day,
which is backwards for a NOC panel.

---

## 5. How to drive the prototype

* Open the HTML. Day strip at the top; days labelled `nothing changed` are the ones that break the current rail.
* <kbd>1</kbd> current rail (baseline) · <kbd>2</kbd> A · <kbd>3</kbd> B · <kbd>4</kbd> C · <kbd>←</kbd> <kbd>→</kbd> days · <kbd>T</kbd> theme.
* Click any bar, column, or incident card — the shared table below scopes to it, exactly as the real modal does.
* In C, drag the tolerance slider to feel the tuning burden.
