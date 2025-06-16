import dotenv from 'dotenv';
import { sendMessageToAllChats } from './telegram.js';

dotenv.config();

['TELEGRAM_BOT_TOKEN','MONGO_URI'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing ${key} in .env`);
    process.exit(1);
  }
});

async function runTest() {
  console.log('🧪 Running test notification...');

  try {
    const sentCount = await sendMessageToAllChats('🧪 <b>Test Notification</b>\n\nWebhook + Inevents bot is working!');
    console.log(`✅ Test completed - sent to ${sentCount} chats`);

    if (sentCount === 0) {
      console.log('💡 No subscribers found. Send /start to your bot on Telegram first!');
    }

    return sentCount;
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

runTest()
  .then((sentCount) => {
    console.log(`✅ Test successful - notified ${sentCount} subscribers`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Error running test:", err);
    process.exit(1);
  });