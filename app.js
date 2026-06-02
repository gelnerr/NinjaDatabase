require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const csv = require('csv-parser');

const Dashboard = require('./models/Dashboard');
const User = require('./models/User');
const Ninja = require('./models/Ninja');
const NBLog = require('./models/NBLog');
const HallOfFame = require('./models/HallOfFame');
const ProgressLog = require('./models/ProgressLog');

const app = express();

// Database Connection
let cachedDb = null;
const connectDB = async () => {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) throw new Error('MONGODB_URI missing!');
  try {
    cachedDb = await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
    console.log('MongoDB Connected');
    return cachedDb;
  } catch (err) { console.error('DB Error:', err.message); throw err; }
};

app.use(async (req, res, next) => { try { await connectDB(); next(); } catch (err) { res.status(500).send(err.message); } });
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/css', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/css')));
app.use('/js', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/js')));
app.use('/icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ninja-secret',
  resave: false, saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));
const upload = multer({ dest: '/tmp' });

// HELPERS
const getDashboardData = async () => {
  const d = (await Dashboard.findOne()) || (await Dashboard.create({}));
  
  // Calculate Boss Battle Leaderboards
  const topDamagers = await NBLog.aggregate([
    { $match: { damageDealt: { $gt: 0 } } },
    { $group: { _id: "$ninjaName", totalDamage: { $sum: "$damageDealt" } } },
    { $sort: { totalDamage: -1 } },
    { $limit: 5 }
  ]);

  const topAttackers = await NBLog.aggregate([
    { $match: { damageDealt: { $gt: 0 } } },
    { $group: { _id: "$ninjaName", attackCount: { $sum: 1 } } },
    { $sort: { attackCount: -1 } },
    { $limit: 5 }
  ]);

  d.topDamagers = topDamagers.map(x => ({ name: x._id, value: x.totalDamage }));
  d.topAttackers = topAttackers.map(x => ({ name: x._id, value: x.attackCount }));

  return d;
};
const isAuthenticated = (req, res, next) => req.session.user ? next() : res.redirect('/login');

const createDatabaseBackup = async () => {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `db-backup-${timestamp}.json`);
  
  const data = {
    ninjas: await Ninja.find({}),
    logs: await NBLog.find({}),
    progressLogs: await ProgressLog.find({}),
    hallOfFame: await HallOfFame.find({}),
    dashboard: await Dashboard.findOne()
  };
  
  fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
  return backupPath;
};

const sendDiscordNotification = async (ninjaName, oldBelt, newBelt, notes) => {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('Discord Notification skipped: DISCORD_WEBHOOK_URL is missing in .env');
    return false;
  }
  
  const emojis = {
    'White': '⚪', 'Yellow': '🟡', 'Orange': '🟠', 'Green': '🟢', 'Blue': '🔵', 
    'Purple': '🟣', 'Brown': '🟤', 'Red': '🔴', 'Black': '⚫', 
    'Bronze': '🥉', 'Silver': '🥈', 'Platinum': '💠', 'Gold': '🥇', 'Going Gold': '✨'
  };

  const oldE = emojis[oldBelt] || '⚪';
  const newE = emojis[newBelt] || '⚪';
  
  const message = `🥋 **Belt Advancement!**\n**${ninjaName}** has leveled up!\n\n${oldE} **${oldBelt}**  ➡️  ${newE} **${newBelt}**\n\n_${notes || 'Manual Update'}_`;
  const data = JSON.stringify({ content: message });
  const url = new URL(webhookUrl);
  const https = require('https');

  console.log(`Sending Discord notification for ${ninjaName}...`);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Discord success for ${ninjaName}`);
          resolve(true);
        } else {
          console.error(`Discord Error ${res.statusCode}:`, body);
          resolve(false);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('Discord Network Error:', e.message);
      resolve(false);
    });
    
    req.write(data);
    req.end();
  });
};

// Shared Google Sheets auth — used by sync, push, and read helpers
const getSheetClient = async () => {
  const credPath = path.join(__dirname, 'credentials.json');
  let authConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
  if (process.env.GOOGLE_CREDENTIALS) authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  else if (fs.existsSync(credPath)) authConfig.keyFilename = credPath;
  else return null;
  try {
    const auth = new google.auth.GoogleAuth(authConfig);
    return google.sheets({ version: 'v4', auth });
  } catch(e) { return null; }
};

// Date string matching the Apps Script format: "January 15, 2025"
const sheetDate = () => new Date().toLocaleDateString('en-US', {
  month: 'long', day: '2-digit', year: 'numeric', timeZone: 'America/Regina'
});

// Find a ninja's 1-indexed row in a sheet column
const findSheetRow = async (sheets, spreadsheetId, sheetName, col, name) => {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!${col}:${col}` });
  const rows = res.data.values || [];
  const idx = rows.findIndex(r => r[0]?.trim().toLowerCase() === name.toLowerCase());
  return idx === -1 ? null : idx + 1;
};

// Push an NB transaction to the NB Log sheet and update the ninja's total in the data sheet
const pushNBToSheets = async (ninjaName, amount, reason, newTotal) => {
  try {
    const d = await getDashboardData();
    if (!d?.mainSpreadsheetId) return;
    const sheets = await getSheetClient();
    if (!sheets) return;
    const sid = d.mainSpreadsheetId;

    // Append log row to NB Log (rows 9+ are the actual log entries)
    const amtStr = amount >= 0 ? `+${amount}` : `${amount}`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid,
      range: 'NB Log!A9:D',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[sheetDate(), ninjaName, reason, amtStr]] }
    });

    // Update running total in data sheet column F
    const row = await findSheetRow(sheets, sid, 'data', 'A', ninjaName);
    if (row) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `data!F${row}`,
        valueInputOption: 'RAW', requestBody: { values: [[newTotal]] }
      });
    }
    console.log(`[Sheets] NB sync: ${ninjaName} ${amtStr} → total ${newTotal}`);
  } catch(e) { console.error('[Sheets] pushNBToSheets error:', e.message); }
};

