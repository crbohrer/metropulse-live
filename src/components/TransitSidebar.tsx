import { Bus, TrainFront, TramFront, Search, AlertTriangle, Info, AlertOctagon, Radio, X, MapPin, Menu, Compass, Footprints } from "lucide-react";
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Vehicle, VehicleType, TransitAlert } from "@/lib/transit-types";
import type { StopDeparture, LiveTransitAlert, TransferPlan } from "@/lib/transit.functions";
import type { GeoJSON as RouteGeoJSON } from "@/lib/route-shapes.functions";
import { getLiveAlerts } from "@/lib/transit.functions";
import { getLiveRailEta } from "../lib/transit.functions";
import { RAIL_STATION_CODES } from "../lib/transit.functions";
import {
  alongDistance,
  buildGhostedRoute,
  filterRouteStops,
  getActiveRouteLines,
  nearestOnLines,
} from "@/lib/geo-utils";
import { findStopsByName } from "@/lib/stops-index";

interface Props {
  vehicles: Vehicle[];
  filters: Record<VehicleType, boolean>;
  onToggle: (t: VehicleType) => void;
  search: string;
  onSearch: (s: string) => void;
  alerts: TransitAlert[];
  onSelectVehicle: (v: Vehicle) => void;
  last: Date;
  activeVehicle: Vehicle | null;
  onClearSelection: () => void;
  isRouteViewActive: boolean;
  routeShape: RouteGeoJSON | null;
  routeStops: RouteGeoJSON | null;
  liveEtas: Record<string, number> | null;
  onSelectStop: (lat: number, lng: number) => void;
  selectedDirections: string[];
  onToggleDirection: (d: string) => void;
  selectedStop: { id: string; name: string; lat: number; lng: number } | null;
  onClearSelectedStop: () => void;
  onPickStop: (s: { id: string; name: string; lat: number; lng: number }) => void;
  stopDepartures: StopDeparture[] | null;
  routingMode: boolean;
  startPin: { lat: number; lng: number } | null;
  endPin: { lat: number; lng: number } | null;
  tripPlan: {
    startStop: { id: string; name: string; lat: number; lng: number } | null;
    endStop: { id: string; name: string; lat: number; lng: number } | null;
    startStops: Array<{ id: string; name: string; lat: number; lng: number; miles: number }>;
    endStops: Array<{ id: string; name: string; lat: number; lng: number; miles: number }>;
    connectingRoutes: string[];
    options: Array<{
      tripId: string;
      vehicleId: string | null;
      routeId: string;
      direction: string;
      vehicleType: "bus" | "rail" | "streetcar";
      startStop: { id: string; name: string; lat: number; lng: number; miles: number };
      endStop: { id: string; name: string; lat: number; lng: number; miles: number };
      walkMinutes: number;
      eta: number;
      hasActiveVehicle: boolean;
    }>;
    transfers: TransferPlan[];
    nextEta: { routeId: string; time: number } | null;
  };
  walkRadiusMiles: number;
  onChangeWalkRadius: (m: number) => void;
  selectedTripKey: string | null;
  onSelectTripOption: (key: string) => void;
  onToggleRoutingMode: () => void;
  onClearTripPlan: () => void;
}

const DIRECTION_OPTIONS = ["Northbound", "Southbound", "Eastbound", "Westbound"] as const;


const typeMeta = {
  bus: { label: "Buses", icon: Bus, color: "var(--bus)" },
  rail: { label: "Light Rail", icon: TrainFront, color: "var(--rail)" },
  streetcar: { label: "Streetcar", icon: TramFront, color: "var(--streetcar)" },
} as const;

const severityIcon = {
  info: Info,
  warning: AlertTriangle,
  critical: AlertOctagon,
};

const severityColor = {
  info: "text-sky-400",
  warning: "text-amber-400",
  critical: "text-red-400",
};

