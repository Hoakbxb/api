const { Router } = require('express');
const { getDb, getCollection, mongoDocToArray } = require('../config/db');

const router = Router();

// GET /get_countries
router.get('/get_countries', (_req, res) => {
  const countries = [
    { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
    { code: 'CA', name: 'Canada' }, { code: 'AU', name: 'Australia' },
    { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
    { code: 'IT', name: 'Italy' }, { code: 'ES', name: 'Spain' },
    { code: 'NL', name: 'Netherlands' }, { code: 'BE', name: 'Belgium' },
    { code: 'CH', name: 'Switzerland' }, { code: 'AT', name: 'Austria' },
    { code: 'SE', name: 'Sweden' }, { code: 'NO', name: 'Norway' },
    { code: 'DK', name: 'Denmark' }, { code: 'FI', name: 'Finland' },
    { code: 'PL', name: 'Poland' }, { code: 'IE', name: 'Ireland' },
    { code: 'PT', name: 'Portugal' }, { code: 'GR', name: 'Greece' },
    { code: 'IN', name: 'India' }, { code: 'CN', name: 'China' },
    { code: 'JP', name: 'Japan' }, { code: 'KR', name: 'South Korea' },
    { code: 'SG', name: 'Singapore' }, { code: 'MY', name: 'Malaysia' },
    { code: 'TH', name: 'Thailand' }, { code: 'PH', name: 'Philippines' },
    { code: 'ID', name: 'Indonesia' }, { code: 'VN', name: 'Vietnam' },
    { code: 'NZ', name: 'New Zealand' }, { code: 'ZA', name: 'South Africa' },
    { code: 'AE', name: 'United Arab Emirates' }, { code: 'SA', name: 'Saudi Arabia' },
    { code: 'BR', name: 'Brazil' }, { code: 'MX', name: 'Mexico' },
  ].sort((a, b) => a.name.localeCompare(b.name));

  res.json({ status: 'success', data: countries, count: countries.length });
});

// GET /get_tables
router.get('/get_tables', async (_req, res) => {
  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const collections = await db.listCollections().toArray();
    const names = collections.map(c => c.name).sort();
    res.json({ status: 'success', message: 'Collections listed', data: { tables: names, count: names.length } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// GET /system_settings — optional key; when key given, optional vendor_id scopes to that vendor.
router.get('/system_settings', async (req, res) => {
  try {
    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const key = (req.query.key || '').trim();
    const vendorId = (req.query.vendor_id || '').trim() || null;

    if (key) {
      // Admin stores vendor-scoped keys as "site_name__v__{vendorId}"; look up that first, then global "site_name"
      let doc = null;
      if (vendorId) {
        const vendorScopedKey = `${key}__v__${vendorId}`;
        doc = await coll.findOne({ setting_key: vendorScopedKey });
      }
      if (!doc) {
        doc = await coll.findOne({
          setting_key: key,
          $or: [{ vendor_id: null }, { vendor_id: '' }, { vendor_id: { $exists: false } }],
        });
      }
      if (!doc) doc = await coll.findOne({ setting_key: key });
      if (!doc) return res.status(404).json({ status: 'error', message: 'Setting not found', data: null });
      let value = doc.setting_value ?? null;
      const type = doc.setting_type || 'string';
      if (type === 'integer') value = parseInt(value);
      else if (type === 'boolean') value = value === '1' || value === 'true';
      else if (['json', 'array'].includes(type)) { try { value = JSON.parse(value); } catch {} }
      return res.json({ status: 'success', message: 'Success', data: { setting_key: key, setting_value: value, setting_type: type } });
    }

    const filter = vendorId ? { $or: [{ vendor_id: vendorId }, { vendor_id: null }, { vendor_id: '' }, { vendor_id: { $exists: false } }] } : {};
    const cursor = coll.find(filter);
    const list = [];
    for await (const doc of cursor) list.push(mongoDocToArray(doc));
    res.json({ status: 'success', message: 'Settings retrieved', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

module.exports = router;
