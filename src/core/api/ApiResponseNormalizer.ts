import { NormalizedApiResponse } from './types';

export class ApiResponseNormalizer {
    
    /**
     * Normalizes an API response into the standard NormalizedApiResponse schema.
     */
    public normalize<T>(
        providerId: string, 
        capability: string, 
        rawData: any, 
        isSuccess: boolean, 
        error?: { code: string; message: string }
    ): NormalizedApiResponse<T> {
        return {
            success: isSuccess,
            provider: providerId,
            capability: capability,
            data: rawData as T,
            timestamp: new Date().toISOString(),
            cached: false,
            error: error
        };
    }
}

export const apiResponseNormalizer = new ApiResponseNormalizer();
