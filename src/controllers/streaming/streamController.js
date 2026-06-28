const StreamRoom = require('../../models/StreamRoom');
const User = require('../../models/User');
const crypto = require('crypto');

// 1. Get active stream room for user
exports.getActiveStream = async (req, res) => {
  try {
    const owner = req.user.id;
    const { roomId } = req.query;

    let room;
    if (roomId) {
      room = await StreamRoom.findOne({ roomId, isActive: true });
    } else {
      room = await StreamRoom.findOne({ hostId: owner, isActive: true });
    }

    if (!room) {
      return res.json({ active: false });
    }
    const hostUser = await User.findById(room.hostId);
    return res.json({
      active: true,
      room: {
        roomId: room.roomId,
        title: room.title,
        fileUrl: room.fileUrl,
        fileId: room.fileId,
        isHost: room.hostId.toString() === owner,
        hostId: room.hostId,
        hostName: hostUser ? hostUser.name : 'Host'
      }
    });
  } catch (error) {
    console.error('Get active stream error:', error);
    return res.status(500).json({ message: 'Server error retrieving active stream' });
  }
};

// 2. Terminate active stream room for user
exports.terminateStream = async (req, res) => {
  try {
    const owner = req.user.id;
    const { terminateRoom } = require('../../sockets');

    const activeRooms = await StreamRoom.find({ hostId: owner, isActive: true });
    for (const r of activeRooms) {
      await terminateRoom(r.roomId);
    }
    // Safeguard to ensure any other lingering active rooms for this host are deactivated in DB
    await StreamRoom.updateMany({ hostId: owner, isActive: true }, { isActive: false });

    return res.json({ message: 'Stream room terminated successfully' });
  } catch (error) {
    console.error('Terminate stream error:', error);
    return res.status(500).json({ message: 'Server error terminating stream' });
  }
};

// 3. Get stream room history for host
exports.getStreamHistory = async (req, res) => {
  try {
    const owner = req.user.id;

    // Decryption helper using same key
    const ENCRYPTION_KEY = crypto.scryptSync(process.env.JWT_SECRET || 'supersecretjwtkey', 'salt', 32);
    const decrypt = (text) => {
      try {
        if (!text) return [];
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return JSON.parse(decrypted.toString());
      } catch (err) {
        console.error('Decryption failed for history item:', err);
        return [];
      }
    };

    const rooms = await StreamRoom.find({ hostId: owner }).sort({ createdAt: -1 });
    
    const history = rooms.map(room => ({
      _id: room._id,
      roomId: room.roomId,
      title: room.title,
      fileUrl: room.fileUrl,
      isActive: room.isActive,
      createdAt: room.createdAt,
      chats: decrypt(room.chats)
    }));

    return res.json(history);
  } catch (error) {
    console.error('Get stream history error:', error);
    return res.status(500).json({ message: 'Server error retrieving stream history' });
  }
};
