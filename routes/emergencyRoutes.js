// routes/emergencyRoutes.js (FINAL v5.1 - Secured)
const express = require('express');
const router = express.Router();
const emergencyService = require('../services/emergencyService');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middleware/validate'); // <--- NEW
const schemas = require('../utils/validationSchemas'); // <--- NEW

// --- GET Emergency Contacts (Validated) ---
// Protected by 'validate(schemas.emergencyFilters, 'query')'
router.get('/', validate(schemas.emergencyFilters, 'query'), asyncHandler(async (req, res) => {
    const filters = {
      scope: req.query.scope,
      country: req.query.country
    };
    const contacts = await emergencyService.getContacts(filters);
    res.status(200).json({ contacts });
}));

module.exports = router;
