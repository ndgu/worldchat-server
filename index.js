const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const http = require('http');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

// ============ Firebase Admin SDK ============
const admin = require('firebase-admin');

// تهيئة Firebase من متغيرات البيئة
if (!admin.apps.length) {
  try {
    // محاولة استخدام متغيرات البيئة
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'worldchat-cde0b.appspot.com'
    });
    console.log('🔥 Firebase Admin initialized successfully');
  } catch (e) {
    console.log('⚠️ Firebase Admin init error:', e.message);
  }
}

const bucket = admin.storage().bucket();
const fcm = admin.messaging();

// ============ Express App ============
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database
const DATABASE_URL = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20
});

const JWT_SECRET = process.env.JWT_SECRET || 'worldchat_super_secret_key_2026_ahmed_12345';

// ============ إنشاء الجداول ============
const initDB = async () => {
  try {
    // جدول users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        avatar TEXT,
        profile_pic TEXT,
        is_online BOOLEAN DEFAULT FALSE,
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // إضافة الأعمدة المفقودة
    const userColumns = ['display_name', 'avatar', 'profile_pic', 'is_online', 'last_seen'];
    for (const col of userColumns) {
      try {
        const type = col === 'is_online' ? 'BOOLEAN DEFAULT FALSE' : 
                     col === 'last_seen' ? 'TIMESTAMP DEFAULT NOW()' : 'TEXT';
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${type};`);
      } catch (e) { /* العمود موجود */ }
    }

    // جدول messages
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT,
        media_type TEXT,
        media_url TEXT,
        reply_to INTEGER,
        delivered BOOLEAN DEFAULT FALSE,
        read BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);

    // إضافة الأعمدة المفقودة في messages
    const msgColumns = [
      { name: 'media_type', type: 'TEXT' },
      { name: 'media_url', type: 'TEXT' },
      { name: 'reply_to', type: 'INTEGER' },
      { name: 'delivered', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'read', type: 'BOOLEAN DEFAULT FALSE' }
    ];
    for (const col of msgColumns) {
      try {
        await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};`);
      } catch (e) { /* العمود موجود */ }
    }

    // جدول calls
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        caller TEXT NOT NULL,
        receiver TEXT NOT NULL,
        status TEXT DEFAULT 'initiated',
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP,
        duration INTEGER DEFAULT 0
      );
    `);

    // جدول devices (لـ FCM)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        fcm_token TEXT UNIQUE NOT NULL,
        platform TEXT DEFAULT 'android',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Database tables ready (v2.7.0)');
    return true;
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    return false;
  }
};

// ============ FCM دالة إرسال الإشعارات ============
const sendFCMNotification = async (toUsername, title, body, data = {}) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT fcm_token FROM devices WHERE username = $1`,
        [toUsername]
      );
      
      const tokens = result.rows.map(row => row.fcm_token);
      if (tokens.length === 0) {
        console.log(`📱 No devices registered for ${toUsername}`);
        return;
      }

      const stringData = {};
      for (const [key, value] of Object.entries(data)) {
        stringData[key] = String(value);
      }

      const message = {
        tokens: tokens,
        notification: { title, body },
        data: stringData,
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            clickAction: 'OPEN_ACTIVITY'
          }
        }
      };

      const response = await fcm.sendEachForMulticast(message);
      console.log(`📨 FCM sent: ${response.successCount} delivered`);

      // تنظيف التوكنات غير الصالحة
      const staleTokens = [];
      response.responses.forEach((resp, index) => {
        if (resp.error && resp.error.message.includes('registration-token-not-registered')) {
          staleTokens.push(tokens[index]);
        }
      });

      if (staleTokens.length > 0) {
        const client2 = await pool.connect();
        try {
          await client2.query(
            `DELETE FROM devices WHERE fcm_token = ANY($1)`,
            [staleTokens]
          );
          console.log(`🧹 Cleaned ${staleTokens.length} stale FCM tokens`);
        } finally {
          client2.release();
        }
      }
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('FCM error:', e.message);
  }
};

