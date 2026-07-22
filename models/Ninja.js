const mongoose = require('mongoose');

const ninjaSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  currentBelt: { 
    type: String, 
    enum: ['White', 'Yellow', 'Orange', 'Green', 'Blue', 'Purple', 'Brown', 'Red', 'Black', 'Bronze', 'Silver', 'Platinum', 'Gold', 'Going Gold'],
    default: 'White'
  },
  totalNinjaBucks: { type: Number, default: 0 },
  type: { type: String, enum: ['Create', 'Junior'], default: 'Create' },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastBeltUpdate: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ninja', ninjaSchema);
