const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../../config/db');

const router = Router();

function maskPin(val) {
  if (!val || val.length <= 2) return '****';
  return '*'.repeat(val.length - 2) + val.slice(-2);
}

function addMaskedPins(obj) {
  for (const f of ['pin', 'pin2', 'pin3', 'pin4', 'pin5']) {
    if (obj[f]) obj[f + '_masked'] = maskPin(obj[f]);
  }
}

// GET /admin/pins/users_with_pins — only this admin's vendor (req.adminVendorId from token)
router.get('/users_with_pins', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: [] });

    const users = await getCollection('users');
    const pins = await getCollection('pins');
    if (!users || !pins) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 1000));

    const filter = { vendor_id: vendorId };
    if (search) {
      const re = { $regex: search, $options: 'i' };
      filter.$or = [{ fname: re }, { email: re }, { phone: re }, { acno: re }];
    }
    if (status) filter.status = status;

    const cursor = users.find(filter, { projection: { pass: 0 } }).sort({ id: -1 }).limit(limit);
    const list = [];
    for await (const doc of cursor) {
      const u = mongoDocToArray(doc);
      const pinDoc = await pins.findOne({ acno: u.acno }, { sort: { id: -1 } });

      if (pinDoc) {
        const p = mongoDocToArray(pinDoc);
        u.pin_id = p.id ?? p._id;
        for (const f of ['pin', 'name', 'pin2', 'name2', 'pin3', 'name3', 'pin4', 'name4', 'pin5', 'name5']) {
          u[f] = p[f] ?? null;
        }
        u.pin_updated_at = p.updated_at ?? null;
        u.pin_status = 'assigned';
        addMaskedPins(u);
      } else {
        u.pin_id = null;
        u.pin_status = 'unassigned';
      }

      if (u.date) {
        u.date_formatted = new Date(u.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
      }
      if (u.pin_updated_at) {
        u.pin_updated_at_formatted = new Date(u.pin_updated_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
      }
      delete u.pass;
      list.push(u);
    }

    res.json({ status: 'success', message: 'Users with PIN status retrieved successfully', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: [] });
  }
});

// GET /admin/pins/get
router.get('/get', async (req, res) => {
  try {
    const acno = (req.query.acno || '').trim();
    const pinId = parseInt(req.query.id) || 0;
    if (!acno && pinId <= 0) {
      return res.status(400).json({ status: 'error', message: 'Account number (acno) or ID is required', data: null });
    }

    const pins = await getCollection('pins');
    const users = await getCollection('users');
    if (!pins) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    let pinDoc;
    if (pinId > 0) {
      pinDoc = await pins.findOne({ id: pinId });
    } else {
      pinDoc = await pins.findOne({ acno }, { sort: { id: -1 } });
    }

    if (!pinDoc) {
      return res.status(404).json({ status: 'error', message: 'PIN record not found', data: null });
    }

    const p = mongoDocToArray(pinDoc);
    const user = await users.findOne({ acno: p.acno });
    if (user) {
      p.user_id = user.id;
      p.fname = user.fname;
      p.email = user.email;
      p.phone = user.phone;
    }
    addMaskedPins(p);

    res.json({ status: 'success', message: 'PIN retrieved successfully', data: p });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// GET /admin/pins/list
router.get('/list', async (req, res) => {
  try {
    const pins = await getCollection('pins');
    const users = await getCollection('users');
    if (!pins) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const acno = (req.query.acno || '').trim();
    const filter = acno ? { acno } : {};
    const cursor = pins.find(filter).sort({ acno: 1, id: -1 });
    const list = [];
    for await (const doc of cursor) {
      const p = mongoDocToArray(doc);
      const user = await users.findOne({ acno: p.acno });
      if (user) { p.user_id = user.id; p.fname = user.fname; p.email = user.email; p.phone = user.phone; }
      addMaskedPins(p);
      list.push(p);
    }

    res.json({ status: 'success', message: 'PINs retrieved successfully', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: [] });
  }
});

// POST /admin/pins/update
router.post('/update', async (req, res) => {
  try {
    const input = req.body;
    const acno = (input.acno || '').trim();
    if (!acno) return res.status(400).json({ status: 'error', message: 'Account number (acno) is required', data: null });
    if (!input.pin || !input.name) {
      return res.status(400).json({ status: 'error', message: 'PIN and name are required', data: null });
    }

    for (const f of ['pin', 'pin2', 'pin3', 'pin4', 'pin5']) {
      const v = (input[f] || '').trim();
      if (v) {
        if (v.length < 4 || v.length > 10) return res.status(400).json({ status: 'error', message: `${f} must be between 4 and 10 characters`, data: null });
        if (!/^\d+$/.test(v)) return res.status(400).json({ status: 'error', message: `${f} must contain only digits`, data: null });
      }
    }

    const pins = await getCollection('pins');
    const users = await getCollection('users');
    if (!pins || !users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const user = await users.findOne({ acno });
    if (!user) return res.status(404).json({ status: 'error', message: 'Account number not found', data: null });

    const existing = await pins.findOne({ acno });
    const fields = ['pin', 'name', 'pin2', 'name2', 'pin3', 'name3', 'pin4', 'name4', 'pin5', 'name5'];
    let action, pinId;

    if (existing) {
      const $set = {};
      for (const f of fields) {
        if (f in input) $set[f] = input[f] || null;
      }
      $set.updated_at = new Date();
      await pins.updateOne({ acno }, { $set });
      pinId = existing.id ?? existing._id;
      action = 'updated';
    } else {
      pinId = await getNextSequence('pins');
      const doc = { id: pinId, acno, created_at: new Date(), updated_at: new Date() };
      for (const f of fields) doc[f] = input[f] || null;
      const vendorId = (input.vendor_id != null && String(input.vendor_id).trim() !== '') ? String(input.vendor_id).trim() : (req.adminVendorId != null ? String(req.adminVendorId) : (user.vendor_id != null ? String(user.vendor_id) : null));
      if (vendorId) doc.vendor_id = vendorId;
      await pins.insertOne(doc);
      action = 'created';
    }

    const updated = await pins.findOne({ acno }, { sort: { id: -1 } });
    const data = mongoDocToArray(updated);
    addMaskedPins(data);

    res.json({ status: 'success', message: `PIN ${action} successfully`, data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
