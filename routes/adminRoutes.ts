// routes/adminRoutes.ts
import express from 'express';
import { checkAuth, checkAdmin } from '../middleware/authMiddleware';
import * as adminController from '../controllers/adminController';

const router = express.Router();

// Protect all admin routes
router.use(checkAuth);
router.use(checkAdmin);

// AI Prompt Management
router.get('/prompts', adminController.getSystemPrompts);
router.patch('/prompts/:id', adminController.updateSystemPrompt);

export default router;
