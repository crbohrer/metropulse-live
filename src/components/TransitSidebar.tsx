import { Bus, TrainFront, TramFront, Search, AlertTriangle, Info, AlertOctagon, Radio, X, MapPin } from "lucide-react";
import { useState, useEffect, useMemo } from 'react';
import type { Vehicle, VehicleType, TransitAlert } from "@/lib/transit-types";
import type { GeoJSON as RouteGeoJSON } from "@/lib/route-shapes.functions";
import { getLiveAlerts } from "@/lib/transit.functions";
import {
  alongDistance,
  buildGhostedRoute,
  filterRouteStops,
  getActiveRouteLines,
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
}: Props) {
  const [liveAlerts, setLiveAlerts] = useState<TransitAlert[]>([]);
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);
  const [itineraryOpen, setItineraryOpen] = useState(true);

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

  return (
    <aside className="glass absolute left-4 top-4 bottom-4 z-10 flex w-[360px] flex-col rounded-2xl p-5 shadow-2xl">
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
          placeholder="Search route (e.g. 72, Streetcar)"
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
  );
}
