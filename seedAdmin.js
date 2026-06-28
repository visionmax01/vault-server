const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const User = require('./src/models/User');

const seedAdmin = async () => {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vault';
  
  console.log(`Connecting to MongoDB at ${mongoUri}...`);
  try {
    await mongoose.connect(mongoUri);
    console.log('Connected to database successfully.');

    const args = process.argv.slice(2);
    let email = 'admin@vault.com';
    let password = 'admin123';
    let name = 'System Admin';

    if (args.length > 0) {
      email = args[0].toLowerCase();
      if (args.length > 1) password = args[1];
      if (args.length > 2) name = args.slice(2).join(' ');
      console.log(`Seeding custom parameters:`);
      console.log(`  Email: ${email}`);
      if (args.length > 1) console.log(`  Password: [PROVIDED]`);
      if (args.length > 2) console.log(`  Name: ${name}`);
    } else {
      console.log(`No arguments provided. Defaulting to:`);
      console.log(`  Email: ${email}`);
      console.log(`  Password: ${password}`);
      console.log(`  Name: ${name}`);
      console.log(`\nTo customize, run: node seedAdmin.js <email> [password] [name]`);
    }

    // Check if user already exists
    let user = await User.findOne({ email });

    if (user) {
      console.log(`\nUser found with email: ${email}`);
      console.log(`Current role: ${user.role}`);
      if (user.role === 'admin') {
        console.log(`User is already an administrator.`);
      } else {
        user.role = 'admin';
        await user.save();
        console.log(`User promoted to admin successfully.`);
      }
    } else {
      console.log(`\nUser not found. Creating new admin user...`);
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      user = await User.create({
        name,
        email,
        password: hashedPassword,
        role: 'admin',
        storageLimit: 10 * 1024 * 1024 * 1024, // 10 GB for admin
        subscription: {
          plan: 'platinum',
          billing: 'yearly',
          expiresAt: null
        }
      });
      console.log(`Admin user created successfully!`);
    }

    console.log('\nAdmin details:');
    console.log(`ID: ${user._id}`);
    console.log(`Name: ${user.name}`);
    console.log(`Email: ${user.email}`);
    console.log(`Role: ${user.role}`);
    console.log(`Blocked: ${user.isBlocked}`);

  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
};

seedAdmin();
