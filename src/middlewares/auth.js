const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  // Get token from header or query string parameter (important for media streams)
  let token = req.header('Authorization');
  
  if (token && token.startsWith('Bearer ')) {
    token = token.slice(7, token.length).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  // Check if no token
  if (!token) {
    return res.status(401).json({ message: 'No authorization token, access denied' });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecretjwtkey');
    
    // Verify user exists and is active
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'No user found with this token, access denied' });
    }

    if (user.isBlocked) {
      return res.status(403).json({ message: 'Your account has been blocked by the admin' });
    }

    req.user = { id: user._id, role: user.role, plan: user.subscription?.plan || 'free' };
    next();
  } catch (err) {
    console.error('JWT Token Verification Error:', err.message);
    return res.status(401).json({ message: 'Token is not valid or has expired' });
  }
};
