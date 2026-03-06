const { Router } = require('express');
const { getCollection, mongoDocToArray } = require('../config/db');

const router = Router();

// GET /pins/get — get PIN record for an account (acno). Optional vendor_id to scope. No admin auth; for dashboard transfer.
router.get('/get', async (req, res) => {
  try {
    const acno = (req.query.acno || '').trim();
    const vendorId = (req.query.vendor_id || '').trim() || null;

    if (!acno) {
      return res.status(400).json({ status: 'error', message: 'Account number (acno) is required', data: null });
    }

    const pins = await getCollection('pins');
    const users = await getCollection('users');
    if (!pins) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    let pinDoc = await pins.findOne({ acno }, { sort: { id: -1 } });
    if (!pinDoc) {
      return res.status(404).json({ status: 'error', message: 'PIN record not found', data: null });
    }

    // When vendor_id is provided, only return pin if it belongs to that vendor (or is unscoped)
    if (vendorId) {
      const pinVendor = pinDoc.vendor_id != null && String(pinDoc.vendor_id).trim() !== '' ? String(pinDoc.vendor_id).trim() : null;
      if (pinVendor && pinVendor !== vendorId) {
        return res.status(404).json({ status: 'error', message: 'PIN record not found', data: null });
      }
    }

    const p = mongoDocToArray(pinDoc);
    if (users) {
      const user = await users.findOne({ acno: p.acno });
      if (user) {
        p.user_id = user.id;
        p.fname = user.fname;
        p.email = user.email;
        p.phone = user.phone;
      }
    }

    res.json({ status: 'success', message: 'PIN retrieved successfully', data: p });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
