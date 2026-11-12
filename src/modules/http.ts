/**
 * HTTP helpers that work inside the Zotero plugin sandbox.
 *
 * The sandbox created by `Zotero.Plugins` injects a small whitelist of globals
 * (`fetch`, `XMLHttpRequest`, `URL`, `TextDecoder`, …) but **not**
 * `AbortController`. Using it here throws a `ReferenceError` before the request
 * is even sent, which previously made every lookup fail with `api_error`.
 *
 * `Zotero.HTTP.request` is always available, provides a real timeout, honours
 * the configured proxy, and reports non-2xx responses as structured errors.
 */

export interface HttpResult {
  /** HTTP status code, or 0 when the request never produced a response. */
  status: number
  /** Parsed JSON body, or null when the body was empty or not valid JSON. */
  data: any | null
  /** Error message when the request itself failed (offline, timeout, DNS, …). */
  error?: string
}

function getStatus(error: any): number {
  const status = Number(error?.status)
  return Number.isFinite(status) && status > 0 ? status : 0
}

/**
 * GET a JSON document.
 *
 * Never throws: transport failures are returned as `{ status: 0, error }` so a
 * caller can distinguish "the server said 404" from "the network failed". Only
 * the former may ever be recorded as a permanent `not_found`.
 */
export async function getJson(url: string, timeoutMs = 20_000): Promise<HttpResult> {
  let xhr: any
  try {
    xhr = await Zotero.HTTP.request('GET', url, {
      headers: { Accept: 'application/json' },
      responseType: 'text',
      successCodes: false,
      timeout: timeoutMs,
      // A retry storm from Zotero's built-in 5xx handling would hide the real
      // status and make the run appear stuck; the caller retries deliberately.
      errorDelayMax: 0,
    })
  } catch (error: any) {
    return { status: getStatus(error), data: null, error: error?.message || String(error) }
  }

  const status = Number(xhr?.status) || 0
  const raw = xhr?.responseText
  if (!raw) {
    return {
      status,
      data: null,
      // With `successCodes: false` a broken connection resolves with status 0
      // instead of rejecting, so surface it as an error explicitly.
      error: status === 0 ? 'Request did not complete' : undefined,
    }
  }
  try {
    return { status, data: JSON.parse(raw) }
  } catch {
    return { status, data: null }
  }
}
