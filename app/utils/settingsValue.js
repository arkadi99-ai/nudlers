/**
 * `app_settings.value` lives in jsonb, so `pg` returns it already parsed for
 * objects/numbers but as a JSON-encoded string for primitives written via
 * `JSON.stringify`. Parse strings back; pass everything else through.
 */
export function unwrapSettingValue(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}
