const mongoose = require('mongoose');

const progressLogSchema = new mongoose.Schema({
  ninjaName: { type: String, required: true },
  oldBelt: String,
  newBelt: String,
  notes: String,
  date: { type: Date, default: Date.now },
  isArchived: { type: Boolean, default: false },
  rowNumber: { type: Number },
  discordPosted: { type: Boolean, default: false }
});

module.exports = mongoose.model('ProgressLog', progressLogSchema);
