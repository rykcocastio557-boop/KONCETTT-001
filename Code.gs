/**
 * ============================================================
 *  MR.RCT EXECUTIVE VAULT — Google Apps Script Backend
 *  Backend alternatif: simpan data ke Google Sheets
 *  + Webhook Telegram untuk notifikasi Alarm & Pasaran
 * ============================================================
 */

// ====== KONFIGURASI ======
const CONFIG = {
  SPREADSHEET_ID: 'ISI_ID_SPREADSHEET_KAMU',           // ID Google Sheets
  SHEET_NAME: 'vault_data',                            // Nama sheet
  TELEGRAM_BOT_TOKEN: 'ISI_TOKEN_BOT_KAMU',            // Token dari @BotFather
  TELEGRAM_CHAT_ID: 'ISI_CHAT_ID_TELEGRAM_KAMU',       // Chat ID tujuan
  API_SECRET_KEY: 'MRRCT_SECRET_2025_CHANGE_ME'        // Secret untuk autentikasi
};

// ====== ENTRY POINT: GET ======
function doGet(e) {
  const action = (e.parameter.action || 'health').toLowerCase();
  const secret = e.parameter.secret || '';

  if (action !== 'health' && secret !== CONFIG.API_SECRET_KEY) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    switch (action) {
      case 'health':
        return jsonResponse({ ok: true, service: 'MR.RCT Vault API', ts: new Date().toISOString() });
      case 'getVault':
        return jsonResponse({ ok: true, data: getVaultData() });
      case 'getMenus':
        return jsonResponse({ ok: true, menus: getVaultData().menus || [] });
      case 'backup':
        return jsonResponse({ ok: true, backup: getVaultData() });
      default:
        return jsonResponse({ ok: false, error: 'Unknown action: ' + action }, 400);
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ====== ENTRY POINT: POST ======
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  // Telegram webhook (tanpa secret)
  if (body.message || body.callback_query) {
    return handleTelegramWebhook(body);
  }

  // API action butuh secret
  if (body.secret !== CONFIG.API_SECRET_KEY) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
  }

  try {
    switch ((body.action || '').toLowerCase()) {
      case 'savevault':
        saveVaultData(body.data);
        return jsonResponse({ ok: true, message: 'Vault saved' });
      case 'savemenus':
        const current = getVaultData();
        current.menus = body.menus || [];
        saveVaultData(current);
        return jsonResponse({ ok: true, message: 'Menus saved' });
      case 'restore':
        saveVaultData(body.backup);
        return jsonResponse({ ok: true, message: 'Restore success' });
      case 'notify':
        sendTelegram(body.message || 'Test notif dari MR.RCT Vault');
        return jsonResponse({ ok: true, message: 'Notif sent' });
      default:
        return jsonResponse({ ok: false, error: 'Unknown action' }, 400);
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

// ====== HELPER: JSON Response ======
function jsonResponse(obj, code) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== HELPER: Get Spreadsheet ======
function getSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
  }
  return sheet;
}

// ====== CORE: Read Vault ======
function getVaultData() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { menus: [], data: [], bgFront: '', bgInner: '' };

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const result = {};
  values.forEach(([key, val]) => {
    if (!key) return;
    try {
      result[key] = JSON.parse(val);
    } catch (e) {
      result[key] = val;
    }
  });
  return result;
}

// ====== CORE: Write Vault ======
function saveVaultData(data) {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();

  // Bersihkan data lama (kecuali header)
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 2).clearContent();

  // Tulis data baru
  const rows = Object.keys(data).map(k => [k, JSON.stringify(data[k])]);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  }
}

// ====== TELEGRAM INTEGRATION ======
function sendTelegram(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML'
  };

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function handleTelegramWebhook(update) {
  const msg = update.message;
  if (!msg || !msg.text) return jsonResponse({ ok: true });

  const text = msg.text.trim();
  const chatId = msg.chat.id;

  if (text === '/start') {
    sendTelegram(`👋 Halo <b>${msg.from.first_name || 'Master'}</b>!\n\nMR.RCT Vault Bot siap.\nKetik /status untuk cek server.`);
  } else if (text === '/status') {
    const vault = getVaultData();
    sendTelegram(`✅ <b>Server Status</b>\nMenus: ${(vault.menus || []).length}\nItems: ${(vault.data || []).length}\nTime: ${new Date().toLocaleString('id-ID')}`);
  }

  return jsonResponse({ ok: true });
}

// ====== TRIGGER: Alarm Otomatis (jalankan via Time-driven trigger) ======
function checkAlarms() {
  const vault = getVaultData();
  const data = vault.data || [];
  const now = new Date();
  const hari = ['MINGGU','SENIN','SELASA','RABU','KAMIS','JUMAT','SABTU'][now.getDay()];
  const hhmm = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm');

  data.forEach(item => {
    if (item.category === 'ALARM CENTER' && item.alarmOn && item.alarmTime === hhmm) {
      const jadwal = (item.alarmDays || 'DAILY').toUpperCase();
      if (jadwal.includes(hari) || jadwal.includes('DAILY')) {
        sendTelegram(`🚨 <b>ALARM!</b>\n📌 ${item.title}\n⏰ ${item.alarmTime} (${hari})`);
      }
    }
    if (item.category === 'RESULT PASARAN' && item.pasaranResultTime === hhmm && !item.pasaranDone) {
      sendTelegram(`🎲 <b>RESULT PASARAN!</b>\n📌 ${item.title}\n⏰ ${item.pasaranResultTime}`);
    }
  });
}

/**
 * ============================================================
 * SETUP:
 * 1. Buat Google Sheet baru → copy ID-nya → isi CONFIG.SPREADSHEET_ID
 * 2. Extensions → Apps Script → paste kode ini → Save
 * 3. Deploy → New deployment → Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy Web App URL → pakai sebagai endpoint
 * 5. Setup trigger: Edit → Triggers → Add:
 *    - Function: checkAlarms, Event: Time-driven, Minutes timer, Every 1 minute
 * 6. Untuk Telegram: kirim /start ke bot, lalu setup webhook:
 *    https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WEB_APP_URL>
 * ============================================================
 */