// Push a belt advancement to the Progress Log sheet and update the belt in the Progress sheet
const pushBeltToSheets = async (ninjaName, oldBelt, newBelt, notes) => {
  try {
    const d = await getDashboardData();
    if (!d?.mainSpreadsheetId) return;
    const sheets = await getSheetClient();
    if (!sheets) return;
    const sid = d.mainSpreadsheetId;

    // Apps Script uses Unity section (cols G-K) for Purple+, Degrees (cols A-E) for White-Blue
    const UNITY_BELTS = new Set(['Purple', 'Brown', 'Red', 'Black', 'Bronze', 'Silver', 'Platinum', 'Gold', 'Going Gold']);
    const isUnity = UNITY_BELTS.has(newBelt);
    const beltStr = `${oldBelt} -> ${newBelt}`;
    const notesStr = notes || 'Website Update';
    const dateStr = sheetDate();

    if (isUnity) {
      const gRes = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Progress Log!G:G' });
      const nextRow = Math.max(3, (gRes.data.values || []).length + 1);
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `Progress Log!G${nextRow}:K${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[dateStr, ninjaName, beltStr, notesStr, false]] }
      });
    } else {
      const aRes = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Progress Log!A:A' });
      const nextRow = Math.max(3, (aRes.data.values || []).length + 1);
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `Progress Log!A${nextRow}:E${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[dateStr, ninjaName, beltStr, notesStr, false]] }
      });
    }

    // Update current belt in Progress sheet column B
    const progRow = await findSheetRow(sheets, sid, 'Progress', 'A', ninjaName);
    if (progRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `Progress!B${progRow}`,
        valueInputOption: 'RAW', requestBody: { values: [[newBelt]] }
      });
    }
    console.log(`[Sheets] Belt sync: ${ninjaName} → ${newBelt}`);
  } catch(e) { console.error('[Sheets] pushBeltToSheets error:', e.message); }
};

