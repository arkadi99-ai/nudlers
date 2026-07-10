import logger from '../../../utils/logger.js';

export const ScrapeErrorTypes = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  CHANGE_PASSWORD_REQUIRED: 'CHANGE_PASSWORD_REQUIRED',
  OTP_REQUIRED: 'OTP_REQUIRED',
  OTP_FAILED: 'OTP_FAILED',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  UNKNOWN: 'UNKNOWN',
};

const USER_MESSAGES = {
  INVALID_CREDENTIALS: 'Login failed. Please verify the credentials for this account.',
  ACCOUNT_BLOCKED: 'This account appears to be locked. Please log in via the provider’s app or website to unlock it.',
  CHANGE_PASSWORD_REQUIRED: 'The provider is asking you to change your password before continuing.',
  OTP_REQUIRED: 'Two-factor authentication is required to continue.',
  OTP_FAILED: 'Two-factor verification failed or timed out.',
  NETWORK: 'Network error while contacting the provider. Please check your connection.',
  TIMEOUT: 'The provider took too long to respond. Please try again later.',
  PROVIDER_ERROR: 'The provider returned an unexpected response. Please try again later.',
  UNKNOWN: 'Sync failed due to an unexpected error.',
};

const RETRYABLE = {
  INVALID_CREDENTIALS: false,
  ACCOUNT_BLOCKED: false,
  CHANGE_PASSWORD_REQUIRED: false,
  OTP_REQUIRED: false,
  OTP_FAILED: false,
  NETWORK: true,
  TIMEOUT: true,
  PROVIDER_ERROR: false,
  UNKNOWN: true,
};

// Keys are the israeli-bank-scrapers ScraperErrorTypes enum VALUES (UPPER_SNAKE —
// see node_modules/israeli-bank-scrapers/lib/scrapers/errors.js), which is what
// scrape results carry in `errorType`.
const LIB_ERROR_TYPE_MAP = {
  INVALID_PASSWORD: ScrapeErrorTypes.INVALID_CREDENTIALS,
  CHANGE_PASSWORD: ScrapeErrorTypes.CHANGE_PASSWORD_REQUIRED,
  ACCOUNT_BLOCKED: ScrapeErrorTypes.ACCOUNT_BLOCKED,
  TIMEOUT: ScrapeErrorTypes.TIMEOUT,
  TWO_FACTOR_RETRIEVER_MISSING: ScrapeErrorTypes.OTP_REQUIRED,
  GENERIC: ScrapeErrorTypes.UNKNOWN,
  GENERAL_ERROR: ScrapeErrorTypes.UNKNOWN,
};

function classifyByMessage(rawMessage) {
  const m = (rawMessage || '').toLowerCase();
  if (!m) return null;
  if (m.includes('econnrefused') || m.includes('enotfound') || m.includes('socket hang up') || m.includes('network error')) return ScrapeErrorTypes.NETWORK;
  if (m.includes('timeout') || m.includes('timed out')) return ScrapeErrorTypes.TIMEOUT;
  if (m.includes('change password') || m.includes('password expired') || m.includes('must change password')) return ScrapeErrorTypes.CHANGE_PASSWORD_REQUIRED;
  if (m.includes('account blocked') || m.includes('account locked') || m.includes('account is locked')) return ScrapeErrorTypes.ACCOUNT_BLOCKED;
  if (m.includes('invalid password') || m.includes('login failed') || m.includes('errorloginfailed') || m.includes('invalid credentials') || m.includes('unauthorized')) return ScrapeErrorTypes.INVALID_CREDENTIALS;
  if (m.includes('otp') && (m.includes('failed') || m.includes('expired') || m.includes('invalid'))) return ScrapeErrorTypes.OTP_FAILED;
  if (m.includes('cannot read properties of undefined') || m.includes('cannot read property')) return ScrapeErrorTypes.PROVIDER_ERROR;
  return null;
}

function classifyByCapturedResponse(captured) {
  if (!captured) return null;
  const { status, body } = captured;
  const lower = (body || '').toLowerCase();
  if (lower.includes('errorloginfailed') || lower.includes('invalid_grant') || lower.includes('invalid credentials') || lower.includes('"invalidpassword"')) {
    return ScrapeErrorTypes.INVALID_CREDENTIALS;
  }
  if (lower.includes('account_blocked') || lower.includes('account is locked') || lower.includes('accountblocked')) return ScrapeErrorTypes.ACCOUNT_BLOCKED;
  if (lower.includes('change_password') || lower.includes('changepassword')) return ScrapeErrorTypes.CHANGE_PASSWORD_REQUIRED;
  if (status === 401 || status === 403) return ScrapeErrorTypes.INVALID_CREDENTIALS;
  if (status === 408 || status === 504) return ScrapeErrorTypes.TIMEOUT;
  if (status >= 500) return ScrapeErrorTypes.PROVIDER_ERROR;
  if (status >= 400) return ScrapeErrorTypes.PROVIDER_ERROR;
  return null;
}

function buildResult(type, originalMessage) {
  return {
    type,
    userMessage: USER_MESSAGES[type] || USER_MESSAGES.UNKNOWN,
    retryable: RETRYABLE[type] ?? true,
    originalMessage: originalMessage || null,
  };
}

export function classifyScrapeError({ thrownError, libResult, capturedResponse } = {}) {
  // 1. Most explicit: structured library errorType.
  if (libResult && libResult.success === false && libResult.errorType && LIB_ERROR_TYPE_MAP[libResult.errorType]) {
    return buildResult(LIB_ERROR_TYPE_MAP[libResult.errorType], libResult.errorMessage);
  }
  // 2. Wire-level response from the provider — higher signal than parsing message strings,
  //    especially when the library swallowed the response (e.g. destructure crashes).
  const fromCaptured = classifyByCapturedResponse(capturedResponse);
  if (fromCaptured) {
    const original = thrownError?.message || libResult?.errorMessage || (capturedResponse ? `HTTP ${capturedResponse.status}` : null);
    return buildResult(fromCaptured, original);
  }
  // 3. Message-based heuristics (lib result first, then thrown error).
  if (libResult && libResult.success === false) {
    const fromMessage = classifyByMessage(libResult.errorMessage);
    if (fromMessage) return buildResult(fromMessage, libResult.errorMessage);
  }
  if (thrownError) {
    const fromMessage = classifyByMessage(thrownError.message);
    if (fromMessage) return buildResult(fromMessage, thrownError.message);
  }
  return buildResult(ScrapeErrorTypes.UNKNOWN, thrownError?.message || libResult?.errorMessage);
}

export function installScrapeFetchInterceptor() {
  const context = { lastFailedResponse: null };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    if (!response.ok) {
      try {
        const cloned = response.clone();
        const bodyText = await cloned.text();
        const urlStr = typeof url === 'string' ? url : url?.url || '';
        context.lastFailedResponse = {
          url: urlStr,
          status: response.status,
          body: bodyText.slice(0, 4000),
        };
        logger.info({
          url: urlStr,
          status: response.status,
          bodyPreview: bodyText.slice(0, 300),
        }, '[Scraper] Provider returned non-2xx');
      } catch {
        // ignore body read errors
      }
    }
    return response;
  };
  const restore = () => {
    if (globalThis.fetch !== originalFetch) {
      globalThis.fetch = originalFetch;
    }
  };
  return { context, restore };
}
