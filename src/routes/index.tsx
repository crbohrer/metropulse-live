import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap }))
);
import { TransitSidebar } from "@/components/TransitSidebar";
import { mockAlerts, type Vehicle, type VehicleType } from "@/lib/mock-transit";
import { getLiveVehicles, getTripUpdates, getStopDepartures, getTripPlanMatches } from "@/lib/transit.functions";
import { getRouteGeometry } from "@/lib/route-shapes.functions";
import { findStopIdsByQuery, findStopIdsByExactName, findNearestStop, findStopsWithinRadius, type PickableStop, type PickableStopWithDistance } from "@/lib/stops-index";

export type Pin = { lat: number; lng: number };
export interface TripOption {
  tripId: string;
  vehicleId: string | null;
  routeId: string;
  direction: string;
  vehicleType: "bus" | "rail" | "streetcar";
  startStop: PickableStopWithDistance;
  endStop: PickableStopWithDistance;
  walkMinutes: number;
  eta: number; // unix seconds
  hasActiveVehicle: boolean;
}
export interface TripPlan {
  startStop: PickableStop | null;
  endStop: PickableStop | null;
  startStops: PickableStopWithDistance[];
  endStops: PickableStopWithDistance[];
  connectingRoutes: string[];
  options: TripOption[];
  nextEta: { routeId: string; time: number } | null;
}

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "MetroPulse Tempe — Live Transit Tracking" },
      { name: "description", content: "Real-time tracking of buses, light rail, and the streetcar across Tempe, Arizona." },
    ],
  }),
});

