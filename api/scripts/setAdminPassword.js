/**
 * One-off script: set admin user password to a given value in MongoDB.
 * Usage: node scripts/setAdminPassword.js [password]
 * Default password: admin123
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getCollection } = require('../config/db');

async function run() {
  const newPassword = process.argv[2] || 'admin123';
  const adminUsers = await getCollection('admin_users');
  if (!adminUsers) {
    console.error('MongoDB connection failed. Check api-mongodb/.env');
    process.exit(1);
  }
  const result = await adminUsers.updateOne(
    { username: 'admin', status: 'active' },
    { $set: { password: newPassword, updated_at: new Date() } }
  );
  if (result.matchedCount === 0) {
    console.error('No admin user found with username "admin" and status "active".');
    process.exit(1);
  }
  console.log('Admin password updated successfully to:', newPassword);
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
