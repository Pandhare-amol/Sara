import { ApiToolAdapter, ExecutionContext } from '../ApiToolAdapter';
import { apiDiscovery } from '../ApiDiscovery';

export class SearchApiAdapter extends ApiToolAdapter {
    public name = 'searchWeb';
    public capability = 'search.web';

    constructor() {
        super();
        apiDiscovery.discoverApi({
            id: 'duckduckgo_lite',
            name: 'DuckDuckGo Lite',
            category: 'Search',
            baseUrl: 'https://api.duckduckgo.com',
            capabilities: ['search.web'],
            authentication: { required: false, type: 'none' },
        });
        apiDiscovery.validateApi('duckduckgo_lite');
    }

    protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
        const { query } = input;
        if (!query) throw new Error("Query is required for search.");

        const url = `${provider.baseUrl}?q=${encodeURIComponent(query)}&format=json`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Search API Error: ${response.statusText}`);
        }

        const data = await response.json();
        return {
            results: data.RelatedTopics?.slice(0, 5).map((t: any) => ({
                text: t.Text,
                url: t.FirstURL
            })) || []
        };
    }
}

export const searchApiTool = new SearchApiAdapter();
