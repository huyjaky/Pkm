/** Static game data extracted from the ROM source at build time (served by /api/meta). */
export type MapSection = { id: number; const: string; name: string; rect: [number, number, number, number] | null };

export type Meta = {
  romHash?: string;
  battleInput?: string[];
  symbols: Record<string, string>;
  maps: { id: string; name: string }[][];
  regionMap: { image: string; width: number; height: number; sections: MapSection[] };
  species: Record<string, { const: string; name: string }>;
  moves: Record<string, string>;
  items: Record<string, string>;
  types: Record<string, string>;
};

export const toID = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let cached: Promise<Meta> | null = null;
let speciesByShowdownId: Map<string, number> | null = null;
let sectionById: Map<number, MapSection> | null = null;

export function loadMeta(): Promise<Meta> {
  cached ??= fetch('/api/meta').then(r => {
    if (!r.ok) throw new Error('Không tải được dữ liệu game (meta.json)');
    return r.json();
  });
  return cached;
}

export function symbol(meta: Meta, name: string): number {
  const v = meta.symbols[name];
  if (!v) throw new Error(`ROM thiếu symbol ${name}`);
  return parseInt(v, 16);
}

export function mapName(meta: Meta, group: number, num: number): string {
  return meta.maps[group]?.[num]?.name ?? `Map ${group}.${num}`;
}

export function section(meta: Meta, id: number): MapSection | undefined {
  sectionById ??= new Map(meta.regionMap.sections.map(s => [s.id, s]));
  return sectionById.get(id);
}

/** Showdown species name ("Charizard-Mega-X") -> in-game species id, for sprites. */
export function speciesIdFromShowdown(meta: Meta, name: string): number | null {
  if (!speciesByShowdownId) {
    speciesByShowdownId = new Map();
    for (const [id, s] of Object.entries(meta.species)) {
      const n = Number(id);
      if (!speciesByShowdownId.has(toID(s.const))) speciesByShowdownId.set(toID(s.const), n);
    }
    for (const [id, s] of Object.entries(meta.species)) {
      if (!speciesByShowdownId.has(toID(s.name))) speciesByShowdownId.set(toID(s.name), Number(id));
    }
  }
  const id = toID(name);
  return speciesByShowdownId.get(id) ?? speciesByShowdownId.get(toID(name.split('-')[0])) ?? null;
}

export const spriteUrl = (id: number | null | undefined) => (id ? `/game/sprites/${id}.png` : '');
export const iconUrl = (id: number | null | undefined) => (id ? `/game/icons/${id}.png` : '');
