import { ApiProvider } from './types';
import { apiRegistry } from './ApiRegistry';
import { apiCredentialManager } from './ApiCredentialManager';
import { apiHealthMonitor } from './ApiHealthMonitor';

export class ApiSelector {
    
    /**
     * Selects the best available API provider for a given capability.
     * Takes into account health, credentials, and reliability.
     */
    public selectProvider(capability: string): ApiProvider | null {
        const providers = apiRegistry.getProvidersByCapability(capability);
        
        if (providers.length === 0) {
            console.warn(`[ApiSelector] No active providers found for capability: ${capability}`);
            return null;
        }

        // Filter out providers missing credentials (if required)
        const validProviders = providers.filter(provider => {
            if (provider.authentication.required) {
                return apiCredentialManager.validateCredential(provider.id);
            }
            return true;
        });

        if (validProviders.length === 0) {
            console.error(`[ApiSelector] Providers exist for ${capability}, but none have valid credentials.`);
            return null;
        }

        // Score providers
        const scoredProviders = validProviders.map(provider => {
            const health = apiHealthMonitor.getMetrics(provider.id);
            let score = provider.reliability || 50; // Base score
            
            if (health) {
                // Penalize for high failure rate or latency
                if (health.successRate < 80) score -= 20;
                if (health.averageLatency > 1000) score -= 10;
                
                // Boost for high success
                if (health.successRate > 95) score += 10;
            }

            return { provider, score };
        });

        // Sort by score descending
        scoredProviders.sort((a, b) => b.score - a.score);

        const selected = scoredProviders[0].provider;
        console.log(`[ApiSelector] Selected provider ${selected.id} for capability ${capability} (Score: ${scoredProviders[0].score})`);
        
        return selected;
    }
}

export const apiSelector = new ApiSelector();
