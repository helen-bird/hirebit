export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorPayload(error) {
  const appError = error instanceof AppError
    ? error
    : new AppError("internal_error", "Internal error", 500);
  return {
    status: appError.status,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    },
  };
}
