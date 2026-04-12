require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const mongoose = require('mongoose');
const Dashboard = require('./models/Dashboard');
const User = require('./models/User');

const app = express();

// Database Connection Helper
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI environment variable is missing!');
    return;
  }
  try {
    const db = await mongoose.connect(MONGODB_URI);
    isConnected = db.connections[0].readyState;
    console.log('Connected to MongoDB!');
    
    // One-time migration logic
    const userCount = await User.countDocuments();
    const jsonPath = path.join(__dirname, 'data/users.json');
    if (userCount === 0 && fs.existsSync(jsonPath)) {
      console.log('Migrating users from users.json to MongoDB...');
      const users = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      await User.insertMany(users);
    }
  } catch (err) {
    console.error('Database connection error:', err.message);
  }
};

// Middleware (applied to all requests)
app.use(async (req, res, next) => {
  await connectDB();
  next();
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

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'ninja-secret-key-123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

// Set EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Database Helpers (Replacing JSON file helpers)
const getDashboardData = async () => {
  let data = await Dashboard.findOne();
  if (!data) {
    // Migrate from JSON if it exists, otherwise create new
    const dataDir = path.join(__dirname, 'data');
    const jsonPath = path.join(dataDir, 'dashboard.json');
    if (fs.existsSync(dataDir) && fs.existsSync(jsonPath)) {
      console.log('Migrating data from dashboard.json to MongoDB...');
      try {
        const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        data = await Dashboard.create(jsonData);
      } catch (err) {
        console.error('Migration failed, creating empty dashboard:', err.message);
        data = await Dashboard.create({});
      }
    } else {
      data = await Dashboard.create({});
    }
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
  
  if (fs.existsSync(credPath)) {
    authConfig.keyFile = credPath;
  } else if (process.env.GOOGLE_CREDENTIALS) {
    // If no file, parse the JSON from environment variable directly
    try {
      const creds = process.env.GOOGLE_CREDENTIALS.trim();
      // Simple check to see if it's JSON or a path
      if (creds.startsWith('{')) {
        authConfig.credentials = JSON.parse(creds);
      } else {
        console.error('GOOGLE_CREDENTIALS env var does not look like JSON');
        return 0;
      }
    } catch (e) {
      console.error('Error parsing GOOGLE_CREDENTIALS env var:', e.message);
      return 0;
    }
  } else {
    // Silent fail if no credentials found to avoid crashing Vercel
    console.warn('Google Credentials not found (file or env var). Skipping sync.');
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
        let name, total;
        if (row.length >= 3) { name = row[1]; total = row[2]; }
        else { name = row[0]; total = row[1]; }

        if (!name || name.toLowerCase().trim() === 'ninja name') return null;

        return {
          name: name.trim(),
          total: parseInt(total ? total.toString().replace(/,/g, '') : '0') || 0,
          monthly: 0
        };
      })
      .filter(n => n !== null);

    data.leaderboard = fullData;
    data.lastUpdated = new Date();
    await data.save();
    return fullData.length;
  } catch (err) {
    console.error('Google Sheets Sync Error:', err.message);
    return 0;
  }
};

// --- ROUTES ---

// Ninja Bucks Full List (Publicly accessible)
app.get('/ninjabucks', async (req, res) => {
  try {
    const data = await getDashboardData();
    // Auto-sync on every visit
    await syncGoogleSheets(data);
  } catch (error) {
    console.error('Auto-sync failed on page visit:', error.message);
  }
  
  const data = await getDashboardData();
  res.render('ninjabucks', { 
    leaderboard: data.leaderboard || [],
    theme: data.theme || 'classic',
    user: req.session.user
  });
});

// Public Kid Dashboard
app.get('/', async (req, res) => {
  const data = await getDashboardData();
  res.render('dashboard', data);
});

// Auth Middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.user) return next();
  res.redirect('/login');
};

