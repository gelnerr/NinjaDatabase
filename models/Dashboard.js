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

const dashboardSchema = new mongoose.Schema({
  theme: { type: String, default: 'classic' },
  activitiesThisWeek: [activitySchema],
  activitiesNextWeek: [activitySchema],
  specialEvents: [specialEventSchema],
  notmMonth: String,
  notmColor: { type: String, default: '#358ebc' },
  ninjasOfTheMonth: [ninjaOfTheMonthSchema],
  funFact: String,
  senseiOfMonth: String,
  senseiVotingLink: String,
  spreadsheetId: String,
  spreadsheetRange: { type: String, default: 'Ninja Bucks!A2:C150' },
  leaderboard: Array,
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Dashboard', dashboardSchema);
