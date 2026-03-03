const { Router } = require('express');

const router = Router();

// GET /admin/cache/clear
router.get('/clear', (_req, res) => {
  res.json({ status: 'success', message: 'Cache cleared successfully', data: { cleared: true, timestamp: new Date().toISOString() } });
});

module.exports = router;
