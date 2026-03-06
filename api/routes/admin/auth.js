const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getCollection, mongoDocToArray } = require('../../config/db');

const router = Router();

function normalizeBcryptHash(hash) {
  const str = String(hash || '');
  if (str.startsWith('$2y$')) return '$2b$' + str.slice(4);
  return str;
}

async function verifyPassword(inputPassword, storedPassword) {
  const plainInput = String(inputPassword ?? '');
  const stored = String(storedPassword ?? '');
  if (stored === plainInput) return true;

  if (stored.startsWith('$2')) {
    const candidates = [];
    // Native/modern bcrypt hash
    candidates.push(stored);

    // Legacy PHP bcrypt variants
    if (stored.startsWith('$2y$')) {
      candidates.push('$2a$' + stored.slice(4));
      candidates.push('$2b$' + stored.slice(4));
    } else {
      const normalized = normalizeBcryptHash(stored);
      if (normalized !== stored) candidates.push(normalized);
    }

    for (const candidate of candidates) {
      try {
        if (await bcrypt.compare(plainInput, candidate)) return true;
      } catch {
        // Try next candidate
      }
    }
  }
  return false;
}

// POST /admin/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || password === undefined || password === '') {
      return res.status(400).json({ status: 'error', message: 'Username and password are required', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    const adminRoles = await getCollection('admin_roles');
    if (!adminUsers || !adminRoles) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const admin = await adminUsers.findOne({ username: username.trim(), status: 'active' });
    if (!admin) {
      return res.status(401).json({ status: 'error', message: 'Invalid username or password', data: null });
    }

    // Support both legacy bcrypt hashes ($2y/$2b) and plain-text passwords.
    const passwordOk = await verifyPassword(password, admin.password || '');
    if (!passwordOk) {
      return res.status(401).json({ status: 'error', message: 'Invalid username or password', data: null });
    }

    const role = await adminRoles.findOne({ id: admin.role_id });
    const adminArr = mongoDocToArray(admin);
    delete adminArr.password;
    adminArr.role_name = role?.name || '';
    adminArr.permissions = role?.permissions || '';

    // Derive a stable vendor/tenant identifier for this admin.
    // If vendor_id already exists on the admin record, use it.
    // Otherwise, default to the admin's username so each admin
    // automatically gets an isolated "vendor space" without DB migration.
    const effectiveVendorId =
      admin.vendor_id !== undefined && admin.vendor_id !== null && String(admin.vendor_id).trim() !== ''
        ? admin.vendor_id
        : admin.username;

    adminArr.vendor_id = effectiveVendorId;

    // Persist back to admin_users so future logins don't need to derive it again.
    try {
      await adminUsers.updateOne(
        { id: admin.id },
        { $set: { vendor_id: effectiveVendorId } }
      );
    } catch (e) {
      // Non-fatal; vendor scoping will still work via session/adminArr
      console.error('Failed to persist admin vendor_id:', e.message);
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const expiresAtStr = expiresAt.toISOString().replace('T', ' ').substring(0, 19);

    const sessions = await getCollection('admin_sessions');
    if (sessions) {
      await sessions.insertOne({
        admin_id: admin.id,
        // Persist vendor/tenant on the session for easier scoping later
        vendor_id: effectiveVendorId,
        session_token: sessionToken,
        ip_address: req.ip || '',
        user_agent: req.headers['user-agent'] || '',
        last_activity: new Date(),
        expires_at: expiresAt,
        created_at: new Date(),
      });
    }
    await adminUsers.updateOne({ id: admin.id }, { $set: { last_login: new Date(), last_login_ip: req.ip || '' } });

    res.json({
      status: 'success',
      message: 'Login successful',
      data: { admin: adminArr, session_token: sessionToken, expires_at: expiresAtStr },
    });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// POST /admin/auth/logout
router.post('/logout', async (req, res) => {
  try {
    const sessionToken =
      req.body.session_token ||
      req.body.token ||
      (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : null);

    if (sessionToken) {
      const sessions = await getCollection('admin_sessions');
      if (sessions) {
        await sessions.deleteOne({ session_token: sessionToken });
      }
    }

    res.json({
      status: 'success',
      message: 'Logged out successfully',
      data: null,
    });
  } catch (err) {
    console.error('Admin logout error:', err.message);
    res.status(500).json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// POST /admin/auth/change_password
router.post('/change_password', async (req, res) => {
  try {
    const adminId = parseInt(req.body.admin_id, 10) || 0;
    const adminUsername = String(req.body.admin_username || '').trim();
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');

    if (adminId <= 0 && !adminUsername) {
      return res.status(400).json({ status: 'error', message: 'Invalid admin identity', data: null });
    }
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ status: 'error', message: 'Current and new passwords are required', data: null });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ status: 'error', message: 'New password must be at least 6 characters', data: null });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ status: 'error', message: 'New password must be different from current password', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    }

    let admin = null;
    if (adminUsername) {
      admin = await adminUsers.findOne({ username: adminUsername, status: 'active' });
    }
    if (!admin && adminId > 0) {
      admin = await adminUsers.findOne({ id: adminId, status: 'active' });
      if (!admin) {
        admin = await adminUsers.findOne({ id: String(adminId), status: 'active' });
      }
    }
    if (!admin) {
      return res.status(404).json({ status: 'error', message: 'Admin user not found', data: null });
    }

    const currentPasswordOk = await verifyPassword(currentPassword, admin.password || '');
    if (!currentPasswordOk) {
      return res.status(401).json({ status: 'error', message: 'Current password is incorrect', data: null });
    }

    // Store plain text password as requested.
    await adminUsers.updateOne(
      { id: adminId },
      { $set: { password: newPassword, updated_at: new Date() } }
    );

    return res.json({ status: 'success', message: 'Admin password changed successfully', data: { admin_id: adminId } });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Error: ' + err.message, data: null });
  }
});

module.exports = router;
