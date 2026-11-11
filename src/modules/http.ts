const DEFAULT_TIMEOUT_MS = 20_000

/**
 * `fetch` with a hard timeout. A hung API must not freeze a whole update run.
 * Abort and network failures are reported as normal exceptions; callers classify
 * them as `api_error`, never as `not_found`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function readJson(response: Response): Promise<any | null> {
  try {
    return await response.json()
  } catch {
    return null
  }
}
