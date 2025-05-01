import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const knowledgeBase = [
  {
    keywords: ['wypłata', 'wypłaty', 'pieniądze', 'pensja'],
    answer: 'Wypłaty są dwa razy w miesiącu: do 10-go i do 25-go. Sprawdź w aplikacji Scoober dokładną datę.'
  },
  {
    keywords: ['ubezpieczenie', 'medicover', 'sport', 'zdrowie'],
    answer: 'Medicover Sport dostępny jest dla kurierów zatrudnionych przez Trenkwalder lub Takeaway. Kurierzy Application Partner nie mają tego benefitu.'
  },
  {
    keywords: ['grafik', 'zmiany', 'dyspozycyjność'],
    answer: 'Grafik edytujesz w Scoober w sekcji „Shift Planning”. Zgłaszaj dostępność do wtorku, 23:59.'
  },
  {
    keywords: ['koordynator', 'kontakt', 'telefon'],
    answer: 'Kontakt do koordynatora znajdziesz w aplikacji Scoober. Wybierz „Połącz z koordynatorem”.'
  },
  {
    keywords: ['scoober'],
    answer: 'Scoober to system do pracy kuriera Pyszne – przez niego odbierasz zlecenia, kontaktujesz się z bazą i edytujesz grafik.'
  }
];

bot.on('message', (msg) => {
  const text = msg.text?.toLowerCase();
  const chatId = msg.chat.id;

  if (!text || text.startsWith('/')) return;

  const match = knowledgeBase.find(entry =>
    entry.keywords.some(keyword => text.includes(keyword))
  );

  if (match) {
    bot.sendMessage(chatId, match.answer);
  } else {
    bot.sendMessage(chatId, 'Nie jestem pewny, ale możesz to sprawdzić w Scoober lub zapytać koordynatora.');
  }
});
