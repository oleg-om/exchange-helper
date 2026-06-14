require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

const legacyTlsAgent = new https.Agent({
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_USER_ID = 1663965326;

const UNISTREAM_API_URL = process.env.UNISTREAM_API_URL;
const RBC_API_URL = process.env.RBC_API_URL;
const AVANGARD_API_URL = process.env.AVANGARD_API_URL;
const AVANGARD_PAGE_URL = process.env.AVANGARD_PAGE_URL;

const LINKS = {
  unistream: process.env.UNISTREAM_LINK,
  avangard: process.env.AVANGARD_LINK,
  rbc: process.env.RBC_LINK,
};

const AVANGARD_OFFICES = Object.fromEntries(
  (process.env.AVANGARD_OFFICES || '').split(',').filter(Boolean).map(id => [id.trim(), null])
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.setMyCommands([
  { command: 'rates', description: 'Получить текущий курс USD в Юнистрим' },
]);

function extractStreetAddress(fullAddress) {
  // "119361, МОСКВА Г, ОЗЕРНАЯ УЛ, 33" -> "ул. Озерная, 33"
  const parts = fullAddress.split(',').map(s => s.trim());
  if (parts.length >= 4) {
    const streetRaw = parts[parts.length - 2];
    const houseRaw = parts[parts.length - 1];

    const streetWords = streetRaw.split(' ');
    const streetType = streetWords[streetWords.length - 1].toLowerCase();
    const streetName = streetWords.slice(0, -1).map(w =>
      w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    ).join(' ');

    const typeMap = { 'ул': 'ул.', 'пр': 'пр.', 'пр-т': 'пр.', 'б-р': 'б-р.', 'пер': 'пер.' };
    const typeLabel = typeMap[streetType] || streetType + '.';

    return `${typeLabel} ${streetName}, ${houseRaw}`;
  }
  return fullAddress;
}

async function fetchUnistreamRates() {
  const response = await axios.get(UNISTREAM_API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; exchange-helper-bot/1.0)',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });

  const items = response.data?.items;
  if (!items || items.length === 0) {
    return [];
  }

  const results = [];

  for (const item of items) {
    const usdRate = item.exchangeRates?.find(r => r.currency === 'USD');
    if (!usdRate) continue;

    const streetAddr = extractStreetAddress(item.address);
    results.push({
      name: `Юнистрим, ${streetAddr}`,
      buyRate: usdRate.buyRate,
      sellRate: usdRate.sellRate,
      lastUpdated: usdRate.lastUpdated,
    });
  }

  return results;
}

async function fetchRbcTopRates() {
  const response = await axios.get(RBC_API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; exchange-helper-bot/1.0)',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });

  const banks = response.data?.banks;
  if (!banks || banks.length === 0) {
    return [];
  }

  // One branch can appear multiple times with different volume tiers — keep the best rate per branch id
  const byId = new Map();
  for (const b of banks.filter(b => b.rate?.buy)) {
    const rate = parseFloat(b.rate.buy);
    if (!byId.has(b.id) || rate > byId.get(b.id).buyRate) {
      byId.set(b.id, { name: b.name, buyRate: rate });
    }
  }

  const sorted = [...byId.values()].sort((a, b) => b.buyRate - a.buyRate);

  return {
    top3: sorted.slice(0, 3),
    top3NoUnistream: sorted.filter(b => !b.name.includes('ЮНИСТРИМ')).slice(0, 3),
  };
}

async function fetchAvangardRates() {
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; exchange-helper-bot/1.0)',
    'Accept': '*/*',
  };

  // Step 1: get session cookie + CSRF token from the page
  const page = await axios.get(AVANGARD_PAGE_URL, {
    headers: commonHeaders,
    httpsAgent: legacyTlsAgent,
    timeout: 10000,
  });

  const setCookie = page.headers['set-cookie'] || [];
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ');
  const csrfMatch = page.data.match(/[a-f0-9]{32}/);
  const csrfToken = csrfMatch?.[0] ?? '';

  // Step 2: fetch rates
  const response = await axios.post(AVANGARD_API_URL, { data: 'hello world' }, {
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json;charset=utf-8',
      'Cookie': cookie,
      'x-bitrix-csrf-token': csrfToken,
      'Referer': AVANGARD_PAGE_URL,
    },
    timeout: 10000,
    httpsAgent: legacyTlsAgent,
  });

  const items = response.data?.data;
  if (!items || items.length === 0) {
    return [];
  }

  return items
    .filter(item => item.id in AVANGARD_OFFICES && item.currency_to === 'USD' && item.sum_buy)
    .map(item => ({
      name: item.label_web || item.label,
      buyRate: parseFloat(item.sum_buy),
    }));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linkHeader(text, url) {
  const href = String(url).replace(/&/g, '&amp;');
  return `<a href="${href}">${text}</a>`;
}

function formatMessage(unistreamRates, rbcData, avangardRates) {
  const now = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const parts = [`📅 Курс USD на ${now}`];

  if (unistreamRates.length > 0) {
    const lines = unistreamRates.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: ${r.buyRate} ₽`
    );
    parts.push('\n' + linkHeader('🏦 Юнистрим', LINKS.unistream) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏦 Юнистрим', LINKS.unistream) + '\n❌ Нет данных');
  }

  const { top3, top3NoUnistream } = rbcData;

  if (avangardRates.length > 0) {
    const lines = avangardRates.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: ${r.buyRate} ₽`
    );
    parts.push('\n' + linkHeader('🏦 Авангард', LINKS.avangard) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏦 Авангард', LINKS.avangard) + '\n❌ Нет данных');
  }

  if (top3.length > 0) {
    const lines = top3.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: ${r.buyRate} ₽`
    );
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК)', LINKS.rbc) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК)', LINKS.rbc) + '\n❌ Нет данных');
  }

  if (top3NoUnistream.length > 0) {
    const lines = top3NoUnistream.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: ${r.buyRate} ₽`
    );
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК) без Юнистрим', LINKS.rbc) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК) без Юнистрим', LINKS.rbc) + '\n❌ Нет данных');
  }

  return parts.join('\n');
}

async function sendRates(chatId) {
  try {
    console.log(`[${new Date().toISOString()}] Fetching rates...`);
    const [unistreamRates, rbcData, avangardRates] = await Promise.all([
      fetchUnistreamRates(),
      fetchRbcTopRates(),
      fetchAvangardRates(),
    ]);
    const message = formatMessage(unistreamRates, rbcData, avangardRates);
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    console.log(`[${new Date().toISOString()}] Message sent to ${chatId}.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
  }
}

async function sendDailyRates() {
  await sendRates(TARGET_USER_ID);
}

// Every day at 11:00 Moscow time (UTC+3 = 08:00 UTC)
cron.schedule('0 8 * * *', sendDailyRates, {
  timezone: 'Europe/Moscow',
});

console.log('Bot started. Will send rates every day at 11:00 MSK.');

bot.onText(/\/rates/, async (msg) => {
  if (msg.chat.id !== TARGET_USER_ID) return;
  await sendRates(msg.chat.id);
});
