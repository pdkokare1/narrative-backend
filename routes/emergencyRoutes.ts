// routes/emergencyRoutes.ts
import express, { Request, Response } from 'express';
import emergencyService from '../services/emergencyService';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

const router = express.Router();

router.get('/', validate(schemas.emergencyFilters, 'query'), asyncHandler(async (req: Request, res: Response) => {
    const filters = {
      scope: req.query.scope as string,
      country: req.query.country as string
    };
    const contacts = await emergencyService.getContacts(filters);
    res.status(200).json({ contacts });
}));

export default router;
