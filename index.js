require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, 'rates-history.json');

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function diff(current, previous) {
  if (previous == null || current == null) return '';
  const delta = current - previous;
  if (delta === 0) return '';
  const pct = Math.abs((delta / previous) * 100).toFixed(2);
  return delta > 0 ? ` 📈 +${pct}%` : ` 📉 -${pct}%`;
}

if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const legacyTlsAgent = new https.Agent({
  family: 4,
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const ipv4Agent = new https.Agent({ family: 4 });

// forabank.ru serves its chain via the Russian Trusted Root CA, which isn't in Node's
// default trust store (AIA chasing that browsers do isn't available here).
const foraTlsAgent = new https.Agent({ ca: process.env.RUSSIAN_TRUSTED_ROOT_CA, family: 4 });

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
  tbank: process.env.TBANK_LINK,
  fora: process.env.FORA_LINK,
};

const AVANGARD_OFFICES = Object.fromEntries(
  (process.env.AVANGARD_OFFICES || '').split(',').filter(Boolean).map(id => [id.trim(), null])
);

const TBANK_API_URL = process.env.TBANK_API_URL;

const FORA_API_URL = process.env.FORA_API_URL;
const FORA_CITY_ID = process.env.FORA_CITY_ID;
const FORA_OFFICE_ID = process.env.FORA_OFFICE_ID;

const botRequestOptions = {
  agentClass: https.Agent,
  agentOptions: { family: 4, keepAlive: true },
  timeout: 30000,
};

if (process.env.TELEGRAM_PROXY) {
  botRequestOptions.proxy = process.env.TELEGRAM_PROXY;
}

const bot = new TelegramBot(BOT_TOKEN, {
  polling: true,
  request: botRequestOptions,
});

bot.on('polling_error', (err) => {
  console.error(`[${new Date().toISOString()}] polling_error:`, err.code, err.message);
  if (err.code === 'EFATAL' || String(err.message).includes('AggregateError')) {
    console.error('Cannot reach Telegram API. Try TELEGRAM_PROXY in .env or check outbound HTTPS access.');
  }
});

bot.setMyCommands([
  { command: 'rates', description: 'Получить текущий курс USD в Юнистрим' },
]).catch((err) => {
  console.error(`[${new Date().toISOString()}] Failed to set bot commands:`, err.message);
});

bot.getMe()
  .then((me) => console.log(`Connected to Telegram as @${me.username}`))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] Telegram connection failed:`, err.message);
    console.error('Set TELEGRAM_PROXY in .env if Telegram is blocked on this server.');
  });

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

async function fetchTbankRate() {
  const response = await axios.get(TBANK_API_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; exchange-helper-bot/1.0)',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });

  const rates = response.data?.payload?.rates;
  if (!rates) return null;

  const entry = rates.find(
    r => r.category === 'CUTransferAbove100' &&
      r.fromCurrency?.name === 'USD' &&
      r.toCurrency?.name === 'RUB'
  );

  return entry?.buy ?? null;
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

// forabank.ru gates every request behind a JS challenge page: it hands out an
// "__js_p_" cookie encoding a seed, expects the client to run a slow hash over it
// client-side, and only serves real content once a matching "__jhash_" cookie comes
// back after a ~1s delay (mirroring the page's own setTimeout). This replicates that
// exact algorithm (lifted from the challenge page's inline script) server-side.
function foraJhash(seed) {
  let x = 123456789;
  let k = 0;
  for (let i = 0; i < 1677696; i++) {
    x = ((x + seed) ^ (x + (x % 3) + (x % 17) + seed) ^ i) % 16776960;
    if (x % 117 === 0) k = (k + 1) % 1111;
  }
  return k;
}

function parseSetCookies(setCookieHeader) {
  const jar = {};
  for (const entry of setCookieHeader || []) {
    const pair = entry.split(';')[0];
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchForaRate() {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const commonHeaders = { 'User-Agent': userAgent };

  const jar = {};

  // Step 1: hit the page to receive the "__js_p_" challenge seed.
  const first = await axios.get(FORA_API_URL, {
    headers: commonHeaders,
    httpsAgent: foraTlsAgent,
    timeout: 10000,
  });
  Object.assign(jar, parseSetCookies(first.headers['set-cookie']));

  const seed = parseInt(jar['__js_p_'].split(',')[0], 10);
  jar['__jhash_'] = foraJhash(seed);
  jar['__jua_'] = encodeURIComponent(userAgent);

  // The challenge page itself waits 1s before replaying the request; mirror that.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 2: replay with the solved hash. Server responds 302 + a "__hash_" cookie
  // that marks this cookie jar as verified for subsequent requests.
  const second = await axios.get(FORA_API_URL, {
    headers: { ...commonHeaders, Cookie: cookieHeader(jar) },
    httpsAgent: foraTlsAgent,
    timeout: 10000,
    maxRedirects: 0,
    validateStatus: (status) => status === 200 || status === 302,
  });
  Object.assign(jar, parseSetCookies(second.headers['set-cookie']));

  // Step 3: now the AJAX endpoint behind the same challenge will respond with data.
  const response = await axios.post(
    `${FORA_API_URL}?act=exchange_offices`,
    `cityId=${FORA_CITY_ID}&officeId=${FORA_OFFICE_ID}`,
    {
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': FORA_API_URL,
        'Cookie': cookieHeader(jar),
      },
      httpsAgent: foraTlsAgent,
      timeout: 10000,
    }
  );

  const html = response.data?.html;
  if (!html) return null;

  // Values appear in order: USD buy, EUR buy, USD sell, EUR sell.
  const values = [...html.matchAll(/-arr">\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return values[2] ?? null;
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

function formatMessage(unistreamRates, rbcData, avangardRates, tbankBuyRate, foraSellRate, history) {
  const now = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });

  const parts = [`📅 Курс USD на ${now}`];

  if (unistreamRates.length > 0) {
    const lines = unistreamRates.map((r, i) => {
      const prevRate = history?.unistream?.[i]?.buyRate ?? null;
      return `${i + 1}. ${escapeHtml(r.name)}: <b>${r.buyRate} ₽</b>${diff(r.buyRate, prevRate)}`;
    });
    parts.push('\n' + linkHeader('🏦 Юнистрим', LINKS.unistream) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏦 Юнистрим', LINKS.unistream) + '\n❌ Нет данных');
  }

  const { top3, top3NoUnistream } = rbcData;

  const prevTbank = history?.tbank ?? null;
  const tbankLine = tbankBuyRate != null
    ? `1. Продать: <b>${tbankBuyRate} ₽</b>${diff(tbankBuyRate, prevTbank)}`
    : '❌ Нет данных';
  parts.push('\n' + linkHeader('🏦 Т-Банк', LINKS.tbank) + '\n' + tbankLine);

  const prevFora = history?.fora ?? null;
  const foraLine = foraSellRate != null
    ? `1. Продать: <b>${foraSellRate} ₽</b>${diff(foraSellRate, prevFora)}`
    : '❌ Нет данных';
  parts.push('\n' + linkHeader('🏦 Фора-Банк (Авеню)', LINKS.fora) + '\n' + foraLine);

  if (avangardRates.length > 0) {
    const lines = avangardRates.map((r, i) => {
      const prevRate = history?.avangard?.[i]?.buyRate ?? null;
      return `${i + 1}. ${escapeHtml(r.name)}: <b>${r.buyRate} ₽</b>${diff(r.buyRate, prevRate)}`;
    });
    parts.push('\n' + linkHeader('🏦 Авангард', LINKS.avangard) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏦 Авангард', LINKS.avangard) + '\n❌ Нет данных');
  }

  if (top3.length > 0) {
    const lines = top3.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: <b>${r.buyRate} ₽</b>`
    );
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК)', LINKS.rbc) + '\n' + lines.join('\n'));
  } else {
    parts.push('\n' + linkHeader('🏆 Топ-3 по покупке (РБК)', LINKS.rbc) + '\n❌ Нет данных');
  }

  if (top3NoUnistream.length > 0) {
    const lines = top3NoUnistream.map((r, i) =>
      `${i + 1}. ${escapeHtml(r.name)}: <b>${r.buyRate} ₽</b>`
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
    const history = loadHistory();
    const [unistreamRates, rbcData, avangardRates, tbankBuyRate, foraSellRate] = await Promise.all([
      fetchUnistreamRates(),
      fetchRbcTopRates(),
      fetchAvangardRates(),
      fetchTbankRate(),
      fetchForaRate().catch((err) => {
        console.error(`[${new Date().toISOString()}] Fora fetch failed:`, err.message);
        return null;
      }),
    ]);
    const message = formatMessage(unistreamRates, rbcData, avangardRates, tbankBuyRate, foraSellRate, history);
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    saveHistory({
      updatedAt: new Date().toISOString(),
      unistream: unistreamRates.map(r => ({ name: r.name, buyRate: r.buyRate })),
      tbank: tbankBuyRate,
      fora: foraSellRate,
      avangard: avangardRates.map(r => ({ name: r.name, buyRate: r.buyRate })),
    });
    console.log(`[${new Date().toISOString()}] Message sent to ${chatId}.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
  }
}

async function sendDailyRates() {
  await sendRates(TARGET_USER_ID);
}

// Every day at 11:00 UTC
cron.schedule('0 11 * * *', sendDailyRates, {
  timezone: 'UTC',
});

console.log('Bot started. Will send rates every day at 11:00 MSK.');

bot.onText(/\/rates/, async (msg) => {
  if (msg.chat.id !== TARGET_USER_ID) return;
  await sendRates(msg.chat.id);
});
