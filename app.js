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
const Dashboard = require('./models/Dashboard');
const User = require('./models/User');

const app = express();

// Database Connection Helper (Lazy & Persistent)
let cachedDb = null;
const connectDB = async () => {
  if (cachedDb && mongoose.connection.readyState === 1) return cachedDb;
  
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is missing!');
  }

  if (MONGODB_URI.includes('<password>')) {
    throw new Error('MONGODB_URI still contains the <password> placeholder!');
  }

  console.log('Connecting to MongoDB...');
  try {
    cachedDb = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      bufferCommands: false,
    });
    console.log('Connected to MongoDB!');
    
    // One-time migration logic
    const userCount = await User.countDocuments();
    const jsonPath = path.join(__dirname, 'data/users.json');
    if (userCount === 0 && fs.existsSync(jsonPath)) {
      console.log('Migrating users from users.json to MongoDB...');
      const users = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      await User.insertMany(users);
    }
    
    return cachedDb;
  } catch (err) {
    console.error('Mongoose Connect Error:', err.message);
    throw err;
  }
};

// Middleware to ensure DB is connected
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB Connection Middleware Error:', err.message);
    res.status(500).send(`Database Connection Error: ${err.message}`);
  }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Serve bootstrap and bootstrap-icons from node_modules
app.use('/css', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/css')));
app.use('/js', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/js')));
app.use('/icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));

// Session setup with persistent MongoStore
// We use a getter or a fallback to handle MongoStore initialization variants
const mongoStoreInstance = (process.env.MONGODB_URI) ? MongoStore.create({
  mongoUrl: process.env.MONGODB_URI,
  ttl: 14 * 24 * 60 * 60,
  autoRemove: 'native'
}) : null;

app.use(session({
  secret: process.env.SESSION_SECRET || 'ninja-secret-key-123',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  store: mongoStoreInstance,
  cookie: { 
    maxAge: 1000 * 60 * 60 * 24,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Set EJS
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Database Helpers
const getDashboardData = async () => {
  let data = await Dashboard.findOne();
  if (!data) {
    data = await Dashboard.create({});
  }
  return data;
};

// Helper: Sync Google Sheets Data
const syncGoogleSheets = async (data) => {
  if (!data.spreadsheetId) return 0;

  let authConfig = {
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  };

  const credPath = path.join(__dirname, 'credentials.json');
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const creds = process.env.GOOGLE_CREDENTIALS.trim();
      if (creds.startsWith('{')) {
        authConfig.credentials = JSON.parse(creds);
      } else {
        console.error('GOOGLE_CREDENTIALS environment variable is not valid JSON.');
        return 0;
      }
    } catch (e) {
      console.error('Error parsing GOOGLE_CREDENTIALS:', e.message);
      return 0;
    }
  } else if (fs.existsSync(credPath)) {
    authConfig.keyFilename = credPath;
  } else {
    console.error('No Google credentials found (environment variable or credentials.json).');
    return 0;
  }

  try {
    const auth = new google.auth.GoogleAuth(authConfig);
    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: data.spreadsheetId,
      range: data.spreadsheetRange || 'Ninja Bucks!A2:C150',
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) return 0;

    const fullData = rows
      .filter(row => row.length >= 2)
      .map(row => {
        let name, total, monthly;
        if (row.length >= 3) {
          // If 3 columns: Name, Total, Monthly
          name = row[0];
          total = row[1];
          monthly = row[2];
        } else {
          // If only 2 columns: Name, Total
          name = row[0];
          total = row[1];
          monthly = 0;
        }

        if (!name || name.toLowerCase().trim() === 'ninja name') return null;

        return {
          name: name.trim(),
          total: parseInt(total ? total.toString().replace(/,/g, '') : '0') || 0,
          monthly: parseInt(monthly ? monthly.toString().replace(/,/g, '') : '0') || 0
        };
      })
      .filter(n => n !== null);

    data.leaderboard = fullData;

    // --- Sync Monthly Top Earners ---
    try {
      const monthlyResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: data.spreadsheetId,
        range: data.monthlyRange || 'Ninja Bucks!E2:F6',
      });
      const monthlyRows = monthlyResponse.data.values;
      if (monthlyRows && monthlyRows.length > 0) {
        data.monthlyLeaderboard = monthlyRows
          .filter(row => row.length >= 2)
          .map(row => ({
            name: row[0].trim(),
            monthly: parseInt(row[1] ? row[1].toString().replace(/,/g, '') : '0') || 0
          }));
      }
    } catch (monthlyErr) {
      console.error('Monthly Sync Error:', monthlyErr.message);
    }

    data.lastUpdated = new Date();
    await data.save();
    return fullData.length;
  } catch (err) {
    console.error('Google Sheets Sync Error:', err.message);
    return 0;
  }
};

// --- ROUTES ---

app.get('/ninjabucks', async (req, res) => {
  try {
    const data = await getDashboardData();
    await syncGoogleSheets(data);
    const updatedData = await getDashboardData();
    res.render('ninjabucks', { 
      leaderboard: updatedData.leaderboard || [],
      monthlyLeaderboard: updatedData.monthlyLeaderboard || [],
      theme: updatedData.theme || 'classic',
      user: req.session.user
    });
  } catch (error) {
    console.error('Ninjabucks page error:', error.message);
    res.status(500).send(`Internal Error: ${error.message}`);
  }
});

app.get('/shop', async (req, res) => {
  try {
    const data = await getDashboardData();
    // Only sync leaderboard if needed, shop is now manual
    await syncGoogleSheets(data);
    const updatedData = await getDashboardData();
    res.render('shop', { 
      shopItems: updatedData.shopItems || [],
      user: req.session.user
    });
  } catch (error) {
    console.error('Shop page error:', error.message);
    res.status(500).send(`Internal Error: ${error.message}`);
  }
});

app.get('/', async (req, res) => {
  try {
    const data = await getDashboardData();
    res.render('dashboard', data);
  } catch (error) {
    res.status(500).send(`Internal Error: ${error.message}`);
  }
});

// Auth Middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

// Emergency Setup Route
app.get('/admin/setup', async (req, res) => {
  try {
    const { username, password } = req.query;
    const targetUser = username || 'sensei';
    const targetPass = password || 'password123';
    
    const hashedPassword = bcrypt.hashSync(targetPass, 10);
    
    await User.findOneAndUpdate(
      { username: targetUser },
      { passwordHash: hashedPassword, role: 'admin' },
      { upsert: true, new: true }
    );

    let message = `User '${targetUser}' is ready. `;

    const dashboardCount = await Dashboard.countDocuments();
    if (dashboardCount === 0) {
      await Dashboard.create({ theme: 'classic' });
      message += "Default dashboard initialized. ";
    }
    
    res.send(`<h3>Setup Successful</h3><p>${message}</p><a href='/login'>Go to Login</a>`);
  } catch (error) {
    res.status(500).send("Setup failed: " + error.message);
  }
});

app.post('/admin/sync-leaderboard', isAuthenticated, async (req, res) => {
  try {
    const data = await getDashboardData();
    const count = await syncGoogleSheets(data);
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin', isAuthenticated, (req, res) => {
  res.render('admin');
});

app.get('/admin/dashboard-editor', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  res.render('dashboard-editor', { data });
});

app.get('/admin/ninjabucks-editor', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  res.render('ninjabucks-editor', { data });
});

app.post('/admin/update-ninjabucks-config', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  const { spreadsheetId, spreadsheetRange, monthlyRange, shopRange } = req.body;
  data.spreadsheetId = spreadsheetId || data.spreadsheetId;
  data.spreadsheetRange = spreadsheetRange || data.spreadsheetRange;
  data.monthlyRange = monthlyRange || data.monthlyRange;
  data.shopRange = shopRange || data.shopRange;
  await data.save();
  res.redirect('/admin/ninjabucks-editor');
});

