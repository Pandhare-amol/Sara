import { apiSelector } from './ApiSelector';
import { apiHealthMonitor } from './ApiHealthMonitor';
import { apiResponseNormalizer } from './ApiResponseNormalizer';
import { apiCredentialManager } from './ApiCredentialManager';
import { NormalizedApiResponse } from './types';
import { apiRateLimitManager } from './ApiRateLimitManager';

export interface ExecutionContext {
    taskId?: string;
    conversationId?: string;
    correlationId?: string;
    timeoutMs?: number;
}

const DEFAULT_RETRYABLE_ERRORS = ['timeout', 'network', 'fetch failed', 'unavailable', 'econnreset'];

export async function executeApiWithPolicy<T>(
    operation: () => Promise<T>,
    options: { timeoutMs?: number; maxAttempts?: number; retryableErrors?: string[] } = {},
): Promise<T> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 15_000, 120_000));
    const maxAttempts = Math.max(1, Math.min(Math.floor(options.maxAttempts ?? 1), 3));
    const retryableErrors = (options.retryableErrors || DEFAULT_RETRYABLE_ERRORS).map((value) => value.toLowerCase());
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            try {
                return await Promise.race([
                    operation(),
                    new Promise<never>((_, reject) => {
                        timeoutHandle = setTimeout(() => reject(new Error(`API request timed out after ${timeoutMs}ms.`)), timeoutMs);
                    }),
                ]);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
            }
        } catch (error) {
            lastError = error;
            const message = String((error as Error)?.message || error).toLowerCase();
            const retryable = retryableErrors.some((value) => message.includes(value));
            if (!retryable || attempt === maxAttempts) throw error;
        }
    }
    throw lastError;
}

export abstract class ApiToolAdapter {
    public abstract name: string;
    public abstract capability: string;

    /**
     * Executes the API tool call by routing it through the API Gateway.
     */
    public async execute(input: any, context: ExecutionContext): Promise<NormalizedApiResponse> {
        const startTime = Date.now();
        const provider = apiSelector.selectProvider(this.capability);

        if (!provider) {
            return apiResponseNormalizer.normalize(
                'unknown',
                this.capability,
                null,
                false,
                { code: 'NO_PROVIDER', message: `No active provider found for ${this.capability}` }
            );
        }

        try {
            // Get credentials if required
            let credentials = null;
            if (provider.authentication.required) {
                credentials = apiCredentialManager.getCredential(provider.id);
                if (!credentials) {
                    throw new Error(`Missing credentials for ${provider.id}`);
                }
            }

            const rateLimit = apiRateLimitManager.consume(provider.id, provider.rateLimit);
            if (!rateLimit.allowed) {
                return apiResponseNormalizer.normalize(
                    provider.id,
                    this.capability,
                    null,
                    false,
                    { code: 'RATE_LIMITED', message: rateLimit.reason },
                );
            }

            // Perform the actual API call logic defined in subclass
            const rawResult = await executeApiWithPolicy(
                () => this.performApiCall(provider, input, credentials),
                {
                    timeoutMs: context.timeoutMs ?? provider.timeoutMs,
                    maxAttempts: provider.retryPolicy?.maxAttempts,
                    retryableErrors: provider.retryPolicy?.retryableErrors,
                },
            );
            
            const latency = Date.now() - startTime;
            apiHealthMonitor.recordSuccess(provider.id, latency);

            return apiResponseNormalizer.normalize(
                provider.id,
                this.capability,
                rawResult,
                true
            );

        } catch (error: any) {
            apiHealthMonitor.recordFailure(provider.id);
            return apiResponseNormalizer.normalize(
                provider.id,
                this.capability,
                null,
                false,
                { code: error?.message?.toLowerCase().includes('timed out') ? 'TIMEOUT' : 'API_ERROR', message: error.message || 'Unknown API Error' }
            );
        }
    }

    /**
     * Subclasses implement the actual HTTP/Fetch call to the provider.
     */
    protected abstract performApiCall(provider: any, input: any, credentials: any): Promise<any>;
}
