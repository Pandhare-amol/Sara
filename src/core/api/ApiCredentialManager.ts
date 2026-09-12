export class ApiCredentialManager {
    
    /**
     * Retrieves an API key securely from environment variables.
     * Never logs or exposes the key directly in standard output.
     */
    public getCredential(providerId: string, credentialType: string = 'API_KEY'): string | null {
        // Construct the expected env var name, e.g. WEATHER_API_KEY
        const envVarName = `${providerId.toUpperCase()}_${credentialType.toUpperCase()}`;
        
        // Use process.env (Server-side ONLY)
        const credential = process.env[envVarName];
        
        if (!credential) {
            console.warn(`[ApiCredentialManager] Missing credential for ${providerId} (${envVarName})`);
            return null;
        }

        return credential;
    }

    public validateCredential(providerId: string): boolean {
        return this.getCredential(providerId) !== null;
    }
}

export const apiCredentialManager = new ApiCredentialManager();
