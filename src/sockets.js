const WebSocket = require('ws');
const StreamRoom = require('./models/StreamRoom');
const mongoose = require('mongoose');

const rooms = {}; // roomId -> { roomId, hostSocket, fileUrl, title, isPlaying, currentTime, viewers: [], chats: [] }

const crypto = require('crypto');
const ENCRYPTION_KEY = crypto.scryptSync(process.env.JWT_SECRET || 'supersecretjwtkey', 'salt', 32);
const IV_LENGTH = 16;

function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  try {
    if (!text) return '[]';
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) {
    console.error('Decryption failed:', err);
    return '[]';
  }
}

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  if (rooms[result]) return generateRoomId(); // Ensure uniqueness
  return result;
}

function broadcastViewerChange(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const viewersList = room.viewers.map(v => ({
    id: v.id,
    name: v.name,
    avatarKey: v.avatarKey,
    userId: v.userId
  }));

  const payload = JSON.stringify({
    type: 'viewerChange',
    viewers: viewersList
  });

  // Send to host
  if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
    room.hostSocket.send(payload);
  }

  // Send to viewers
  room.viewers.forEach(v => {
    if (v.socket.readyState === WebSocket.OPEN) {
      v.socket.send(payload);
    }
  });
}

async function terminateRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  console.log(`Terminating stream room: ${roomId}`);

  // Persist inactive status and encrypted chats in MongoDB
  try {
    const chatJson = JSON.stringify(room.chats || []);
    const encryptedChats = encrypt(chatJson);
    await StreamRoom.findOneAndUpdate(
      { roomId, isActive: true },
      { isActive: false, chats: encryptedChats }
    );
    console.log(`StreamRoom ${roomId} marked as inactive and chats saved in DB.`);
  } catch (err) {
    console.error('Failed to save chats and mark StreamRoom as inactive in DB:', err);
  }

  const payload = JSON.stringify({ type: 'streamTerminated' });

  // Notify all viewers
  room.viewers.forEach(v => {
    try {
      if (v.socket.readyState === WebSocket.OPEN) {
        v.socket.send(payload);
        v.socket.close();
      }
    } catch (e) {
      console.error('Error closing viewer socket:', e);
    }
  });

  // Close host socket
  try {
    if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
      room.hostSocket.send(payload);
      room.hostSocket.close();
    }
  } catch (e) {
    console.error('Error closing host socket:', e);
  }

  delete rooms[roomId];
}

