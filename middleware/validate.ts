// middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { Schema } from 'joi';
import logger = require('../utils/logger');

const validate = (schema: Schema, property: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false, 
      stripUnknown: true, 
    });

    if (error) {
      const errorMessage = error.details.map((details) => details.message).join(', ');
      logger.warn(`Validation Error [${req.originalUrl}]: ${errorMessage}`);
      return res.status(400).json({ error: errorMessage });
    }

    req[property] = value;
    next();
  };
};

export = validate;
