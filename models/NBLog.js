const mongoose = require('mongoose');

const nbLogSchema = new mongoose.Schema({
  ninjaName: { type: String, required: true },
  buttonAction: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  isArchived: { type: Boolean, default: false },
  rowNumber: { type: Number },
  damageDealt: { type: Number, default: 0 }
});

module.exports = mongoose.model('NBLog', nbLogSchema);
