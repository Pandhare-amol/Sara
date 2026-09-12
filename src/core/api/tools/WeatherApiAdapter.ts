import { ApiToolAdapter, ExecutionContext } from '../ApiToolAdapter';
import { apiDiscovery } from '../ApiDiscovery';

export class WeatherApiAdapter extends ApiToolAdapter {
    public name = 'getWeather';
    public capability = 'weather.current';

    constructor() {
        super();
        // Register a default provider if none exists
        apiDiscovery.discoverApi({
            id: 'openweather_default',
            name: 'OpenWeatherMap',
            category: 'Weather',
            baseUrl: 'https://api.openweathermap.org/data/2.5/weather',
            capabilities: ['weather.current'],
            authentication: { required: true, type: 'api_key' },
        });
        // Mock validation for the purpose of the setup
        apiDiscovery.validateApi('openweather_default');
    }

    protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
        const { location } = input;
        if (!location) throw new Error("Location is required for weather lookup.");

        const url = `${provider.baseUrl}?q=${encodeURIComponent(location)}&appid=${credentials}&units=metric`;
        
        // Use Node's built-in fetch
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Weather API Error: ${response.statusText}`);
        }

        const data = await response.json();
        return {
            temperature: data.main?.temp,
            condition: data.weather?.[0]?.description,
            location: data.name
        };
    }
}

export const weatherApiTool = new WeatherApiAdapter();
