const nodemailer = require('nodemailer');
const { getCollection } = require('./db');

function castSettingValue(doc) {
  let value = doc?.setting_value ?? null;
  const type = doc?.setting_type || 'string';
  if (type === 'integer') value = parseInt(value, 10);
  else if (type === 'boolean') value = value === '1' || value === 'true';
  else if (type === 'json' || type === 'array') {
    try { value = JSON.parse(value); } catch {}
  }
  return value;
}

/** Build config object from a flat map of setting keys (base keys like bHost, smtpPort, etc.) */
function configFromMap(map) {
  const host = String(map.bHost || '').trim();
  const port = parseInt(map.smtpPort, 10) || 587;
  const security = String(map.smtpSecurity || 'tls').toLowerCase();
  const timeoutSec = parseInt(map.smtpTimeout, 10) || 30;
  const username = String(map.bEmail || '').trim();
  const password = String(map.bP || '').trim();
  const fromName = String(map.emailFromName || 'Bank Notification').trim();
  const replyTo = String(map.emailReplyTo || '').trim();
  const defaultProvider = String(map.default_email_provider || 'smtp').toLowerCase().trim();
  const resendApiKey = String(map.resend_api_key || '').trim();
  const resendEmail = String(map.resend_email || '').trim();

  return {
    defaultProvider,
    host,
    port,
    secure: security === 'ssl' || port === 465,
    timeoutMs: Math.max(5000, timeoutSec * 1000),
    username,
    password,
    fromName,
    replyTo,
    resendApiKey,
    resendEmail,
  };
}

/** Load email config for a specific vendor (scoped keys: baseKey__v__vendorId). Returns null if no config. */
async function loadEmailSettingsForVendor(vendorId) {
  if (!vendorId) return null;
  const coll = await getCollection('system_settings');
  if (!coll) return null;

  const docs = await coll.find({ category: 'email_config' }).toArray();
  const map = {};
  const suffix = `__v__${String(vendorId)}`;
  for (const doc of docs) {
    const rawKey = doc.setting_key;
    if (typeof rawKey !== 'string' || !rawKey.endsWith(suffix)) continue;
    const baseKey = rawKey.slice(0, -suffix.length);
    map[baseKey] = castSettingValue(doc);
  }
  return configFromMap(map);
}

/** Load global/legacy email config (keys without __v__ suffix). Used when no vendor is specified. */
async function loadEmailSettings() {
  const coll = await getCollection('system_settings');
  if (!coll) return null;

  const docs = await coll.find({ category: 'email_config' }).toArray();
  const map = {};
  for (const doc of docs) {
    const rawKey = doc.setting_key;
    if (typeof rawKey === 'string' && rawKey.includes('__v__')) continue;
    map[rawKey] = castSettingValue(doc);
  }
  return configFromMap(map);
}

