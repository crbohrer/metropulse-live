import { useCallback, useEffect, useState } from "react";

export interface FavoriteStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

const STORAGE_KEY = "metropulse.favorites.v1";

function readStored(): FavoriteStop[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is FavoriteStop =>
        x &&
        typeof x.name === "string" &&
        typeof x.lat === "number" &&
        typeof x.lng === "number",
    );
  } catch {
    return [];
  }
}

/** Persistent starred-stop list. Keyed by lowercase stop name. */
export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteStop[]>([]);

  // Hydrate on mount (avoids SSR mismatch).
  useEffect(() => {
    setFavorites(readStored());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    } catch {
      /* ignore quota errors */
    }
  }, [favorites]);

  const key = (name: string) => name.trim().toLowerCase();

  const isFavorite = useCallback(
    (name: string) => {
      const k = key(name);
      return favorites.some((f) => key(f.name) === k);
    },
    [favorites],
  );

  const toggle = useCallback((stop: FavoriteStop) => {
    setFavorites((prev) => {
      const k = key(stop.name);
      if (prev.some((f) => key(f.name) === k)) {
        return prev.filter((f) => key(f.name) !== k);
      }
      return [...prev, stop];
    });
  }, []);

  const remove = useCallback((name: string) => {
    const k = key(name);
    setFavorites((prev) => prev.filter((f) => key(f.name) !== k));
  }, []);

  return { favorites, isFavorite, toggle, remove };
}
