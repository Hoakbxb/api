const { MongoClient, ServerApiVersion } = require('mongodb');

let client = null;
let connectionError = null;

function buildUri() {
  const fullUri = process.env.MONGO_URI;
  if (fullUri) return fullUri;

  const password = process.env.MONGO_DB_PASSWORD || '';
  const user = 'GeneralDB';
  const host = 'generaldb.uctoogg.mongodb.net';
  const encoded = encodeURIComponent(password);
  return `mongodb+srv://${user}:${encoded}@${host}/?appName=GeneralDB`;
}

async function getClient() {
  if (client) return client;
  connectionError = null;

  const uri = buildUri();
  if (!uri || uri.includes('<db_password>')) {
    connectionError = 'MONGO_DB_PASSWORD is not set. Create api-mongodb/.env with MONGO_DB_PASSWORD=your_atlas_password';
    console.error('MongoDB:', connectionError);
    return null;
  }
  if (/\/\/[^:]+:@/.test(uri)) {
    connectionError = 'MONGO_DB_PASSWORD is empty. Set it in api-mongodb/.env';
    console.error('MongoDB:', connectionError);
    return null;
  }

  try {
    client = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
    });
    await client.connect();
    return client;
  } catch (err) {
    connectionError = err.message;
    console.error('MongoDB connection failed:', err.message);
    client = null;
    return null;
  }
}

async function getDb(name = 'generaldb') {
  const c = await getClient();
  return c ? c.db(name) : null;
}

async function getCollection(name, dbName = 'generaldb') {
  const db = await getDb(dbName);
  return db ? db.collection(name) : null;
}

function getConnectionError() {
  return connectionError;
}

async function getNextSequence(name) {
  const coll = await getCollection('counters');
  if (!coll) throw new Error('MongoDB connection failed');
  const result = await coll.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return result.seq || 1;
}

function mongoDocToArray(doc) {
  if (!doc) return {};
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && v._bsontype === 'ObjectId') {
      obj[k] = v.toString();
    } else if (v instanceof Date) {
      obj[k] = v.toISOString().replace('T', ' ').substring(0, 19);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      obj[k] = mongoDocToArray(v);
    }
  }
  if (obj._id && !obj.id) {
    obj.id = typeof obj._id === 'object' ? obj._id.toString() : obj._id;
  }
  return obj;
}

module.exports = {
  getClient,
  getDb,
  getCollection,
  getConnectionError,
  getNextSequence,
  mongoDocToArray,
};
