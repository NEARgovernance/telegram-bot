import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || 'govbot';
const collectionName = process.env.MONGO_COLLECTION || 'seen_proposals';

let client;
let collection;

async function connectMongo() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    collection = db.collection(collectionName);
    await collection.createIndex({ proposalId: 1 }, { unique: true });
  }
}

export async function getStatus(proposalId) {
  await connectMongo();
  const result = await collection.findOne({ proposalId });
  return result ? result.status : null;
}

export async function setStatus(proposalId, status) {
  await connectMongo();
  await collection.updateOne(
    { proposalId },
    { $set: { proposalId, status, updatedAt: new Date() } },
    { upsert: true }
  );
}