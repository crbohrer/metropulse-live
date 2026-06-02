import { Bus, TrainFront, TramFront, Search, AlertTriangle, Info, AlertOctagon, Radio, X, MapPin } from "lucide-react";
import { useState, useEffect, useMemo } from 'react';
import { Menu, X } from "lucide-react";
import type { Vehicle, VehicleType, TransitAlert } from "@/lib/transit-types";
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
}


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
}: Props) {
  const [liveAlerts, setLiveAlerts] = useState<TransitAlert[]>([]);
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);
  const [, forceUpdate] = useState({});
  const [railEtas, setRailEtas] = useState<Record<string, number>>({});
  const [itineraryOpen, setItineraryOpen] = useState(true);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const filtered = vehicles.filter(
    (v) =>
      filters[v.vehicle_type] &&
      (search.trim() === "" ||
        v.route_id.toLowerCase().includes(search.toLowerCase()))
  );

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
    if (rawRid === "A") {
      const dLower = normalizedDir.toLowerCase();
      normalizedDir = (dLower.includes("north") || dLower.includes("west")) ? "Westbound" : "Eastbound";
    } else if (rawRid === "B") {
      const dLower = normalizedDir.toLowerCase();
      // Route B is the North/South corridor!
      normalizedDir = (dLower.includes("east") || dLower.includes("south")) ? "Southbound" : "Northbound";
    }

    // 2. IDENTIFY REVERSED GEOMETRY
    // Route A geometry is Mesa(0) to Phoenix(100), so Eastbound travels backwards.
    // Route B geometry is Baseline(0) to Metro Pkwy(100), so Southbound travels backwards.
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
          const threshold = isRail ? 0.00002 : 0.00000004;
          if (!nearest || nearest.distSq > threshold) return null;
        }

        const along = ghosted ? alongDistance(ghosted.chosen, [lng, lat]) : 0;
          const name = f.properties?.stop_name || f.properties?.StationName || "Transit Stop";

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

          // 2. TERMINAL-SAFE RAIL DICTIONARY LOOKUP
          if (!ts && liveEtas && (rawRid === "A" || rawRid === "B" || rawRid === "S")) {
            const cleanName = name.replace(" Station", "").replace(" Stn", "").trim();
            const stationDict = RAIL_STATION_CODES[cleanName];

            if (stationDict) {
              const possibleCodes = Object.values(stationDict);
              let foundMatch = false;

              for (const code of possibleCodes) {
                if (code && typeof liveEtas[code] === "number") {
                  ts = liveEtas[code];
                  foundMatch = true;
                  break;
                }
              }

              if (!foundMatch) validForDirection = false; 
            } else {
              validForDirection = false;
            }
          }

          // 🚨 THE KILL SWITCH 🚨
          if (!validForDirection) {
             return null; 
          }

          // 🚨 THE TEMPORAL VETO (SAFETY BUBBLE) 🚨
          let isPassed = false;

          if (typeof ts === "number") {
            const timeUntilMs = (ts * 1000) - Date.now();

            if (timeUntilMs > 0) {
              isPassed = false; // ETA is in the future, it is upcoming!
            } else {
              // ETA has expired! Is the vehicle still sitting at the red light?
              let drivenAway = true;
              if (ghosted) {
                // Check the absolute distance between the vehicle and the stop
                const distDiff = Math.abs(along - ghosted.vehicleAlong);
                if (distDiff < 0.05) { // 0.05 = 50-meter safety bubble
                  drivenAway = false; 
                }
              }
              // If the time expired and it left the 50m bubble, it is passed!
              isPassed = drivenAway; 
            }
          } else if (ghosted) {
            // Fallback for stops with no live ETA data
            isPassed = isLineReversed ? along > ghosted.vehicleAlong : along < ghosted.vehicleAlong;
          }

          // Purge passed stops from the sidebar list
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

  // Fetch active transit alerts on load and refresh when 'last' changes
  useEffect(() => {
    getLiveAlerts()
      .then((data) => {
        if (data) setLiveAlerts(data);
      })
      .catch((err) => console.error("Alert layout stream failed:", err));
  }, [last]);

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

      {/* Search */}
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search route (e.g. 72, 0)"
          className="w-full rounded-xl border border-border bg-input/40 py-2.5 pl-9 pr-3 text-sm placeholder:text-muted-foreground/70 outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/20"
        />
      </div>

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
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {a.route !== "System" ? `ROUTE ${a.route}` : "SYSTEM"}
                          </span>
                          <span className="text-[10px] text-muted-foreground">{a.time}</span>
                        </div>
                        <p className={`mt-0.5 text-xs leading-snug ${isExpanded ? '' : 'line-clamp-2'}`}>
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
