// routes/emergencyRoutes.js
const express = require('express');
const router = express.Router();
const emergencyService = require('../services/emergencyService');

// --- GET /api/emergency-resources ---
// Fetches the list of numbers.
// Optional Query Params: ?scope=Mumbai or ?scope=All
router.get('/', async (req, res) => {
  try {
    const filters = {
      scope: req.query.scope,
      country: req.query.country
    };
    
    // Fetch from service
    const contacts = await emergencyService.getContacts(filters);
    
    // Return to frontend
    res.status(200).json({ contacts });
  } catch (error) {
    console.error('Error fetching emergency contacts:', error);
    res.status(500).json({ error: 'Failed to load emergency resources' });
  }
});

module.exports = router;
