import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Star, MapPin, X, ChevronDown, ChevronRight } from "lucide-react";
import { getStopDepartures } from "@/lib/transit.functions";
import { findStopIdsByExactName } from "@/lib/stops-index";
import type { FavoriteStop } from "@/hooks/use-favorites";

interface Props {
  favorites: FavoriteStop[];
  onRemove: (name: string) => void;
  onPickStop: (s: { id: string; name: string; lat: number; lng: number }) => void;
}

export function StarredBoards({ favorites, onRemove, onPickStop }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-left transition hover:bg-amber-400/[0.1]"
      >
        <Star className="h-3.5 w-3.5 text-amber-400" fill="currentColor" />
        <span className="text-xs font-semibold uppercase tracking-wider text-amber-200">
          Starred Boards
        </span>
        <span className="ml-auto rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
          {favorites.length}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-amber-200/70" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-amber-200/70" />
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {favorites.length === 0 ? (
            <p className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] px-3 py-3 text-center text-[11px] text-muted-foreground">
              Tap the <Star className="inline h-3 w-3 text-amber-400" /> next to any stop to pin
              live arrivals here.
            </p>
          ) : (
            favorites.map((f) => (
              <StarredBoard
                key={`${f.name}-${f.id}`}
                stop={f}
                onRemove={() => onRemove(f.name)}
                onOpen={() => onPickStop(f)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function StarredBoard({
  stop,
  onRemove,
  onOpen,
}: {
  stop: FavoriteStop;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const fetchStopDepartures = useServerFn(getStopDepartures);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  const stopIds = useMemo(() => {
    const ids = findStopIdsByExactName(stop.name);
    if (stop.id) {
      ids.add(stop.id);
      ids.add(stop.id.replace(/^0+/, ""));
    }
    return Array.from(ids);
  }, [stop.name, stop.id]);

  const { data } = useQuery({
    queryKey: ["favorite-departures", stop.name, stopIds.join(",")],
    queryFn: () => fetchStopDepartures({ data: { stopIds } }),
    enabled: stopIds.length > 0,
    refetchInterval: 15000,
    staleTime: 10_000,
  });

  const upcoming = useMemo(() => {
    const list = data?.departures ?? [];
    const nowSec = now / 1000;
    return list.filter((d) => d.time >= nowSec).slice(0, 4);
  }, [data, now]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-foreground transition hover:text-amber-200"
          title="Open full departure board"
        >
          {stop.name}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Unstar ${stop.name}`}
          className="shrink-0 rounded-md p-1 text-muted-foreground/70 transition hover:bg-white/10 hover:text-red-300"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {upcoming.length === 0 ? (
        <p className="px-1 py-1 text-[10.5px] text-muted-foreground">No upcoming arrivals.</p>
      ) : (
        <ul className="space-y-1">
          {upcoming.map((d, i) => {
            const mins = Math.max(0, Math.round((d.time * 1000 - now) / 60000));
            return (
              <li
                key={`${d.tripId}-${d.stopId}-${i}`}
                className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 text-[11px]"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-foreground">Route {d.routeId}</span>
                  {d.delay > 60 && (
                    <span className="ml-1 text-amber-300">+{Math.floor(d.delay / 60)}m</span>
                  )}
                </span>
                <span
                  className={`shrink-0 font-mono ${
                    mins <= 1 ? "text-emerald-300 font-semibold" : "text-emerald-200/90"
                  }`}
                  suppressHydrationWarning
                >
                  {mins <= 0 ? "Now" : `${mins} min`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
