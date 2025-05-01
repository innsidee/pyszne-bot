import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.toLowerCase();

  if (text === '/start') {
    await bot.sendMessage(chatId, 'Привет! Я бот.');
  } else {
    await bot.sendMessage(chatId, `Ты написал: ${text}`);
  }
});