app.get('/admin/shop-editor', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  res.render('shop-editor', { data });
});

app.post('/admin/update-shop', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  const body = req.body;
  
  const shopItems = [];
  let k = 0;
  while (body[`shop_name_${k}`] !== undefined) {
    shopItems.push({
      name: body[`shop_name_${k}`],
      price: parseInt(body[`shop_price_${k}`]) || 0,
      category: body[`shop_category_${k}`] || 'General'
    });
    k++;
  }
  data.shopItems = shopItems;
  await data.save();
  res.redirect('/admin/shop-editor');
});

app.post('/admin/update-dashboard', isAuthenticated, upload.any(), async (req, res) => {
  const data = await getDashboardData();
  const body = req.body;
  
  const activitiesThisWeek = [];
  let i = 0;
  while (body[`activitiesThisWeek_desc_${i}`] !== undefined) {
    const act = {
      description: body[`activitiesThisWeek_desc_${i}`],
      link: body[`activitiesThisWeek_link_${i}`],
      image: data.activitiesThisWeek[i] ? data.activitiesThisWeek[i].image : "/img/cn_logo.png"
    };
    if (body[`activitiesThisWeek_url_${i}`]) act.image = body[`activitiesThisWeek_url_${i}`];
    activitiesThisWeek.push(act);
    i++;
  }
  data.activitiesThisWeek = activitiesThisWeek;

  const activitiesNextWeek = [];
  let j = 0;
  while (body[`activitiesNextWeek_desc_${j}`] !== undefined) {
    const act = {
      description: body[`activitiesNextWeek_desc_${j}`],
      link: body[`activitiesNextWeek_link_${j}`],
      image: data.activitiesNextWeek[j] ? data.activitiesNextWeek[j].image : "/img/cn_logo.png"
    };
    if (body[`activitiesNextWeek_url_${j}`]) act.image = body[`activitiesNextWeek_url_${j}`];
    activitiesNextWeek.push(act);
    j++;
  }
  data.activitiesNextWeek = activitiesNextWeek;

  const specialEvents = [];
  let l = 0;
  while (body[`specialEvents_date_${l}`] !== undefined) {
    specialEvents.push({
      date: body[`specialEvents_date_${l}`],
      text: body[`specialEvents_text_${l}`]
    });
    l++;
  }
  data.specialEvents = specialEvents;

  data.notmMonth = body.notmMonth || data.notmMonth;
  data.notmColor = body.notmColor || data.notmColor;
  
  const ninjasOfTheMonth = [];
  let k = 0;
  while (body[`notm_name_${k}`] !== undefined) {
    ninjasOfTheMonth.push({
      name: body[`notm_name_${k}`],
      type: body[`notm_type_${k}`],
      image: `/img/notm/${body[`notm_type_${k}`]}.png`
    });
    k++;
  }
  data.ninjasOfTheMonth = ninjasOfTheMonth;

  data.theme = body.theme || data.theme;
  data.funFact = body.funFact || data.funFact;
  data.senseiOfMonth = body.senseiOfMonth || data.senseiOfMonth;
  data.senseiVotingLink = body.senseiVotingLink || data.senseiVotingLink;

  await data.save();
  res.redirect('/admin/dashboard-editor');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (user && bcrypt.compareSync(password, user.passwordHash)) {
      req.session.user = { username: user.username, role: user.role };
      return res.redirect('/admin');
    }
    res.render('login', { error: 'Invalid username or password' });
  } catch (error) {
    res.render('login', { error: `Auth Error: ${error.message}` });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Final error handler
app.use((err, req, res, next) => {
  console.error('Global Error:', err);
  res.status(500).send(`Something broke: ${err.message}`);
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
