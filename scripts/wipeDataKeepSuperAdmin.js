/**
 * Wipe all database data EXCEPT super admin login details.
 * - Keeps: admin_roles, and admin_users where role_id === 1 (Super Admin).
 * - Deletes all other data from all collections.
 *
 * Run from api folder: node scripts/wipeDataKeepSuperAdmin.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, getCollection } = require('../config/db');

const DB_NAME = 'generaldb';

// All collections that may exist (from installSchema + usage)
const COLLECTIONS = [
  'users',
  'acn',
  'pins',
  'branch',
  'admin_roles',
  'admin_sessions',
  'admin_users',
  'audit_logs',
  'card_products',
  'credit_cards',
  'kyc_verifications',
  'loan_products',
  'loans',
  'system_settings',
  'user_activity_logs',
  'counters',
];

async function run() {
  console.log('=== Wipe all data except Super Admin login ===\n');

  const db = await getDb(DB_NAME);
  if (!db) {
    console.error('MongoDB connection failed. Set MONGO_URI or MONGO_DB_PASSWORD in .env');
    process.exit(1);
  }

  const adminUsers = await getCollection('admin_users', DB_NAME);
  if (!adminUsers) {
    console.error('Could not get admin_users collection');
    process.exit(1);
  }

  // 1) Keep only Super Admins (role_id === 1) in admin_users
  const superAdminRoleId = 1;
  const deleteNonSuperAdmin = await adminUsers.deleteMany({ role_id: { $ne: superAdminRoleId } });
  const kept = await adminUsers.countDocuments({ role_id: superAdminRoleId });
  console.log(`admin_users: removed ${deleteNonSuperAdmin.deletedCount} non–Super Admin(s), kept ${kept} Super Admin(s).`);

  // 2) Leave admin_roles as-is (needed for role_id 1 = Super Admin)
  const adminRoles = await getCollection('admin_roles', DB_NAME);
  if (adminRoles) {
    const rolesCount = await adminRoles.countDocuments({});
    console.log(`admin_roles: left unchanged (${rolesCount} roles).`);
  }

  // 3) Wipe all other collections
  for (const name of COLLECTIONS) {
    if (name === 'admin_users' || name === 'admin_roles') continue;

    try {
      const coll = db.collection(name);
      const result = await coll.deleteMany({});
      console.log(`${name}: deleted ${result.deletedCount} document(s).`);
    } catch (e) {
      if (e.code === 26 || e.message.includes('not found')) {
        console.log(`${name}: (collection does not exist, skipped)`);
      } else {
        console.error(`${name}: error -`, e.message);
      }
    }
  }

  console.log('\n=== Done. Only Super Admin login(s) and roles remain. ===');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
