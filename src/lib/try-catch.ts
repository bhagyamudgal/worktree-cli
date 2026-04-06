type Success<T> = { data: T; error: null };
type Failure = { data: null; error: Error };
type Result<T> = Success<T> | Failure;

function ensureError(value: unknown): Error {
    if (value instanceof Error) return value;
    return new Error(String(value));
}

async function tryCatch<T>(promise: Promise<T>): Promise<Result<T>> {
    try {
        const data = await promise;
        return { data, error: null };
    } catch (error) {
        return { data: null, error: ensureError(error) };
    }
}

function tryCatchSync<T>(fn: () => T): Result<T> {
    try {
        const data = fn();
        return { data, error: null };
    } catch (error) {
        return { data: null, error: ensureError(error) };
    }
}

export { tryCatch, tryCatchSync };
export type { Result };
