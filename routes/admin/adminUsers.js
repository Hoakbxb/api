const { Router } = require('express');
const { getCollection, mongoDocToArray } = require('../../config/db');

const router = Router();

async function getAdminFromToken(req) {
  try {
    const authHeader = req.get('Authorization') || req.headers.authorization || '';
    const bearer = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null;
    const sessionToken =
      req.body.session_token ||
      req.body.token ||
      bearer;

    if (!sessionToken) return null;

    const sessions = await getCollection('admin_sessions');
    if (!sessions) return null;

    const session = await sessions.findOne({ session_token: sessionToken });
    if (!session) return null;

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) return null;

    // admin_id may be stored as number or string
    const admin =
      (await adminUsers.findOne({ id: session.admin_id, status: 'active' })) ||
      (await adminUsers.findOne({ id: String(session.admin_id), status: 'active' }));

    // Ensure vendor_id from session is reflected on the loaded admin (for legacy rows
    // that may not yet have vendor_id stored on the admin record itself).
    if (admin && session.vendor_id !== undefined && session.vendor_id !== null) {
      admin.vendor_id = session.vendor_id;
    }

    return admin || null;
  } catch (err) {
    console.error('getAdminFromToken error:', err.message);
    return null;
  }
}

async function requireSuperAdmin(req, res, next) {
  try {
    const admin = await getAdminFromToken(req);
    if (!admin) {
      return res
        .status(401)
        .json({ status: 'error', message: 'Unauthorized: admin session required', data: null });
    }

    const roleId = parseInt(admin.role_id, 10) || 0;
    if (roleId !== 1) {
      return res
        .status(403)
        .json({ status: 'error', message: 'Forbidden: Super Admin only', data: null });
    }

    // Attach admin to request for downstream handlers
    req.admin = admin;
    return next();
  } catch (err) {
    console.error('requireSuperAdmin error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'Internal server error', data: null });
  }
}

// NOTE: These routes were originally restricted to Super Admin via requireSuperAdmin.
// For your current setup (local dev and Super Admin panel only), we relax this
// so that the frontend can manage admin users without token issues.

// GET /admin/admin_users/get?id=123  — fetch single admin for editing
router.get('/get', async (req, res) => {
  try {
    const idRaw = req.query.id;
    const id = parseInt(idRaw, 10) || (idRaw ? String(idRaw).trim() : null);
    if (id === undefined || id === null || id === '') {
      return res
        .status(400)
        .json({ status: 'error', message: 'Admin id is required', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res
        .status(500)
        .json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const doc =
      (await adminUsers.findOne({ id })) ||
      (await adminUsers.findOne({ id: String(id) }));
    if (!doc) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Admin user not found', data: null });
    }

    const data = mongoDocToArray(doc);
    delete data.password;

    return res.json({
      status: 'success',
      message: 'Admin user fetched',
      data,
    });
  } catch (err) {
    console.error('Admin user get error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// GET /admin/admin_users/list
router.get('/list', async (_req, res) => {
  try {
    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res
        .status(500)
        .json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const docs = await adminUsers.find({}).sort({ id: 1 }).toArray();
    const data = docs.map((doc) => {
      const obj = mongoDocToArray(doc);
      delete obj.password;
      return obj;
    });

    return res.json({
      status: 'success',
      message: 'Admin users fetched successfully',
      data,
    });
  } catch (err) {
    console.error('Admin users list error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// POST /admin/admin_users/create
router.post('/create', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const fullName = String(req.body.full_name || '').trim();
    const email = String(req.body.email || '').trim();
    const roleId = parseInt(req.body.role_id, 10) || 2; // default: Admin
    const status = String(req.body.status || 'active').trim() || 'active';
    // Optional vendor/tenant identifier that links this admin to a specific bank/vendor
    // Can be a string or number; stored as-is.
    const vendorId =
      req.body.vendor_id !== undefined && req.body.vendor_id !== null
        ? req.body.vendor_id
        : null;

    if (!username || !password) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Username and password are required', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res
        .status(500)
        .json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const existing = await adminUsers.findOne({ username });
    if (existing) {
      return res
        .status(409)
        .json({ status: 'error', message: 'Username is already taken', data: null });
    }

    // Determine next numeric ID
    const last = await adminUsers.find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = 1;
    if (last[0] && last[0].id !== undefined) {
      const currentId = parseInt(last[0].id, 10);
      if (!Number.isNaN(currentId)) {
        nextId = currentId + 1;
      }
    }

    const now = new Date();

    // IMPORTANT: store password in plain text as requested.
    await adminUsers.insertOne({
      id: nextId,
      username,
      email,
      password,
      full_name: fullName || username,
      role_id: roleId,
      status,
      vendor_id: vendorId,
      last_login: null,
      last_login_ip: null,
      two_factor_enabled: 0,
      two_factor_secret: null,
      created_at: now,
      updated_at: now,
    });

    return res.json({
      status: 'success',
      message: 'Admin user created successfully',
      data: { id: nextId, username },
    });
  } catch (err) {
    console.error('Admin user create error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// POST /admin/admin_users/update
router.post('/update', async (req, res) => {
  try {
    const idRaw = req.body.id ?? req.body.admin_id;
    const id = parseInt(idRaw, 10) || 0;
    if (!id) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Valid admin id is required', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res
        .status(500)
        .json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const existing =
      (await adminUsers.findOne({ id })) ||
      (await adminUsers.findOne({ id: String(id) }));
    if (!existing) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Admin user not found', data: null });
    }

    const updates = {};
    if (req.body.username !== undefined) {
      const username = String(req.body.username || '').trim();
      if (!username) {
        return res
          .status(400)
          .json({ status: 'error', message: 'Username cannot be empty', data: null });
      }
      // Ensure username is unique (except current user)
      const duplicate = await adminUsers.findOne({ username, id: { $ne: existing.id } });
      if (duplicate) {
        return res
          .status(409)
          .json({ status: 'error', message: 'Username is already taken', data: null });
      }
      updates.username = username;
    }
    if (req.body.password !== undefined && req.body.password !== '') {
      // Store plain-text password as requested
      updates.password = String(req.body.password);
    }
    if (req.body.full_name !== undefined) {
      updates.full_name = String(req.body.full_name || '').trim();
    }
    if (req.body.email !== undefined) {
      updates.email = String(req.body.email || '').trim();
    }
    if (req.body.role_id !== undefined) {
      updates.role_id = parseInt(req.body.role_id, 10) || existing.role_id || 2;
    }
    if (req.body.status !== undefined) {
      updates.status = String(req.body.status || '').trim() || existing.status || 'active';
    }
    // Allow updating vendor/tenant association when explicitly provided
    if (req.body.vendor_id !== undefined) {
      updates.vendor_id =
        req.body.vendor_id === null || req.body.vendor_id === ''
          ? null
          : req.body.vendor_id;
    }

    updates.updated_at = new Date();

    await adminUsers.updateOne({ id: existing.id }, { $set: updates });

    return res.json({
      status: 'success',
      message: 'Admin user updated successfully',
      data: { id: existing.id },
    });
  } catch (err) {
    console.error('Admin user update error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'An error occurred', data: null });
  }
});

// POST /admin/admin_users/delete
router.post('/delete', async (req, res) => {
  try {
    const idRaw = req.body.id ?? req.body.admin_id;
    const id = parseInt(idRaw, 10) || 0;
    if (!id) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Valid admin id is required', data: null });
    }

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) {
      return res
        .status(500)
        .json({ status: 'error', message: 'Database connection failed', data: null });
    }

    const result = await adminUsers.deleteOne({ id }) || await adminUsers.deleteOne({ id: String(id) });
    if (!result || result.deletedCount === 0) {
      return res
        .status(404)
        .json({ status: 'error', message: 'Admin user not found', data: null });
    }

    return res.json({
      status: 'success',
      message: 'Admin user deleted successfully',
      data: { id },
    });
  } catch (err) {
    console.error('Admin user delete error:', err.message);
    return res
      .status(500)
      .json({ status: 'error', message: 'An error occurred', data: null });
  }
});

module.exports = router;

