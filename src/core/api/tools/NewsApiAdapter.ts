import { ApiToolAdapter, ExecutionContext } from '../ApiToolAdapter';
import { apiDiscovery } from '../ApiDiscovery';

export class NewsApiAdapter extends ApiToolAdapter {
    public name = 'getNews';
    public capability = 'news.top_headlines';

    constructor() {
        super();
        apiDiscovery.discoverApi({
            id: 'newsapi_default',
            name: 'NewsAPI',
            category: 'News',
            baseUrl: 'https://newsapi.org/v2/top-headlines',
            capabilities: ['news.top_headlines'],
            authentication: { required: true, type: 'api_key' },
        });
        apiDiscovery.validateApi('newsapi_default');
    }

    protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
        const { topic, country } = input;
        
        let url = `${provider.baseUrl}?apiKey=${credentials}`;
        if (topic) url += `&q=${encodeURIComponent(topic)}`;
        if (country) url += `&country=${encodeURIComponent(country)}`;
        if (!topic && !country) url += `&country=us`; // Default fallback
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`News API Error: ${response.statusText}`);
        }

        const data = await response.json();
        return {
            articles: data.articles?.slice(0, 5).map((a: any) => ({
                title: a.title,
                source: a.source?.name,
                url: a.url
            })) || []
        };
    }
}

export const newsApiTool = new NewsApiAdapter();
