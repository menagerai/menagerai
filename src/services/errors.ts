// Framework-agnostic error type shared by the admin services. A service throws
// this on a validation/precondition failure; the EJS handlers map it to a flash
// (using `i18nKey` + `vars`, preserving the original messages and severity) and
// the JSON API maps it to an HTTP status + `{ error: code }` body. Keeping the
// logic in services means the UI and the API enforce exactly the same rules.
export class ApiError extends Error {
  constructor(
    public status: number,
    public i18nKey: string, // an i18n key under flash.* / validate.* (also used as the API error code)
    public vars?: Record<string, string | number>,
    public level?: 'warning' | 'error',
  ) {
    super(i18nKey);
    this.name = 'ApiError';
  }
}

// A missing resource. The UI renders the plain "Not found" page it always has;
// the API returns 404 JSON. Distinct subclass so handlers can tell it apart from
// a validation ApiError (which flashes rather than 404s).
export class NotFoundError extends ApiError {
  constructor(i18nKey = 'error.notFound') {
    super(404, i18nKey);
    this.name = 'NotFoundError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
