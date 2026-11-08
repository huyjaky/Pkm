import { useEffect, useState } from 'react';
import { loadMeta, mapName, section, type Meta } from './meta';
import type { Pos } from './session';

export function useMeta(): Meta | null {
  const [meta, setMeta] = useState<Meta | null>(null);
  useEffect(() => {
    let alive = true;
    loadMeta().then(m => alive && setMeta(m)).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return meta;
}

/** Human place name: the map-section (town/route) name, plus the exact map when indoors. */
export function placeName(meta: Meta | null, pos: Pos | null): string {
  if (!pos) return 'Chưa vào game';
  if (!meta) return '…';
  const map = mapName(meta, pos.group, pos.num);
  const sec = section(meta, pos.mapsec);
  const secName = sec?.name ? titleCase(sec.name) : '';
  if (!secName) return map;
  return secName.toLowerCase().replace(/\s/g, '') === map.toLowerCase().replace(/\s/g, '') ? secName : `${secName} · ${map}`;
}

export function titleCase(s: string) {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

/** Pixel position on region_map.png for a player position, or null when the section has no map square. */
export function regionPoint(meta: Meta, pos: Pos): { x: number; y: number } | null {
  const sec = section(meta, pos.mapsec);
  if (!sec?.rect) return null;
  const [rx, ry, rw, rh] = sec.rect;
  // Spread players across multi-square sections (long routes) using the position inside the map.
  const fx = pos.w > 0 ? Math.min(1, Math.max(0, pos.x / pos.w)) : 0.5;
  const fy = pos.h > 0 ? Math.min(1, Math.max(0, pos.y / pos.h)) : 0.5;
  return { x: rx + (rw > 8 ? fx * rw : rw / 2), y: ry + (rh > 8 ? fy * rh : rh / 2) };
}
