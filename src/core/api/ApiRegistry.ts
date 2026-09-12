import { ApiProvider } from './types';

export class ApiRegistry {
    private providers: Map<string, ApiProvider> = new Map();

    public registerProvider(provider: ApiProvider): void {
        if (!provider.id) {
            throw new Error("API Provider must have an ID");
        }
        this.providers.set(provider.id, provider);
        console.log(`[ApiRegistry] Registered provider: ${provider.id} [${provider.status}]`);
    }

    public getProvider(id: string): ApiProvider | undefined {
        return this.providers.get(id);
    }

    public removeProvider(id: string): void {
        this.providers.delete(id);
    }

    public getAllProviders(): ApiProvider[] {
        return Array.from(this.providers.values());
    }

    public getProvidersByCapability(capability: string): ApiProvider[] {
        return this.getAllProviders().filter(
            p => p.capabilities.includes(capability) && p.enabled && p.status === 'active'
        );
    }

    public getProvidersByCategory(category: string): ApiProvider[] {
        return this.getAllProviders().filter(p => p.category === category);
    }
}

export const apiRegistry = new ApiRegistry();