export function TransitSidebar({
  vehicles,
  filters,
  onToggle,
  search,
  onSearch,
  alerts,
  onSelectVehicle,
  last,
  activeVehicle,
  onClearSelection,
  isRouteViewActive,
  routeShape,
  routeStops,
  liveEtas,
  onSelectStop,
  selectedDirections,
  onToggleDirection,
  selectedStop,
  onClearSelectedStop,
  onPickStop,
  stopDepartures,
  routingMode,
  startPin,
  endPin,
  tripPlan,
  walkRadiusMiles,
  onChangeWalkRadius,
  selectedTripKey,
  onSelectTripOption,
  onToggleRoutingMode,
  onClearTripPlan,
}: Props) {
  const fetchLiveAlerts = useServerFn(getLiveAlerts);
  const { data: liveAlertsData } = useQuery({
    queryKey: ["live-alerts"],
    queryFn: () => fetchLiveAlerts(),
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
    staleTime: 4 * 60 * 1000,
  });
  const liveAlerts: LiveTransitAlert[] = liveAlertsData ?? [];
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);
  const [, forceUpdate] = useState({});
  const [railEtas, setRailEtas] = useState<Record<string, number>>({});
  const [itineraryOpen, setItineraryOpen] = useState(true);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const filtered = vehicles.filter((v) => {
    if (!filters[v.vehicle_type]) return false;
    const q = search.trim().toLowerCase();
    if (q !== "") {
      const matchRoute = v.route_id.toLowerCase().includes(q);
      const matchDir = v.direction.toLowerCase().includes(q);
      if (!matchRoute && !matchDir) return false;
    }
    if (selectedDirections.length > 0) {
      const vDir = v.direction.toLowerCase();
      const hit = selectedDirections.some((d) => vDir.includes(d.toLowerCase()));
      if (!hit) return false;
    }
    return true;
  });

  // Departure board: every future arrival at the selected stop across ALL routes,
  // sourced from the global trip-updates feed (not restricted to the active vehicle).
  const departures = useMemo(() => {
    if (!selectedStop || !stopDepartures) return [] as Array<{ v: Vehicle; eta: number | null }>;
    const nowSec = Date.now() / 1000;
    const byTrip = new Map<string, Vehicle>();
    const byVehicle = new Map<string, Vehicle>();
    for (const v of vehicles) {
      byTrip.set(v.id, v);
      byVehicle.set(v.id, v);
    }
    const seen = new Set<string>();
    const out: Array<{ v: Vehicle; eta: number }> = [];
    for (const d of stopDepartures) {
      if (d.time < nowSec) continue;
      const key = d.vehicleId || d.tripId;
      if (seen.has(key)) continue;
      seen.add(key);
      const matched =
        byTrip.get(d.tripId) ||
        (d.vehicleId ? byVehicle.get(d.vehicleId) : undefined);
      const v: Vehicle = matched ?? {
        id: d.tripId,
        latitude: 0,
        longitude: 0,
        route_id: d.routeId,
        direction: "—",
        delay_seconds: d.delay ?? 0,
        vehicle_type: "bus",
      };
      out.push({ v, eta: d.time });
    }
    out.sort((a, b) => a.eta - b.eta);
    return out;
  }, [selectedStop, stopDepartures, vehicles]);

  // Matching stops sourced from the master stops.json (deduped by name).
  const matchingStops = useMemo(() => {
    if (selectedStop) return [];
    return findStopsByName(search, 20);
  }, [search, selectedStop]);

  const counts = {
    bus: vehicles.filter((v) => v.vehicle_type === "bus").length,
    rail: vehicles.filter((v) => v.vehicle_type === "rail").length,
    streetcar: vehicles.filter((v) => v.vehicle_type === "streetcar").length,
  };

  const upcomingStops = useMemo(() => {
    if (!isRouteViewActive || !activeVehicle) return [];
    
   // 1. NORMALIZE LIGHT RAIL DIRECTIONS
        const rawRid = activeVehicle?.route_id.replace("Route", "").split("·")[0].split(" · ")[0].trim() || "";
        let normalizedDir = activeVehicle?.direction || "";
        const isRail = rawRid === "A" || rawRid === "B" || rawRid === "S" || activeVehicle?.vehicle_type?.toLowerCase() === "rail";

        const dLower = normalizedDir.toLowerCase();

        // 🚨 THE BOUNCER: Force Valley Metro's chaotic API strings into strict physical tracks!
        if (rawRid === "A") {
           // Route A is East/West. If the API says "North", force it West.
           normalizedDir = (dLower.includes("west") || dLower.includes("north")) ? "Westbound" : "Eastbound";
        } else if (rawRid === "B") {
           // Route B is North/South. If the API says "East" (Baseline), force it South!
           normalizedDir = (dLower.includes("south") || dLower.includes("east")) ? "Southbound" : "Northbound";
        }

        // 2. IDENTIFY REVERSED GEOMETRY
        // The raw map data draws Eastbound and Southbound tracks completely backwards (100 -> 0).
        const isLineReversed = (rawRid === "A" && normalizedDir === "Eastbound") || (rawRid === "B" && normalizedDir === "Southbound");
    const lines = getActiveRouteLines(
      routeShape,
      normalizedDir, 
      activeVehicle.vehicle_type,
      rawRid,
    );
    const ghosted = buildGhostedRoute(lines, activeVehicle);
    
    const stops = filterRouteStops(routeStops, { ...activeVehicle, direction: normalizedDir });
    const seenNames = new Set<string>();

    return stops
      .map((f) => {
        const coords = (f.geometry?.coordinates as number[]) ?? [];
        const [lng, lat] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;

        if (lines.length > 0) {
          const nearest = nearestOnLines(lines, [lng, lat]);
          // Give Rail a ~400m spatial buffer to catch Central Ave across the street! Buses stay strict.
          const threshold = isRail ? 0.0000005 : 0.00000004;
          if (!nearest || nearest.distSq > threshold) return null;
        }

        const along = ghosted ? alongDistance(ghosted.chosen, [lng, lat]) : 0;
        const name = String(f.properties?.stop_name || f.properties?.StationName || "Transit Stop");

          // 1. RESTORE FULL PLATFORM ID LOOKUPS
          const idCandidates = [
            f.properties?.stop_id,
            f.properties?.stop_code,
            f.properties?.StationId,
            f.properties?.NextRide,
            f.properties?.PlatformID,
            f.properties?.PlatformId,
            f.properties?.platform_id,
          ];
          
          const sid = String(idCandidates[0] ?? name);
          let ts: number | null = null;
          let validForDirection = true;
        // 🚨 RETIREMENT HARD-BLOCK: Only drop Dorsey if it is on the Light Rail (Route A or B)
          if ((rawRid === "A") && name.includes("Dorsey")) {
            validForDirection = false;
          }

        if (
            rawRid === "A" && 
            activeVehicle?.direction?.toLowerCase().includes("west") && 
            name.includes("Washington") && 
            name.includes("Central")
          ) {
            validForDirection = false;
          }

          // STANDARD BUS ETA MATCHING
          for (const c of idCandidates) {
            if (c == null) continue;
            const cleanKey = String(c).trim();
            const match = liveEtas?.[cleanKey] ?? liveEtas?.[cleanKey.replace(/^0+/, '')] ?? liveEtas?.[Number(cleanKey)];
            if (typeof match === "number") {
              ts = match;
              break;
            }
          }

      // Rail Dictionary Lookup
          // Allow Route A and Route B to use the Station Code Name lookup if their property IDs fail!
          // Rail Dictionary Lookup
          if (!ts && liveEtas && (rawRid === "A" || rawRid === "B" || rawRid === "S")) {
            // THE FIX: Standardize sashes, hyphens, and spaces so it matches perfectly
            const cleanName = name
              .replace(" Station", "")
              .replace(" Stn", "")
              .replace(/\s*[\/\-]\s*/g, " / ") // Converts "Ln-Apache" or "Ln/Apache" directly to "Ln / Apache"
              .trim();
              
            const stationDict = RAIL_STATION_CODES[cleanName];

            if (stationDict) {
              // Determine the direction key dynamically to prevent bleeding
              const dirKey = normalizedDir.toLowerCase() as 'eastbound' | 'westbound' | 'northbound' | 'southbound';
              const specificCode = stationDict[dirKey];

              let foundMatch = false;
              if (specificCode && typeof liveEtas[specificCode] === "number") {
                ts = liveEtas[specificCode];
                foundMatch = true;
              } else {
                // Fall back to checking all possible keys inside this station sub-object
                const possibleCodes = Object.values(stationDict);
                for (const code of possibleCodes) {
                  if (code && typeof liveEtas[code] === "number") {
                    ts = liveEtas[code];
                    foundMatch = true;
                    break;
                  }
                }
              }

              // ... inside your stationDict check ...
              if (!foundMatch && rawRid === "S") {
                validForDirection = false;
              }
            } else {
              // THE FIX: If the station name doesn't exist in our dictionary at all, 
              // it's a retired stop! Kill it for Route A, B, and S.
              validForDirection = false; 
            }
          }

          // 🚨 THE KILL SWITCH 🚨
          if (!validForDirection) {
             return null; 
          }

         // 1. Calculate GPS distance
          let isPassed = false;
          if (ghosted) {
            isPassed = isLineReversed ? along > ghosted.vehicleAlong : along < ghosted.vehicleAlong;
          }

          // 2. THE OVERRIDE: If the ETA is in the future, it CANNOT be passed!
          if (typeof ts === "number") {
             const timeUntilMs = (ts * 1000) - Date.now();
             
             if (timeUntilMs > 0) {
               // Absolute veto: force it to be upcoming
               isPassed = false; 
             } else if (timeUntilMs < -180000) { 
               // Stale API Purge (older than 3 mins)
               isPassed = true;
             }
          }

          // Purge physically passed stops from the sidebar list immediately
          if (isPassed) return null;
          return { name, sid, lat, lng, along, ts, properties: f.properties, validForDirection };
        })
        .filter((x): x is { name: string; sid: string; lat: number; lng: number; along: number; ts: number | null; properties: any; validForDirection: boolean } => {
          if (!x) return false;
          if (!x.validForDirection) return false;
          
          // The Date.now() clock check has been completely removed!
          // If the stop made it here with a live ETA, it is guaranteed to be valid.

          if (seenNames.has(x.name)) return false;
          seenNames.add(x.name);
          return true;
        })
    
      .sort((a, b) => {
        // 1. CHRONOLOGICAL ORDER IS KING
        // If both have live ETAs, sort them exactly as they will arrive in real life.
        if (typeof a.ts === "number" && typeof b.ts === "number") {
          return a.ts - b.ts;
        }
        
        // 2. THE LIVE OVERRIDE
        // If one stop has a live ETA and the other doesn't, the live one MUST win!
        // This prevents dead loop geometry from scrambling the timeline.
        if (typeof a.ts === "number") return -1;
        if (typeof b.ts === "number") return 1;
        
        // 3. FALLBACK GEOMETRY SEQUENCE (For vehicles missing ETA data)
        const seqA = a.properties?.stop_sequence ?? a.properties?.Sequence ?? a.properties?.SequenceNum ?? 0;
        const seqB = b.properties?.stop_sequence ?? b.properties?.Sequence ?? b.properties?.SequenceNum ?? 0;
    
        if (seqA !== 0 || seqB !== 0) {
          return isLineReversed ? seqB - seqA : seqA - seqB;
        }
    
        // 4. FALLBACK SPATIAL SORTING
        // Eastbound tracks backwards (100 -> 0), so LARGER distances are closer/upcoming
        return isLineReversed ? b.along - a.along : a.along - b.along;
      });
  }, [isRouteViewActive, activeVehicle, routeShape, routeStops, liveEtas]);

  // Live alerts now fetched via useQuery above (5-minute polling).

  return (
    <>
      {/* 1. THE FLOATING MOBILE BUTTON */}
      <button
        onClick={() => setIsMobileOpen(true)}
        className={`md:hidden absolute top-4 left-4 z-40 p-3 bg-slate-900/90 text-white rounded-xl shadow-lg border border-slate-700 backdrop-blur-md transition-opacity duration-300 ${
          isMobileOpen ? "opacity-0 pointer-events-none" : "opacity-100"
        }`}
      >
        <Menu className="w-6 h-6" />
      </button>

      {/* 2. YOUR UPDATED ASIDE TAG (Includes your glass classes + mobile translations) */}
      <aside 
        className={`glass absolute left-4 top-4 bottom-4 flex flex-col rounded-2xl p-5 shadow-2xl transition-transform duration-300 ease-in-out z-50 w-[calc(100vw-2rem)] sm:w-[360px] ${
          isMobileOpen ? "translate-x-0" : "-translate-x-[150%]"
        } md:translate-x-0`}
      >
        {/* 3. THE MOBILE CLOSE BUTTON */}
        <div className="md:hidden absolute top-2 right-2 z-50">
          <button 
            onClick={() => setIsMobileOpen(false)}
            className="p-2 text-slate-400 hover:text-white bg-slate-800/50 rounded-full transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Header */}
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/20 ring-1 ring-primary/40">
              <Radio className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight">MetroPulse</h1>
              <p className="text-xs text-muted-foreground">Tempe, Arizona · Live</p>
            </div>
            <div className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 ring-1 ring-emerald-500/30">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              <span className="text-[10px] font-medium text-emerald-300">LIVE</span>
            </div>
          </div>
        </div>

        {/* Plan a Trip */}
        <div className="mb-4">
          <button
            onClick={onToggleRoutingMode}
            className={`flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
              routingMode
                ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_-2px_rgb(16,185,129)]"
                : "border-white/10 bg-white/[0.04] text-foreground hover:border-primary/40 hover:bg-primary/10"
            }`}
          >
            <MapPin className="h-3.5 w-3.5" />
            {routingMode ? "Cancel Trip Planner" : "Plan a Trip"}
          </button>

          {routingMode && (
            <div className="mt-2 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs">
              {/* Walking radius adjuster */}
              <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Footprints className="h-3.5 w-3.5 text-emerald-300" />
                  <span className="text-[11px] font-semibold text-foreground/90">Walking Radius</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onChangeWalkRadius(walkRadiusMiles - 0.1)}
                    disabled={walkRadiusMiles <= 0.2}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-foreground transition hover:bg-white/[0.1] disabled:opacity-40"
                    aria-label="Decrease radius"
                  >
                    −
                  </button>
                  <span className="min-w-[44px] text-center font-mono text-[12px] font-semibold text-emerald-200">
                    {walkRadiusMiles.toFixed(1)} mi
                  </span>
                  <button
                    type="button"
                    onClick={() => onChangeWalkRadius(walkRadiusMiles + 0.1)}
                    disabled={walkRadiusMiles >= 3.0}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-foreground transition hover:bg-white/[0.1] disabled:opacity-40"
                    aria-label="Increase radius"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-emerald-200/30" />
                <span className="min-w-0 flex-1 truncate">
                  {startPin
                    ? tripPlan.startStops.length > 0
                      ? `${tripPlan.startStops.length} stops within ${walkRadiusMiles.toFixed(1)} mi`
                      : `No stops within ${walkRadiusMiles.toFixed(1)} mi`
                    : "Click map to set start"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-red-500 ring-2 ring-red-200/30" />
                <span className="min-w-0 flex-1 truncate">
                  {endPin
                    ? tripPlan.endStops.length > 0
                      ? `${tripPlan.endStops.length} stops within ${walkRadiusMiles.toFixed(1)} mi`
                      : `No stops within ${walkRadiusMiles.toFixed(1)} mi`
                    : "Click map to set destination"}
                </span>
              </div>

              {startPin && endPin && (
                <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
                  {tripPlan.options.length === 0 ? (
                    <p className="text-[11px] text-amber-300/80">
                      No routes connect these two areas. Try widening your radius.
                    </p>
                  ) : (
                    <>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Best Trip Options ({tripPlan.options.length})
                      </p>
                      <ul className="-mr-2 max-h-72 space-y-2 overflow-y-auto pr-2">
                        {tripPlan.options.slice(0, 8).map((o, idx) => {
                          const TypeIcon =
                            o.vehicleType === "rail"
                              ? TrainFront
                              : o.vehicleType === "streetcar"
                              ? TramFront
                              : Bus;
                          const optKey = `${o.routeId}|${o.direction}`;
                          const isSelected = selectedTripKey === optKey;
                          const mins = Math.max(0, Math.round((o.eta * 1000 - Date.now()) / 60000));
                          const routeLabel =
                            o.vehicleType === "rail"
                              ? "Light Rail"
                              : o.vehicleType === "streetcar"
                              ? "Streetcar"
                              : `Route ${o.routeId}`;
                          return (
                            <li key={`${optKey}-${idx}`}>
                              <button
                                type="button"
                                onClick={() => onSelectTripOption(optKey)}
                                className={`w-full rounded-lg border p-2 text-left transition ${
                                  isSelected
                                    ? "border-primary/60 bg-primary/15 shadow-[0_0_12px_-2px_rgba(99,102,241,0.6)]"
                                    : "border-white/10 bg-white/[0.04] hover:border-primary/40 hover:bg-white/[0.07]"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <TypeIcon className="h-3.5 w-3.5 text-primary" />
                                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
                                    {routeLabel} - {o.direction}
                                  </span>
                                  {o.hasActiveVehicle ? (
                                    <span className="shrink-0 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-200">
                                      {mins} min
                                    </span>
                                  ) : (
                                    <span className="shrink-0 rounded-md bg-slate-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                                      Scheduled
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 flex items-start gap-1 text-[11px] text-foreground/90">
                                  <Footprints className="mt-0.5 h-3 w-3 shrink-0 text-emerald-300" />
                                  <span>
                                    Walk {o.walkMinutes} min ({o.startStop.miles.toFixed(2)} mi) to{" "}
                                    <span className="font-semibold">{o.startStop.name}</span>
                                  </span>
                                </p>
                                <p className="mt-0.5 flex items-start gap-1 text-[11px] text-muted-foreground">
                                  <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-red-300" />
                                  <span>
                                    Arrive near <span className="font-semibold text-foreground">{o.endStop.name}</span>
                                  </span>
                                </p>
                                {o.hasActiveVehicle ? (
                                  <p
                                    className="mt-1 text-[10px] text-emerald-200/90"
                                    suppressHydrationWarning
                                  >
                                    Next vehicle at{" "}
                                    {new Date(o.eta * 1000).toLocaleTimeString([], {
                                      hour: "numeric",
                                      minute: "2-digit",
                                    })}
                                  </p>
                                ) : (
                                  <p className="mt-1 text-[10px] text-slate-300/80">
                                    {routeLabel} serves this trip. No live vehicles currently in range—refer to standard schedule.
                                  </p>
                                )}
                                {isSelected && (
                                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
                                    Focus mode active — tap again to clear
                                  </p>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>
              )}

              {(startPin || endPin) && (
                <button
                  onClick={onClearTripPlan}
                  className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground"
                >
                  <X className="h-3 w-3" /> Clear Route
                </button>
              )}
            </div>
          )}
        </div>


      {/* Search (hidden when a stop is selected — Back to All Vehicles restores it) */}
      {!selectedStop && (
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search route or stop (e.g. 72, Rural)"
            className="w-full rounded-xl border border-border bg-input/40 py-2.5 pl-9 pr-3 text-sm placeholder:text-muted-foreground/70 outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
          />
        </div>
      )}

      {!selectedStop && search.trim() !== "" && matchingStops.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Matching Stops ({matchingStops.length})
            </span>
          </div>
          <ul className="-mr-2 max-h-44 space-y-1 overflow-y-auto pr-2">
            {matchingStops.map((s) => (
              <li key={`${s.id}-${s.name}`}>
                <button
                  type="button"
                  onClick={() => onPickStop(s)}
                  className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left text-xs transition hover:border-primary/40 hover:bg-primary/10"
                  title="Open departure board"
                >
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">Departures →</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeVehicle && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Showing route</div>
            <div className="truncate text-sm font-semibold">Route {activeVehicle.route_id}</div>
          </div>
          <button
            onClick={onClearSelection}
            className="rounded-md p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
            aria-label="Clear selected route"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isRouteViewActive && activeVehicle && (
        <div className="mb-3 rounded-xl border border-white/10 bg-white/[0.03]">
          <button
            onClick={() => setItineraryOpen((o) => !o)}
            className="flex w-full items-center justify-between px-3 py-2 text-left"
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Upcoming Stops ({upcomingStops.length})
            </span>
            <span className="text-xs text-muted-foreground">{itineraryOpen ? "−" : "+"}</span>
          </button>
          {itineraryOpen && (
            <ul className="max-h-56 overflow-y-auto border-t border-white/5 px-2 py-1.5">
              {upcomingStops.length === 0 && (
                <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No upcoming stops.
                </li>
              )}
              {upcomingStops.map((s, idx) => (
                <li key={`${s.sid}-${idx}`}>
                  <button
                    type="button"
                    onClick={() => onSelectStop(s.lat, s.lng)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none"
                    title="Center map on this stop"
                  >
                    <MapPin className="h-3 w-3 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span
                      className={`shrink-0 font-mono text-[11px] ${s.ts ? "text-emerald-300" : "text-muted-foreground"}`}
                      suppressHydrationWarning
                    >
                      {s.ts
                        ? new Date(s.ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                        : "No live ETA"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}


      {/* Filters */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        {(Object.keys(typeMeta) as VehicleType[]).map((t) => {
          const meta = typeMeta[t];
          const Icon = meta.icon;
          const active = filters[t];
          return (
            <button
              key={t}
              onClick={() => onToggle(t)}
              className={`group flex flex-col items-center gap-1 rounded-xl border p-2.5 text-xs transition ${
                active
                  ? "border-white/15 bg-white/5"
                  : "border-transparent bg-white/[0.02] opacity-50 hover:opacity-80"
              }`}
              style={active ? { boxShadow: `0 0 0 1px ${meta.color}40, 0 0 16px ${meta.color}25` } : {}}
            >
              <Icon className="h-4 w-4" style={{ color: meta.color }} />
              <span className="font-medium">{meta.label}</span>
              <span className="text-[10px] text-muted-foreground">{counts[t]} active</span>
            </button>
          );
        })}
      </div>

      {/* Direction filter */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Compass className="h-3 w-3" />
            Direction
          </div>
          {selectedDirections.length > 0 && (
            <button
              onClick={() => selectedDirections.forEach((d) => onToggleDirection(d))}
              className="text-[10px] text-muted-foreground transition hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {DIRECTION_OPTIONS.map((d) => {
            const active = selectedDirections.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => onToggleDirection(d)}
                aria-pressed={active}
                className={`rounded-lg border px-1 py-1.5 text-[11px] font-medium transition ${
                  active
                    ? "border-primary/60 bg-primary/15 text-primary shadow-[0_0_12px_-2px_var(--primary)]"
                    : "border-white/10 bg-white/[0.02] text-muted-foreground hover:border-white/20 hover:text-foreground"
                }`}
                title={d}
              >
                {d.slice(0, 1)}
                <span className="hidden sm:inline">{d.slice(1, -5)}</span>
              </button>
            );
          })}
        </div>
      </div>


      {selectedStop ? (
        <>
          {/* Departure board */}
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              onClick={onClearSelectedStop}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:bg-white/[0.08] hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Back to All Vehicles
            </button>
            <span className="text-[10px] text-muted-foreground" suppressHydrationWarning>
              {last ? last.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "..."}
            </span>
          </div>
          <div className="mb-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Departures</div>
            <div className="truncate text-sm font-semibold">{selectedStop.name}</div>
          </div>
          <div className="-mr-2 mb-4 max-h-[28%] overflow-y-auto pr-2">
            {departures.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No tracked arrivals.</p>
            )}
            <ul className="space-y-1.5">
              {departures.map(({ v, eta }) => {
                const meta = typeMeta[v.vehicle_type];
                const Icon = meta.icon;
                return (
                  <li key={v.id}>
                    <button
                      onClick={() => onSelectVehicle(v)}
                      className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-white/[0.02] px-2.5 py-2 text-left text-xs transition hover:border-white/10 hover:bg-white/[0.05]"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold">Route {v.route_id}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{v.direction}</div>
                      </div>
                      <span
                        className={`shrink-0 font-mono text-[11px] ${eta ? "text-emerald-300" : "text-muted-foreground"}`}
                        suppressHydrationWarning
                      >
                        {eta
                          ? new Date(eta * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                          : v.delay_seconds > 60
                          ? `+${Math.floor(v.delay_seconds / 60)}m`
                          : v.delay_seconds < -60
                          ? `-${Math.floor(Math.abs(v.delay_seconds) / 60)}m`
                          : "On time"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
        <>
          {/* Vehicle feed */}
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Vehicles ({filtered.length})
            </h2>
            <span className="text-[10px] text-muted-foreground" suppressHydrationWarning>
                {last ? last.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "..."}
              </span>
          </div>
          <div className="-mr-2 mb-4 max-h-[28%] overflow-y-auto pr-2">
            {filtered.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">No vehicles match.</p>
            )}
            <ul className="space-y-1.5">
              {filtered.slice(0, 30).map((v) => {
                const meta = typeMeta[v.vehicle_type];
                const Icon = meta.icon;
                return (
                  <li key={v.id}>
                    <button
                      onClick={() => onSelectVehicle(v)}
                      className="flex w-full items-center gap-3 rounded-lg border border-transparent bg-white/[0.02] px-2.5 py-2 text-left text-xs transition hover:border-white/10 hover:bg-white/[0.05]"
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: meta.color }} />
                      <span className="font-semibold">Route {v.route_id}</span>
                      <span className="truncate text-muted-foreground">{v.direction}</span>
                      <span
                        className={`ml-auto shrink-0 font-medium ${
                          v.delay_seconds > 60 ? "text-amber-400" : v.delay_seconds < -60 ? "text-emerald-400" : "text-emerald-400"
                        }`}
                      >
                        {v.delay_seconds > 60
                          ? `+${Math.floor(v.delay_seconds / 60)}m late`
                          : v.delay_seconds < -60
                          ? `${Math.floor(Math.abs(v.delay_seconds) / 60)}m early`
                          : "On time"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {/* Alerts */}
      <div className="mt-auto flex min-h-0 flex-1 flex-col">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Live Alerts
        </h2>
        <div className="-mr-2 flex-1 overflow-y-auto pr-2">
          {liveAlerts.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground" suppressHydrationWarning>
              No current alerts as of {last ? `${last.toLocaleDateString()} ${last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "..."}
            </p>
          ) : (
            <ul className="space-y-2">
              {liveAlerts.map((a) => {
                const Icon = severityIcon[a.severity];
                const isExpanded = expandedAlert === a.id;
                
                return (
                  <li
                    key={a.id}
                    onClick={() => setExpandedAlert(isExpanded ? null : a.id)}
                    className="cursor-pointer rounded-xl border border-white/5 bg-white/[0.03] p-3 transition hover:bg-white/[0.06]"
                  >
                    <div className="flex items-start gap-2.5">
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${severityColor[a.severity]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {a.routes.slice(0, 4).map((r) => (
                            <span
                              key={r}
                              className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/90"
                            >
                              {r === "System" ? "SYSTEM" : `ROUTE ${r}`}
                            </span>
                          ))}
                          {a.routes.length > 4 && (
                            <span className="text-[10px] text-muted-foreground">+{a.routes.length - 4}</span>
                          )}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {a.isMock ? "System Test Alert" : a.time}
                          </span>
                        </div>
                        <p className={`mt-1 text-xs leading-snug ${isExpanded ? '' : 'line-clamp-2'}`}>
                          {a.title}
                        </p>
                        {isExpanded && a.description && (
                          <p className="mt-2 border-t border-white/10 pt-2 text-xs text-muted-foreground">
                            {a.description}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </aside>
  </>
  );
}
