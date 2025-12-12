// middleware/validate.js
const Joi = require('joi');
const logger = require('../utils/logger');

/**
 * Higher-order function that returns an Express middleware.
 * @param {Joi.Schema} schema - The validation schema to check against.
 * @param {string} property - The part of the request to check ('body', 'query', 'params').
 */
const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    // Validate the request data against the schema
    const { error, value } = schema.validate(req[property], {
      abortEarly: false, // Show all errors, not just the first one
      stripUnknown: true, // Remove fields that are not in the schema (Security: Sanitize input)
    });

    if (error) {
      const errorMessage = error.details.map((details) => details.message).join(', ');
      logger.warn(`Validation Error [${req.originalUrl}]: ${errorMessage}`);
      return res.status(400).json({ error: errorMessage });
    }

    // Replace request data with the validated/sanitized data
    req[property] = value;
    next();
  };
};

module.exports = validate;