// ============ Health Check ============
app.get('/health', async (req, res) => {
  let dbStatus = 'unknown';
  let usersCount = 0;
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT COUNT(*) FROM users');
      usersCount = parseInt(result.rows[0].count);
      dbStatus = 'up';
    } finally {
      client.release();
    }
  } catch (e) {
    dbStatus = 'down';
  }
  
  res.json({
    ok: true,
    service: 'worldchat',
    version: '2.7.0',
    db: dbStatus,
    usersCount: usersCount,
    features: ['chat', 'media', 'profile', 'calls', 'offline_inbox', 'background_support']
  });
});

// ============ Upload to Firebase Storage ============
const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload', upload.single('file'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileName = `uploads/${username}/${Date.now()}-${req.file.originalname}`;
    const file = bucket.file(fileName);

    const stream = file.createWriteStream({
      metadata: { contentType: req.file.mimetype }
    });

    stream.on('error', (err) => {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Upload failed' });
    });

    stream.on('finish', async () => {
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
      });
      
      res.json({
        success: true,
        fileUrl: url,
        fileName: fileName
      });
    });

    stream.end(req.file.buffer);
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Device Registration (FCM) ============
app.post('/device/register', async (req, res) => {
  const { username, fcmToken, platform } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== username) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token required' });
    }

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO devices (username, fcm_token, platform) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (fcm_token) DO UPDATE SET username = $1, platform = $3`,
        [username, fcmToken, platform || 'android']
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Device register error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Device Unregister ============
app.delete('/device/unregister', async (req, res) => {
  const { fcmToken } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM devices WHERE fcm_token = $1', [fcmToken]);
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Device unregister error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Register ============
app.post('/register', async (req, res) => {
  const { username, password, displayName, profilePic } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const existing = await client.query('SELECT username FROM users WHERE username = $1', [username]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Username already exists' });
      }
      
      const hashed = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO users (username, password, display_name, profile_pic, is_online) 
         VALUES ($1, $2, $3, $4, $5)`,
        [username, hashed, displayName || username, profilePic || null, true]
      );
      
      const token = jwt.sign({ username }, JWT_SECRET);
      res.json({ token, username, displayName: displayName || username });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Login ============
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      const valid = await bcrypt.compare(password, result.rows[0].password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      await client.query(
        `UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE username = $1`,
        [username]
      );
      
      const token = jwt.sign({ username }, JWT_SECRET);
      res.json({ 
        token, 
        username, 
        displayName: result.rows[0].display_name || username,
        profilePic: result.rows[0].profile_pic || result.rows[0].avatar || null
      });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Update Profile ============
app.post('/update-profile', async (req, res) => {
  const { username, displayName, profilePic, password } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== username) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    const client = await pool.connect();
    try {
      let query = 'UPDATE users SET display_name = $1, profile_pic = $2';
      let params = [displayName || username, profilePic || null];
      
      if (password && password.length >= 4) {
        const hashed = await bcrypt.hash(password, 10);
        query += ', password = $3';
        params.push(hashed);
      }
      
      query += ' WHERE username = $4';
      params.push(username);
      
      await client.query(query, params);
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Update profile error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Get Me ============
app.get('/me', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT username, display_name, profile_pic, is_online, last_seen, created_at 
         FROM users WHERE username = $1`,
        [decoded.username]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Me error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Get Users ============
app.get('/users', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT username, display_name, profile_pic, is_online, last_seen 
         FROM users ORDER BY username`
      );
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Users error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Search Users ============
app.get('/users/search', async (req, res) => {
  const { username } = req.query;
  
  if (!username) {
    return res.status(400).json({ error: 'Username query param required' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT username, display_name, profile_pic, is_online, last_seen 
         FROM users 
         WHERE username ILIKE $1 
         ORDER BY username LIMIT 20`,
        [`%${username}%`]
      );
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Inbox ============
app.get('/inbox', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;
    
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM messages WHERE 
         sender = $1 OR receiver = $1
         ORDER BY timestamp DESC LIMIT 500`,
        [username]
      );
      
      await client.query(
        `UPDATE messages SET delivered = TRUE 
         WHERE receiver = $1 AND delivered = FALSE`,
        [username]
      );
      
      res.json(result.rows.reverse());
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Inbox error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Get Messages ============
app.post('/messages', async (req, res) => {
  const { myUsername, otherUsername, limit = 50, offset = 0 } = req.body;
  
  if (!myUsername || !otherUsername) {
    return res.status(400).json({ error: 'Both usernames required' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM messages WHERE 
         (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
         ORDER BY timestamp DESC LIMIT $3 OFFSET $4`,
        [myUsername, otherUsername, limit, offset]
      );
      res.json(result.rows.reverse());
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Messages error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Send Message (HTTP) ============
app.post('/messages/send', async (req, res) => {
  const { sender, receiver, content, mediaType, mediaUrl, replyTo } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== sender) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!receiver) {
      return res.status(400).json({ error: 'Receiver required' });
    }
    
    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO messages (sender, receiver, content, media_type, media_url, reply_to) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [sender, receiver, content || null, mediaType || null, mediaUrl || null, replyTo || null]
      );
      
      // Send via WebSocket
      const receiverSockets = clients.get(receiver);
      if (receiverSockets) {
        const messageData = JSON.stringify({
          type: 'message',
          ...result.rows[0]
        });
        receiverSockets.forEach((socket) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(messageData);
          }
        });
      } else {
        // Send FCM notification if user offline
        await sendFCMNotification(
          receiver,
          sender,
          content || '📷 صورة جديدة',
          {
            type: 'message',
            sender: sender,
            messageId: result.rows[0].id
          }
        );
      }
      
      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Send message error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Mark Messages as Read ============
app.post('/messages/read', async (req, res) => {
  const { username, otherUsername } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== username) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE messages SET read = TRUE, delivered = TRUE 
         WHERE sender = $1 AND receiver = $2 AND read = FALSE`,
        [otherUsername, username]
      );
      res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Read error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ Call Routes ============

// Start Call
app.post('/call/start', async (req, res) => {
  const { from, to, offer, isVideo } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const client = await pool.connect();
    try {
      const userCheck = await client.query('SELECT username, is_online FROM users WHERE username = $1', [to]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      await client.query(
        'INSERT INTO calls (caller, receiver, status) VALUES ($1, $2, $3)',
        [from, to, 'ringing']
      );
    } finally {
      client.release();
    }

    const receiverSockets = clients.get(to);
    if (!receiverSockets || receiverSockets.size === 0) {
      // Send FCM notification for call
      await sendFCMNotification(
        to,
        `📞 ${isVideo ? 'مكالمة فيديو' : 'مكالمة صوتية'}`,
        `${from} يتصل بك...`,
        {
          type: 'call',
          from: from,
          isVideo: String(isVideo || false)
        }
      );
      return res.status(404).json({ error: 'User offline, notification sent' });
    }

    const message = JSON.stringify({
      type: 'call_offer',
      from: from,
      offer: offer,
      isVideo: isVideo || false,
      callerName: from
    });

    let delivered = false;
    receiverSockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        delivered = true;
      }
    });

    if (!delivered) {
      await sendFCMNotification(
        to,
        `📞 ${isVideo ? 'مكالمة فيديو' : 'مكالمة صوتية'}`,
        `${from} يتصل بك...`,
        {
          type: 'call',
          from: from,
          isVideo: String(isVideo || false)
        }
      );
      return res.status(404).json({ error: 'User offline, notification sent' });
    }

    res.json({ success: true, message: 'Call initiated' });
  } catch (e) {
    console.error('Call start error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Answer Call
app.post('/call/answer', async (req, res) => {
  const { from, to, answer } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE calls SET status = $1, started_at = NOW() 
           WHERE caller = $2 AND receiver = $3 AND ended_at IS NULL`,
          ['connected', to, from]
        );
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Update call record error:', e);
    }

    const receiverSockets = clients.get(to);
    if (!receiverSockets || receiverSockets.size === 0) {
      return res.status(404).json({ error: 'User offline' });
    }

    const message = JSON.stringify({
      type: 'call_answer',
      from: from,
      answer: answer
    });

    let delivered = false;
    receiverSockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        delivered = true;
      }
    });

    if (!delivered) {
      return res.status(404).json({ error: 'User offline' });
    }

    res.json({ success: true, message: 'Call answered' });
  } catch (e) {
    console.error('Call answer error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ICE Exchange
app.post('/call/ice', async (req, res) => {
  const { from, to, candidate } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const receiverSockets = clients.get(to);
    if (!receiverSockets || receiverSockets.size === 0) {
      return res.status(404).json({ error: 'User offline' });
    }

    const message = JSON.stringify({
      type: 'call_ice',
      from: from,
      candidate: candidate
    });

    let delivered = false;
    receiverSockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        delivered = true;
      }
    });

    if (!delivered) {
      return res.status(404).json({ error: 'User offline' });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('ICE error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// End Call
app.post('/call/end', async (req, res) => {
  const { from, to } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE calls SET status = $1, ended_at = NOW() 
           WHERE (caller = $2 AND receiver = $3) OR (caller = $3 AND receiver = $2)
           AND ended_at IS NULL`,
          ['ended', from, to]
        );
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Update call record error:', e);
    }

    const receiverSockets = clients.get(to);
    if (receiverSockets && receiverSockets.size > 0) {
      const message = JSON.stringify({
        type: 'call_end',
        from: from
      });
      receiverSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        }
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Call end error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Reject Call
app.post('/call/reject', async (req, res) => {
  const { from, to } = req.body;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE calls SET status = $1, ended_at = NOW() 
           WHERE caller = $2 AND receiver = $3 AND ended_at IS NULL`,
          ['rejected', to, from]
        );
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Update call record error:', e);
    }

    const receiverSockets = clients.get(to);
    if (receiverSockets && receiverSockets.size > 0) {
      const message = JSON.stringify({
        type: 'call_rejected',
        from: from
      });
      receiverSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        }
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Call reject error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Call Status
app.get('/call/status', async (req, res) => {
  const { with: otherUser } = req.query;
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;

    if (!otherUser) {
      return res.status(400).json({ error: 'Missing parameter: with' });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM calls WHERE 
         (caller = $1 AND receiver = $2) OR (caller = $2 AND receiver = $1)
         ORDER BY started_at DESC LIMIT 1`,
        [username, otherUser]
      );

      if (result.rows.length === 0) {
        return res.json({ hasCall: false });
      }

      const call = result.rows[0];
      res.json({
        hasCall: true,
        status: call.status,
        startedAt: call.started_at,
        endedAt: call.ended_at,
        duration: call.duration || 0
      });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Call status error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Call History
app.get('/call/history', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = decoded.username;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM calls WHERE 
         caller = $1 OR receiver = $1
         ORDER BY started_at DESC LIMIT 50`,
        [username]
      );

      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Call history error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ WebSocket Server ============
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          username = decoded.username;
          
          if (!clients.has(username)) {
            clients.set(username, new Set());
          }
          clients.get(username).add(ws);
          
          try {
            const client = await pool.connect();
            try {
              await client.query(
                `UPDATE users SET is_online = TRUE, last_seen = NOW() WHERE username = $1`,
                [username]
              );
            } finally {
              client.release();
            }
          } catch (e) {
            console.error('Update online status error:', e);
          }
          
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          console.log(`✅ ${username} connected (${clients.get(username).size} devices)`);
          
          broadcastOnlineUsers();
          
          // Send inbox
          try {
            const client = await pool.connect();
            try {
              const result = await client.query(
                `SELECT * FROM messages WHERE 
                 receiver = $1 AND read = FALSE
                 ORDER BY timestamp ASC`,
                [username]
              );
              
              if (result.rows.length > 0) {
                console.log(`📬 Sending ${result.rows.length} offline messages to ${username}`);
                result.rows.forEach((msg) => {
                  ws.send(JSON.stringify({
                    type: 'message',
                    ...msg
                  }));
                });
                
                await client.query(
                  `UPDATE messages SET delivered = TRUE 
                   WHERE receiver = $1 AND delivered = FALSE`,
                  [username]
                );
              }
            } finally {
              client.release();
            }
          } catch (e) {
            console.error('Inbox delivery error:', e.message);
          }
          
          broadcastUserStatus(username, true);
          
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
          console.error('Auth error:', e.message);
        }
        return;
      }
      
      if (data.type === 'message' && username) {
        const { receiver, content, mediaType, mediaUrl, replyTo } = data;
        
        if (!receiver) return;
        
        const client = await pool.connect();
        try {
          const result = await client.query(
            `INSERT INTO messages (sender, receiver, content, media_type, media_url, reply_to) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [username, receiver, content || null, mediaType || null, mediaUrl || null, replyTo || null]
          );
          
          const receiverSockets = clients.get(receiver);
          if (receiverSockets) {
            const messageData = JSON.stringify({
              type: 'message',
              ...result.rows[0]
            });
            receiverSockets.forEach((socket) => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(messageData);
              }
            });
          } else {
            await sendFCMNotification(
              receiver,
              username,
              content || '📷 صورة جديدة',
              {
                type: 'message',
                sender: username,
                messageId: result.rows[0].id
              }
            );
          }
          
          ws.send(JSON.stringify({ type: 'sent', messageId: result.rows[0].id }));
        } finally {
          client.release();
        }
        return;
      }
      
      if (data.type === 'call_offer' && username) {
        const { to, offer, isVideo } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_offer',
            from: username,
            offer: offer,
            isVideo: isVideo || false,
            callerName: username
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(message);
            }
          });
        }
        return;
      }
      
      if (data.type === 'call_answer' && username) {
        const { to, answer } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_answer',
            from: username,
            answer: answer
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(message);
            }
          });
        }
        return;
      }
      
      if (data.type === 'call_ice' && username) {
        const { to, candidate } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_ice',
            from: username,
            candidate: candidate
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(message);
            }
          });
        }
        return;
      }
      
      if (data.type === 'call_end' && username) {
        const { to } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_end',
            from: username
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(message);
            }
          });
        }
        return;
      }
      
      if (data.type === 'call_rejected' && username) {
        const { to } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_rejected',
            from: username
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(message);
            }
          });
        }
        return;
      }
      
      if (data.type === 'typing' && username) {
        const { to } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const typingData = JSON.stringify({
            type: 'typing',
            from: username
          });
          receiverSockets.forEach((socket) => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(typingData);
            }
          });
        }
        return;
      }
      
      if (data.type === 'status' && username) {
        const { isOnline } = data;
        try {
          const client = await pool.connect();
          try {
            await client.query(
              `UPDATE users SET is_online = $1, last_seen = NOW() WHERE username = $2`,
              [isOnline, username]
            );
          } finally {
            client.release();
          }
          broadcastUserStatus(username, isOnline);
        } catch (e) {
          console.error('Status error:', e);
        }
        return;
      }
      
    } catch (e) {
      console.error('❌ WS error:', e.message);
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
    }
  });

  ws.on('close', () => {
    if (username) {
      const userSockets = clients.get(username);
      if (userSockets) {
        userSockets.delete(ws);
        if (userSockets.size === 0) {
          clients.delete(username);
          console.log(`❌ ${username} disconnected (no devices left)`);
          
          try {
            const client = pool.connect();
            client.then(async (c) => {
              try {
                await c.query(
                  `UPDATE users SET is_online = FALSE, last_seen = NOW() WHERE username = $1`,
                  [username]
                );
              } finally {
                c.release();
              }
            });
          } catch (e) {
            console.error('Update offline status error:', e);
          }
          
          broadcastUserStatus(username, false);
        } else {
          console.log(`❌ ${username} device disconnected (${userSockets.size} devices remain)`);
        }
      }
      broadcastOnlineUsers();
    }
  });
});