function Index() {
  const fetchVehicles = useServerFn(getLiveVehicles);
  const fetchRouteGeometry = useServerFn(getRouteGeometry);
  const fetchTripUpdates = useServerFn(getTripUpdates);
  const fetchStopDepartures = useServerFn(getStopDepartures);
  const fetchTripPlanMatches = useServerFn(getTripPlanMatches);
  const { data } = useQuery({
    queryKey: ["live-vehicles"],
    queryFn: () => fetchVehicles(),
    refetchInterval: 15000,
    refetchIntervalInBackground: true,
    staleTime: 10_000,
  });

  const vehicles: Vehicle[] = data?.vehicles ?? [];
  const lastUpdated = useMemo(
    () => (data?.fetchedAt ? new Date(data.fetchedAt) : new Date()),
    [data?.fetchedAt]
  );
  const feedError = data?.error ?? null;

  const [filters, setFilters] = useState<Record<VehicleType, boolean>>({
    bus: true,
    rail: true,
    streetcar: true,
  });
  const [search, setSearch] = useState("");
  const [selectedDirections, setSelectedDirections] = useState<string[]>([]);
  const [active, setActive] = useState<Vehicle | null>(null);
  const [isRouteViewActive, setIsRouteViewActive] = useState(false);
  const [focusedStop, setFocusedStop] = useState<{ lat: number; lng: number; key: number } | null>(null);
  const [selectedStop, setSelectedStop] = useState<{ id: string; name: string; lat: number; lng: number } | null>(null);
  const [routingMode, setRoutingMode] = useState(false);
  const [startPin, setStartPin] = useState<Pin | null>(null);
  const [endPin, setEndPin] = useState<Pin | null>(null);
  const [walkRadiusMiles, setWalkRadiusMiles] = useState(1);
  const [selectedTripKey, setSelectedTripKey] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const WALK_RADIUS_MILES = walkRadiusMiles;
  const WALK_MIN_PER_MILE = 20; // ~3 mph

  // All stops within 1mi of each pin (covers bus + rail + streetcar platforms).
  const startStops = useMemo<PickableStopWithDistance[]>(
    () => (startPin ? findStopsWithinRadius(startPin.lat, startPin.lng, WALK_RADIUS_MILES) : []),
    [startPin],
  );
  const endStops = useMemo<PickableStopWithDistance[]>(
    () => (endPin ? findStopsWithinRadius(endPin.lat, endPin.lng, WALK_RADIUS_MILES) : []),
    [endPin],
  );
  const startStop = useMemo(() => (startPin ? findNearestStop(startPin.lat, startPin.lng) : null), [startPin]);
  const endStop = useMemo(() => (endPin ? findNearestStop(endPin.lat, endPin.lng) : null), [endPin]);

  const startStopIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of startStops) {
      for (const v of findStopIdsByExactName(s.name)) ids.add(v);
      ids.add(s.id);
      ids.add(s.id.replace(/^0+/, ""));
    }
    return Array.from(ids);
  }, [startStops]);
  const endStopIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of endStops) {
      for (const v of findStopIdsByExactName(s.name)) ids.add(v);
      ids.add(s.id);
      ids.add(s.id.replace(/^0+/, ""));
    }
    return Array.from(ids);
  }, [endStops]);

  const activeTripIds = useMemo(() => vehicles.map((v) => v.id), [vehicles]);
  const { data: tripMatches } = useQuery({
    queryKey: ["plan-trip-matches", startStopIds.join(","), endStopIds.join(","), activeTripIds.join(",")],
    queryFn: () =>
      fetchTripPlanMatches({
        data: { startStopIds, endStopIds, activeTripIds },
      }),
    enabled: startStopIds.length > 0 && endStopIds.length > 0,
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
  });

  const tripPlan: TripPlan = useMemo(() => {
    const empty: TripPlan = {
      startStop,
      endStop,
      startStops,
      endStops,
      connectingRoutes: [],
      options: [],
      nextEta: null,
    };
    if (!startStop || !endStop || !tripMatches?.matches) return empty;

    // Map every exact-name stop_id / stop_code variant back to the nearest stop record in each pin radius.
    const stopRecordById = (pool: PickableStopWithDistance[]) => {
      const map = new Map<string, PickableStopWithDistance>();
      const norm = (s: string) => s.replace(/^0+/, "");
      for (const s of pool) {
        map.set(s.id, s);
        map.set(norm(s.id), s);
        for (const id of findStopIdsByExactName(s.name)) {
          map.set(id, s);
          map.set(norm(id), s);
        }
      }
      return map;
    };
    const startIdMap = stopRecordById(startStops);
    const endIdMap = stopRecordById(endStops);

    // Helper: lookup active vehicle context by trip ID, vehicle ID, then route fallback.
    const vByTripOrVehicle = new Map<string, Vehicle>();
    const vByRoute = new Map<string, Vehicle>();
    for (const v of vehicles) {
      vByTripOrVehicle.set(v.id, v);
      const rid = v.route_id.split(" · ")[0].trim();
      if (!vByRoute.has(rid)) vByRoute.set(rid, v);
    }

    const norm = (s: string) => s.replace(/^0+/, "");
    const best = new Map<string, TripOption>();

    for (const match of tripMatches.matches) {
      const startRec = startIdMap.get(match.startStopId) || startIdMap.get(norm(match.startStopId));
      if (!startRec) continue;
      const endRec = endIdMap.get(match.endStopId) || endIdMap.get(norm(match.endStopId));
      if (!endRec) continue;

      const veh =
        vByTripOrVehicle.get(match.tripId) ||
        (match.vehicleId ? vByTripOrVehicle.get(match.vehicleId) : undefined) ||
        vByRoute.get(match.routeId);
      const direction = veh?.direction ?? "—";
      const vehicleType = veh?.vehicle_type ?? "bus";
      const walkMinutes = Math.max(1, Math.round(startRec.miles * WALK_MIN_PER_MILE));

      const key = `${match.tripId}|${match.vehicleId ?? ""}|${match.startStopId}|${match.endStopId}`;
      const existing = best.get(key);
      if (!existing || match.eta < existing.eta) {
        best.set(key, {
          tripId: match.tripId,
          vehicleId: match.vehicleId,
          routeId: match.routeId,
          direction,
          vehicleType,
          startStop: startRec,
          endStop: endRec,
          walkMinutes,
          eta: match.eta,
          hasActiveVehicle: match.hasActiveVehicle,
        });
      }
    }

    const allOptions = Array.from(best.values()).sort((a, b) => {
      // Prefer active vehicles, then by ETA
      if (a.hasActiveVehicle !== b.hasActiveVehicle) return a.hasActiveVehicle ? -1 : 1;
      return a.eta - b.eta;
    });
    // Dedupe by route+direction so each unique route surfaces once (active preferred).
    const byRouteDir = new Map<string, TripOption>();
    for (const o of allOptions) {
      const k = `${o.routeId}|${o.direction}`;
      if (!byRouteDir.has(k)) byRouteDir.set(k, o);
    }
    const options = Array.from(byRouteDir.values());
    const seenRoutes = new Set<string>();
    const connectingRoutes: string[] = [];
    for (const o of options) {
      if (!seenRoutes.has(o.routeId)) {
        seenRoutes.add(o.routeId);
        connectingRoutes.push(o.routeId);
      }
    }
    const firstActive = options.find((o) => o.hasActiveVehicle);
    const nextEta = firstActive ? { routeId: firstActive.routeId, time: firstActive.eta } : null;

    return { startStop, endStop, startStops, endStops, connectingRoutes, options, nextEta };
  }, [startStop, endStop, startStops, endStops, tripMatches, vehicles]);


  const { data: routeGeo } = useQuery({
    queryKey: ["route-geo", active?.route_id],
    queryFn: () => {
      // Split "72 · Label" and only take the "72" part to send to the database
      const cleanRouteId = active!.route_id.split(" · ")[0].trim();
      
      return fetchRouteGeometry({ data: { routeId: cleanRouteId } });
    },
    enabled: !!active?.route_id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: tripUpdates } = useQuery({
    queryKey: ["trip-updates", active?.id],
    queryFn: () => fetchTripUpdates({ data: { vehicleId: active!.id } }),
    enabled: !!active && isRouteViewActive,
    refetchInterval: 15000,
  });

  // Departure-board feed: every future arrival at the selected stop across ALL routes/vehicles.
  const stopDepartureIds = useMemo(() => {
    if (!selectedStop) return [] as string[];
    const ids = findStopIdsByExactName(selectedStop.name);
    if (selectedStop.id) {
      ids.add(selectedStop.id);
      ids.add(selectedStop.id.replace(/^0+/, ""));
    }
    return Array.from(ids);
  }, [selectedStop]);

  const { data: stopDeparturesData } = useQuery({
    queryKey: ["stop-departures", selectedStop?.name, stopDepartureIds.join(",")],
    queryFn: () => fetchStopDepartures({ data: { stopIds: stopDepartureIds } }),
    enabled: !!selectedStop && stopDepartureIds.length > 0,
    refetchInterval: 15000,
  });

  // Bridge plain-text stop names -> numeric stop IDs using the master stops.json database.
  const matchedStopIds = useMemo(() => findStopIdsByQuery(search), [search]);

  const visibleVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const dirs = selectedDirections.map((d) => d.toLowerCase());
    const etas = tripUpdates?.etas ?? null;
    return vehicles.filter((v) => {
      if (!filters[v.vehicle_type]) return false;
      if (dirs.length > 0 && !dirs.some((d) => v.direction.toLowerCase().includes(d))) return false;
      if (q === "") return true;
      if (v.route_id.toLowerCase().includes(q) || v.direction.toLowerCase().includes(q)) return true;
      // Stop-name match: keep vehicles whose upcoming ETA stop IDs intersect matchedStopIds.
      if (matchedStopIds.size > 0 && etas && v.id === active?.id) {
        for (const sid of Object.keys(etas)) {
          const clean = String(sid).trim();
          if (matchedStopIds.has(clean) || matchedStopIds.has(clean.replace(/^0+/, ""))) return true;
        }
      }
      return false;
    });
  }, [vehicles, filters, search, selectedDirections, matchedStopIds, tripUpdates, active]);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      {mounted && (
        <Suspense fallback={null}>
          <TransitMap
            vehicles={visibleVehicles}
            activeVehicle={active}
            routeShape={active && isRouteViewActive ? routeGeo?.shape ?? null : null}
            routeStops={active && isRouteViewActive ? routeGeo?.stops ?? null : null}
            isRouteViewActive={isRouteViewActive}
            liveEtas={isRouteViewActive ? tripUpdates?.etas ?? null : null}
            focusedStop={focusedStop}
            stopSearch={search}
            onPickStop={(s) => {
              setSelectedStop(s);
              setFocusedStop({ lat: s.lat, lng: s.lng, key: Date.now() });
            }}
            onClearSelection={() => {
              setActive(null);
              setIsRouteViewActive(false);
              setFocusedStop(null);
              setSelectedStop(null);
            }}
            onSelectVehicle={(v) => {
              setActive(v);
              setIsRouteViewActive(false);
              setFocusedStop(null);
              setSelectedStop(null);
            }}
            onShowRoute={() => setIsRouteViewActive(true)}
            routingMode={routingMode}
            startPin={startPin}
            endPin={endPin}
            onDropPin={(latlng: Pin) => {
              if (!startPin) setStartPin(latlng);
              else if (!endPin) setEndPin(latlng);
              else setStartPin(latlng); // cycle: replace start once both are set
            }}
            onMoveStartPin={(p: Pin) => setStartPin(p)}
            onMoveEndPin={(p: Pin) => setEndPin(p)}
            startRadiusStops={startStops}
            endRadiusStops={endStops}
            radiusMiles={WALK_RADIUS_MILES}
          />
        </Suspense>
      )}
      <TransitSidebar
        vehicles={vehicles}
        filters={filters}
        onToggle={(t) => setFilters((f) => ({ ...f, [t]: !f[t] }))}
        search={search}
        onSearch={setSearch}
        alerts={mockAlerts}
        onSelectVehicle={(v) => {
          setActive(v);
          setIsRouteViewActive(false);
        }}
        last={lastUpdated}
        activeVehicle={active}
        onClearSelection={() => {
          setActive(null);
          setIsRouteViewActive(false);
        }}
        isRouteViewActive={isRouteViewActive}
        routeShape={active && isRouteViewActive ? routeGeo?.shape ?? null : null}
        routeStops={active && isRouteViewActive ? routeGeo?.stops ?? null : null}
        liveEtas={isRouteViewActive ? tripUpdates?.etas ?? null : null}
        onSelectStop={(lat, lng) => setFocusedStop({ lat, lng, key: Date.now() })}
        selectedStop={selectedStop}
        onClearSelectedStop={() => setSelectedStop(null)}
        onPickStop={(s) => {
          setSelectedStop(s);
          setFocusedStop({ lat: s.lat, lng: s.lng, key: Date.now() });
        }}
        selectedDirections={selectedDirections}
        onToggleDirection={(d) =>
          setSelectedDirections((prev) =>
            prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
          )
        }
        stopDepartures={stopDeparturesData?.departures ?? null}
        routingMode={routingMode}
        startPin={startPin}
        endPin={endPin}
        tripPlan={tripPlan}
        onToggleRoutingMode={() => {
          setRoutingMode((m) => {
            const next = !m;
            if (!next) {
              setStartPin(null);
              setEndPin(null);
            }
            return next;
          });
        }}
        onClearTripPlan={() => {
          setStartPin(null);
          setEndPin(null);
        }}
      />
      {feedError && (
        <div className="pointer-events-none absolute bottom-4 right-4 z-[1000] rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive backdrop-blur">
          Live feed: {feedError}
        </div>
      )}
    </main>
  );
}

