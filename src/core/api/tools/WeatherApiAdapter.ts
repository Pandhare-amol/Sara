import { ApiToolAdapter } from "../ApiToolAdapter";
import { apiDiscovery } from "../ApiDiscovery";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snowfall",
  73: "moderate snowfall",
  75: "heavy snowfall",
  77: "snow grains",
  80: "light rain showers",
  81: "moderate rain showers",
  82: "heavy rain showers",
  85: "light snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with light hail",
  99: "thunderstorm with heavy hail",
};

function validCoordinates(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } | null {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("Latitude and longitude must be valid coordinates.");
  }
  return { latitude: lat, longitude: lon };
}

async function fetchJson(url: URL): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Weather provider returned HTTP ${response.status}.`);
  return response.json();
}

export class WeatherApiAdapter extends ApiToolAdapter {
  public name = "getWeather";
  public capability = "weather.current";

  constructor() {
    super();
    apiDiscovery.discoverApi({
      id: "openweather_default",
      name: "OpenWeatherMap",
      category: "Weather",
      baseUrl: "https://api.openweathermap.org/data/2.5/weather",
      capabilities: [this.capability],
      authentication: { required: true, type: "api_key" },
      reliability: 55,
      pricing: { freeTier: true, notes: "Requires an OpenWeatherMap API key." },
    });
    void apiDiscovery.validateApi("openweather_default");

    apiDiscovery.discoverApi({
      id: "open_meteo_default",
      name: "Open-Meteo",
      category: "Weather",
      description: "Current weather and geocoding from the free Open-Meteo service; no key required.",
      baseUrl: OPEN_METEO_FORECAST_URL,
      documentationUrl: "https://open-meteo.com/en/docs",
      capabilities: [this.capability],
      authentication: { required: false, type: "none" },
      reliability: 70,
      pricing: { freeTier: true, notes: "No API key required for non-commercial use." },
    });
    void apiDiscovery.validateApi("open_meteo_default");
  }

  protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
    if (provider.id === "open_meteo_default") return this.fetchOpenMeteo(input);
    return this.fetchOpenWeather(provider, input, credentials);
  }

  private async fetchOpenMeteo(input: any): Promise<any> {
    const coordinates = validCoordinates(input.latitude, input.longitude);
    const location = typeof input.location === "string" ? input.location.trim().slice(0, 120) : "";
    if (!coordinates && !location) throw new Error("Provide a city name or valid latitude and longitude.");
    if ((input.latitude === undefined) !== (input.longitude === undefined)) {
      throw new Error("Provide both latitude and longitude, or a city name.");
    }

    let resolved = coordinates;
    let placeName = location;
    if (!resolved) {
      const geocodeUrl = new URL(OPEN_METEO_GEOCODING_URL);
      geocodeUrl.searchParams.set("name", location);
      geocodeUrl.searchParams.set("count", "1");
      geocodeUrl.searchParams.set("language", "en");
      geocodeUrl.searchParams.set("format", "json");
      const geocoding = await fetchJson(geocodeUrl);
      const first = Array.isArray(geocoding?.results) ? geocoding.results[0] : null;
      if (!first || !Number.isFinite(Number(first.latitude)) || !Number.isFinite(Number(first.longitude))) {
        throw new Error("Open-Meteo could not find that location.");
      }
      resolved = validCoordinates(first.latitude, first.longitude);
      placeName = [first.name, first.admin1, first.country].filter((part) => typeof part === "string" && part.trim()).join(", ");
    }

    const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
    forecastUrl.searchParams.set("latitude", String(resolved!.latitude));
    forecastUrl.searchParams.set("longitude", String(resolved!.longitude));
    forecastUrl.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m");
    forecastUrl.searchParams.set("timezone", "auto");
    const data = await fetchJson(forecastUrl);
    const current = data?.current;
    if (!current || !Number.isFinite(Number(current.temperature_2m))) {
      throw new Error("Open-Meteo returned an incomplete weather result.");
    }

    return {
      provider: "Open-Meteo",
      location: placeName || `${resolved!.latitude}, ${resolved!.longitude}`,
      temperature: Number(current.temperature_2m),
      apparentTemperature: Number.isFinite(Number(current.apparent_temperature)) ? Number(current.apparent_temperature) : undefined,
      temperatureUnit: data?.current_units?.temperature_2m || "°C",
      condition: WEATHER_CODES[Number(current.weather_code)] || "unknown conditions",
      humidity: Number.isFinite(Number(current.relative_humidity_2m)) ? Number(current.relative_humidity_2m) : undefined,
      windSpeed: Number.isFinite(Number(current.wind_speed_10m)) ? Number(current.wind_speed_10m) : undefined,
      windSpeedUnit: data?.current_units?.wind_speed_10m || "km/h",
      windDirection: Number.isFinite(Number(current.wind_direction_10m)) ? Number(current.wind_direction_10m) : undefined,
      observedAt: current.time,
      source: "https://open-meteo.com",
    };
  }

  private async fetchOpenWeather(provider: any, input: any, credentials: unknown): Promise<any> {
    const location = typeof input.location === "string" ? input.location.trim().slice(0, 120) : "";
    if (!location) throw new Error("Location is required for weather lookup.");
    const url = new URL(provider.baseUrl);
    url.searchParams.set("q", location);
    url.searchParams.set("appid", String(credentials || ""));
    url.searchParams.set("units", "metric");

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Weather provider returned HTTP ${response.status}.`);
    const data = await response.json();
    return {
      provider: "OpenWeatherMap",
      temperature: data.main?.temp,
      condition: data.weather?.[0]?.description,
      location: data.name,
      source: "https://openweathermap.org",
    };
  }
}

export const weatherApiTool = new WeatherApiAdapter();