function broadcastOnlineUsers() {
  const onlineUsers = Array.from(clients.keys());
  const message = JSON.stringify({
    type: 'online_users',
    users: onlineUsers
  });
  
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  });
}

function broadcastUserStatus(username, isOnline) {
  const message = JSON.stringify({
    type: 'user_status',
    username: username,
    isOnline: isOnline,
    lastSeen: new Date().toISOString()
  });
  
  clients.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  });
}

// ============ Start Server ============
const startServer = async () => {
  console.log('🚀 Starting WorldChat Server v2.7.0...');
  console.log('📡 DATABASE_URL:', DATABASE_URL ? 'Set ✅' : 'Missing ❌');
  console.log('🔐 JWT_SECRET:', JWT_SECRET ? 'Set ✅' : 'Missing ❌');
  console.log('🔥 Firebase:', admin.apps.length ? 'Initialized ✅' : 'Not initialized ❌');
  
  const dbReady = await initDB();
  
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📊 DB Status: ${dbReady ? 'ready ✅' : 'not ready ❌'}`);
    console.log('✨ Features: chat, media, profile, calls, offline_inbox, background_support');
    console.log('👥 Multi-device: enabled');
    console.log('📬 Offline Inbox: enabled');
    console.log('📞 WebRTC Signaling: enabled');
    console.log('🔥 Firebase FCM + Storage: enabled');
  });
};

startServer();