// Delete a row from the NB Log sheet and update the ninja's total in data sheet
// Write damage dealt to column E of the matching NB Log row in the sheet
const pushDamageToSheets = async (ninjaName, amount, reason, damageDealt) => {
  try {
    const d = await getDashboardData();
    if (!d?.mainSpreadsheetId) return;
    const sheets = await getSheetClient();
    if (!sheets) return;
    const sid = d.mainSpreadsheetId;

    const logRes = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'NB Log!A9:D' });
    const rows = logRes.data.values || [];
    const amtStr = amount >= 0 ? `+${amount}` : `${amount}`;

    let matchIndex = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][1]?.trim() === ninjaName &&
          rows[i][2]?.trim() === reason &&
          rows[i][3]?.trim() === amtStr) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) { console.log(`[Sheets] No matching row for damage: ${ninjaName}`); return; }

    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `NB Log!E${9 + matchIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[damageDealt]] }
    });
    console.log(`[Sheets] Damage ${damageDealt} → NB Log row ${9 + matchIndex}`);
  } catch(e) { console.error('[Sheets] pushDamageToSheets error:', e.message); }
};

const deleteFromNBLogSheet = async (ninjaName, amount, reason, newNinjaTotal) => {
  try {
    const d = await getDashboardData();
    if (!d?.mainSpreadsheetId) return;
    const sheets = await getSheetClient();
    if (!sheets) return;
    const sid = d.mainSpreadsheetId;

    // Read all log entries (rows 9+ are actual log entries)
    const logRes = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'NB Log!A9:D' });
    const rows = logRes.data.values || [];

    const amtStr = amount >= 0 ? `+${amount}` : `${amount}`;

    // Search bottom-up so we match the most recent duplicate
    let matchIndex = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][1]?.trim() === ninjaName &&
          rows[i][2]?.trim() === reason &&
          rows[i][3]?.trim() === amtStr) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      console.log(`[Sheets] No matching NB Log row for ${ninjaName} ${amtStr} "${reason}"`);
    } else {
      // Get the NB Log sheet ID (needed for deleteDimension)
      const ssInfo = await sheets.spreadsheets.get({ spreadsheetId: sid });
      const sheetId = ssInfo.data.sheets.find(s => s.properties.title === 'NB Log')?.properties.sheetId;
      if (sheetId !== undefined) {
        // Row 9 in the sheet = index 8 (0-indexed); matchIndex is offset within A9:D
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: sid,
          requestBody: { requests: [{ deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: 8 + matchIndex, endIndex: 9 + matchIndex }
          }}]}
        });
        console.log(`[Sheets] Deleted NB Log row ${9 + matchIndex} for ${ninjaName} ${amtStr}`);
      }
    }

    // Always update the running total in data sheet
    const row = await findSheetRow(sheets, sid, 'data', 'A', ninjaName);
    if (row) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sid, range: `data!F${row}`,
        valueInputOption: 'RAW', requestBody: { values: [[newNinjaTotal]] }
      });
    }
  } catch(e) { console.error('[Sheets] deleteFromNBLogSheet error:', e.message); }
};

const syncGoogleSheets = async (data) => {
  if (!data.spreadsheetId) return 0;
  const sheets = await getSheetClient();
  if (!sheets) return 0;
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: data.spreadsheetId, range: data.spreadsheetRange || 'Ninja Bucks!A2:C150' });
    const rows = response.data.values; if (!rows) return 0;
    data.leaderboard = rows.filter(r => r[0]).map(r => ({ name: r[0].trim(), total: parseInt(r[1]?.toString().replace(/,/g,''))||0, monthly: parseInt(r[2]?.toString().replace(/,/g,''))||0 }));
    await data.save(); return data.leaderboard.length;
  } catch (e) { console.error('Sync Error:', e.message); return 0; }
};

const BELTS = ['White', 'Yellow', 'Orange', 'Green', 'Blue', 'Purple', 'Brown', 'Red', 'Black', 'Bronze', 'Silver', 'Platinum', 'Gold', 'Going Gold'];

const getNewBelt = (oldBelt, degree) => {
  const b = oldBelt?.trim();
  const d = degree?.trim();
  
  if (b === 'White') {
    if (d === 'Second Degree') return 'Yellow';
    return 'White';
  }
  if (b === 'Yellow') {
    if (d === 'Second Degree' || d === 'Third Degree') return 'Green';
    return 'Orange';
  }
  if (b === 'Orange') {
    if (d === 'Second Degree' || d === 'Third Degree') return 'Purple';
    return 'Blue';
  }
  if (b === 'Green') return 'Brown';
  if (b === 'Blue') {
    if (d === 'Third Degree') return 'Black';
    return 'Red';
  }
  if (b === 'Purple') return 'Bronze';
  if (b === 'Brown') return 'Silver';
  if (b === 'Red') return 'Platinum';
  if (b === 'Black') return 'Gold';
  if (b === 'Finished Black Belt') return 'Going Gold';
  
  return b || 'White';
};

// ── Sheets → Website webhook ──────────────────────────────────────────────────
// Called by Apps Script after every button action or belt update.
// Secured by SHEETS_WEBHOOK_SECRET env var (must match Script Property on Sheets side).
app.post('/api/sheets-webhook', async (req, res) => {
  const secret = req.body.secret;
  if (!secret || secret !== process.env.SHEETS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, ninjaName, amount, reason, newBelt, notes } = req.body;

  try {
    if (type === 'nb_award') {
      const parsedAmount = parseInt(amount) || 0;
      if (!ninjaName || parsedAmount === 0) return res.status(400).json({ error: 'Invalid payload' });

      // Write to MongoDB — do NOT call pushNBToSheets (data already came FROM sheets)
      await Promise.all([
        NBLog.create({ ninjaName, buttonAction: reason || 'Sheets Award', amount: parsedAmount }),
        Ninja.findOneAndUpdate({ name: ninjaName }, { $inc: { totalNinjaBucks: parsedAmount } })
      ]);

      // Keep the in-memory leaderboard cache in sync
      const d = await getDashboardData();
      const n = d.leaderboard.find(x => x.name === ninjaName);
      if (n) { n.total += parsedAmount; d.markModified('leaderboard'); await d.save(); }

      console.log(`[Webhook] NB ${parsedAmount > 0 ? '+' : ''}${parsedAmount} for ${ninjaName} (${reason})`);
      return res.json({ success: true });
    }

    if (type === 'belt_update') {
      if (!ninjaName || !newBelt) return res.status(400).json({ error: 'Invalid payload' });

      const ninja = await Ninja.findOne({ name: ninjaName });
      if (!ninja) return res.status(404).json({ error: `Ninja "${ninjaName}" not found` });

      const oldBelt = ninja.currentBelt;
      if (oldBelt !== newBelt) {
        ninja.currentBelt = newBelt;
        // Do NOT call pushBeltToSheets — change already came FROM sheets
        await Promise.all([
          ninja.save(),
          ProgressLog.create({ ninjaName, oldBelt, newBelt, notes: notes || 'Sheets Update', discordPosted: true }),
          sendDiscordNotification(ninjaName, oldBelt, newBelt, notes || 'Sheets Update')
        ]);
        console.log(`[Webhook] Belt: ${ninjaName} ${oldBelt} → ${newBelt}`);
      }
      return res.json({ success: true });
    }

    if (type === 'damage_update') {
      const parsedDamage = parseInt(req.body.damageDealt) || 0;
      const parsedAmount = parseInt(req.body.amount) || 0;
      if (!ninjaName || parsedDamage <= 0) return res.status(400).json({ error: 'Invalid payload' });

      // Find the most recent matching log entry for this ninja/action
      const log = await NBLog.findOne({ ninjaName, amount: parsedAmount, buttonAction: reason }).sort({ date: -1 });
      if (!log) return res.status(404).json({ error: `No matching log entry for ${ninjaName}` });

      const oldDmg = log.damageDealt || 0;
      const d = await getDashboardData();
      d.bossHP = Math.max(0, Math.min(d.bossMaxHP, d.bossHP + oldDmg - parsedDamage));
      log.damageDealt = parsedDamage;
      await Promise.all([d.save(), log.save()]);

      console.log(`[Webhook] Damage update: ${ninjaName} dealt ${parsedDamage}, boss HP now ${d.bossHP}`);
      return res.json({ success: true, newHP: d.bossHP });
    }

    return res.status(400).json({ error: `Unknown event type: ${type}` });
  } catch(e) {
    console.error('[Webhook] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  const data = await getDashboardData();
  if (req.query.theme) data.theme = req.query.theme;
  res.render('dashboard', data);
});
app.get('/ninjabucks', async (req, res) => {
  const data = await getDashboardData(); await syncGoogleSheets(data);
  res.render('ninjabucks', { leaderboard: data.leaderboard || [], monthlyLeaderboard: data.monthlyLeaderboard || [], theme: data.theme, user: req.session.user });
});
app.get('/shop', async (req, res) => {
  const data = await getDashboardData();
  res.render('shop', { shopItems: data.shopItems, theme: data.theme, user: req.session.user });
});
app.get('/belts', async (req, res) => {
  const data = await getDashboardData();
  const ninjas = await Ninja.find({ isActive: true }).sort({ name: 1 });
  const theme = req.query.theme || data.theme;
  res.render('belts', { ninjas, theme, user: req.session.user });
});
app.get('/notm-archive', async (req, res) => {
  const data = await getDashboardData();
  res.render('notm-archive', { archive: data.notmArchive, theme: data.theme, user: req.session.user });
});

// AUTH
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (user && bcrypt.compareSync(password, user.passwordHash)) { req.session.user = { username: user.username, role: user.role }; return res.redirect('/admin'); }
  res.render('login', { error: 'Invalid creds' });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ADMIN CORE
app.get('/admin', isAuthenticated, async (req, res) => {
  res.render('admin', { data: await getDashboardData() });
});
app.get('/admin/setup', async (req, res) => {
  const { username, password } = req.query;
  const hash = bcrypt.hashSync(password || 'password123', 10);
  await User.findOneAndUpdate({ username: username || 'sensei' }, { passwordHash: hash, role: 'admin' }, { upsert: true });
  res.send('Admin ready');
});

// ADMIN ACTIONS
app.get('/admin/add-ninja', isAuthenticated, (req, res) => res.render('add-ninja'));
app.post('/admin/add-ninja', isAuthenticated, async (req, res) => {
  await Ninja.create({ name: req.body.name.trim(), currentBelt: req.body.currentBelt, totalNinjaBucks: req.body.totalNinjaBucks });
  res.redirect('/admin');
});

app.get('/admin/buttons', isAuthenticated, async (req, res) => {
  const ninjas = await Ninja.find({ isActive: true }).sort({ name: 1 });
  res.render('buttons', { ninjas });
});

app.get('/admin/update-progress', isAuthenticated, async (req, res) => res.render('update-progress', { ninjas: await Ninja.find({ isActive: true }).sort({ name: 1 }) }));
app.post('/admin/ninjas/:id/update-belt', isAuthenticated, async (req, res) => {
  const n = await Ninja.findById(req.params.id);
  const old = n.currentBelt; 
  n.currentBelt = req.body.currentBelt; 
  await n.save();
  
  if (old !== n.currentBelt) {
    const notes = req.body.notes || 'Manual Update';
    await Promise.all([
      ProgressLog.create({ ninjaName: n.name, oldBelt: old, newBelt: n.currentBelt, notes, discordPosted: true }),
      sendDiscordNotification(n.name, old, n.currentBelt, notes),
      pushBeltToSheets(n.name, old, n.currentBelt, notes).catch(e => console.error('[Sheets] Belt push failed:', e.message))
    ]);
  }
  res.json({ success: true });
});

app.get('/admin/nb-log', isAuthenticated, async (req, res) => res.render('nb-log', { logs: await NBLog.find({ isArchived: req.query.archived === 'true' }).sort({ date: -1 }).limit(100), archived: req.query.archived === 'true' }));
app.post('/admin/archive-logs', isAuthenticated, async (req, res) => { await NBLog.updateMany({ isArchived: false }, { isArchived: true }); res.json({ success: true }); });

app.get('/admin/inactive', isAuthenticated, async (req, res) => res.render('inactive', { ninjas: await Ninja.find({ isActive: false }).sort({ name: 1 }) }));
app.post('/admin/ninjas/:id/toggle-active', isAuthenticated, async (req, res) => {
  const n = await Ninja.findById(req.params.id); n.isActive = !n.isActive; await n.save();
  res.json({ success: true });
});

app.get('/admin/boss-battle', isAuthenticated, async (req, res) => res.render('boss-battle', { data: await getDashboardData() }));
app.post('/admin/boss-battle/update', isAuthenticated, async (req, res) => {
  const d = await getDashboardData();
  d.bossHP = req.body.bossHP; 
  d.bossMaxHP = req.body.bossMaxHP; 
  d.bossName = req.body.bossName; 
  d.bossImage = req.body.bossImage || '/img/cn_logo.png';
  d.bossActive = req.body.bossActive === 'on';
  d.backgroundImage = req.body.backgroundImage || d.backgroundImage;
  await d.save(); res.redirect('/admin/boss-battle');
});

app.get('/admin/backups', isAuthenticated, async (req, res) => {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
  const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort().reverse();
  res.render('backups', { backups: files });
});

app.post('/admin/backups/restore', isAuthenticated, async (req, res) => {
  try {
    const { filename } = req.body;
    const backupPath = path.join(__dirname, 'backups', filename);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });
    
    const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    
    // Safety: Backup current state before restoring an old one
    await createDatabaseBackup();
    
    await Ninja.deleteMany({});
    await NBLog.deleteMany({});
    await ProgressLog.deleteMany({});
    await HallOfFame.deleteMany({});
    
    if (data.ninjas) await Ninja.insertMany(data.ninjas);
    if (data.logs) await NBLog.insertMany(data.logs);
    if (data.progressLogs) await ProgressLog.insertMany(data.progressLogs);
    if (data.hallOfFame) await HallOfFame.insertMany(data.hallOfFame);
    if (data.dashboard) await Dashboard.findOneAndUpdate({}, data.dashboard, { upsert: true });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/backups/rename', isAuthenticated, async (req, res) => {
  try {
    const { oldFilename, newFilename } = req.body;
    const oldPath = path.join(__dirname, 'backups', oldFilename);
    let targetName = newFilename.endsWith('.json') ? newFilename : newFilename + '.json';
    const newPath = path.join(__dirname, 'backups', targetName);
    
    if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'Backup not found' });
    if (fs.existsSync(newPath)) return res.status(400).json({ error: 'Name already exists' });
    
    // Copy then delete is often more stable on synced drives like OneDrive
    fs.copyFileSync(oldPath, newPath);
    
    // Tiny delay before deleting the old one to let OneDrive catch up
    setTimeout(() => {
      try { fs.unlinkSync(oldPath); } catch(e) {}
    }, 500);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/backups/delete', isAuthenticated, async (req, res) => {
  try {
    const { filename } = req.body;
    const backupPath = path.join(__dirname, 'backups', filename);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });
    
    fs.unlinkSync(backupPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Global status for background migration
let migrationStatus = { active: false, progress: 0, message: 'Ready', results: null, error: null };

app.get('/admin/migration-status', isAuthenticated, (req, res) => {
  res.json(migrationStatus);
});

app.post('/admin/migrate-database', isAuthenticated, async (req, res) => {
  if (migrationStatus.active) return res.status(400).json({ error: 'Migration already in progress.' });

  const wipe = req.body.wipe === true;
  migrationStatus = { active: true, progress: 0, message: 'Initializing...', results: null, error: null };
  res.json({ success: true, started: true });

  (async () => {
    try {
      migrationStatus.message = 'Creating safety backup...';
      const backupFile = await createDatabaseBackup();

      if (wipe) {
        migrationStatus.message = 'Clearing existing data...';
        await Ninja.deleteMany({});
        await NBLog.deleteMany({});
        await ProgressLog.deleteMany({});
        await HallOfFame.deleteMany({});
      }

      const parse = (p) => new Promise(res => { 
        const r=[]; if(!fs.existsSync(p)) return res([]); 
        fs.createReadStream(p).pipe(csv({ headers: false })).on('data',d=>r.push(d)).on('end',()=>res(r)); 
      });

      const ninjaRowsRaw = await parse(path.join(__dirname, 'sheets/Ninja Database 2026 - data.csv'));
      const progRowsRaw = await parse(path.join(__dirname, 'sheets/Ninja Database 2026 - Progress.csv'));
      
      const ninjaRows = ninjaRowsRaw.slice(1); 
      const progRows = progRowsRaw.slice(1); 

      migrationStatus.message = 'Migrating Ninjas...';
      if (ninjaRows.length > 0) {
        const ninjaOps = ninjaRows.map(n => {
          const name = n[0]?.trim();
          if (!name || name === 'Ninjas' || name === 'Leaderboard' || name.length > 30) return null;
          
          const pRow = progRows.find(pr => pr[0]?.trim() === name);
          let beltValue = 'White';
          if (pRow) {
            const oldBelt = pRow[1]?.trim() || 'White';
            
            // Logic: Determine current rank based on the first FALSE degree column
            const isT = (idx) => pRow[idx]?.trim().toUpperCase() === 'TRUE';

            if (oldBelt === 'White') {
              if (isT(2)) beltValue = 'Yellow';
              else beltValue = 'White';
            } else if (oldBelt === 'Yellow') {
              if (isT(4)) beltValue = 'Green';
              else beltValue = 'Orange';
            } else if (oldBelt === 'Orange') {
              if (isT(8)) beltValue = 'Purple';
              else beltValue = 'Blue';
            } else if (oldBelt === 'Green') {
              beltValue = 'Brown';
            } else if (oldBelt === 'Blue') {
              if (isT(14)) beltValue = 'Black';
              else beltValue = 'Red';
            } else if (oldBelt === 'Purple') {
              beltValue = 'Bronze';
            } else if (oldBelt === 'Brown') {
              beltValue = 'Silver';
            } else if (oldBelt === 'Red') {
              beltValue = 'Platinum';
            } else if (oldBelt === 'Black') {
              beltValue = 'Gold';
            } else if (oldBelt === 'Finished Black Belt') {
               beltValue = 'Going Gold';
            }
          }

          return {
            updateOne: {
              filter: { name },
              update: { 
                totalNinjaBucks: parseInt(n[1]?.toString().replace(/,/g,'')) || 0,
                currentBelt: beltValue,
                isActive: true 
              },
              upsert: true
            }
          };
        }).filter(Boolean);
        if (ninjaOps.length > 0) await Ninja.bulkWrite(ninjaOps);
      }
      migrationStatus.progress = 30;

      const migrateLogs = async (filename, isArchived, startProgress, endProgress) => {
        const rows = await parse(path.join(__dirname, 'sheets', filename));
        if (rows.length === 0) return 0;
        
        let headerRowFound = false;
        const logs = rows.map((r, idx) => {
          let name, action, amount, date;
          const isMainLog = /NB Log\.csv$/i.test(filename);

          if (isMainLog) {
            if (r[0] === 'Date' || r[1] === 'Ninja') { headerRowFound = true; return null; }
            if (!headerRowFound) {
              name = r[0]; amount = parseInt(r[1]) || 0; action = 'Monthly Award'; date = new Date();
            } else {
              date = r[0] ? new Date(r[0]) : new Date(); name = r[1]; action = r[2] || 'Session Award'; amount = parseInt(r[3]?.toString().replace(/[+ ]/g,'')) || 0;
            }
          } else {
            if (idx === 0) return null; 
            name = r[1]; action = r[2] || 'Legacy'; amount = parseInt(r[3]?.toString().replace(/[+ ]/g,'')) || 0; date = r[0] ? new Date(r[0]) : new Date();
          }

          if (!name || name === 'Leaderboard' || name === 'Ninja' || name === 'Date' || name.length > 30) return null;
          if (name.toUpperCase() === 'TRUE' || name.toUpperCase() === 'FALSE') return null;
          return { ninjaName: name.trim(), buttonAction: action, amount: amount, date: isNaN(date.getTime()) ? new Date() : date, isArchived };
        }).filter(Boolean);

        if (logs.length > 0) {
          for (let i = 0; i < logs.length; i += 500) {
            await NBLog.insertMany(logs.slice(i, i + 500));
            migrationStatus.progress = startProgress + Math.floor((i / logs.length) * (endProgress - startProgress));
          }
        }
        return logs.length;
      };

      const activeCount = await migrateLogs('Ninja Database 2026 - NB Log.csv', false, 30, 50);
      const oldCount = await migrateLogs('Ninja Database 2026 - Old NB Logs.csv', true, 50, 80);
      
      // 3. Migrate Progress Log
      migrationStatus.message = 'Migrating Progress Log...';
      const progLogRows = await parse(path.join(__dirname, 'sheets/Ninja Database 2026 - Progress Log.csv'));
      if (progLogRows.length > 0) {
        const pLogs = [];
        for (let i = 2; i < progLogRows.length; i++) {
          const r = progLogRows[i];
          const parseSet = (dateIdx, nameIdx, beltIdx) => {
            const dateStr = r[dateIdx];
            const name = r[nameIdx]?.trim();
            if (!dateStr || !name || name.toUpperCase() === 'TRUE' || name.toUpperCase() === 'FALSE' || name.startsWith('Post to')) return null;
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return null;
            
            const beltInfo = r[beltIdx] || '';
            const degreeInfo = r[beltIdx + 1] || 'First Degree';
            const parts = beltInfo.split('->');
            
            const rawOld = parts[0].trim();
            const rawNew = parts.length > 1 ? parts[1].trim() : parts[0].trim();

            return {
              ninjaName: name,
              oldBelt: getNewBelt(rawOld, ''),
              newBelt: getNewBelt(rawNew, degreeInfo),
              notes: degreeInfo,
              date: date,
              isArchived: true,
              discordPosted: r[beltIdx + 2]?.trim().toUpperCase() === 'TRUE',
              rowNumber: i + 1
            };
          };
          const log1 = parseSet(0, 1, 2); if (log1) pLogs.push(log1);
          const log2 = parseSet(6, 7, 8); if (log2) pLogs.push(log2);
        }
        if (pLogs.length > 0) await ProgressLog.insertMany(pLogs);
      }
      migrationStatus.progress = 100;
      migrationStatus.active = false;
      migrationStatus.message = 'Migration Complete!';
      migrationStatus.results = { ninjas: ninjaRows.length, logs: activeCount + oldCount };
      console.log('Migration background task finished.');

    } catch (err) {
      console.error('Background Migration Error:', err);
      migrationStatus.active = false;
      migrationStatus.error = err.message;
    }
  })();
});

// DASHBOARD EDITORS
app.get('/admin/dashboard-editor', isAuthenticated, async (req, res) => res.render('dashboard-editor', { data: await getDashboardData() }));
app.post('/admin/update-dashboard', isAuthenticated, upload.any(), async (req, res) => {
  const d = await getDashboardData(); const b = req.body;
  const procList = (prefix, fields) => {
    const list = [];
    Object.keys(b).filter(k => k.startsWith(`${prefix}_${fields[0]}_`)).forEach(k => {
      const id = k.split('_').pop();
      const obj = {};
      fields.forEach(f => obj[f] = b[`${prefix}_${f}_${id}`]);
      list.push(obj);
    });
    return list;
  };
  d.activitiesThisWeek = procList('activitiesThisWeek', ['desc', 'url', 'link']).map(a => ({ description: a.desc, image: a.url, link: a.link }));
  d.activitiesNextWeek = procList('activitiesNextWeek', ['desc', 'url', 'link']).map(a => ({ description: a.desc, image: a.url, link: a.link }));
  d.ninjasOfTheMonth = procList('notm', ['name', 'type', 'image']);
  d.notmMonth = b.notmMonth; d.notmColor = b.notmColor; d.funFact = b.funFact; d.senseiOfMonth = b.senseiOfMonth;
  d.theme = b.theme; d.senseiVotingLink = b.senseiVotingLink;
  d.backgroundImage = b.backgroundImage || '';
  await d.save(); res.redirect('/admin/dashboard-editor');
});

app.get('/admin/ninjabucks-editor', isAuthenticated, async (req, res) => res.render('ninjabucks-editor', { data: await getDashboardData() }));
app.post('/admin/update-ninjabucks-config', isAuthenticated, async (req, res) => {
  const d = await getDashboardData();
  d.spreadsheetId = req.body.spreadsheetId;
  d.mainSpreadsheetId = req.body.mainSpreadsheetId;
  d.spreadsheetRange = req.body.spreadsheetRange;
  await d.save();
  res.redirect('/admin/ninjabucks-editor');
});

app.get('/admin/shop-editor', isAuthenticated, async (req, res) => res.render('shop-editor', { data: await getDashboardData() }));
app.post('/admin/update-shop', isAuthenticated, async (req, res) => {
  const d = await getDashboardData(); const b = req.body; const s=[]; let k=0;
  while(b[`shop_name_${k}`]!==undefined){ s.push({ name: b[`shop_name_${k}`], price: parseInt(b[`shop_price_${k}`])||0, category: b[`shop_category_${k}`], outOfStock: b[`shop_outOfStock_${k}`]==='on', image: b[`shop_image_${k}`]||'bi-box-seam' }); k++; }
  d.shopItems = s; await d.save(); res.redirect('/admin/shop-editor');
});

// ── NB Totals Reconcile ───────────────────────────────────────────────────────
app.get('/admin/sync-totals', isAuthenticated, async (req, res) => {
  const d = await getDashboardData();
  const ninjas = await Ninja.find({ isActive: true }).sort({ name: 1 });
  let sheetsData = [];

  if (d.mainSpreadsheetId) {
    const sheets = await getSheetClient();
    if (sheets) {
      try {
        const r = await sheets.spreadsheets.values.get({ spreadsheetId: d.mainSpreadsheetId, range: 'data!A:F' });
        sheetsData = (r.data.values || []).slice(1).map(row => ({ name: row[0]?.trim(), total: parseInt(row[5]) || 0 })).filter(r => r.name);
      } catch(e) { console.error('sync-totals read error:', e.message); }
    }
  }

  const rows = ninjas.map(n => {
    const s = sheetsData.find(r => r.name.toLowerCase() === n.name.toLowerCase());
    return { id: n._id, name: n.name, mongo: n.totalNinjaBucks, sheets: s?.total ?? null, diff: s ? n.totalNinjaBucks - s.total : null };
  });

  res.render('sync-totals', { rows, hasSheets: !!d.mainSpreadsheetId });
});

app.post('/admin/sync-totals', isAuthenticated, async (req, res) => {
  const { direction } = req.body; // 'mongo-to-sheets' or 'sheets-to-mongo'
  const d = await getDashboardData();
  if (!d.mainSpreadsheetId) return res.status(400).json({ error: 'No operational spreadsheet configured' });

  const sheets = await getSheetClient();
  if (!sheets) return res.status(500).json({ error: 'Sheets auth failed' });

  try {
    const [ninjas, sheetRes] = await Promise.all([
      Ninja.find({ isActive: true }),
      sheets.spreadsheets.values.get({ spreadsheetId: d.mainSpreadsheetId, range: 'data!A:F' })
    ]);
    const sheetRows = (sheetRes.data.values || []).slice(1);
    let synced = 0;

    if (direction === 'mongo-to-sheets') {
      for (const ninja of ninjas) {
        const rowIdx = sheetRows.findIndex(r => r[0]?.trim().toLowerCase() === ninja.name.toLowerCase());
        if (rowIdx === -1) continue;
        await sheets.spreadsheets.values.update({
          spreadsheetId: d.mainSpreadsheetId, range: `data!F${rowIdx + 2}`,
          valueInputOption: 'RAW', requestBody: { values: [[ninja.totalNinjaBucks]] }
        });
        synced++;
      }
    } else if (direction === 'sheets-to-mongo') {
      for (const row of sheetRows) {
        const name = row[0]?.trim();
        const total = parseInt(row[5]) || 0;
        if (!name) continue;
        const result = await Ninja.findOneAndUpdate({ name }, { totalNinjaBucks: total });
        if (result) synced++;
      }
    }

    res.json({ success: true, synced });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

app.get('/admin/ninja-bucks-award', isAuthenticated, async (req, res) => res.render('ninja-bucks-award', { leaderboard: (await getDashboardData()).leaderboard }));
app.post('/admin/update-ninja-bucks', isAuthenticated, async (req, res) => {
  const d = await getDashboardData();
  const { ninjaName, amount, reason } = req.body;
  const parsedAmount = parseInt(amount);
  const n = d.leaderboard.find(x => x.name === ninjaName);
  if (!n) return res.status(404).json({ error: 'Not found in leaderboard' });

  n.total += parsedAmount; d.markModified('leaderboard');
  // n.total is already the new value — do NOT add parsedAmount again

  await Promise.all([
    d.save(),
    NBLog.create({ ninjaName, buttonAction: reason, amount: parsedAmount }),
    Ninja.findOneAndUpdate({ name: ninjaName }, { $inc: { totalNinjaBucks: parsedAmount } }, { new: true }),
    pushNBToSheets(ninjaName, parsedAmount, reason, n.total).catch(e => console.error('[Sheets] NB push failed:', e.message))
  ]);

  res.json({ success: true, newTotal: n.total });
});

app.post('/admin/nb-log/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const log = await NBLog.findById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log not found' });

    // Refund the bucks from the Ninja document
    let newNinjaTotal = 0;
    const ninja = await Ninja.findOne({ name: log.ninjaName });
    if (ninja) {
      ninja.totalNinjaBucks = Math.max(0, ninja.totalNinjaBucks - log.amount);
      await ninja.save();
      newNinjaTotal = ninja.totalNinjaBucks;
    }

    // Update the leaderboard cache
    const d = await getDashboardData();
    const n = d.leaderboard.find(x => x.name === log.ninjaName);
    if (n) { n.total -= log.amount; d.markModified('leaderboard'); await d.save(); }

    // Delete from MongoDB then sync the deletion to Sheets
    await NBLog.findByIdAndDelete(req.params.id);
    await deleteFromNBLogSheet(log.ninjaName, log.amount, log.buttonAction, newNinjaTotal);

    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/nb-log/update-damage/:id', isAuthenticated, async (req, res) => {
  try {
    const log = await NBLog.findById(req.params.id);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    const d = await getDashboardData();
    const oldDmg = log.damageDealt || 0;
    const newDmg = parseInt(req.body.damageDealt) || 0;
    d.bossHP = Math.max(0, Math.min(d.bossMaxHP, d.bossHP + oldDmg - newDmg));
    log.damageDealt = newDmg;
    await Promise.all([
      d.save(),
      log.save(),
      pushDamageToSheets(log.ninjaName, log.amount, log.buttonAction, newDmg)
    ]);
    res.json({ success: true, newHP: d.bossHP });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/progress-log/delete/:id', isAuthenticated, async (req, res) => {
  try {
    const log = await ProgressLog.findById(req.params.id); if (!log) return res.status(404).json({ error: 'Log not found' });
    const ninja = await Ninja.findOne({ name: log.ninjaName });
    if (ninja && ninja.currentBelt === log.newBelt && log.oldBelt) { ninja.currentBelt = log.oldBelt; await ninja.save(); }
    await ProgressLog.findByIdAndDelete(req.params.id); res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/progress-log/post-discord', isAuthenticated, async (req, res) => {
  try {
    const logs = await ProgressLog.find({ discordPosted: false });
    for (const log of logs) { await sendDiscordNotification(log.ninjaName, log.oldBelt, log.newBelt, log.notes); log.discordPosted = true; await log.save(); }
    res.json({ success: true, count: logs.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/test-webhook', isAuthenticated, async (req, res) => {
  const steps = [];
  const step = (label, ok, detail) => steps.push({ label, ok, detail: detail || null });

  // 1. Secret configured on Vercel?
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  step('SHEETS_WEBHOOK_SECRET set on Vercel', !!secret,
    secret ? `Configured (${secret.length} chars) — make sure WEBHOOK_SECRET in Apps Script Script Properties matches exactly`
           : 'NOT SET — go to Vercel → Settings → Environment Variables and add SHEETS_WEBHOOK_SECRET');
  if (!secret) return res.json({ steps, success: false });

  // 2. Grab a real ninja to test with
  const d = await getDashboardData();
  const testNinja = d.leaderboard?.[0];
  step('Leaderboard has ninjas to test with', !!testNinja,
    testNinja ? `Will test with: "${testNinja.name}"` : 'Leaderboard empty — visit /ninjabucks to sync from Sheets first');
  if (!testNinja) return res.json({ steps, success: false });

  // 3. Run the exact same logic the webhook handler runs
  try {
    const ninjaName = testNinja.name;
    await Promise.all([
      NBLog.create({ ninjaName, buttonAction: 'Webhook Test', amount: 1 }),
      Ninja.findOneAndUpdate({ name: ninjaName }, { $inc: { totalNinjaBucks: 1 } })
    ]);
    const n = d.leaderboard.find(x => x.name === ninjaName);
    if (n) { n.total += 1; d.markModified('leaderboard'); await d.save(); }
    step('Webhook handler logic works', true, `+1 NB logged for "${ninjaName}" — check NB Log to confirm the entry appeared`);
    return res.json({ steps, success: true, testedNinja: ninjaName });
  } catch(e) {
    step('Webhook handler logic works', false, e.message);
    return res.json({ steps, success: false });
  }
});

app.get('/admin/test-sheets', isAuthenticated, async (req, res) => {
  const steps = [];
  const step = (label, ok, detail) => steps.push({ label, ok, detail: detail || null });

  try {
    // 1. Credentials present?
    const hasEnv = !!process.env.GOOGLE_CREDENTIALS;
    const hasFile = fs.existsSync(path.join(__dirname, 'credentials.json'));
    step('Credentials found', hasEnv || hasFile, hasEnv ? 'env var (GOOGLE_CREDENTIALS)' : hasFile ? 'credentials.json file' : 'neither found');
    if (!hasEnv && !hasFile) return res.json({ steps, success: false });

    // 2. Credentials JSON valid?
    if (hasEnv) {
      try { JSON.parse(process.env.GOOGLE_CREDENTIALS); step('Credentials JSON parseable', true); }
      catch(e) { step('Credentials JSON parseable', false, e.message); return res.json({ steps, success: false }); }
    }

    // 3. Can we build the Sheets client?
    const sheets = await getSheetClient();
    step('Sheets client created', !!sheets);
    if (!sheets) return res.json({ steps, success: false });

    const d = await getDashboardData();

    // 4. Main (operational) spreadsheet ID configured?
    step('Main spreadsheet ID configured', !!d.mainSpreadsheetId,
      d.mainSpreadsheetId || 'not set — paste the ID of the spreadsheet that has NB Log, data, Progress sheets');
    if (!d.mainSpreadsheetId) return res.json({ steps, success: false });

    // 5. Main spreadsheet accessible + has required sheets?
    try {
      const info = await sheets.spreadsheets.get({ spreadsheetId: d.mainSpreadsheetId });
      const sheetNames = info.data.sheets.map(s => s.properties.title);
      step('Main spreadsheet accessible', true, `"${info.data.properties.title}" — sheets: ${sheetNames.join(', ')}`);

      const required = ['NB Log', 'data', 'Progress', 'Progress Log'];
      const missing = required.filter(n => !sheetNames.includes(n));
      step('Required sheets present', missing.length === 0,
        missing.length ? `Missing: ${missing.join(', ')} — found: ${sheetNames.join(', ')}` : `All found: ${required.join(', ')}`
      );
      if (missing.length) return res.json({ steps, success: false });

      // 6. Test an actual write (append then immediately clear a test row)
      try {
        const testRow = [`[TEST ${Date.now()}]`, 'DiagnosticCheck', 'Connection Test', '+0'];
        const appendRes = await sheets.spreadsheets.values.append({
          spreadsheetId: d.mainSpreadsheetId, range: 'NB Log!A9:D',
          valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [testRow] }
        });
        const writtenRange = appendRes.data.updates?.updatedRange;
        if (writtenRange) {
          await sheets.spreadsheets.values.clear({ spreadsheetId: d.mainSpreadsheetId, range: writtenRange });
        }
        step('Write permission confirmed', true, writtenRange ? `Wrote and cleared ${writtenRange}` : 'Write succeeded');
      } catch(e) {
        step('Write permission confirmed', false, e.message.includes('403') ? '403 — service account has read-only access, needs Editor role' : e.message);
        return res.json({ steps, success: false });
      }

      return res.json({ steps, success: true });
    } catch(e) {
      step('Main spreadsheet accessible', false,
        e.message.includes('403') ? '403 Forbidden — share this spreadsheet with your service account email' : e.message);
      return res.json({ steps, success: false });
    }
  } catch(e) {
    step('Unexpected error', false, e.message);
    return res.json({ steps, success: false });
  }
});

app.get('/admin/notm-archive-editor', isAuthenticated, async (req, res) => {
  const archive = await HallOfFame.find({}).sort({ year: -1, _id: -1 });
  res.render('notm-archive-editor', { data: await getDashboardData(), archive });
});
app.post('/admin/hall-of-fame/delete/:id', isAuthenticated, async (req, res) => {
  try {
    await HallOfFame.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/admin/ninjas/:id/delete', isAuthenticated, async (req, res) => {
  try {
    await Ninja.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get('/admin/master-data', isAuthenticated, async (req, res) => res.render('master-data', { ninjas: await Ninja.find({}).sort({ name: 1 }) }));
app.get('/admin/progress-matrix', isAuthenticated, async (req, res) => res.render('progress-matrix', { ninjas: await Ninja.find({ isActive: true }).sort({ name: 1 }) }));
app.get('/admin/progress-log', isAuthenticated, async (req, res) => res.render('progress-log', { logs: await ProgressLog.find({}).sort({ date: -1 }).limit(100) }));

app.post('/admin/archive-month', isAuthenticated, async (req, res) => {
  try {
    const d = await getDashboardData();
    await HallOfFame.create({ month: d.notmMonth, year: new Date().getFullYear(), ninjaOfTheMonth: d.ninjasOfTheMonth.map(n => n.name).join(', '), senseiOfTheMonth: d.senseiOfMonth });
    d.notmArchive = d.notmArchive || [];
    d.notmArchive.unshift({ month: d.notmMonth, color: d.notmColor, ninjas: d.ninjasOfTheMonth, dateArchived: new Date() });
    d.markModified('notmArchive');
    await d.save();
    res.json({ success: true });
  } catch (error) { res.status(500).send(error.message); }
});

app.use((err, req, res, next) => { console.error(err); res.status(500).send(err.message); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on http://localhost:${PORT}`));
module.exports = app;
