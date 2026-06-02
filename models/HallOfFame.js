const mongoose = require('mongoose');

const hallOfFameSchema = new mongoose.Schema({
  month: { type: String, required: true },
  year: { type: Number, required: true },
  ninjaOfTheMonth: { type: String },
  senseiOfTheMonth: { type: String },
  dateArchived: { type: Date, default: Date.now }
});

module.exports = mongoose.model('HallOfFame', hallOfFameSchema);
