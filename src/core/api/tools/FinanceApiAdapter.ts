import { ApiToolAdapter, ExecutionContext } from '../ApiToolAdapter';
import { apiDiscovery } from '../ApiDiscovery';

export class FinanceApiAdapter extends ApiToolAdapter {
    public name = 'getFinanceData';
    public capability = 'finance.quote';

    constructor() {
        super();
        apiDiscovery.discoverApi({
            id: 'alphavantage_default',
            name: 'AlphaVantage',
            category: 'Finance',
            baseUrl: 'https://www.alphavantage.co/query',
            capabilities: ['finance.quote'],
            authentication: { required: true, type: 'api_key' },
        });
        apiDiscovery.validateApi('alphavantage_default');
    }

    protected async performApiCall(provider: any, input: any, credentials: any): Promise<any> {
        const { symbol } = input;
        if (!symbol) throw new Error("Stock symbol is required.");

        const url = `${provider.baseUrl}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${credentials}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Finance API Error: ${response.statusText}`);
        }

        const data = await response.json();
        const quote = data['Global Quote'];
        
        if (!quote || Object.keys(quote).length === 0) {
             // Sometimes AlphaVantage returns empty objects if limit exceeded or invalid symbol, 
             // though they usually return an info message.
             if (data['Information']) {
                 throw new Error(`AlphaVantage rate limit: ${data['Information']}`);
             }
             throw new Error("Invalid symbol or no data found.");
        }

        return {
            symbol: quote['01. symbol'],
            price: quote['05. price'],
            change: quote['09. change'],
            changePercent: quote['10. change percent']
        };
    }
}

export const financeApiTool = new FinanceApiAdapter();
