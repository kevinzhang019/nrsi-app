import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  weatherRunFactor,
  weatherComponentFactors,
  NEUTRAL_WEATHER,
  parseCoversHtml,
  type WeatherInfo,
} from "./weather";

const COVERS_FIXTURE = readFileSync(
  join(__dirname, "__fixtures__/covers-mlb.html"),
  "utf-8",
);

const base: WeatherInfo = {
  tempF: null,
  windMph: null,
  windDir: null,
  windCardinal: null,
  precipPct: null,
  humidityPct: null,
  pressureInHg: null,
  isDome: false,
  source: "covers",
};

describe("weatherRunFactor", () => {
  it("returns 1.0 for dome regardless of inputs", () => {
    expect(weatherRunFactor({ ...base, isDome: true, tempF: 100, windMph: 30, windDir: "out" })).toBe(1.0);
  });

  it("boosts on hot day with wind out", () => {
    const f = weatherRunFactor({ ...base, tempF: 90, windMph: 12, windDir: "out" });
    expect(f).toBeGreaterThan(1.05);
  });

  it("suppresses on cold with wind in", () => {
    const f = weatherRunFactor({ ...base, tempF: 50, windMph: 12, windDir: "in" });
    expect(f).toBeLessThan(0.95);
  });

  it("clamps in [0.85, 1.15]", () => {
    const high = weatherRunFactor({ ...base, tempF: 110, windMph: 30, windDir: "out" });
    const low = weatherRunFactor({ ...base, tempF: 20, windMph: 30, windDir: "in", precipPct: 90 });
    expect(high).toBeLessThanOrEqual(1.15);
    expect(low).toBeGreaterThanOrEqual(0.85);
  });
});

describe("weatherComponentFactors", () => {
  it("dome is neutral on every component", () => {
    const f = weatherComponentFactors({ ...base, isDome: true, tempF: 100, windMph: 30, windDir: "out" });
    expect(f).toEqual(NEUTRAL_WEATHER);
  });

  it("K and BB are unaffected by weather (literature says so)", () => {
    const hot = weatherComponentFactors({ ...base, tempF: 95, windMph: 15, windDir: "out", humidityPct: 80 });
    expect(hot.k).toBe(1);
    expect(hot.bb).toBe(1);
  });

  it("HR moves more than 2B/3B which moves more than 1B", () => {
    const hot = weatherComponentFactors({ ...base, tempF: 95, windMph: 15, windDir: "out" });
    expect(hot.hr).toBeGreaterThan(hot.double);
    expect(hot.double).toBeGreaterThan(hot.single);
    expect(hot.single).toBeGreaterThanOrEqual(1);
  });

  it("cold + wind in suppresses HR", () => {
    const cold = weatherComponentFactors({ ...base, tempF: 45, windMph: 18, windDir: "in" });
    expect(cold.hr).toBeLessThan(1);
  });

  it("high humidity boosts HR (less dense air)", () => {
    const dry = weatherComponentFactors({ ...base, tempF: 75, humidityPct: 20 });
    const humid = weatherComponentFactors({ ...base, tempF: 75, humidityPct: 90 });
    expect(humid.hr).toBeGreaterThan(dry.hr);
  });

  it("low pressure boosts HR; high pressure suppresses", () => {
    const lowP = weatherComponentFactors({ ...base, tempF: 75, pressureInHg: 29.5 });
    const highP = weatherComponentFactors({ ...base, tempF: 75, pressureInHg: 30.5 });
    expect(lowP.hr).toBeGreaterThan(highP.hr);
  });
});

describe("parseCoversHtml", () => {
  it("extracts Detroit @ Atlanta brick (Truist Park, NW wind, ~64°F)", async () => {
    const w = await parseCoversHtml(COVERS_FIXTURE, "Detroit Tigers", "Atlanta Braves");
    expect(w.source).toBe("covers");
    expect(w.tempF).toBeGreaterThan(60);
    expect(w.tempF).toBeLessThan(70);
    expect(w.windMph).toBeGreaterThan(8);
    expect(w.windMph).toBeLessThan(13);
    // wind dir should be a real classification, not null
    expect(["out", "in", "cross"]).toContain(w.windDir);
    expect(w.humidityPct).toBeGreaterThan(60);
    expect(w.humidityPct).toBeLessThan(80);
  });

  it("extracts St. Louis @ Pittsburgh brick (PNC Park, NE wind, ~45°F)", async () => {
    const w = await parseCoversHtml(COVERS_FIXTURE, "St. Louis Cardinals", "Pittsburgh Pirates");
    expect(w.source).toBe("covers");
    expect(w.tempF).toBeGreaterThan(40);
    expect(w.tempF).toBeLessThan(50);
    expect(w.windMph).toBeGreaterThan(8);
    expect(["out", "in", "cross"]).toContain(w.windDir);
  });

  it("returns DEFAULT for a matchup not in the fixture", async () => {
    const w = await parseCoversHtml(COVERS_FIXTURE, "New York Mets", "Los Angeles Dodgers");
    expect(w.source).toBe("fallback");
  });

  it("returns DEFAULT when team names are unknown", async () => {
    const w = await parseCoversHtml(COVERS_FIXTURE, "Imaginary Team", "Fake Squad");
    expect(w.source).toBe("fallback");
  });
});
