// routes/emergencyRoutes.js
const express = require('express');
const router = express.Router();
const emergencyService = require('../services/emergencyService');
const asyncHandler = require('../utils/asyncHandler');

router.get('/', asyncHandler(async (req, res) => {
    const filters = {
      scope: req.query.scope,
      country: req.query.country
    };
    const contacts = await emergencyService.getContacts(filters);
    res.status(200).json({ contacts });
}));

module.exports = router;
