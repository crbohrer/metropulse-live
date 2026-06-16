import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const TransitMap = lazy(() =>
  import("@/components/TransitMap").then((m) => ({ default: m.TransitMap }))
);
import { TransitSidebar } from "@/components/TransitSidebar";
import { mockAlerts, type Vehicle, type VehicleType } from "@/lib/mock-transit";
import { getLiveVehicles, getTripUpdates, getStopDepartures } from "@/lib/transit.functions";
import { getRouteGeometry } from "@/lib/route-shapes.functions";
import { findStopIdsByQuery, findStopIdsByExactName, findNearestStop, type PickableStop } from "@/lib/stops-index";

export type Pin = { lat: number; lng: number };
export interface TripPlan {
  startStop: PickableStop | null;
  endStop: PickableStop | null;
  connectingRoutes: string[];
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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Free pin-to-nearest-stop matching using stops.json
  const startStop = useMemo(() => (startPin ? findNearestStop(startPin.lat, startPin.lng) : null), [startPin]);
  const endStop = useMemo(() => (endPin ? findNearestStop(endPin.lat, endPin.lng) : null), [endPin]);

  const startStopIds = useMemo(() => {
    if (!startStop) return [] as string[];
    const ids = findStopIdsByExactName(startStop.name);
    ids.add(startStop.id);
    ids.add(startStop.id.replace(/^0+/, ""));
    return Array.from(ids);
  }, [startStop]);
  const endStopIds = useMemo(() => {
    if (!endStop) return [] as string[];
    const ids = findStopIdsByExactName(endStop.name);
    ids.add(endStop.id);
    ids.add(endStop.id.replace(/^0+/, ""));
    return Array.from(ids);
  }, [endStop]);

  const { data: startDep } = useQuery({
    queryKey: ["plan-dep-start", startStopIds.join(",")],
    queryFn: () => fetchStopDepartures({ data: { stopIds: startStopIds } }),
    enabled: startStopIds.length > 0,
    refetchInterval: 30000,
  });
  const { data: endDep } = useQuery({
    queryKey: ["plan-dep-end", endStopIds.join(",")],
    queryFn: () => fetchStopDepartures({ data: { stopIds: endStopIds } }),
    enabled: endStopIds.length > 0,
    refetchInterval: 30000,
  });

  const tripPlan: TripPlan = useMemo(() => {
    const connecting: string[] = [];
    let nextEta: TripPlan["nextEta"] = null;
    if (startStop && endStop && startDep?.departures && endDep?.departures) {
      const endRoutes = new Set(endDep.departures.map((d) => d.routeId));
      const seen = new Set<string>();
      for (const d of startDep.departures) {
        if (!endRoutes.has(d.routeId)) continue;
        if (!seen.has(d.routeId)) {
          seen.add(d.routeId);
          connecting.push(d.routeId);
        }
        if (!nextEta || d.time < nextEta.time) {
          nextEta = { routeId: d.routeId, time: d.time };
        }
      }
    }
    return { startStop, endStop, connectingRoutes: connecting, nextEta };
  }, [startStop, endStop, startDep, endDep]);


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
            onDropPin={(latlng) => {
              if (!startPin) setStartPin(latlng);
              else if (!endPin) setEndPin(latlng);
              else setStartPin(latlng); // cycle: replace start once both are set
            }}
            onMoveStartPin={(p) => setStartPin(p)}
            onMoveEndPin={(p) => setEndPin(p)}
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

