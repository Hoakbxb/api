const { Router } = require('express');
const { getCollection, getNextSequence, mongoDocToArray } = require('../config/db');
const { sendAccountCreatedEmail, sendPasswordChangedEmail } = require('../config/mailer');
const { getAdminFromToken } = require('../middleware/adminAuth');

const router = Router();

function generateAccountNumber() {
  return 'AC' + String(Math.floor(Math.random() * 10000000000)).padStart(10, '0');
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
}

function calcAge(dob) {
  const b = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

// GET /get_user — single user by id or acno. When admin token present, only return user for that admin's vendor.
router.get('/get_user', async (req, res) => {
  try {
    const userId = parseInt(req.query.id) || 0;
    const acno = (req.query.acno || '').trim();
    if (userId <= 0 && !acno) {
      return res.status(400).json({ status: 'error', message: 'Invalid user ID or account number', data: null });
    }

    const users = await getCollection('users');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const filter = userId > 0 ? { id: userId } : { acno };
    const admin = await getAdminFromToken(req);
    if (admin) {
      filter.vendor_id = admin.vendor_id ?? admin.username;
    }
    const user = await users.findOne(filter);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found', data: null });

    const u = mongoDocToArray(user);
    delete u.pass;
    u.total = parseFloat(u.total || 0);
    u.count = parseInt(u.count || 0);
    if (u.date) u.date_formatted = fmtDate(u.date);
    if (u.dob) {
      u.dob_formatted = fmtDate(u.dob);
      u.age = calcAge(u.dob);
    }

    if (req.query.include_pins === '1' && u.acno) {
      const pins = await getCollection('pins');
      const pinDoc = await pins.findOne({ acno: u.acno }, { sort: { id: -1 } });
      if (pinDoc) {
        const pinData = mongoDocToArray(pinDoc);
        for (const f of ['pin', 'pin2', 'pin3', 'pin4', 'pin5']) {
          if (pinData[f] && pinData[f].length > 2) {
            pinData[f + '_masked'] = '*'.repeat(pinData[f].length - 2) + pinData[f].slice(-2);
          }
        }
        u.pins = pinData;
      } else {
        u.pins = null;
      }
    }
    delete u.pin;

    res.json({ status: 'success', message: 'User retrieved successfully', data: u });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// GET /get_users — paginated list
router.get('/get_users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 10));
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();
    let sort = (req.query.sort || 'id').trim();
    const order = (req.query.order || '').toUpperCase() === 'ASC' ? 1 : -1;

    const allowed = ['id', 'fname', 'email', 'phone', 'acno', 'date', 'total', 'status'];
    if (!allowed.includes(sort)) sort = 'id';

    const users = await getCollection('users');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: [] });

    const filter = {};
    if (search) {
      const re = { $regex: search, $options: 'i' };
      filter.$or = [{ fname: re }, { email: re }, { phone: re }, { acno: re }];
    }
    if (status) filter.status = status;

    // When admin is logged in (Bearer token), only return users for that admin's vendor.
    const admin = await getAdminFromToken(req);
    if (admin) {
      filter.vendor_id = admin.vendor_id ?? admin.username;
    }

    const totalItems = await users.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / limit);
    const skip = (page - 1) * limit;

    const cursor = users.find(filter)
      .sort({ [sort]: order }).skip(skip).limit(limit);
    const list = [];
    for await (const doc of cursor) {
      const u = mongoDocToArray(doc);
      u.total = parseFloat(u.total || 0);
      u.count = parseInt(u.count || 0);
      if (u.date) u.date_formatted = fmtDate(u.date);
      if (u.dob) u.dob_formatted = fmtDate(u.dob);
      list.push(u);
    }

    res.json({
      status: 'success',
      message: 'Users retrieved successfully',
      data: list,
      pagination: { current_page: page, total_pages: totalPages, total_items: totalItems, items_per_page: limit },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: [], pagination: { current_page: 1, total_pages: 0, total_items: 0, items_per_page: 10 } });
  }
});

