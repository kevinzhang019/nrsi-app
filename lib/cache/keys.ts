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
  weather: (gamePk: number) => `weather:${gamePk}`,
  schedule: (date: string) => `schedule:${date}`,
  runsByDate: (date: string) => `nrsi:runs:${date}`,
  watcherLock: (gamePk: number) => `nrsi:lock:${gamePk}`,
  snapshot: () => `nrsi:snapshot`,
  pubsubChannel: () => `nrsi:games`,
};
