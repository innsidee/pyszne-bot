import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const knownZones = {
  "centrum": "Centrum",
  "ursus": "Ursus",
  "bemowo": "Bemowo/Bielany",
  "bielany": "Bemowo/Bielany",
  "białołęka": "Białołęka/Tarchomin",
  "tarchomin": "Białołęka/Tarchomin",
  "praga": "Praga",
  "rembertów": "Rembertów",
  "wawer": "Wawer",
  "służew": "Służew",
  "ursynów": "Ursynów",
  "wilanów": "Wilanów",
  "marki": "Marki",
  "legionowo": "Legionowo",
  "łomianki": "Łomianki"
};

let shifts = [];

function parseZone(text) {
  const lower = text.toLowerCase();
  for (const [key, val] of Object.entries(knownZones)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

bot.onText(/oddaj[eę]? zmian[ęe]? (.+), (.+), (.+)/i, (msg, match) => {
  const date = match[1];
  const hours = match[2];
  const zoneRaw = match[3];
  const user = `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
  const userId = msg.from.id;

  const zone = parseZone(zoneRaw);
  if (!zone) {
    bot.sendMessage(msg.chat.id, `Nie rozpoznano strefy "${zoneRaw}". Podaj dokładną nazwę lub popraw literówki.`);
    return;
  }

  shifts.push({ date, hours, zone, user, userId });
  bot.sendMessage(msg.chat.id, `Zapisano: ${user}, ${date} ${hours}, ${zone}`);
});

bot.onText(/zobacz zmiany (.+)/i, (msg, match) => {
  const zoneRaw = match[1];
  const zone = parseZone(zoneRaw);
  if (!zone) {
    bot.sendMessage(msg.chat.id, `Nie rozpoznano strefy "${zoneRaw}".`);
    return;
  }

  const zoneShifts = shifts.filter(s => s.zone === zone);
  if (zoneShifts.length === 0) {
    bot.sendMessage(msg.chat.id, `Brak dostępnych zmian w strefie ${zone}.`);
    return;
  }

  const list = zoneShifts.map(s => `${s.user}: ${s.date} ${s.hours}`).join('\n');
  bot.sendMessage(msg.chat.id, `Dostępne zmiany w strefie ${zone}:\n${list}`);
});
