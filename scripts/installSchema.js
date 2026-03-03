/**
 * MongoDB Schema Installation - Bank 2026
 * Run: node scripts/installSchema.js  (from api-mongodb folder)
 *
 * Creates collections, indexes, and seed data matching bank.sql schema.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, getCollection, getNextSequence } = require('../config/db');

async function run() {
  console.log('=== Installing Bank 2026 MongoDB Schema ===\n');

  const db = await getDb();
  if (!db) {
    console.error('MongoDB connection failed. Set MONGO_DB_PASSWORD in .env');
    process.exit(1);
  }

  const collectionNames = [
    'users', 'acn', 'pins', 'branch', 'admin_roles', 'admin_sessions', 'admin_users',
    'audit_logs', 'card_products', 'credit_cards', 'kyc_verifications', 'loan_products',
    'loans', 'system_settings', 'user_activity_logs', 'counters',
  ];

  for (const name of collectionNames) {
    try { await db.createCollection(name); } catch (e) {
      if (!e.message.includes('already exists')) throw e;
    }
    console.log(`✓ Collection: ${name}`);
  }

  // --- Indexes ---
  const users = db.collection('users');
  await users.createIndex({ acno: 1 }, { unique: true });
  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ phone: 1 });
  await users.createIndex({ status: 1 });
  await users.createIndex({ vendor_id: 1 });

  const acn = db.collection('acn');
  await acn.createIndex({ acno: 1 });
  await acn.createIndex({ date: -1 });
  await acn.createIndex({ status: 1 });
  await acn.createIndex({ acno: 1, date: -1 });
  await acn.createIndex({ vendor_id: 1 });

  const pinsColl = db.collection('pins');
  await pinsColl.createIndex({ acno: 1 });
  await pinsColl.createIndex({ vendor_id: 1 });
  const branchColl = db.collection('branch');
  await branchColl.createIndex({ bname: 1 });
  await branchColl.createIndex({ vendor_id: 1 });

  const ss = db.collection('system_settings');
  await ss.createIndex({ setting_key: 1 }, { unique: true });
  await ss.createIndex({ category: 1 });
  await ss.createIndex({ vendor_id: 1 });

  const au = db.collection('admin_users');
  await au.createIndex({ username: 1 }, { unique: true });
  await au.createIndex({ email: 1 }, { unique: true });
  await au.createIndex({ role_id: 1 });

  const as = db.collection('admin_sessions');
  await as.createIndex({ session_token: 1 }, { unique: true });
  await as.createIndex({ admin_id: 1 });
  await as.createIndex({ expires_at: 1 });

  const audit = db.collection('audit_logs');
  await audit.createIndex({ admin_id: 1 });
  await audit.createIndex({ user_id: 1 });
  await audit.createIndex({ action_type: 1 });
  await audit.createIndex({ created_at: -1 });

  const cc = db.collection('credit_cards');
  await cc.createIndex({ card_number: 1 }, { unique: true });
  await cc.createIndex({ user_id: 1 });
  await cc.createIndex({ status: 1 });
  await cc.createIndex({ vendor_id: 1 });

  const cardProductsColl = db.collection('card_products');
  await cardProductsColl.createIndex({ status: 1 });
  await cardProductsColl.createIndex({ name: 1 });

  const kyc = db.collection('kyc_verifications');
  await kyc.createIndex({ user_id: 1 });
  await kyc.createIndex({ status: 1 });

  const loans = db.collection('loans');
  await loans.createIndex({ loan_number: 1 }, { unique: true });
  await loans.createIndex({ user_id: 1 });
  await loans.createIndex({ status: 1 });
  await loans.createIndex({ vendor_id: 1 });

  const ual = db.collection('user_activity_logs');
  await ual.createIndex({ user_id: 1 });
  await ual.createIndex({ activity_type: 1 });
  await ual.createIndex({ created_at: -1 });

  console.log('✓ All indexes created');

  const now = new Date();

  // --- Seed admin_roles ---
  const rolesColl = db.collection('admin_roles');
  if ((await rolesColl.countDocuments({})) === 0) {
    await rolesColl.insertMany([
      { id: 1, name: 'Super Admin', description: 'Full system access', permissions: 'all', created_at: now, updated_at: now },
      { id: 2, name: 'Admin', description: 'Standard admin access', permissions: 'users,transactions,accounts,kyc', created_at: now, updated_at: now },
      { id: 3, name: 'Support', description: 'Support staff access', permissions: 'tickets,users_view', created_at: now, updated_at: now },
      { id: 4, name: 'Compliance', description: 'Compliance and KYC access', permissions: 'kyc,transactions_view,reports', created_at: now, updated_at: now },
    ]);
    console.log('✓ admin_roles seeded (4 rows)');
  }

  // --- Seed admin_users ---
  if ((await au.countDocuments({ username: 'admin' })) === 0) {
    await au.insertOne({
      id: 1, username: 'admin', email: 'admin@bank.com',
      password: '$2y$10$TBFDxp8UV0GwZyIRRZqEeOv6BeJclEJ5fwEsCVQZMt0G11Y.2cvz6',
      full_name: 'System Administrator', role_id: 1, status: 'active',
      last_login: null, last_login_ip: null,
      two_factor_enabled: 0, two_factor_secret: null,
      created_at: now, updated_at: now,
    });
    console.log('✓ admin_users seeded (admin)');
  }

  // --- Seed Super Admin user with plain-text password as requested ---
  if ((await au.countDocuments({ username: 'adminstrator' })) === 0) {
    await au.insertOne({
      id: 2,
      username: 'adminstrator',
      email: 'adminstrator@bank.com',
      // IMPORTANT: plain-text password (no hashing) per requirements
      password: 'adampekolo',
      full_name: 'Super Administrator',
      role_id: 1,
      status: 'active',
      last_login: null,
      last_login_ip: null,
      two_factor_enabled: 0,
      two_factor_secret: null,
      created_at: now,
      updated_at: now,
    });
    console.log('✓ admin_users seeded (super admin: adminstrator / adampekolo)');
  }

  // --- Seed branch ---
  const branchColl = db.collection('branch');
  if ((await branchColl.countDocuments({})) === 0) {
    await branchColl.insertOne({
      id: 1, bname: 'united kingdom', badd: '32 ukn',
      status: 'active', created_at: now, updated_at: now,
    });
    console.log('✓ branch seeded (1 row)');
  }

  // --- Insert Card Products (seed when empty) ---
  const cp = db.collection('card_products');
  if ((await cp.countDocuments({})) === 0) {
    const cardProducts = [
      { id: 1, name: 'Classic Card', description: 'Basic credit card with standard features. Perfect for everyday purchases and building credit history.', min_credit_limit: 1000, max_credit_limit: 10000, annual_fee: 0, interest_rate: 18.99, eligibility_criteria: 'Minimum income: $20,000/year. Good credit score required.', status: 'active', created_at: now, updated_at: now },
      { id: 2, name: 'Gold Card', description: 'Premium credit card with enhanced rewards and benefits. Includes travel insurance and cashback rewards.', min_credit_limit: 5000, max_credit_limit: 50000, annual_fee: 99, interest_rate: 16.99, eligibility_criteria: 'Minimum income: $50,000/year. Excellent credit score (720+) required.', status: 'active', created_at: now, updated_at: now },
      { id: 3, name: 'Platinum Card', description: 'Elite credit card with premium benefits. Includes airport lounge access, concierge service, and exclusive rewards.', min_credit_limit: 10000, max_credit_limit: 100000, annual_fee: 299, interest_rate: 15.99, eligibility_criteria: 'Minimum income: $100,000/year. Excellent credit score (750+) required. Invitation only.', status: 'active', created_at: now, updated_at: now },
      { id: 4, name: 'Student Card', description: 'Designed for students with lower credit requirements. Build credit while studying with no annual fee.', min_credit_limit: 500, max_credit_limit: 5000, annual_fee: 0, interest_rate: 19.99, eligibility_criteria: 'Must be enrolled in an accredited educational institution. No credit history required.', status: 'active', created_at: now, updated_at: now },
      { id: 5, name: 'Business Card', description: 'Credit card designed for business expenses. Includes expense tracking, employee cards, and business rewards.', min_credit_limit: 10000, max_credit_limit: 250000, annual_fee: 199, interest_rate: 17.99, eligibility_criteria: 'Must be a registered business. Business credit history required.', status: 'active', created_at: now, updated_at: now },
      { id: 6, name: 'Secured Card', description: 'Build or rebuild credit with a secured deposit. Your credit limit equals your security deposit.', min_credit_limit: 200, max_credit_limit: 5000, annual_fee: 49, interest_rate: 20.99, eligibility_criteria: 'No credit check required. Security deposit required (refundable).', status: 'active', created_at: now, updated_at: now },
      { id: 7, name: 'Cashback Card', description: 'Earn cashback on all purchases. 1% on all purchases, 2% on groceries, 3% on gas stations.', min_credit_limit: 2000, max_credit_limit: 30000, annual_fee: 0, interest_rate: 18.49, eligibility_criteria: 'Minimum income: $30,000/year. Good credit score (650+) required.', status: 'active', created_at: now, updated_at: now },
      { id: 8, name: 'Travel Rewards Card', description: 'Earn points for travel. 2x points on travel and dining, 1x on all other purchases. Points transfer to airline partners.', min_credit_limit: 5000, max_credit_limit: 75000, annual_fee: 149, interest_rate: 17.49, eligibility_criteria: 'Minimum income: $60,000/year. Excellent credit score (700+) required.', status: 'active', created_at: now, updated_at: now },
    ];
    await cp.insertMany(cardProducts);
    console.log('✓ Card Products inserted (8 rows)');
  }

  // --- Seed loan_products ---
  const lp = db.collection('loan_products');
  if ((await lp.countDocuments({})) === 0) {
    await lp.insertMany([
      { id: 1, name: 'Personal Loan', description: 'Unsecured personal loan for various purposes', min_amount: 5000, max_amount: 50000, interest_rate: 12.50, min_tenure_months: 6, max_tenure_months: 60, eligibility_criteria: 'Minimum income of /month, good credit score', status: 'active', created_at: now, updated_at: now },
      { id: 2, name: 'Home Loan', description: 'Mortgage loan for home purchase', min_amount: 50000, max_amount: 500000, interest_rate: 8.75, min_tenure_months: 60, max_tenure_months: 360, eligibility_criteria: 'Minimum income of /month, property valuation required', status: 'active', created_at: now, updated_at: now },
      { id: 3, name: 'Auto Loan', description: 'Vehicle financing loan', min_amount: 10000, max_amount: 100000, interest_rate: 9.25, min_tenure_months: 12, max_tenure_months: 84, eligibility_criteria: 'Vehicle must be less than 5 years old', status: 'active', created_at: now, updated_at: now },
      { id: 4, name: 'Business Loan', description: 'Loan for business expansion and working capital', min_amount: 25000, max_amount: 250000, interest_rate: 11.00, min_tenure_months: 12, max_tenure_months: 120, eligibility_criteria: 'Business must be operational for at least 2 years', status: 'active', created_at: now, updated_at: now },
      { id: 5, name: 'Education Loan', description: 'Student loan for education expenses', min_amount: 10000, max_amount: 100000, interest_rate: 7.50, min_tenure_months: 12, max_tenure_months: 120, eligibility_criteria: 'Must be enrolled in accredited institution', status: 'active', created_at: now, updated_at: now },
    ]);
    console.log('✓ loan_products seeded (5 rows)');
  }

  // --- Seed system_settings ---
  if ((await ss.countDocuments({})) === 0) {
    const settings = [
      { id: 1, setting_key: 'default_email_provider', setting_value: 'resend', setting_type: 'string', category: 'email_config', description: 'Default email provider (smtp, resend, mailgun, sendgrid, ses)' },
      { id: 2, setting_key: 'resend_api_key', setting_value: '', setting_type: 'string', category: 'email_config', description: 'Resend API key' },
      { id: 21, setting_key: 'site_name', setting_value: 'Lime WHere', setting_type: 'string', category: 'site_config', description: 'Site name' },
      { id: 22, setting_key: 'site_description', setting_value: '', setting_type: 'string', category: 'site_config', description: 'Site description' },
      { id: 24, setting_key: 'maintenance_mode', setting_value: '0', setting_type: 'boolean', category: 'site_config', description: 'Maintenance mode' },
      { id: 26, setting_key: 'timezone', setting_value: 'UTC', setting_type: 'string', category: 'system', description: 'Timezone' },
      { id: 27, setting_key: 'date_format', setting_value: 'Y-m-d', setting_type: 'string', category: 'system', description: 'Date format' },
      { id: 29, setting_key: 'default_currency', setting_value: 'USD', setting_type: 'string', category: 'system', description: 'Default currency' },
      { id: 62, setting_key: 'bHost', setting_value: '', setting_type: 'string', category: 'email_config', description: 'SMTP Host' },
      { id: 63, setting_key: 'smtpPort', setting_value: '587', setting_type: 'integer', category: 'email_config', description: 'SMTP Port' },
      { id: 65, setting_key: 'bEmail', setting_value: 'noreply@resend.dev', setting_type: 'string', category: 'email_config', description: 'SMTP Username/Email' },
      { id: 117, setting_key: 'bName', setting_value: '', setting_type: 'string', category: 'bank_info', description: 'Bank Name' },
      { id: 118, setting_key: 'bFullName', setting_value: '', setting_type: 'string', category: 'bank_info', description: 'Bank Full Name' },
      { id: 121, setting_key: 'bContact', setting_value: '', setting_type: 'string', category: 'contact', description: 'Contact Email' },
      { id: 122, setting_key: 'bPhone', setting_value: '', setting_type: 'string', category: 'contact', description: 'Contact Phone' },
    ].map(s => ({ ...s, created_at: now, updated_at: now }));
    await ss.insertMany(settings);
    console.log(`✓ system_settings seeded (${settings.length} rows)`);
  }

  console.log('\n=== Schema installation complete ===');
  process.exit(0);
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