function buildFromAddress(fromName, username) {
  if (!username) return null;
  const safeName = (fromName || '').replace(/"/g, '\\"').trim();
  return safeName ? `"${safeName}" <${username}>` : username;
}

function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmailLayout({ title, intro, rows = [], note = '', accent = '#0f766e' }) {
  const rowsHtml = rows
    .filter((r) => r && r.label)
    .map((r) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;width:38%;">${escapeHtml(r.label)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:13px;font-weight:600;">${escapeHtml(r.value || 'N/A')}</td>
      </tr>
    `)
    .join('');

  return `
    <div style="margin:0;padding:24px;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <div style="background:${accent};padding:16px 20px;">
          <h2 style="margin:0;color:#ffffff;font-size:18px;line-height:1.3;">${escapeHtml(title)}</h2>
        </div>
        <div style="padding:20px;">
          <p style="margin:0 0 14px 0;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(intro)}</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <tbody>${rowsHtml}</tbody>
          </table>
          ${note ? `<p style="margin:14px 0 0 0;color:#475569;font-size:13px;line-height:1.6;">${escapeHtml(note)}</p>` : ''}
        </div>
        <div style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">
          This is an automated notification from your banking system.
        </div>
      </div>
    </div>
  `;
}

async function sendWithResend(cfg, payload) {
  if (!cfg.resendApiKey || !cfg.resendEmail) {
    return { sent: false, reason: 'Resend is selected but API key or from email is missing' };
  }

  if (typeof fetch !== 'function') {
    return { sent: false, reason: 'Server runtime does not support fetch for Resend provider' };
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: cfg.resendEmail,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        reply_to: cfg.replyTo || undefined,
      }),
    });

    if (!resp.ok) {
      let errMsg = `Resend request failed (${resp.status})`;
      try {
        const body = await resp.json();
        if (body?.message) errMsg = body.message;
      } catch {}
      return { sent: false, reason: errMsg };
    }

    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message || 'Failed to send with Resend' };
  }
}

async function sendWithSmtp(cfg, payload) {
  if (!cfg.host || !cfg.username || !cfg.password) {
    return { sent: false, reason: 'SMTP settings are incomplete' };
  }

  const from = buildFromAddress(cfg.fromName, cfg.username);
  if (!from) return { sent: false, reason: 'Invalid sender email configuration' };

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: cfg.timeoutMs,
    socketTimeout: cfg.timeoutMs,
  });

  try {
    await transporter.sendMail({
      from,
      to: payload.to,
      replyTo: cfg.replyTo || undefined,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message || 'Failed to send via SMTP' };
  }
}

/** Check if Resend is configured (API key and from email). */
function isResendConfigured(cfg) {
  return !!(cfg && cfg.resendApiKey && cfg.resendEmail);
}

/** Check if SMTP is configured (host, username, password). */
function isSmtpConfigured(cfg) {
  return !!(cfg && cfg.host && cfg.username && cfg.password);
}

const EMAIL_NOT_CONFIGURED_MSG =
  'Configure Resend (API key and From email) or SMTP (Host, Username, Password) in System Settings > Email.';

/**
 * Send email using only the selected provider from settings. No fallback to the other provider.
 */
async function sendEmailWithFallback(cfg, payload) {
  const selectedProvider = String(cfg.defaultProvider || 'smtp').toLowerCase().trim();

  if (selectedProvider === 'resend') {
    if (!isResendConfigured(cfg)) {
      return { sent: false, reason: 'Resend is selected but API key or From email is missing. Set them in System Settings > Email or switch to SMTP.' };
    }
    return sendWithResend(cfg, payload);
  }

  if (!isSmtpConfigured(cfg)) {
    return { sent: false, reason: 'SMTP is selected but settings are incomplete (Host, Username, Password required). Configure in System Settings > Email or switch to Resend.' };
  }
  return sendWithSmtp(cfg, payload);
}

async function sendCreditCardIssuedEmail({ user, card, productName, vendorId }) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = vendorId
    ? (await loadEmailSettingsForVendor(vendorId)) || (await loadEmailSettings())
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const currency = (user.cur || 'USD').toUpperCase();
  const formattedLimit = Number(card.credit_limit || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const subject = 'Your new credit card has been issued';
  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    'Your new credit card has been issued successfully.',
    `Card Number: ${card.card_number_masked || '**** **** **** ****'}`,
    `Card Holder: ${card.card_holder_name || 'N/A'}`,
    `Credit Limit: ${currency} ${formattedLimit}`,
    `Expiry Date: ${card.expiry_date || 'N/A'}`,
    productName ? `Product: ${productName}` : null,
    '',
    'If you did not request this card, contact support immediately.',
  ].filter(Boolean).join('\n');

  const html = renderEmailLayout({
    title: 'Credit Card Issued',
    intro: `Hello ${user.fname || 'Customer'}, your new credit card has been issued successfully.`,
    rows: [
      { label: 'Card Number', value: card.card_number_masked || '**** **** **** ****' },
      { label: 'Card Holder', value: card.card_holder_name || 'N/A' },
      { label: 'Credit Limit', value: `${currency} ${formattedLimit}` },
      { label: 'Expiry Date', value: card.expiry_date || 'N/A' },
      productName ? { label: 'Product', value: productName } : null,
    ],
    note: 'If you did not request this card, contact support immediately.',
    accent: '#0f766e',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendCreditCardStatusEmail({ user, card, previousStatus, newStatus, reason, vendorId }) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = vendorId
    ? (await loadEmailSettingsForVendor(vendorId)) || (await loadEmailSettings())
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const currency = (user.cur || 'USD').toUpperCase();
  const formattedLimit = Number(card.credit_limit || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const statusLabels = {
    pending: 'Pending',
    active: 'Active',
    frozen: 'Frozen',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
    suspended: 'Suspended',
    blocked: 'Blocked',
    expired: 'Expired',
  };
  const fromLabel = statusLabels[String(previousStatus || '').toLowerCase()] || String(previousStatus || 'Unknown');
  const toLabel = statusLabels[String(newStatus || '').toLowerCase()] || String(newStatus || 'Unknown');

  const subject = `Credit card status updated to ${toLabel}`;
  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    'Your credit card status has been updated.',
    `Card Number: ${card.card_number_masked || '**** **** **** ****'}`,
    `Card Holder: ${card.card_holder_name || 'N/A'}`,
    `Credit Limit: ${currency} ${formattedLimit}`,
    `Previous Status: ${fromLabel}`,
    `Current Status: ${toLabel}`,
    reason ? `Reason: ${reason}` : null,
    '',
    'If you did not expect this update, contact support immediately.',
  ].filter(Boolean).join('\n');

  const html = renderEmailLayout({
    title: 'Credit Card Status Updated',
    intro: `Hello ${user.fname || 'Customer'}, your credit card status has been updated.`,
    rows: [
      { label: 'Card Number', value: card.card_number_masked || '**** **** **** ****' },
      { label: 'Card Holder', value: card.card_holder_name || 'N/A' },
      { label: 'Credit Limit', value: `${currency} ${formattedLimit}` },
      { label: 'Previous Status', value: fromLabel },
      { label: 'Current Status', value: toLabel },
      reason ? { label: 'Reason', value: reason } : null,
    ],
    note: 'If you did not expect this update, contact support immediately.',
    accent: '#1d4ed8',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendLoanStatusEmail({ user, loan, previousStatus, newStatus, reason, vendorId }) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = vendorId
    ? (await loadEmailSettingsForVendor(vendorId)) || (await loadEmailSettings())
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const currency = (user.cur || 'USD').toUpperCase();
  const statusLabels = {
    application: 'Application',
    pending: 'Pending',
    under_review: 'Under Review',
    approved: 'Approved',
    rejected: 'Rejected',
    disbursed: 'Disbursed',
    active: 'Active',
    closed: 'Closed',
    defaulted: 'Defaulted',
  };
  const fromLabel = statusLabels[String(previousStatus || '').toLowerCase()] || String(previousStatus || 'Unknown');
  const toLabel = statusLabels[String(newStatus || '').toLowerCase()] || String(newStatus || 'Unknown');
  const principal = Number(loan?.principal_amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const totalAmount = Number(loan?.total_amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const monthlyInstallment = Number(loan?.monthly_installment || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const subject = `Loan status updated to ${toLabel}`;
  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    'Your loan application status has been updated.',
    `Loan Number: ${loan?.loan_number || loan?.id || 'N/A'}`,
    `Principal Amount: ${currency} ${principal}`,
    `Total Amount: ${currency} ${totalAmount}`,
    `Monthly Installment: ${currency} ${monthlyInstallment}`,
    `Previous Status: ${fromLabel}`,
    `Current Status: ${toLabel}`,
    reason ? `Reason: ${reason}` : null,
    '',
    'If you did not expect this update, contact support immediately.',
  ].filter(Boolean).join('\n');

  const html = renderEmailLayout({
    title: 'Loan Status Updated',
    intro: `Hello ${user.fname || 'Customer'}, your loan status has been updated.`,
    rows: [
      { label: 'Loan Number', value: loan?.loan_number || loan?.id || 'N/A' },
      { label: 'Principal Amount', value: `${currency} ${principal}` },
      { label: 'Total Amount', value: `${currency} ${totalAmount}` },
      { label: 'Monthly Installment', value: `${currency} ${monthlyInstallment}` },
      { label: 'Previous Status', value: fromLabel },
      { label: 'Current Status', value: toLabel },
      reason ? { label: 'Reason', value: reason } : null,
    ],
    note: 'If you did not expect this update, contact support immediately.',
    accent: '#7c3aed',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendPasswordChangedEmail({ user }) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const changedAt = new Date().toISOString();
  const subject = 'Your account password was changed';
  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    'Your account password has been changed successfully.',
    `Account Number: ${user.acno || 'N/A'}`,
    `Time (UTC): ${changedAt}`,
    '',
    'If you did not perform this change, contact support immediately.',
  ].join('\n');

  const html = renderEmailLayout({
    title: 'Password Changed Successfully',
    intro: `Hello ${user.fname || 'Customer'}, your account password has been changed successfully.`,
    rows: [
      { label: 'Account Number', value: user.acno || 'N/A' },
      { label: 'Time (UTC)', value: changedAt },
    ],
    note: 'If you did not perform this change, contact support immediately.',
    accent: '#b45309',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendConfiguredTestEmail({ to, adminName, vendorId }) {
  if (!to) return { sent: false, reason: 'Recipient email is required' };

  const cfg = vendorId
    ? await loadEmailSettingsForVendor(vendorId)
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const subject = 'Test email configuration';
  const text = [
    `Hello,`,
    '',
    `This is a test email from your admin settings${adminName ? ` (${adminName})` : ''}.`,
    `Provider: ${cfg.defaultProvider || 'smtp'}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'If you received this message, your email settings are working.',
  ].join('\n');

  const html = renderEmailLayout({
    title: 'Email Configuration Test',
    intro: `This is a test email from your admin settings${adminName ? ` (${adminName})` : ''}.`,
    rows: [
      { label: 'Provider', value: cfg.defaultProvider || 'smtp' },
      { label: 'Time (UTC)', value: new Date().toISOString() },
      { label: 'Recipient', value: to },
    ],
    note: 'If you received this message, your email settings are working.',
    accent: '#7c3aed',
  });

  const payload = { to, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendTransactionNotificationEmail({
  user,
  transactionType,
  amount,
  currency,
  previousBalance,
  newBalance,
  status,
  date,
  branch,
  narration,
  reference,
  reason,
  vendorId,
}) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = vendorId
    ? (await loadEmailSettingsForVendor(vendorId)) || (await loadEmailSettings())
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const txLabel = transactionType === 'credit' ? 'Credit' : 'Debit';
  const statusLabel = status || 'Processed';
  const cur = (currency || user.cur || 'USD').toUpperCase();
  const amt = Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prev = Number(previousBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const next = Number(newBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const subject = `${txLabel} transaction ${String(statusLabel).toLowerCase()}`;

  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    `Your ${txLabel.toLowerCase()} transaction has been updated.`,
    `Reference: ${reference || 'N/A'}`,
    `Status: ${statusLabel}`,
    `Amount: ${cur} ${amt}`,
    `Previous Balance: ${cur} ${prev}`,
    `New Balance: ${cur} ${next}`,
    date ? `Date: ${date}` : null,
    branch ? `Branch: ${branch}` : null,
    narration ? `Narration: ${narration}` : null,
    reason ? `Reason: ${reason}` : null,
    '',
    'If you did not authorize this transaction, contact support immediately.',
  ].filter(Boolean).join('\n');

  const html = renderEmailLayout({
    title: `${txLabel} Transaction Notification`,
    intro: `Hello ${user.fname || 'Customer'}, your ${txLabel.toLowerCase()} transaction has been updated.`,
    rows: [
      { label: 'Reference', value: reference || 'N/A' },
      { label: 'Status', value: statusLabel },
      { label: 'Amount', value: `${cur} ${amt}` },
      { label: 'Previous Balance', value: `${cur} ${prev}` },
      { label: 'New Balance', value: `${cur} ${next}` },
      date ? { label: 'Date', value: date } : null,
      branch ? { label: 'Branch', value: branch } : null,
      narration ? { label: 'Narration', value: narration } : null,
      reason ? { label: 'Reason', value: reason } : null,
    ],
    note: 'If you did not authorize this transaction, contact support immediately.',
    accent: transactionType === 'credit' ? '#0f766e' : '#b45309',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

async function sendAccountCreatedEmail({ user, plainPassword, vendorId }) {
  if (!user?.email) return { sent: false, reason: 'User email is missing' };

  const cfg = vendorId
    ? (await loadEmailSettingsForVendor(vendorId)) || (await loadEmailSettings())
    : await loadEmailSettings();
  if (!cfg) return { sent: false, reason: 'Email settings unavailable' };

  const currency = (user.cur || 'USD').toUpperCase();
  const openingBalance = Number(user.total || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const subject = 'Your new bank account has been created';
  const text = [
    `Hello ${user.fname || 'Customer'},`,
    '',
    'Your account has been created successfully.',
    `Account Number: ${user.acno || 'N/A'}`,
    `Email: ${user.email || 'N/A'}`,
    `Phone: ${user.phone || 'N/A'}`,
    `Account Type: ${user.typ || 'N/A'}`,
    `Branch: ${user.branch || 'N/A'}`,
    `Opening Balance: ${currency} ${openingBalance}`,
    `Login Password: ${plainPassword || 'N/A'}`,
    '',
    'Please keep your credentials secure and change your password after first login.',
  ].join('\n');

  const html = renderEmailLayout({
    title: 'Account Created Successfully',
    intro: `Hello ${user.fname || 'Customer'}, your new account has been created successfully.`,
    rows: [
      { label: 'Account Number', value: user.acno || 'N/A' },
      { label: 'Email', value: user.email || 'N/A' },
      { label: 'Phone', value: user.phone || 'N/A' },
      { label: 'Account Type', value: user.typ || 'N/A' },
      { label: 'Branch', value: user.branch || 'N/A' },
      { label: 'Opening Balance', value: `${currency} ${openingBalance}` },
      { label: 'Login Password', value: plainPassword || 'N/A' },
    ],
    note: 'Please keep your credentials secure and change your password after first login.',
    accent: '#0f766e',
  });

  const payload = { to: user.email, subject, text, html };
  return sendEmailWithFallback(cfg, payload);
}

module.exports = {
  sendCreditCardIssuedEmail,
  sendCreditCardStatusEmail,
  sendLoanStatusEmail,
  sendPasswordChangedEmail,
  sendConfiguredTestEmail,
  sendTransactionNotificationEmail,
  sendAccountCreatedEmail,
};
