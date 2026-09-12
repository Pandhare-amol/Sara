export interface ApiEndpoint {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    description: string;
}

export interface ApiProvider {
    id: string;
    name: string;
    category: string;
    description: string;
    baseUrl?: string;

    authentication: {
        required: boolean;
        type:
          | "none"
          | "api_key"
          | "bearer"
          | "oauth2"
          | "basic"
          | "custom";
    };

    capabilities: string[];
    endpoints?: ApiEndpoint[];
    documentationUrl?: string;

    pricing?: {
        freeTier: boolean;
        notes?: string;
    };

    rateLimit?: {
        requestsPerMinute?: number;
        requestsPerDay?: number;
    };

    timeoutMs?: number;
    retryPolicy?: {
        maxAttempts: number;
        retryableErrors?: string[];
    };

    reliability?: number;

    status:
      | "unknown"
      | "active"
      | "inactive"
      | "degraded";

    enabled: boolean;
    verified: boolean;
    lastHealthCheck?: Date;
}

export interface NormalizedApiResponse<T = unknown> {
    success: boolean;
    provider: string;
    capability: string;
    data: T;
    confidence?: number;
    source?: string;
    timestamp: string;
    cached: boolean;
    error?: {
        code: string;
        message: string;
    };
}
