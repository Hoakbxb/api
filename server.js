require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getClient, getConnectionError } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 8080;

const path = require('path');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Static uploads (profile images) ────────────────────
const uploadsDir = path.join(__dirname, '..', 'api', 'uploads');
app.use('/uploads', express.static(uploadsDir, { maxAge: '1y' }));
app.get('/get_image', (req, res) => {
  const file = req.query.file || '';
  const filename = path.basename(file.replace(/^uploads\//, ''));
  if (!filename) return res.status(400).send('File parameter required');
  const filePath = path.join(uploadsDir, filename);
  res.sendFile(filePath, err => { if (err) res.status(404).send('Image not found'); });
});

// ─── Admin auth: resolve vendor from token, require login for all /admin except /auth ───
const { attachAdmin, requireAdmin } = require('./middleware/adminAuth');
app.use('/admin', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  attachAdmin(req, res, () => {
    requireAdmin(req, res, next);
  });
});

// ─── Routes ──────────────────────────────────────────────

app.use('/auth', require('./routes/auth'));
app.use('/', require('./routes/users'));
app.use('/', require('./routes/transactions'));
app.use('/', require('./routes/branches'));
app.use('/', require('./routes/misc'));
app.use('/loans', require('./routes/loans'));
app.use('/credit_cards', require('./routes/creditCards'));
app.use('/pins', require('./routes/pins'));
app.use('/admin/auth', require('./routes/admin/auth'));
app.use('/admin/dashboard', require('./routes/admin/dashboard'));
app.use('/admin/transactions', require('./routes/admin/transactions'));
app.use('/admin/settings', require('./routes/admin/settings'));
app.use('/admin/pins', require('./routes/admin/pins'));
app.use('/admin/credit_cards', require('./routes/admin/creditCards'));
app.use('/admin/loans', require('./routes/admin/loans'));
app.use('/admin/users', require('./routes/admin/users'));
app.use('/admin/backup', require('./routes/admin/backup'));
app.use('/admin/cache', require('./routes/admin/cache'));
app.use('/admin/admin_users', require('./routes/admin/adminUsers'));
app.use('/upload', require('./routes/upload'));

// ─── Health / Index ──────────────────────────────────────

app.get('/', async (_req, res) => {
  let ok = false;
  let hint = '';
  try {
    const client = await getClient();
    if (client) {
      await client.db('admin').command({ ping: 1 });
      ok = true;
    } else {
      hint = getConnectionError() || '';
    }
  } catch (e) {
    hint = e.message;
  }

  res.json({
    status: ok ? 'success' : 'error',
    message: ok ? 'API (MongoDB/Node.js) is running' : 'MongoDB connection failed' + (hint ? ': ' + hint : ''),
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    database: 'mongodb',
    endpoints: {
      health: '/',
      auth_login: '/auth/login',
      get_user: '/get_user',
      get_users: '/get_users',
      create_account: '/create_account',
      update_user: '/update_user',
      transfer: '/transfer',
      credit: '/credit',
      debit: '/debit',
      get_branches: '/get_branches',
      get_countries: '/get_countries',
      system_settings: '/system_settings',
      admin_login: '/admin/auth/login',
      admin_logout: '/admin/auth/logout',
      admin_stats: '/admin/dashboard/stats',
      admin_recent_transactions: '/admin/dashboard/recent_transactions',
      admin_top_customers: '/admin/dashboard/top_customers',
      admin_chart_data: '/admin/dashboard/chart_data',
      admin_pending: '/admin/transactions/pending',
      admin_approve: '/admin/transactions/approve',
      admin_settings_get: '/admin/settings/get',
      admin_settings_update: '/admin/settings/update',
      admin_settings_email: '/admin/settings/email',
      admin_settings_live_chat: '/admin/settings/live_chat',
      admin_settings_site: '/admin/settings/site',
      admin_pins_users: '/admin/pins/users_with_pins',
      admin_pins_get: '/admin/pins/get',
      admin_pins_update: '/admin/pins/update',
      admin_users_transactions: '/admin/users/transactions',
      admin_users_get_transaction: '/admin/users/get_transaction',
      admin_users_update_transaction: '/admin/users/update_transaction',
      admin_users_delete_transaction: '/admin/users/delete_transaction',
      admin_users_delete: '/admin/users/delete',
      admin_loans_list: '/admin/loans/list',
      admin_loans_get: '/admin/loans/get',
      admin_loans_approve: '/admin/loans/approve',
      admin_loans_reject: '/admin/loans/reject',
      admin_loans_disburse: '/admin/loans/disburse',
      admin_loans_products: '/admin/loans/products',
      admin_loans_stats: '/admin/loans/stats',
      admin_credit_cards_list: '/admin/credit_cards/list',
      admin_credit_cards_get: '/admin/credit_cards/get',
      admin_credit_cards_update_status: '/admin/credit_cards/update_status',
      admin_credit_cards_issue: '/admin/credit_cards/issue',
      admin_credit_cards_products: '/admin/credit_cards/products',
      admin_credit_cards_stats: '/admin/credit_cards/stats',
      admin_backup_create: '/admin/backup/backup',
      admin_backup_list: '/admin/backup/list',
      admin_backup_delete: '/admin/backup/delete',
      admin_cache_clear: '/admin/cache/clear',
      upload_avatar: '/upload/avatar',
      loans_apply: '/loans/apply',
      credit_cards_apply: '/credit_cards/apply',
    },
  });
});

// ─── 404 ─────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ status: 'error', message: 'Endpoint not found', data: null });
});

// ─── Global error handler ────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ status: 'error', message: 'Internal server error', data: null });
});

// ─── Start ───────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Bank 2026 API (MongoDB/Node.js) running on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});
