export class ApiCredentialManager {
  private envVarName(providerId: string, credentialType: string): string {
    return `${providerId.toUpperCase()}_${credentialType.toUpperCase()}`;
  }

  /** Retrieves an API key securely from environment variables; never logs its value. */
  public getCredential(providerId: string, credentialType = "API_KEY"): string | null {
    const envVarName = this.envVarName(providerId, credentialType);
    const credential = process.env[envVarName]?.trim();
    if (!credential) {
      console.warn(`[ApiCredentialManager] Missing credential for ${providerId} (${envVarName})`);
      return null;
    }
    return credential;
  }

  /** Check availability without retrieving or logging a credential. */
  public hasCredential(providerId: string, credentialType = "API_KEY"): boolean {
    return Boolean(process.env[this.envVarName(providerId, credentialType)]?.trim());
  }

  public validateCredential(providerId: string): boolean {
    return this.hasCredential(providerId);
  }
}

export const apiCredentialManager = new ApiCredentialManager();
