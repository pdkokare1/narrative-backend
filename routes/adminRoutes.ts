// narrative-backend/routes/adminRoutes.ts
import express from 'express';
import { checkAuth, checkAdmin } from '../middleware/authMiddleware';
import * as adminController from '../controllers/adminController';

const router = express.Router();

// Protect all admin routes
router.use(checkAuth);
router.use(checkAdmin);

// --- Dashboard Stats ---
router.get('/dashboard', adminController.getDashboardStats); // NEW

// --- AI Prompt Management ---
router.get('/prompts', adminController.getSystemPrompts);
router.patch('/prompts/:id', adminController.updateSystemPrompt);

// --- Article Management (Newsroom) ---
router.post('/articles', adminController.createArticle); // NEW: Manual Add
router.get('/articles', adminController.getAllArticles);
router.get('/articles/:id', adminController.getArticleById);
router.patch('/articles/:id', adminController.updateArticle);
router.delete('/articles/:id', adminController.archiveArticle); // NEW: Archive (Delete)
router.post('/articles/:id/restore', adminController.restoreArticle); // NEW: Restore
router.post('/articles/:id/toggle-visibility', adminController.toggleArticleVisibility);

// --- Trash Bin ---
router.get('/trash/articles', adminController.getArchivedArticles); // NEW: View Trash

// --- User Management ---
router.get('/users', adminController.getAllUsers);
router.get('/users/:id', adminController.getUserById);
router.patch('/users/:id', adminController.updateUserStatus);

// --- System Config ---
router.get('/config', adminController.getSystemConfigs);
router.post('/config', adminController.updateSystemConfig);

export default router;
