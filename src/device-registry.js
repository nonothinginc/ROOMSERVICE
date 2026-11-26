const modules = import.meta.glob('./devices/*.js', { eager: true });

export const DEVICES = {};

for (const [path, mod] of Object.entries(modules)) {
  if (!mod || !mod.meta || typeof mod.createNode !== 'function') {
    console.warn(`[ROOMSERVICE] Skipping invalid DSP module: ${path}`);
    continue;
  }
  const { meta, createNode } = mod;
  if (!meta.id || !meta.name || !meta.category || !Array.isArray(meta.params)) {
    console.warn(`[ROOMSERVICE] Invalid meta in DSP module: ${path}`);
    continue;
  }
  DEVICES[meta.id] = {
    meta: {
      ...meta,
      params: meta.params.slice(0, 6),
      extendedParams: Array.isArray(meta.extendedParams) ? meta.extendedParams : []
    },
    createNode
  };
}

export function getDevicesByCategory(category) {
  return Object.values(DEVICES)
    .filter((d) => d.meta.category === category)
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name));
}

export function getDevice(id) {
  return DEVICES[id] || null;
}

export function getDefaultParams(id) {
  const dev = DEVICES[id];
  if (!dev) return {};
  const params = {};
  for (const p of [...dev.meta.params, ...(dev.meta.extendedParams || [])]) {
    params[p.id] = p.default;
  }
  return params;
}
