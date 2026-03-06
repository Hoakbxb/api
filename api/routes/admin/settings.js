const { Router } = require('express');
const { getCollection, mongoDocToArray } = require('../../config/db');
const { sendConfiguredTestEmail } = require('../../config/mailer');

const router = Router();

// GET /admin/settings/get
router.get('/get', async (req, res) => {
  try {
    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const category = (req.query.category || '').trim();
    const key = (req.query.key || '').trim();

    if (key) {
      const doc = await coll.findOne({ setting_key: key });
      if (!doc) return res.status(404).json({ status: 'error', message: 'Setting not found', data: null });
      let value = doc.setting_value ?? null;
      const type = doc.setting_type || 'string';
      if (type === 'integer') value = parseInt(value);
      else if (type === 'boolean') value = value === '1' || value === 'true';
      else if (['json', 'array'].includes(type)) { try { value = JSON.parse(value); } catch {} }
      return res.json({
        status: 'success', message: 'Success',
        data: { setting_key: key, setting_value: value, setting_type: type, category: doc.category || '', description: doc.description || null },
      });
    }

    const filter = category ? { category } : {};
    const cursor = coll.find(filter);
    const list = [];
    for await (const doc of cursor) list.push(mongoDocToArray(doc));
    res.json({ status: 'success', message: 'Success', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// POST|PUT /admin/settings/update
router.all('/update', async (req, res) => {
  if (!['POST', 'PUT'].includes(req.method)) {
    return res.status(405).json({ status: 'error', message: 'Method not allowed', data: null });
  }
  try {
    const input = req.body;
    const key = (input.setting_key || input.key || '').trim();
    if (!key) return res.status(400).json({ status: 'error', message: 'setting_key is required', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    let value = input.setting_value ?? input.value ?? '';
    const type = input.setting_type || 'string';
    const category = (input.category || 'general').trim();
    const description = (input.description || '').trim();

    if (typeof value === 'object') value = JSON.stringify(value);
    if (typeof value === 'boolean') value = value ? '1' : '0';

    const existing = await coll.findOne({ setting_key: key });
    if (existing) {
      await coll.updateOne({ setting_key: key }, { $set: {
        setting_value: String(value), setting_type: type,
        category, description, updated_at: new Date(),
      }});
    } else {
      const newDoc = {
        setting_key: key, setting_value: String(value), setting_type: type,
        category, description, created_at: new Date(), updated_at: new Date(),
      };
      const vendorId = (input.vendor_id != null && String(input.vendor_id).trim() !== '') ? String(input.vendor_id).trim() : (req.adminVendorId != null ? String(req.adminVendorId) : null);
      if (vendorId) newDoc.vendor_id = vendorId;
      await coll.insertOne(newDoc);
    }

    res.json({ status: 'success', message: 'Setting updated successfully', data: null });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, data: null });
  }
});

// ─── Helper: upsert multiple settings (optionally per vendor) ─────────────
async function upsertSettings(coll, items) {
  for (const s of items) {
    const match = { setting_key: s.key };
    const base = {
      setting_value: String(s.value),
      setting_type: s.type,
      category: s.category,
      updated_at: new Date(),
    };
    if (s.vendor_id !== undefined && s.vendor_id !== null && String(s.vendor_id).trim() !== '') {
      base.vendor_id = String(s.vendor_id).trim();
    }
    await coll.updateOne(
      match,
      {
        $set: base,
        $setOnInsert: {
          description: s.description || '',
          created_at: new Date(),
        },
      },
      { upsert: true }
    );
  }
}

function castValue(doc) {
  let v = doc.setting_value ?? null;
  const t = doc.setting_type || 'string';
  if (t === 'integer') v = parseInt(v);
  else if (t === 'boolean') v = v === '1' || v === 'true';
  else if (['json', 'array'].includes(t)) { try { v = JSON.parse(v); } catch {} }
  return v;
}

// ─── GET|POST /admin/settings/email (per admin/vendor via scoped keys) ─────
router.get('/email', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const docs = await coll.find({ category: 'email_config' }).toArray();
    const m = {};
    for (const d of docs) {
      const rawKey = d.setting_key;
      const parts = String(rawKey).split('__v__');
      if (parts.length !== 2) continue;
      const [baseKey, vid] = parts;
      if (String(vid) !== String(vendorId)) continue;
      m[baseKey] = castValue(d);
    }

    res.json({
      status: 'success',
      data: {
        default_provider: m.default_email_provider ?? 'smtp',
        smtp: {
          host: m.bHost ?? '',
          port: parseInt(m.smtpPort) || 587,
          security: m.smtpSecurity ?? 'tls',
          timeout: parseInt(m.smtpTimeout) || 30,
          username: m.bEmail ?? '',
          password: m.bP ?? '',
          from_name: m.emailFromName ?? '',
          reply_to: m.emailReplyTo ?? '',
        },
        resend: {
          api_key: m.resend_api_key ?? '',
          email: m.resend_email ?? '',
          domain: m.resend_domain ?? '',
          enabled: !!m.resend_api_key,
        },
        other_mailers: {
          mailgun_api_key: m.mailgun_api_key ?? '',
          mailgun_domain: m.mailgun_domain ?? '',
          sendgrid_api_key: m.sendgrid_api_key ?? '',
          ses_region: m.ses_region ?? '',
          ses_access_key: m.ses_access_key ?? '',
          ses_secret_key: m.ses_secret_key ?? '',
        },
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

router.post('/email', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });

    const input = req.body;
    if (!input || !Object.keys(input).length) {
      return res.status(400).json({ status: 'error', message: 'No data provided', data: null });
    }

    const items = [];
    const cat = 'email_config';

    const baseItem = (baseKey, value, type) => ({
      key: vendorScopedKey(baseKey, vendorId),
      value,
      type,
      category: cat,
      vendor_id: vendorId,
    });

    if (input.default_provider != null) {
      items.push(baseItem('default_email_provider', input.default_provider, 'string'));
    }
    if (input.smtp) {
      const s = input.smtp;
      if (s.host != null) items.push(baseItem('bHost', s.host, 'string'));
      if (s.port != null) items.push(baseItem('smtpPort', s.port, 'integer'));
      if (s.security != null) items.push(baseItem('smtpSecurity', s.security, 'string'));
      if (s.timeout != null) items.push(baseItem('smtpTimeout', s.timeout, 'integer'));
      if (s.username != null) items.push(baseItem('bEmail', s.username, 'string'));
      if (s.password != null) items.push(baseItem('bP', s.password, 'string'));
      if (s.from_name != null) items.push(baseItem('emailFromName', s.from_name, 'string'));
      if (s.reply_to != null) items.push(baseItem('emailReplyTo', s.reply_to, 'string'));
    }
    if (input.resend) {
      const r = input.resend;
      if (r.api_key != null) items.push(baseItem('resend_api_key', r.api_key, 'string'));
      if (r.email != null) items.push(baseItem('resend_email', r.email, 'string'));
      if (r.domain != null) items.push(baseItem('resend_domain', r.domain, 'string'));
    }
    if (input.other_mailers) {
      const o = input.other_mailers;
      for (const k of ['mailgun_api_key', 'mailgun_domain', 'sendgrid_api_key', 'ses_region', 'ses_access_key', 'ses_secret_key']) {
        if (o[k] != null) items.push(baseItem(k, o[k], 'string'));
      }
    }

    await upsertSettings(coll, items);
    res.json({ status: 'success', message: 'Email settings updated successfully', data: { updated: items.length } });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

router.post('/email/test', async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim();
    if (!to) {
      return res.status(400).json({ status: 'error', message: 'Recipient email is required', data: null });
    }

    const vendorId = req.adminVendorId;
    const result = await sendConfiguredTestEmail({
      to,
      adminName: req.body?.admin || 'Admin',
      vendorId: vendorId || undefined,
    });

    if (result.sent) {
      return res.json({ status: 'success', message: 'Test email sent successfully', data: { to } });
    }

    // Return 200 so client can parse JSON and show the reason (e.g. missing SMTP config)
    return res.json({
      status: 'error',
      message: result.reason || 'Failed to send test email',
      data: null,
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message, data: null });
  }
});

// ─── GET|POST /admin/settings/live_chat (per admin/vendor via scoped keys) ─
router.get('/live_chat', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const docs = await coll.find({ category: 'live_chat' }).toArray();
    const m = {};
    for (const d of docs) {
      const rawKey = d.setting_key;
      const parts = String(rawKey).split('__v__');
      if (parts.length !== 2) continue;
      const [baseKey, vid] = parts;
      if (String(vid) !== String(vendorId)) continue;
      m[baseKey] = castValue(d);
    }
    res.json({ status: 'success', data: {
      enabled: m.live_chat_enabled ?? false,
      default_provider: m.default_live_chat_provider ?? 'tawk',
      tawk: { enabled: m.tawk_enabled ?? false, property_id: m.tawk_property_id ?? '', widget_id: m.tawk_widget_id ?? '', embed_code: m.tawk_embed_code ?? '' },
      tido: { enabled: m.tido_enabled ?? false, api_key: m.tido_api_key ?? '', widget_id: m.tido_widget_id ?? '', embed_code: m.tido_embed_code ?? '' },
      other: { custom_script: m.custom_chat_script ?? '', custom_css: m.custom_chat_css ?? '' },
    }});
  } catch (e) { res.status(500).json({ status: 'error', message: e.message, data: null }); }
});

router.post('/live_chat', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const input = req.body;
    if (!input || !Object.keys(input).length) return res.status(400).json({ status: 'error', message: 'No data provided', data: null });
    const items = [];
    const cat = 'live_chat';
    const baseItem = (baseKey, value, type) => ({
      key: vendorScopedKey(baseKey, vendorId),
      value,
      type,
      category: cat,
      vendor_id: vendorId,
    });

    if (input.enabled != null) items.push(baseItem('live_chat_enabled', input.enabled ? '1' : '0', 'boolean'));
    if (input.default_provider != null) items.push(baseItem('default_live_chat_provider', input.default_provider, 'string'));
    if (input.tawk) { const t = input.tawk;
      if (t.enabled != null) items.push(baseItem('tawk_enabled', t.enabled ? '1' : '0', 'boolean'));
      if (t.property_id != null) items.push(baseItem('tawk_property_id', t.property_id, 'string'));
      if (t.widget_id != null) items.push(baseItem('tawk_widget_id', t.widget_id, 'string'));
      if (t.embed_code != null) items.push(baseItem('tawk_embed_code', t.embed_code, 'string'));
    }
    if (input.tido) { const t = input.tido;
      if (t.enabled != null) items.push(baseItem('tido_enabled', t.enabled ? '1' : '0', 'boolean'));
      if (t.api_key != null) items.push(baseItem('tido_api_key', t.api_key, 'string'));
      if (t.widget_id != null) items.push(baseItem('tido_widget_id', t.widget_id, 'string'));
      if (t.embed_code != null) items.push(baseItem('tido_embed_code', t.embed_code, 'string'));
    }
    if (input.other) { const o = input.other;
      if (o.custom_script != null) items.push(baseItem('custom_chat_script', o.custom_script, 'string'));
      if (o.custom_css != null) items.push(baseItem('custom_chat_css', o.custom_css, 'string'));
    }
    await upsertSettings(coll, items);
    res.json({ status: 'success', message: 'Live chat settings updated successfully', data: { updated: items.length } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message, data: null }); }
});

// Helper to build vendor-scoped setting keys without requiring compound indexes
function vendorScopedKey(baseKey, vendorId) {
  return `${baseKey}__v__${vendorId}`;
}

// ─── GET|POST /admin/settings/site (per vendor via scoped keys) ──────────
router.get('/site', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const cats = ['site_config', 'bank_info', 'website', 'contact', 'system'];
    const bucket = {};
    for (const c of cats) {
      // Load all docs for this category, then pick only this vendor's scoped keys
      const docs = await coll.find({ category: c }).toArray();
      bucket[c] = {};
      for (const d of docs) {
        const rawKey = d.setting_key;
        const parts = String(rawKey).split('__v__');
        if (parts.length === 2) {
          const [baseKey, vid] = parts;
          if (String(vid) !== String(vendorId)) continue;
          bucket[c][baseKey] = castValue(d);
        }
        // Ignore legacy global keys (without vendor suffix) so one admin's changes
        // do not affect another admin's view in this vendor-scoped endpoint.
      }
    }
    const s = bucket.site_config, b = bucket.bank_info, w = bucket.website, ct = bucket.contact, sy = bucket.system;
    res.json({ status: 'success', data: {
      general: { site_name: s.site_name ?? '', site_url: w.web ?? '', site_description: s.site_description ?? '', site_keywords: s.site_keywords ?? '', maintenance_mode: s.maintenance_mode ?? false, maintenance_message: s.maintenance_message ?? '' },
      bank_info: { bank_name: b.bName ?? '', bank_full_name: b.bFullName ?? '', bank_tagline: b.bTagline ?? '', bank_logo: b.bank_logo ?? '' },
      contact: { contact_email: ct.bContact ?? '', contact_phone: ct.bPhone ?? '', support_hours: ct.bSupportHours ?? '', address: ct.bAddress ?? '', city: ct.bCity ?? '', state: ct.bState ?? '', country: ct.bCountry ?? '', postal_code: ct.bPostalCode ?? '' },
      website: { website_url: w.web ?? '', admin_url: w.admin_url ?? '', api_url: w.api_url ?? '', terms_url: w.terms_url ?? '', privacy_url: w.privacy_url ?? '' },
      system: { timezone: sy.timezone ?? 'UTC', date_format: sy.date_format ?? 'Y-m-d', time_format: sy.time_format ?? 'H:i:s', currency: sy.default_currency ?? 'USD', language: sy.default_language ?? 'en' },
    }});
  } catch (e) { res.status(500).json({ status: 'error', message: e.message, data: null }); }
});

