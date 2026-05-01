export const k = {
  batterSplit: (id: number, season: number, sit: "vl" | "vr") =>
    `bat:split:${id}:${season}:${sit}`,
  pitcherSplit: (id: number, season: number, sit: "vl" | "vr") =>
    `pit:split:${id}:${season}:${sit}`,
  hand: (id: number) => `hand:${id}`,
  parkFactors: (season: number) => `park:factors:${season}`,
  oaa: (season: number) => `oaa:${season}`,
  framing: (season: number) => `framing:${season}`,
  venue: (id: number) => `venue:${id}`,
  // v2: added windCardinal field (commit c9320bc). Bumped to invalidate
  // pre-deploy entries that lack the field — without this, workers running
  // new code still read stale cached WeatherInfo for up to 30 min and the
  // wind arrow doesn't render. Bump again on any future WeatherInfo shape change.
  weather: (gamePk: number) => `weather:v2:${gamePk}`,
  schedule: (date: string) => `schedule:${date}`,
  runsByDate: (date: string) => `nrxi:runs:${date}`,
  watcherLock: (gamePk: number) => `nrxi:lock:${gamePk}`,
  snapshot: () => `nrxi:snapshot`,
  pubsubChannel: () => `nrxi:games`,
};