// Sync Leaderboard from Google Sheets (Manual Trigger)
app.post('/admin/sync-leaderboard', isAuthenticated, async (req, res) => {
  try {
    const data = await getDashboardData();
    const count = await syncGoogleSheets(data);
    res.json({ success: true, count });
  } catch (error) {
    console.error('Manual Spreadsheet Sync Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin Panel
app.get('/admin', isAuthenticated, (req, res) => {
  res.render('admin');
});

// Dashboard Editor
app.get('/admin/dashboard-editor', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  res.render('dashboard-editor', { data });
});

// Ninja Bucks Editor
app.get('/admin/ninjabucks-editor', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  res.render('ninjabucks-editor', { data });
});

// Update Ninja Bucks Config
app.post('/admin/update-ninjabucks-config', isAuthenticated, async (req, res) => {
  const data = await getDashboardData();
  const { spreadsheetId, spreadsheetRange } = req.body;
  
  data.spreadsheetId = spreadsheetId || data.spreadsheetId;
  data.spreadsheetRange = spreadsheetRange || data.spreadsheetRange;
  
  await data.save();
  res.redirect('/admin/ninjabucks-editor');
});

// Update Dashboard Logic
app.post('/admin/update-dashboard', isAuthenticated, upload.any(), async (req, res) => {
  const data = await getDashboardData();
  const body = req.body;
  const files = req.files;

  const getFile = (fieldName) => {
    const file = files.find(f => f.fieldname === fieldName);
    return file ? `/uploads/${file.filename}` : null;
  };

  // Update Activities This Week
  const activitiesThisWeek = [];
  let i = 0;
  while (body[`activitiesThisWeek_desc_${i}`] !== undefined) {
    const act = {
      description: body[`activitiesThisWeek_desc_${i}`],
      link: body[`activitiesThisWeek_link_${i}`],
      image: data.activitiesThisWeek[i] ? data.activitiesThisWeek[i].image : "/img/cn_logo.png"
    };
    const urlImg = body[`activitiesThisWeek_url_${i}`];
    const newImg = getFile(`activitiesThisWeek_image_${i}`);
    if (urlImg) act.image = urlImg; else if (newImg) act.image = newImg;
    activitiesThisWeek.push(act);
    i++;
  }
  data.activitiesThisWeek = activitiesThisWeek;

  // Update Activities Next Week
  const activitiesNextWeek = [];
  let j = 0;
  while (body[`activitiesNextWeek_desc_${j}`] !== undefined) {
    const act = {
      description: body[`activitiesNextWeek_desc_${j}`],
      link: body[`activitiesNextWeek_link_${j}`],
      image: data.activitiesNextWeek[j] ? data.activitiesNextWeek[j].image : "/img/cn_logo.png"
    };
    const urlImg = body[`activitiesNextWeek_url_${j}`];
    const newImg = getFile(`activitiesNextWeek_image_${j}`);
    if (urlImg) act.image = urlImg; else if (newImg) act.image = newImg;
    activitiesNextWeek.push(act);
    j++;
  }
  data.activitiesNextWeek = activitiesNextWeek;

  data.specialEvents.forEach((event, idx) => {
    event.date = body[`specialEvents_date_${idx}`] || event.date;
    event.text = body[`specialEvents_text_${idx}`] || event.text;
  });

  data.notmMonth = body.notmMonth || data.notmMonth;
  data.notmColor = body.notmColor || data.notmColor;
  data.ninjasOfTheMonth.forEach((ninja, idx) => {
    ninja.name = body[`notm_name_${idx}`] || ninja.name;
    ninja.type = body[`notm_type_${idx}`] || ninja.type;
    ninja.image = `/img/notm/${ninja.type}.png`;
  });

  data.theme = body.theme || data.theme;
  data.funFact = body.funFact || data.funFact;
  data.senseiOfMonth = body.senseiOfMonth || data.senseiOfMonth;
  data.senseiVotingLink = body.senseiVotingLink || data.senseiVotingLink;

  await data.save();
  res.redirect('/admin/dashboard-editor');
});

// Auth Routes (Login)
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
    console.error('Login error:', error);
    res.render('login', { error: 'A server error occurred. Please try again.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });
}

module.exports = app;
