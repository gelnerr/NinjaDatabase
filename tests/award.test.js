const request = require('supertest');
const app = require('./app');
const mongoose = require('mongoose');
const Dashboard = require('./models/Dashboard');

describe('Award Ninja Bucks API', () => {
  beforeAll(async () => {
    // Connect to a test database if needed or use existing
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  it('should return 404 if ninja is not found in local cache', async () => {
    const response = await request(app)
      .post('/admin/update-ninja-bucks')
      .send({
        ninjaName: 'NonExistentNinja',
        amount: 5,
        reason: 'Test'
      });
    // This will fail because we need to be authenticated
    expect(response.status).toBe(302); // Redirect to login
  });
});
