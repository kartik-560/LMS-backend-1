// Custom error class for API errors
class ApiError extends Error {
  constructor(message, statusCode, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    
    Error.captureStackTrace(this, this.constructor);
  }
}

// Create error with message and status code
const createError = (message, statusCode = 500, isOperational = true) => {
  return new ApiError(message, statusCode, isOperational);
};

// Create validation error
const createValidationError = (message, field = null) => {
  const error = new ApiError(message, 400, true);
  error.field = field;
  return error;
};

// Create authentication error
const createAuthError = (message = 'Authentication failed') => {
  return new ApiError(message, 401, true);
};

// Create authorization error
const createAuthzError = (message = 'Access denied') => {
  return new ApiError(message, 403, true);
};

// Create not found error
const createNotFoundError = (resource = 'Resource') => {
  return new ApiError(`${resource} not found`, 404, true);
};

// Create conflict error
const createConflictError = (message = 'Resource conflict') => {
  return new ApiError(message, 409, true);
};

// Create rate limit error
const createRateLimitError = (message = 'Too many requests') => {
  return new ApiError(message, 429, true);
};

// Create server error
const createServerError = (message = 'Internal server error') => {
  return new ApiError(message, 500, false);
};

// Create service unavailable error
const createServiceUnavailableError = (message = 'Service temporarily unavailable') => {
  return new ApiError(message, 503, false);
};

// Format error for response
const formatError = (error) => {
  if (error instanceof ApiError) {
    return {
      success: false,
      message: error.message,
      statusCode: error.statusCode,
      status: error.status,
      field: error.field || undefined,
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    };
  }

  // Handle mongoose validation errors
  if (error.name === 'ValidationError') {
    const messages = Object.values(error.errors).map(err => err.message);
    return {
      success: false,
      message: 'Validation failed',
      statusCode: 400,
      status: 'fail',
      errors: messages
    };
  }

  // Handle mongoose duplicate key errors
  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return {
      success: false,
      message: `${field} already exists`,
      statusCode: 409,
      status: 'fail',
      field
    };
  }

  // Handle mongoose cast errors
  if (error.name === 'CastError') {
    return {
      success: false,
      message: 'Invalid ID format',
      statusCode: 400,
      status: 'fail',
      field: error.path
    };
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError') {
    return {
      success: false,
      message: 'Invalid token',
      statusCode: 401,
      status: 'fail'
    };
  }

  if (error.name === 'TokenExpiredError') {
    return {
      success: false,
      message: 'Token expired',
      statusCode: 401,
      status: 'fail'
    };
  }

  // Handle unknown errors
  return {
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
    statusCode: 500,
    status: 'error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  };
};

// Check if error is operational
const isOperationalError = (error) => {
  if (error instanceof ApiError) {
    return error.isOperational;
  }
  return false;
};

// Handle async errors
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Handle async errors with custom error handler
const asyncHandlerWithError = (fn, errorHandler) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      const formattedError = errorHandler ? errorHandler(error) : formatError(error);
      res.status(formattedError.statusCode).json(formattedError);
    });
  };
};

// Error logging utility
const logError = (error, req = null) => {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    statusCode: error.statusCode || 500,
    timestamp: new Date().toISOString(),
    url: req ? req.originalUrl : 'N/A',
    method: req ? req.method : 'N/A',
    ip: req ? req.ip : 'N/A',
    userAgent: req ? req.get('User-Agent') : 'N/A'
  };

  // Log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.error('Error Details:', errorInfo);
  }

  // In production, you might want to log to a file or external service
  // logger.error(errorInfo);
};

// Error monitoring utility
const monitorError = (error, req = null) => {
  // Log the error
  logError(error, req);

  // In production, you might want to send errors to monitoring services
  // like Sentry, LogRocket, etc.
  
  // Example: Sentry.captureException(error);
};

export {
  ApiError,
  createError,
  createValidationError,
  createAuthError,
  createAuthzError,
  createNotFoundError,
  createConflictError,
  createRateLimitError,
  createServerError,
  createServiceUnavailableError,
  formatError,
  isOperationalError,
  asyncHandler,
  asyncHandlerWithError,
  logError,
  monitorError
};
