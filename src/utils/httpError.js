export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function httpError(status, message, details = undefined) {
  return new HttpError(status, message, details);
}
