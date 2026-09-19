export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly errors: unknown[] = [],
    public readonly isOperational = true,
  ) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
  }
}