router.post('/site', async (req, res) => {
  try {
    const vendorId = req.adminVendorId;
    if (!vendorId) return res.status(401).json({ status: 'error', message: 'Unauthorized', data: null });

    const coll = await getCollection('system_settings');
    if (!coll) return res.status(500).json({ status: 'error', message: 'Database connection failed', data: null });
    const input = req.body;
    if (!input || !Object.keys(input).length) return res.status(400).json({ status: 'error', message: 'No data provided', data: null });
    const items = [];
    const baseItem = (baseKey, value, type, category) => ({
      key: vendorScopedKey(baseKey, vendorId),
      value,
      type,
      category,
      vendor_id: vendorId,
    });

    if (input.general) { const g = input.general;
      if (g.site_name != null) items.push(baseItem('site_name', g.site_name, 'string', 'site_config'));
      if (g.site_url != null) items.push(baseItem('web', g.site_url, 'string', 'website'));
      if (g.site_description != null) items.push(baseItem('site_description', g.site_description, 'string', 'site_config'));
      if (g.site_keywords != null) items.push(baseItem('site_keywords', g.site_keywords, 'string', 'site_config'));
      if (g.maintenance_mode != null) items.push(baseItem('maintenance_mode', g.maintenance_mode ? '1' : '0', 'boolean', 'site_config'));
      if (g.maintenance_message != null) items.push(baseItem('maintenance_message', g.maintenance_message, 'string', 'site_config'));
    }
    if (input.bank_info) { const b = input.bank_info;
      if (b.bank_name != null) items.push(baseItem('bName', b.bank_name, 'string', 'bank_info'));
      if (b.bank_full_name != null) items.push(baseItem('bFullName', b.bank_full_name, 'string', 'bank_info'));
      if (b.bank_tagline != null) items.push(baseItem('bTagline', b.bank_tagline, 'string', 'bank_info'));
      if (b.bank_logo != null) items.push(baseItem('bank_logo', b.bank_logo, 'string', 'bank_info'));
    }
    if (input.contact) { const c = input.contact;
      if (c.contact_email != null) items.push(baseItem('bContact', c.contact_email, 'string', 'contact'));
      if (c.contact_phone != null) items.push(baseItem('bPhone', c.contact_phone, 'string', 'contact'));
      if (c.support_hours != null) items.push(baseItem('bSupportHours', c.support_hours, 'string', 'contact'));
      if (c.address != null) items.push(baseItem('bAddress', c.address, 'string', 'contact'));
      if (c.city != null) items.push(baseItem('bCity', c.city, 'string', 'contact'));
      if (c.state != null) items.push(baseItem('bState', c.state, 'string', 'contact'));
      if (c.country != null) items.push(baseItem('bCountry', c.country, 'string', 'contact'));
      if (c.postal_code != null) items.push(baseItem('bPostalCode', c.postal_code, 'string', 'contact'));
    }
    if (input.website) { const w = input.website;
      if (w.website_url != null) items.push(baseItem('web', w.website_url, 'string', 'website'));
      if (w.admin_url != null) items.push(baseItem('admin_url', w.admin_url, 'string', 'website'));
      if (w.api_url != null) items.push(baseItem('api_url', w.api_url, 'string', 'website'));
      if (w.terms_url != null) items.push(baseItem('terms_url', w.terms_url, 'string', 'website'));
      if (w.privacy_url != null) items.push(baseItem('privacy_url', w.privacy_url, 'string', 'website'));
    }
    if (input.system) { const sy = input.system;
      if (sy.timezone != null) items.push(baseItem('timezone', sy.timezone, 'string', 'system'));
      if (sy.date_format != null) items.push(baseItem('date_format', sy.date_format, 'string', 'system'));
      if (sy.time_format != null) items.push(baseItem('time_format', sy.time_format, 'string', 'system'));
      if (sy.currency != null) items.push(baseItem('default_currency', sy.currency, 'string', 'system'));
      if (sy.language != null) items.push(baseItem('default_language', sy.language, 'string', 'system'));
    }
    await upsertSettings(coll, items);
    res.json({ status: 'success', message: 'Site settings updated successfully', data: { updated: items.length } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message, data: null }); }
});

module.exports = router;
