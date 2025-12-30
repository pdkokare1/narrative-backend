// utils/AppError.ts

/**
 * Operational Error Class
 * Use this to throw errors that are expected and should be sent to the client
 * (e.g., "User not found", "Invalid input", "Permission denied")
 */
class AppError extends Error {
  public statusCode: number;
  public status: string;
  public isOperational: boolean;
  public errorCode?: string; // Added to support specific error codes

  constructor(message: string, statusCode: number, errorCode?: string) {
    super(message);

    this.statusCode = statusCode;
    // If code is 4xx, status is 'fail', else 'error'
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    
    // Operational errors are predictable (user input bad, etc.)
    // Programming errors (bugs) are not operational.
    this.isOperational = true;
    
    // Store the optional error code if provided
    this.errorCode = errorCode;

    Error.captureStackTrace(this, this.constructor);
  }
}

export default AppError;
