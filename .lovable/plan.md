# Wire real Valley Metro vehicle data into MetroPulse

## Good news: no protobuf parsing required

The feed URL you provided uses `asJson=true`:

```
https://mna.mecatran.com/utw/ws/gtfsfeed/vehicles/valleymetro?apiKey=...&asJson=true
```

Mecatran returns the GTFS-Realtime feed pre-decoded as JSON. We don't need `gtfs-realtime-bindings`, Python, or FastAPI — a single TanStack server function can fetch, normalize, and serve the data to the existing frontend polling loop.

## Steps

1. **Store the API key as a runtime secret** (`VALLEY_METRO_API_KEY`) so it's not hardcoded in the repo. The feed URL becomes `https://mna.mecatran.com/utw/ws/gtfsfeed/vehicles/valleymetro?apiKey=${KEY}&asJson=true`.

2. **Create `src/lib/transit.functions.ts`** with a `getLiveVehicles` server function (`createServerFn({ method: "GET" })`) that:
   - Fetches the Mecatran JSON feed server-side (keeps the API key off the client).
   - Maps each `entity.vehicle` into the existing `Vehicle` shape used by `TransitMap`/`TransitSidebar`: `id`, `lat`, `lng`, `routeId`, `type` (bus/rail/streetcar, inferred from route_id), `bearing`, `speed`, `label`, `lastUpdate`.
   - Returns `{ vehicles, fetchedAt }` as a plain DTO.
   - Wraps the fetch in try/catch; on failure returns `{ vehicles: [], error }` so the UI degrades cleanly instead of crashing.

3. **Vehicle-type classification.** Valley Metro route IDs: light rail = `BLU`/`RED` (or numeric line IDs from the feed), streetcar = `TS`/`SC`, everything else = bus. I'll confirm the actual route_id strings from the live payload on the first fetch and adjust the mapping.

4. **Swap the polling source in `src/routes/index.tsx`.** Replace the `driftVehicles` mock interval with `useQuery` calling the server fn via `useServerFn`, `refetchInterval: 15000`. Keep all existing filter/search/active-vehicle state untouched — only the data source changes. Mock data stays in `mock-transit.ts` as a fallback when the fetch errors (and for the alerts list, which isn't in the vehicles feed).

5. **Loading + error UI.** Add a subtle "Last updated" timestamp (already in sidebar) plus a small inline error chip when the server fn returns an `error` field. No layout changes.

## Technical notes

- Feed is JSON, so no `gtfs-realtime-bindings`, no `protobufjs`, no Python service. Works inside the Cloudflare Worker runtime with plain `fetch`.
- Server function keeps the API key out of the client bundle.
- 15s polling is preserved; React Query handles dedupe and background refetch.
- If you later switch to an agency that only publishes `.pb`, we'd add `protobufjs` + the GTFS-RT `.proto` schema in the same server function — still no external Python needed.

## Out of scope

- Live service alerts feed (separate Mecatran endpoint) — mock alerts remain for now; can wire in a follow-up.
- Auth, database, persistence — none needed for this step.