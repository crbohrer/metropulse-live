## What's wrong

The current classifier in `src/lib/transit.functions.ts` only recognizes `RAIL`/`RL`/`0` as light rail and `SMC`/`TS` as streetcar. Looking at the live Mecatran feed right now, Valley Metro actually uses different route IDs:

- **Light Rail**: `A` (A Line — Mesa ↔ downtown Phoenix, the one you noticed missing), `B` (B Line — downtown ↔ 19th Ave), and `0` (legacy/combined service still appearing in the feed). That's why only one rail line shows — `A` and `B` are currently being bucketed as buses.
- **Tempe Streetcar**: route ID is `STRN` (confirmed via a vehicle in the feed labeled "Tempe Public Library"). The current code looks for `SMC`/`TS`, so every streetcar falls through to "bus" and then gets filtered out when you uncheck buses.
- **Bus**: everything else (~569 vehicles ✓ matches what you're seeing).

Also worth noting the feed contains neighborhood circulators (`DASH`, `MARS`, `JUPI`, `EART`, `VENU`, `MERC`, `MSTG`, `MLHD`, `ALEX`, `MARY`, `FLSH`, `SMRT`, `DBUZ`, `FBUZ`) — these are buses and will stay classified as such.

## Plan

Update `classify()` in `src/lib/transit.functions.ts`:

```ts
function classify(routeId: string | undefined): VehicleType {
  if (!routeId) return "bus";
  const r = routeId.toUpperCase();
  if (r === "A" || r === "B" || r === "0") return "rail";
  if (r === "STRN") return "streetcar";
  return "bus";
}
```

That's the entire fix — no UI, schema, or polling changes needed. After the swap you should see both A and B light rail lines plus the Tempe Streetcar running its short loop around Mill Ave / ASU / Marina Heights.

## Where this info comes from

The Mecatran `asJson=true` feed already contains the streetcar — it's just under a non-obvious route ID. The authoritative source is Valley Metro's GTFS static `routes.txt` (published at `valleymetro.org/maps-schedules/data` / their developer page), which maps each `route_id` to a human name and `route_type` (0 = tram/streetcar/light-rail, 3 = bus). If we wanted to be bulletproof against future route renames, we could fetch and cache that static file once and classify by `route_type` instead of hardcoded IDs — happy to add that as a follow-up if you want it, but for now the three-ID patch is enough.
