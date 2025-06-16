import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB || 'govbot';
const proposalsCollection = process.env.MONGO_COLLECTION || 'seen_proposals';
const chatsCollection = 'subscribed_chats';

let client;
let db;

async function connectMongo() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);

    // Create indexes for both collections
    await db.collection(proposalsCollection).createIndex({ proposalId: 1 }, { unique: true });
    await db.collection(chatsCollection).createIndex({ chatId: 1 }, { unique: true });

    console.log('✅ Connected to MongoDB');
  }
}

// Proposal status functions (your existing ones)
export async function getStatus(proposalId) {
  try {
    await connectMongo();
    const collection = db.collection(proposalsCollection);
    const result = await collection.findOne({ proposalId });
    return result ? result.status : null;
  } catch (error) {
    console.error('❌ MongoDB error in getStatus:', error);
    return null;
  }
}

export async function setStatus(proposalId, status) {
  try {
    await connectMongo();
    const collection = db.collection(proposalsCollection);
    await collection.updateOne(
      { proposalId },
      { $set: { proposalId, status, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.error('❌ MongoDB error in setStatus:', error);
    throw error;
  }
}

// Chat subscription functions
export async function addChat(chatId, chatType, chatName) {
  try {
    await connectMongo();
    const collection = db.collection(chatsCollection);

    await collection.updateOne(
      { chatId: chatId.toString() },
      {
        $set: {
          chatId: chatId.toString(),
          chatType: chatType,
          chatName: chatName,
          subscribedAt: new Date(),
          lastActive: new Date(),
          isActive: true
        }
      },
      { upsert: true }
    );

    console.log(`✅ Added/updated chat ${chatId} (${chatType}: ${chatName})`);
    return true;
  } catch (error) {
    console.error('❌ MongoDB error in addChat:', error);
    return false;
  }
}

export async function removeChat(chatId) {
  try {
    await connectMongo();
    const collection = db.collection(chatsCollection);

    const result = await collection.updateOne(
      { chatId: chatId.toString() },
      {
        $set: {
          isActive: false,
          unsubscribedAt: new Date()
        }
      }
    );

    console.log(`✅ Removed chat ${chatId}`);
    return result.modifiedCount > 0;
  } catch (error) {
    console.error('❌ MongoDB error in removeChat:', error);
    return false;
  }
}

export async function getAllChats() {
  try {
    await connectMongo();
    const collection = db.collection(chatsCollection);

    const chats = await collection.find({ 
      isActive: { $ne: false } 
    }).toArray();

    return chats;
  } catch (error) {
    console.error('❌ MongoDB error in getAllChats:', error);
    return [];
  }
}

export async function updateChatActivity(chatId) {
  try {
    await connectMongo();
    const collection = db.collection(chatsCollection);

    await collection.updateOne(
      { chatId: chatId.toString() },
      { $set: { lastActive: new Date() } }
    );
  } catch (error) {
    console.error('❌ MongoDB error in updateChatActivity:', error);
  }
}

export async function getChatStats() {
  try {
    await connectMongo();
    const collection = db.collection(chatsCollection);

    const stats = await collection.aggregate([
      {
        $group: {
          _id: '$chatType',
          count: { $sum: 1 },
          active: {
            $sum: {
              $cond: [{ $ne: ['$isActive', false] }, 1, 0]
            }
          }
        }
      }
    ]).toArray();

    return stats;
  } catch (error) {
    console.error('❌ MongoDB error in getChatStats:', error);
    return [];
  }
}

// Close connection (for graceful shutdown)
export async function closeMongo() {
  if (client) {
    try {
      await client.close();
      console.log('✅ MongoDB connection closed');
    } catch (error) {
      console.error('❌ Error closing MongoDB:', error);
    } finally {
      client = null;
      db = null;
    }
  }
}