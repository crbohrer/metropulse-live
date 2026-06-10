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
