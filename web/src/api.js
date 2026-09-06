export const api = {
  async get(path) {
    const res = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  },
  overview: () => api.get('/overview'),
  meta: () => api.get('/meta'),
  matches: (params = {}) => api.get(`/matches?${new URLSearchParams(params)}`),
  match: (id) => api.get(`/matches/${encodeURIComponent(id)}`),
  competitions: () => api.get('/competitions'),
  competition: (id, season) => api.get(`/competitions/${encodeURIComponent(id)}${season ? `?season=${encodeURIComponent(season)}` : ''}`),
  team: (id) => api.get(`/teams/${encodeURIComponent(id)}`),
  streams: (params = {}) => api.get(`/streams?${new URLSearchParams(params)}`),
};