function initSockets(server) {
  const wss = new WebSocket.Server({ server });

  console.log('WebSocket Server integrated on top of HTTP server.');

  wss.on('connection', (ws) => {
    console.log('New WebSocket client connected.');

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log('Received WebSocket message type:', data.type);

        switch (data.type) {
          case 'createRoom': {
            // Before creating a new room, terminate/deactivate any existing active rooms for this host
            if (data.hostId) {
              try {
                const activeRooms = await StreamRoom.find({ hostId: data.hostId, isActive: true });
                for (const r of activeRooms) {
                  await terminateRoom(r.roomId);
                }
              } catch (err) {
                console.error('Failed to deactivate old stream rooms:', err);
              }
            }

            const roomId = generateRoomId();
            console.log(`Host created stream room: ${roomId} for file: ${data.title}`);

            rooms[roomId] = {
              roomId,
              hostSocket: ws,
              fileUrl: data.fileUrl,
              title: data.title,
              isPlaying: false,
              currentTime: 0,
              viewers: [],
              chats: [],
              hostId: data.hostId,
              hostAvatarKey: data.hostAvatarKey || null,
              hostName: data.hostName || 'Host'
            };

            ws.roomId = roomId;
            ws.isHost = true;

            // Save stream room record to MongoDB
            try {
              let hostIdVal = mongoose.Types.ObjectId.isValid(data.hostId) ? data.hostId : null;
              if (!hostIdVal) {
                try {
                  const fallbackUser = await require('./models/User').findOne({});
                  if (fallbackUser) {
                    hostIdVal = fallbackUser._id;
                    console.log(`Fallback hostId assigned: ${hostIdVal}`);
                  }
                } catch (userErr) {
                  console.error('Failed to find fallback user:', userErr);
                }
              }

              if (!hostIdVal) {
                hostIdVal = new mongoose.Types.ObjectId();
                console.log(`No hostId or fallback user found. Generated temporary hostId: ${hostIdVal}`);
              }

              // Extract fileId from fileUrl if not explicitly provided as a valid ObjectId
              let fileIdVal = mongoose.Types.ObjectId.isValid(data.fileId) ? data.fileId : null;
              if (!fileIdVal && data.fileUrl) {
                try {
                  const parts = data.fileUrl.split('/files/stream/');
                  if (parts.length > 1) {
                    const idPart = parts[1].split('/')[0];
                    if (mongoose.Types.ObjectId.isValid(idPart)) {
                      fileIdVal = idPart;
                      console.log(`Parsed fileId from URL: ${fileIdVal}`);
                    }
                  }
                } catch (urlErr) {
                  console.error('Error parsing fileId from URL:', urlErr);
                }
              }

              const newStream = new StreamRoom({
                roomId,
                hostId: hostIdVal,
                fileId: fileIdVal,
                fileUrl: data.fileUrl,
                title: data.title,
                isActive: true
              });
              await newStream.save();
              console.log(`Persisted active StreamRoom ${roomId} to MongoDB.`);
            } catch (err) {
              console.error('Failed to save StreamRoom in DB:', err);
            }

            ws.send(JSON.stringify({
              type: 'roomCreated',
              roomId,
              fileUrl: data.fileUrl,
              title: data.title,
              hostId: data.hostId,
              hostAvatarKey: data.hostAvatarKey || null,
              hostName: data.hostName || 'Host'
            }));
            break;
          }

          case 'joinRoom': {
            const { roomId, name, avatarKey, viewerId, userId } = data;
            let room = rooms[roomId];

            if (!room) {
              console.log(`Failed join attempt. Room not found in memory: ${roomId}. Checking DB...`);
              try {
                const dbRoom = await StreamRoom.findOne({ roomId, isActive: true });
                if (dbRoom) {
                  console.log(`Restoring room ${roomId} from MongoDB for viewer join.`);
                  const decryptedChats = dbRoom.chats ? JSON.parse(decrypt(dbRoom.chats)) : [];
                  rooms[roomId] = {
                    roomId,
                    hostSocket: null,
                    fileUrl: dbRoom.fileUrl,
                    title: dbRoom.title,
                    isPlaying: false,
                    currentTime: 0,
                    viewers: [],
                    chats: decryptedChats,
                    hostId: dbRoom.hostId.toString(),
                    hostAvatarKey: null,
                    hostName: 'Host'
                  };
                  room = rooms[roomId];
                } else {
                  const inactiveRoom = await StreamRoom.findOne({ roomId });
                  if (inactiveRoom) {
                    ws.send(JSON.stringify({
                      type: 'error',
                      message: 'Streaming has ended and is no longer available.'
                    }));
                  } else {
                    ws.send(JSON.stringify({
                      type: 'error',
                      message: 'Room not found. Please check the 6-digit ID.'
                    }));
                  }
                  return;
                }
              } catch (dbErr) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Room not found. Please check the 6-digit ID.'
                }));
                return;
              }
            }

            const newViewerId = viewerId || Math.random().toString(36).substring(7);
            const viewer = {
              id: newViewerId,
              userId: userId || null,
              name: name || 'Anonymous',
              avatarKey: avatarKey || null,
              socket: ws
            };

            room.viewers.push(viewer);
            ws.roomId = roomId;
            ws.isHost = false;
            ws.viewerId = newViewerId;

            console.log(`Viewer ${viewer.name} joined room ${roomId}. Total viewers: ${room.viewers.length}`);

            // Send initialization data to the new viewer
            ws.send(JSON.stringify({
              type: 'roomJoined',
              roomId,
              fileUrl: room.fileUrl,
              title: room.title,
              isPlaying: room.isPlaying,
              currentTime: room.currentTime,
              chats: room.chats,
              viewers: room.viewers.map(v => ({ id: v.id, name: v.name, avatarKey: v.avatarKey, userId: v.userId })),
              hostId: room.hostId,
              hostAvatarKey: room.hostAvatarKey,
              hostName: room.hostName || 'Host'
            }));

            // Notify everyone of the updated list
            broadcastViewerChange(roomId);
            break;
          }

          case 'reconnectHost': {
            const { roomId, hostId, hostAvatarKey, hostName } = data;
            let room = rooms[roomId];

            if (!room) {
              console.log(`Host reconnecting. Room not found in memory: ${roomId}. Checking DB...`);
              try {
                const dbRoom = await StreamRoom.findOne({ roomId, isActive: true });
                if (dbRoom) {
                  if (dbRoom.hostId.toString() !== hostId.toString()) {
                    console.log(`Unauthorized host reconnect attempt for room ${roomId} by user ${hostId}`);
                    ws.send(JSON.stringify({
                      type: 'error',
                      message: 'Unauthorized reconnect attempt.'
                    }));
                    return;
                  }
                  console.log(`Restoring room ${roomId} from MongoDB for host reconnect.`);
                  const decryptedChats = dbRoom.chats ? JSON.parse(decrypt(dbRoom.chats)) : [];
                  rooms[roomId] = {
                    roomId,
                    hostSocket: ws,
                    fileUrl: dbRoom.fileUrl,
                    title: dbRoom.title,
                    isPlaying: false,
                    currentTime: 0,
                    viewers: [],
                    chats: decryptedChats,
                    hostId: dbRoom.hostId.toString(),
                    hostAvatarKey: hostAvatarKey || null,
                    hostName: hostName || 'Host'
                  };
                  room = rooms[roomId];
                } else {
                  ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Stream session has ended and is no longer available.'
                  }));
                  return;
                }
              } catch (dbErr) {
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Failed to restore stream session.'
                }));
                return;
              }
            } else {
              if (room.hostId && room.hostId.toString() !== hostId.toString()) {
                console.log(`Unauthorized host reconnect attempt for active room ${roomId} by user ${hostId}`);
                ws.send(JSON.stringify({
                  type: 'error',
                  message: 'Unauthorized reconnect attempt.'
                }));
                return;
              }
              room.hostSocket = ws;
              room.hostId = hostId || room.hostId.toString();
              if (hostAvatarKey) {
                room.hostAvatarKey = hostAvatarKey;
              }
              if (hostName) {
                room.hostName = hostName;
              }
            }

            ws.roomId = roomId;
            ws.isHost = true;

            console.log(`Host reconnected to room ${roomId}.`);

            ws.send(JSON.stringify({
              type: 'roomCreated',
              roomId,
              fileUrl: room.fileUrl,
              title: room.title,
              hostId: room.hostId,
              hostAvatarKey: room.hostAvatarKey || null,
              hostName: room.hostName || 'Host',
              isPlaying: room.isPlaying,
              currentTime: room.currentTime,
              chats: room.chats || []
            }));

            broadcastViewerChange(roomId);
            break;
          }

          case 'sync': {
            const room = rooms[ws.roomId];
            if (!room || !ws.isHost) return;

            room.isPlaying = data.action === 'play';
            room.currentTime = data.currentTime;

            // Broadcast sync event to all viewers
            const payload = JSON.stringify({
              type: 'sync',
              action: data.action,
              currentTime: data.currentTime
            });

            room.viewers.forEach(v => {
              if (v.socket.readyState === WebSocket.OPEN) {
                v.socket.send(payload);
              }
            });
            break;
          }

          case 'hostProgress': {
            const room = rooms[ws.roomId];
            if (!room || !ws.isHost) return;

            room.isPlaying = data.isPlaying;
            room.currentTime = data.currentTime;

            // Broadcast periodic sync to all viewers so they stay locked to host
            if (room.viewers.length > 0) {
              const syncPayload = JSON.stringify({
                type: 'sync',
                action: data.isPlaying ? 'play' : 'pause',
                currentTime: data.currentTime
              });
              room.viewers.forEach(v => {
                if (v.socket.readyState === WebSocket.OPEN) {
                  v.socket.send(syncPayload);
                }
              });
            }
            break;
          }

          case 'changeTrack': {
            const room = rooms[ws.roomId];
            if (!room || !ws.isHost) return;

            console.log(`[WS] Host in room ${ws.roomId} changing track to: ${data.title}`);
            room.fileUrl = data.fileUrl;
            room.title = data.title;
            room.isPlaying = data.isPlaying !== undefined ? data.isPlaying : false;
            room.currentTime = 0;

            // Sync database stream record
            try {
              await StreamRoom.findOneAndUpdate(
                { roomId: ws.roomId, isActive: true },
                { fileUrl: data.fileUrl, title: data.title }
              );
              console.log(`[WS] Updated StreamRoom ${ws.roomId} file URL in database.`);
            } catch (err) {
              console.error('Failed to update StreamRoom in DB on track change:', err);
            }

            // Broadcast trackChanged event to viewers
            const payload = JSON.stringify({
              type: 'trackChanged',
              fileUrl: data.fileUrl,
              title: data.title,
              isPlaying: room.isPlaying
            });

            room.viewers.forEach(v => {
              if (v.socket.readyState === WebSocket.OPEN) {
                v.socket.send(payload);
              }
            });
            break;
          }


          case 'chat': {
            const room = rooms[ws.roomId];
            if (!room) return;

            let senderName = 'Host';
            let avatarKey = null;
            let userId = null;

            if (!ws.isHost) {
              const v = room.viewers.find(x => x.id === ws.viewerId);
              if (v) {
                senderName = v.name;
                avatarKey = v.avatarKey;
                userId = v.userId;
              }
            } else {
              senderName = data.senderName || 'Host';
              avatarKey = data.avatarKey || null;
              userId = room.hostId || data.userId || null;
            }

            const chatMsg = {
              id: Math.random().toString(36).substring(7),
              sender: senderName,
              avatarKey: avatarKey,
              userId: userId,
              isHost: ws.isHost,
              message: data.message,
              timestamp: Date.now()
            };

            room.chats.push(chatMsg);
            console.log(`Chat in room ${ws.roomId} from ${senderName}: ${data.message}`);

            // Broadcast chat to all clients (host + viewers)
            const payload = JSON.stringify({
              type: 'chat',
              chat: chatMsg
            });

            if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
              room.hostSocket.send(payload);
            }

            room.viewers.forEach(v => {
              if (v.socket.readyState === WebSocket.OPEN) {
                v.socket.send(payload);
              }
            });
            break;
          }

          case 'terminateStream': {
            if (ws.isHost && ws.roomId) {
              terminateRoom(ws.roomId);
            }
            break;
          }

          default:
            console.warn('Unknown WebSocket message type:', data.type);
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    });

    ws.on('close', async () => {
      console.log('WebSocket connection closed.');
      if (ws.roomId && rooms[ws.roomId]) {
        if (ws.isHost) {
          console.log(`Host disconnected from room ${ws.roomId}. Keeping stream room active.`);
          const room = rooms[ws.roomId];
          if (room) {
            room.hostSocket = null;
            // Backup chats to database in case of crash
            try {
              const chatJson = JSON.stringify(room.chats || []);
              const encryptedChats = encrypt(chatJson);
              await StreamRoom.findOneAndUpdate(
                { roomId: ws.roomId, isActive: true },
                { chats: encryptedChats }
              );
            } catch (err) {
              console.error('Failed to backup chats on host disconnect:', err);
            }
          }
        } else {
          // Viewer disconnected, remove from room and broadcast updated list
          const room = rooms[ws.roomId];
          const index = room.viewers.findIndex(v => v.id === ws.viewerId);
          if (index !== -1) {
            console.log(`Viewer ${room.viewers[index].name} disconnected from room ${ws.roomId}.`);
            room.viewers.splice(index, 1);
            broadcastViewerChange(ws.roomId);
          }
        }
      }
    });
  });
}

module.exports = { initSockets, rooms, terminateRoom };
