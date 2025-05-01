import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import dotenv from 'dotenv';

const app = express();
const port = process.env.PORT || 3000;
const token = process.env.TELEGRAM_TOKEN;

const bot = new TelegramBot(token, { polling: true });

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Siema benc!');
});

app.get('/', (req, res) => {
  res.send('Bot działa!');
});

app.listen(port, () => {
  console.log(`Serwer działa na porcie ${port}`);
});
