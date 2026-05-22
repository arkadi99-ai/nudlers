// Type declarations for pages/api/utils/apiHandler.js
// Loose typing — the handler is consumed by both production Next API
// routes and tests passing partial mocks.
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module '*api/utils/apiHandler' {
    interface QueryResult {
        sql: string;
        params?: unknown[];
    }

    interface CreateApiHandlerOptions {
        query: (req: any, client: any) => Promise<QueryResult> | QueryResult;
        validate?: (req: any) => string | undefined | Promise<string | undefined>;
        transform?: (result: any, req: any) => unknown | Promise<unknown>;
    }

    export function createApiHandler(
        options: CreateApiHandlerOptions
    ): (req: any, res: any) => Promise<void>;
}
