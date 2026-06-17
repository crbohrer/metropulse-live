import stopsData from "./stops.json";

export interface StopRecord {
  stop_id: number;
  stop_code: number;
  stop_name: string;
  stop_desc?: string;
  stop_lat: number;
  stop_lon: number;
}

export const ALL_STOPS = stopsData as StopRecord[];

export interface PickableStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

/** Stops whose name contains the query, deduped by name. */
export function findStopsByName(query: string, limit = 20): PickableStop[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const out: PickableStop[] = [];
  for (const s of ALL_STOPS) {
    if (!s.stop_name) continue;
    const lower = s.stop_name.toLowerCase();
    if (!lower.includes(q)) continue;
    if (seen.has(lower)) continue;
    if (!Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    seen.add(lower);
    out.push({
      id: String(s.stop_id),
      name: s.stop_name,
      lat: s.stop_lat,
      lng: s.stop_lon,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Every stop_id / stop_code (with leading-zero variants) for stops whose name matches the query. */
export function findStopIdsByQuery(query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const ids = new Set<string>();
  if (!q) return ids;
  for (const s of ALL_STOPS) {
    if (!s.stop_name || !s.stop_name.toLowerCase().includes(q)) continue;
    addAllIdVariants(ids, s);
  }
  return ids;
}

/** Every stop_id / stop_code for stops with the exact same name (case-insensitive). */
export function findStopIdsByExactName(name: string): Set<string> {
  const target = name.trim().toLowerCase();
  const ids = new Set<string>();
  if (!target) return ids;
  for (const s of ALL_STOPS) {
    if (s.stop_name && s.stop_name.toLowerCase() === target) {
      addAllIdVariants(ids, s);
    }
  }
  return ids;
}

/** Free nearest-stop lookup using planar distance scaled by latitude. */
export function findNearestStop(lat: number, lng: number): PickableStop | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best: StopRecord | null = null;
  let bestDist = Infinity;
  for (const s of ALL_STOPS) {
    if (!Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    const dx = (s.stop_lon - lng) * cosLat;
    const dy = s.stop_lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (!best) return null;
  return {
    id: String(best.stop_id),
    name: best.stop_name,
    lat: best.stop_lat,
    lng: best.stop_lon,
  };
}

/** Haversine distance in miles between two coordinates. */
export function distanceMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.7613; // Earth radius (miles)
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface PickableStopWithDistance extends PickableStop {
  miles: number;
}

/** All stops within `radiusMiles` of (lat, lng), deduped by name, sorted nearest first. */
export function findStopsWithinRadius(
  lat: number,
  lng: number,
  radiusMiles = 1,
): PickableStopWithDistance[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const out: PickableStopWithDistance[] = [];
  const seen = new Map<string, number>(); // name -> index in out
  for (const s of ALL_STOPS) {
    if (!Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    const d = distanceMiles(lat, lng, s.stop_lat, s.stop_lon);
    if (d > radiusMiles) continue;
    const key = (s.stop_name || "").toLowerCase();
    const existing = seen.get(key);
    if (existing != null) {
      if (d < out[existing].miles) {
        out[existing] = { id: String(s.stop_id), name: s.stop_name, lat: s.stop_lat, lng: s.stop_lon, miles: d };
      }
      continue;
    }
    seen.set(key, out.length);
    out.push({ id: String(s.stop_id), name: s.stop_name, lat: s.stop_lat, lng: s.stop_lon, miles: d });
  }
  out.sort((a, b) => a.miles - b.miles);
  return out;
}

/** All stop_id / stop_code variants for every stop within `radiusMiles` of (lat,lng). */
export function findStopIdsWithinRadius(lat: number, lng: number, radiusMiles = 1): Set<string> {
  const ids = new Set<string>();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return ids;
  for (const s of ALL_STOPS) {
    if (!Number.isFinite(s.stop_lat) || !Number.isFinite(s.stop_lon)) continue;
    if (distanceMiles(lat, lng, s.stop_lat, s.stop_lon) > radiusMiles) continue;
    addAllIdVariants(ids, s);
    // Also include any other stops sharing the same name (different platforms).
    if (s.stop_name) {
      for (const t of ALL_STOPS) {
        if (t.stop_name && t.stop_name.toLowerCase() === s.stop_name.toLowerCase()) {
          addAllIdVariants(ids, t);
        }
      }
    }
  }
  return ids;
}

function addAllIdVariants(ids: Set<string>, s: StopRecord) {
  if (s.stop_id != null) {
    const id = String(s.stop_id);
    ids.add(id);
    ids.add(id.replace(/^0+/, ""));
  }
  if (s.stop_code != null && s.stop_code !== 0) {
    const code = String(s.stop_code);
    ids.add(code);
    ids.add(code.replace(/^0+/, ""));
  }
}