// POST /create_account
router.post('/create_account', async (req, res) => {
  try {
    const input = req.body;
    const required = {
      fname: 'First name', pass: 'Password', email: 'Email', phone: 'Phone',
      address: 'Address', city: 'City', state: 'State', country: 'Country',
      dob: 'Date of birth', gender: 'Gender', typ: 'Account type', cur: 'Currency',
      pin: 'PIN', branch: 'Branch',
    };
    const missing = Object.entries(required).filter(([f]) => !input[f]).map(([f, l]) => `${l} (${f})`);
    if (missing.length) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields: ' + missing.join(', '), data: null });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      return res.status(400).json({ status: 'error', message: 'Invalid email format', data: null });
    }

    const users = await getCollection('users');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    if (await users.findOne({ email: input.email.trim() })) {
      return res.status(409).json({ status: 'error', message: 'Email already exists', data: null });
    }

    let acno = input.acno ? input.acno.trim() : generateAccountNumber();
    if (!input.acno) {
      while (await users.findOne({ acno })) acno = generateAccountNumber();
    } else if (await users.findOne({ acno })) {
      return res.status(409).json({ status: 'error', message: 'Account number already exists', data: null });
    }

    const admin = await getAdminFromToken(req);
    const inputVendorId =
      input.vendor_id !== undefined && input.vendor_id !== null && String(input.vendor_id).trim() !== ''
        ? String(input.vendor_id).trim()
        : null;
    const vendorId = admin ? String(admin.vendor_id ?? admin.username) : inputVendorId;
    if (!vendorId || String(vendorId).trim() === '') {
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized: vendor context required to create account',
        data: null,
      });
    }

    const userId = await getNextSequence('users');
    const doc = {
      id: userId,
      fname: (input.fname || '').trim(),
      acno,
      pass: (input.pass || '').trim(),
      address: (input.address || '').trim(),
      phone: (input.phone || '').trim(),
      email: (input.email || '').trim(),
      city: (input.city || '').trim(),
      state: (input.state || '').trim(),
      country: (input.country || '').trim(),
      image: (input.image || '').trim(),
      date: input.date || new Date().toISOString().substring(0, 10),
      typ: (input.typ || '').trim(),
      cur: (input.cur || 'USD').trim(),
      total: parseFloat(input.total) || 0,
      pin: (input.pin || '').trim(),
      count: parseInt(input.count) || 0,
      status: (input.status || 'active').trim(),
      gender: (input.gender || '').trim(),
      branch: (input.branch || '').trim(),
      dob: input.dob || null,
      marital: (input.marital || '').trim(),
      bname: (input.bname || '').trim(),
      badd: (input.badd || '').trim(),
      vendor_id: String(vendorId).trim(),
    };

    await users.insertOne(doc);
    const emailVendorId = vendorId != null && String(vendorId).trim() !== '' ? String(vendorId).trim() : null;
    const emailResult = await sendAccountCreatedEmail({
      user: doc,
      plainPassword: doc.pass,
      vendorId: emailVendorId,
    });
    const data = { ...doc };
    delete data.pass;
    delete data._id;
    data.notification = {
      email_sent: emailResult.sent === true,
      email_error: emailResult.sent ? null : (emailResult.reason || null),
    };

    res.status(201).json({
      status: 'success',
      message: emailResult.sent
        ? 'Account created successfully and notification email sent'
        : 'Account created successfully (email notification could not be sent)',
      data,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

// POST|PUT /update_user
router.all('/update_user', async (req, res) => {
  if (!['POST', 'PUT'].includes(req.method)) {
    return res.status(405).json({ status: 'error', message: 'Method not allowed. Use POST or PUT.', data: null });
  }
  try {
    const input = req.body;
    if (!input.id) return res.status(400).json({ status: 'error', message: 'User ID is required', data: null });
    const userId = parseInt(input.id);

    const users = await getCollection('users');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const current = await users.findOne({ id: userId });
    if (!current) return res.status(404).json({ status: 'error', message: 'User not found', data: null });

    const admin = await getAdminFromToken(req);
    if (admin) {
      const adminVendorId = admin.vendor_id ?? admin.username;
      if (current.vendor_id != null && String(current.vendor_id) !== String(adminVendorId)) {
        return res.status(403).json({ status: 'error', message: 'You can only update users belonging to your organization', data: null });
      }
    }

    const allowed = ['fname', 'address', 'phone', 'email', 'city', 'state', 'country', 'image', 'date', 'typ', 'cur', 'total', 'count', 'status', 'gender', 'branch', 'dob', 'marital', 'bname', 'badd', 'pass'];
    const $set = {};
    for (const f of allowed) {
      if (f in input) $set[f] = input[f];
    }
    if (admin) {
      $set.vendor_id = admin.vendor_id ?? admin.username;
    }
    if (!Object.keys($set).length) {
      return res.status(400).json({ status: 'error', message: 'No fields to update', data: null });
    }

    const passwordChanged = ('pass' in $set) && String($set.pass || '') !== String(current.pass || '');

    await users.updateOne({ id: userId }, { $set });
    const updated = await users.findOne({ id: userId });
    const data = mongoDocToArray(updated);
    delete data.pass;

    if (passwordChanged) {
      const emailResult = await sendPasswordChangedEmail({ user: updated });
      data.notification = {
        email_sent: emailResult.sent === true,
        email_error: emailResult.sent ? null : (emailResult.reason || null),
      };
      return res.json({
        status: 'success',
        message: emailResult.sent
          ? 'Password changed successfully and notification email sent'
          : `Password changed successfully (email notification could not be sent: ${emailResult.reason || 'Unknown error'})`,
        data,
      });
    }

    res.json({ status: 'success', message: 'User updated successfully', data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
