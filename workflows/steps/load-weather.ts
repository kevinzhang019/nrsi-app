import {
  loadWeather,
  weatherRunFactor,
  weatherComponentFactors,
  type WeatherInfo,
  type WeatherComponentFactors,
} from "@/lib/env/weather";
import { log } from "@/lib/log";

export async function loadWeatherStep(opts: {
  gamePk: number;
  awayTeam: string;
  homeTeam: string;
}): Promise<{ info: WeatherInfo; factor: number; components: WeatherComponentFactors }> {
  "use step";
  const { gamePk, awayTeam, homeTeam } = opts;
  log.info("step", "loadWeather:start", { gamePk, awayTeam, homeTeam });
  const info = await loadWeather(gamePk, awayTeam, homeTeam);
  const factor = weatherRunFactor(info);
  const components = weatherComponentFactors(info);
  log.info("step", "loadWeather:ok", { gamePk, factor, hr: components.hr });
  return { info, factor, components };
}
