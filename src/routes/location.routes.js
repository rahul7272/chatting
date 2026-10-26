const express = require('express');
const router = express.Router();
const statesData = require('../config/states.json');
const { successResponse } = require('../utils/response');

// GET /api/v1/locations - returns all states and their corresponding cities
router.get('/', (req, res) => {
  return successResponse(res, statesData, 'States and cities retrieved successfully.');
});

// GET /api/v1/locations/states - returns list of all state names
router.get('/states', (req, res) => {
  const states = Object.keys(statesData).sort();
  return successResponse(res, { states }, 'State names retrieved successfully.');
});

// GET /api/v1/locations/cities/:state - returns list of cities for a specific state
router.get('/cities/:state', (req, res) => {
  const stateParam = decodeURIComponent(req.params.state);
  const cities = statesData[stateParam] || [];
  return successResponse(res, { state: stateParam, cities }, 'Cities retrieved successfully.');
});

module.exports = router;
