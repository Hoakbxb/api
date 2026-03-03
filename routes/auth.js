const { Router } = require('express');
const crypto = require('crypto');
const { getCollection, mongoDocToArray } = require('../config/db');

const router = Router();

// POST /auth/login  — User login
router.post('/login', async (req, res) => {
  try {
    const { acno, password } = req.body;
    if (!acno || !password) {
      return res.status(400).json({ status: 'error', message: 'Account number and password are required', data: null });
    }

    const users = await getCollection('users');
    if (!users) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const user = await users.findOne(
      { acno: acno.trim(), status: 'active' },
      { projection: { id: 1, fname: 1, acno: 1, pass: 1, address: 1, phone: 1, email: 1, city: 1, state: 1, country: 1, image: 1, date: 1, typ: 1, cur: 1, total: 1, pin: 1, count: 1, status: 1, gender: 1, branch: 1, dob: 1, marital: 1, bname: 1, badd: 1 } }
    );
    if (!user) {
      return res.status(401).json({ status: 'error', message: 'Invalid account number or password', data: null });
    }

    const userArr = mongoDocToArray(user);
    if ((userArr.pass || '') !== password.trim()) {
      return res.status(401).json({ status: 'error', message: 'Invalid account number or password', data: null });
    }

    delete userArr.pass;
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

    res.json({
      status: 'success',
      message: 'Login successful',
      data: { user: userArr, session_token: sessionToken, expires_at: expiresAt },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ status: 'error', message: 'An error occurred. Please try again later.', data: null });
  }
});

module.exports = router;
