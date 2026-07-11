const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  description: String,
  link: String,
  image: String
});

const specialEventSchema = new mongoose.Schema({
  date: String,
  text: String
});

const ninjaOfTheMonthSchema = new mongoose.Schema({
  name: String,
  type: String,
  image: String
});

const shopItemSchema = new mongoose.Schema({
  name: String,
  price: Number,
  moneyValue: { type: Number, default: 0 },
  category: String,
  outOfStock: { type: Boolean, default: false },
  image: { type: String, default: 'bi-box-seam' }
});

const dashboardSchema = new mongoose.Schema({
  theme: { type: String, default: 'classic' },
  activitiesThisWeek: [activitySchema],
  activitiesNextWeek: [activitySchema],
  specialEvents: [specialEventSchema],
  notmMonth: String,
  notmColor: { type: String, default: '#358ebc' },
  ninjasOfTheMonth: [ninjaOfTheMonthSchema],
  notmArchive: [{
    month: String,
    color: String,
    ninjas: [ninjaOfTheMonthSchema],
    dateArchived: { type: Date, default: Date.now }
  }],
  funFact: String,
  senseiOfMonth: String,
  senseiVotingLink: String,
  spreadsheetId: String,
  mainSpreadsheetId: String,
  spreadsheetRange: { type: String, default: 'Ninja Bucks!A2:C150' },
  monthlyRange: { type: String, default: 'Ninja Bucks!E2:F6' },
  shopRange: { type: String, default: 'Shop!A2:C50' },
  beltsTotemRange: { type: String, default: 'Belts Totem!A1:R100' },
  logRange: { type: String, default: 'Log!A2:D' },
  leaderboard: Array,
  monthlyLeaderboard: Array,
  beltsTotemData: Array,
  shopItems: [shopItemSchema],
  lastUpdated: { type: Date, default: Date.now },
  bossHP: { type: Number, default: 100 },
  bossMaxHP: { type: Number, default: 100 },
  bossName: { type: String, default: 'Dr. Worm' },
  bossImage: { type: String, default: '/img/cn_logo.png' },
  bossActive: { type: Boolean, default: false },
  backgroundImage: { type: String, default: '' },
  activityStartMinute: { type: Number, default: 45 }
});

module.exports = mongoose.model('Dashboard', dashboardSchema);
