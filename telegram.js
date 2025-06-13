import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendMessage(text, chatId = CHAT_ID) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    // parse_mode: 'Markdown',
  };

  try {
    console.log('Attempting to send message:', text);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = await res.json();
    console.log('Telegram API response:', result);

    if (!res.ok) {
      console.error(`Failed to send Telegram message: ${res.statusText}`);
      console.error('Response body:', result);
    } else {
      console.log('Message sent successfully');
    }
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}
