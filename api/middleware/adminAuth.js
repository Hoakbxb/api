/**
 * Resolve admin and vendor from Bearer token.
 * Used to enforce "only show data created by this admin" (vendor isolation).
 */
const { getCollection } = require('../config/db');

async function getAdminFromToken(req) {
  try {
    const authHeader = req.get('Authorization') || req.headers.authorization || '';
    const bearer = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7).trim() : null;
    const queryToken = req.query?.session_token || req.query?.token || null;
    const sessionToken =
      req.body?.session_token ||
      req.body?.token ||
      (queryToken ? String(queryToken).trim() : null) ||
      bearer;

    if (!sessionToken) return null;

    const sessions = await getCollection('admin_sessions');
    if (!sessions) return null;

    const session = await sessions.findOne({ session_token: sessionToken });
    if (!session) return null;

    const adminUsers = await getCollection('admin_users');
    if (!adminUsers) return null;

    const admin =
      (await adminUsers.findOne({ id: session.admin_id, status: 'active' })) ||
      (await adminUsers.findOne({ id: String(session.admin_id), status: 'active' }));

    if (!admin) return null;

    // Use session's vendor_id (set at login) or admin's vendor_id or fallback to username
    const vendorId = session.vendor_id ?? admin.vendor_id ?? admin.username;
    if (vendorId !== undefined && vendorId !== null) {
      admin.vendor_id = vendorId;
    } else {
      admin.vendor_id = admin.username;
    }

    return admin;
  } catch (err) {
    console.error('getAdminFromToken error:', err.message);
    return null;
  }
}

/**
 * Attach admin and adminVendorId to request. Does not block; call next() always.
 * Use for routes that need to know the current admin's vendor for filtering.
 */
function attachAdmin(req, res, next) {
  getAdminFromToken(req)
    .then((admin) => {
      if (admin) {
        req.admin = admin;
        req.adminVendorId = admin.vendor_id ?? admin.username;
      } else {
        req.admin = null;
        req.adminVendorId = null;
      }
      next();
    })
    .catch((err) => {
      console.error('attachAdmin error:', err.message);
      req.admin = null;
      req.adminVendorId = null;
      next();
    });
}

/**
 * Require admin to be logged in. Returns 401 if no valid admin token.
 * Use after attachAdmin for routes that must be admin-only and vendor-scoped.
 */
function requireAdmin(req, res, next) {
  if (!req.adminVendorId) {
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: valid admin session required',
      data: null,
    });
  }
  next();
}

module.exports = {
  getAdminFromToken,
  attachAdmin,
  requireAdmin,
};
