import { ApiProvider } from './types';
import { apiRegistry } from './ApiRegistry';
import { publicApiCatalogManager } from './publicApiCatalog';

export class ApiDiscovery {
    
    /**
     * Validates and potentially registers a discovered API.
     * Starts in PENDING REVIEW state.
     */
    public discoverApi(rawApiData: Partial<ApiProvider>): ApiProvider {
        const id = rawApiData.id || this.generateId(rawApiData.name);
        const validated = publicApiCatalogManager.validateEntry({
            id,
            name: rawApiData.name || 'Unknown API',
            category: rawApiData.category || 'General',
            description: rawApiData.description || '',
            base_url: rawApiData.baseUrl,
            documentation_url: rawApiData.documentationUrl,
            authentication: rawApiData.authentication?.type || 'none',
            https: Boolean(rawApiData.baseUrl?.startsWith('https://')),
            capabilities: rawApiData.capabilities || [],
            enabled: false,
            health_status: 'UNKNOWN',
            reliability_score: 0.5,
            risk_level: 'READ_ONLY',
            privacy_classification: 'PUBLIC',
            user_approval_required: false,
        } as any);
        
        const newProvider: ApiProvider = {
            id: validated.id,
            name: validated.name,
            category: validated.category,
            description: validated.description,
            baseUrl: validated.base_url,
            authentication: rawApiData.authentication || { required: false, type: "none" },
            capabilities: validated.capabilities,
            enabled: false,
            status: "unknown",
            verified: false
        };

        publicApiCatalogManager.importEntries([validated], { persist: true });
        apiRegistry.registerProvider(newProvider);
        return newProvider;
    }

    /**
     * Validates an API to ensure it meets requirements before becoming ACTIVE
     */
    public async validateApi(id: string): Promise<boolean> {
        const provider = apiRegistry.getProvider(id);
        if (!provider) return false;

        // Basic validation rules
        const isValid = !!(
            provider.baseUrl && 
            provider.baseUrl.startsWith('https://') &&
            provider.authentication &&
            provider.name
        );

        if (isValid) {
            provider.verified = true;
            provider.status = "active";
            provider.enabled = true;
            apiRegistry.registerProvider(provider); // Update
        }

        return isValid;
    }

    private generateId(name?: string): string {
        return (name || "api").toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
    }
}

export const apiDiscovery = new ApiDiscovery();
