import { describe, it, expect } from 'vitest';

vi.mock('../utils/logger.js', () => ({
    default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }
}));

import { vi } from 'vitest';
import { classifyScrapeError, ScrapeErrorTypes } from '../pages/api/utils/scraperErrors.js';

describe('classifyScrapeError', () => {
    // errorType values below are the israeli-bank-scrapers ScraperErrorTypes enum
    // VALUES (UPPER_SNAKE), i.e. what scrape results actually carry — see
    // node_modules/israeli-bank-scrapers/lib/scrapers/errors.js.
    it('maps library errorType INVALID_PASSWORD to INVALID_CREDENTIALS', () => {
        const result = classifyScrapeError({
            libResult: { success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'wrong password' }
        });
        expect(result.type).toBe(ScrapeErrorTypes.INVALID_CREDENTIALS);
        expect(result.retryable).toBe(false);
    });

    it('maps library errorType TIMEOUT to TIMEOUT (retryable)', () => {
        const result = classifyScrapeError({
            libResult: { success: false, errorType: 'TIMEOUT', errorMessage: 'timed out' }
        });
        expect(result.type).toBe(ScrapeErrorTypes.TIMEOUT);
        expect(result.retryable).toBe(true);
    });

    it('maps library errorType CHANGE_PASSWORD to CHANGE_PASSWORD_REQUIRED even with empty errorMessage', () => {
        // Regression: the lib emits UPPER_SNAKE errorType values with often-empty
        // errorMessage; classification must not depend on message heuristics here.
        const result = classifyScrapeError({
            libResult: { success: false, errorType: 'CHANGE_PASSWORD', errorMessage: '' }
        });
        expect(result.type).toBe(ScrapeErrorTypes.CHANGE_PASSWORD_REQUIRED);
        expect(result.retryable).toBe(false);
    });

    it('classifies OneZero ErrorLoginFailed body as INVALID_CREDENTIALS', () => {
        // Mirrors production: lib swallowed the response, threw a destructure error,
        // and run-stream wrapped the failure with both the libResult and the captured response.
        const result = classifyScrapeError({
            thrownError: new Error("Cannot read properties of undefined (reading 'idToken')"),
            libResult: {
                success: false,
                errorMessage: "Cannot read properties of undefined (reading 'idToken')"
            },
            capturedResponse: {
                url: 'https://identity.tfd-bank.com/v1//getIdToken',
                status: 500,
                body: '{"errorResponse":{"type":"ErrorLoginFailed"}}'
            }
        });
        expect(result.type).toBe(ScrapeErrorTypes.INVALID_CREDENTIALS);
        expect(result.retryable).toBe(false);
    });

    it('classifies HTTP 401 as INVALID_CREDENTIALS', () => {
        const result = classifyScrapeError({
            capturedResponse: { url: 'https://x', status: 401, body: '' }
        });
        expect(result.type).toBe(ScrapeErrorTypes.INVALID_CREDENTIALS);
    });

    it('classifies HTTP 5xx with no auth signal as PROVIDER_ERROR', () => {
        const result = classifyScrapeError({
            capturedResponse: { url: 'https://x', status: 503, body: 'maintenance' }
        });
        expect(result.type).toBe(ScrapeErrorTypes.PROVIDER_ERROR);
        expect(result.retryable).toBe(false);
    });

    it('classifies network errors as NETWORK (retryable)', () => {
        const result = classifyScrapeError({
            thrownError: new Error('connect ECONNREFUSED 1.2.3.4:443')
        });
        expect(result.type).toBe(ScrapeErrorTypes.NETWORK);
        expect(result.retryable).toBe(true);
    });

    it('falls back to UNKNOWN for unrecognised errors', () => {
        const result = classifyScrapeError({
            thrownError: new Error('something weird happened')
        });
        expect(result.type).toBe(ScrapeErrorTypes.UNKNOWN);
    });

    it('classifies a destructure crash with no captured response as PROVIDER_ERROR', () => {
        const result = classifyScrapeError({
            thrownError: new Error("Cannot read properties of undefined (reading 'foo')")
        });
        expect(result.type).toBe(ScrapeErrorTypes.PROVIDER_ERROR);
    });
});
