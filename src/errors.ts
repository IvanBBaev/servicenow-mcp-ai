/**
 * Error thrown when a ServiceNow request fails — either before it leaves the
 * client (bad host, missing credentials, policy denial) or because the API
 * returned a non-2xx response. `status` is the HTTP status when known and
 * `detail` is the parsed ServiceNow error body, so callers can react
 * differently to 401 vs 403 vs 429.
 */
export class ServiceNowError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ServiceNowError";
  }
}
