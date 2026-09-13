/**
 * ============================================================
 *  MR.RCT EXECUTIVE VAULT — Node.js TypeScript Backend
 *  Stack: Express + Firebase Admin + node-cron + Telegraf
 * ============================================================
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import admin from 'firebase-admin';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

// ====== INIT FIREBASE ADMIN ======
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: (process.env.FB_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    }),
    databaseURL: process.env.FB_DATABASE_URL
  });
}
const db = admin.database();

// ====== INIT TELEGRAM BOT ======
const bot = process.env.TELEGRAM_BOT_TOKEN
  ? new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
  : null;

// ====== INIT EXPRESS ======
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_SECRET = process.env.API_SECRET || 'change-me';

// Middleware
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// ====== AUTH MIDDLEWARE ======
function requireSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== API_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ====== ROUTES: HEALTH ======
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'MR.RCT Vault API',
    version: '1.0.0',
    uptime: process.uptime(),
    ts: new Date().toISOString()
  });
});

// ====== ROUTES: VAULT CRUD ======
app.get('/api/vault', requireSecret, async (_req, res) => {
  try {
    const snap = await db.ref('vault_data').once('value');
    res.json({ ok: true, data: snap.val() });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/vault', requireSecret, async (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ ok: false, error: 'Missing data' });
    await db.ref('vault_data').set({
      ...data,
      updatedAt: new Date().toISOString()
    });
    res.json({ ok: true, message: 'Vault saved' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch('/api/vault', requireSecret, async (req, res) => {
  try {
    await db.ref('vault_data').update({
      ...req.body,
      updatedAt: new Date().toISOString()
    });
    res.json({ ok: true, message: 'Vault updated' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== ROUTES: TELEGRAM NOTIFY ======
app.post('/api/notify', requireSecret, async (req, res) => {
  try {
    const { message, chatId } = req.body;
    if (!bot) return res.status(503).json({ ok: false, error: 'Bot not configured' });
    await bot.telegram.sendMessage(
      chatId || process.env.TELEGRAM_CHAT_ID!,
      message || 'Test notif',
      { parse_mode: 'HTML' }
    );
    res.json({ ok: true, message: 'Notif sent' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== ROUTES: BACKUP ======
app.get('/api/backup', requireSecret, async (_req, res) => {
  try {
    const snap = await db.ref('vault_data').once('value');
    const filename = `vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(snap.val() || {});
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/restore', requireSecret, async (req, res) => {
  try {
    await db.ref('vault_data').set(req.body);
    res.json({ ok: true, message: 'Restore success' });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ====== TELEGRAM BOT COMMANDS ======
if (bot) {
  bot.start((ctx) => ctx.reply(
    `👋 Halo <b>${ctx.from.first_name}</b>!\n\nMR.RCT Vault Bot siap.\nCommand:\n/status - Cek server\n/alarms - Daftar alarm aktif`,
    { parse_mode: 'HTML' }
  ));

  bot.command('status', async (ctx) => {
    const snap = await db.ref('vault_data').once('value');
    const v = snap.val() || {};
    ctx.reply(
      `✅ <b>Server Status</b>\nMenus: ${(v.menus || []).length}\nItems: ${(v.data || []).length}\nTime: ${new Date().toLocaleString('id-ID')}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('alarms', async (ctx) => {
    const snap = await db.ref('vault_data').once('value');
    const v = snap.val() || {};
    const alarms = (v.data || []).filter((d: any) => d.category === 'ALARM CENTER' && d.alarmOn);
    const list = alarms.map((a: any) => `⏰ ${a.alarmTime} - ${a.title}`).join('\n') || 'Tidak ada alarm aktif';
    ctx.reply(`<b>Daftar Alarm:</b>\n${list}`, { parse_mode: 'HTML' });
  });

  bot.launch().then(() => console.log('🤖 Telegram bot running (polling)'));
}

// ====== CRON: Cek alarm tiap menit ======
cron.schedule('* * * * *', async () => {
  try {
    const snap = await db.ref('vault_data').once('value');
    const v = snap.val() || {};
    const data = v.data || [];

    const now = new Date();
    const hari = ['MINGGU','SENIN','SELASA','RABU','KAMIS','JUMAT','SABTU'][now.getDay()];
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    for (const item of data) {
      if (item.category === 'ALARM CENTER' && item.alarmOn && item.alarmTime === hhmm) {
        const jadwal = (item.alarmDays || 'DAILY').toUpperCase();
        if (jadwal.includes(hari) || jadwal.includes('DAILY')) {
          await bot?.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID!,
            `🚨 <b>ALARM!</b>\n📌 ${item.title}\n⏰ ${item.alarmTime} (${hari})`,
            { parse_mode: 'HTML' }
          );
        }
      }
      if (item.category === 'RESULT PASARAN' && item.pasaranResultTime === hhmm && !item.pasaranDone) {
        await bot?.telegram.sendMessage(
          process.env.TELEGRAM_CHAT_ID!,
          `🎲 <b>RESULT PASARAN!</b>\n📌 ${item.title}\n⏰ ${item.pasaranResultTime}`,
          { parse_mode: 'HTML' }
        );
      }
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

// ====== ERROR HANDLER ======
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: err.message || 'Server error' });
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`🚀 MR.RCT Vault API running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});

export default app;
