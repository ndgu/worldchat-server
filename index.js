const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const http = require('http');

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

// ============ إنشاء الجداول وتحديثها ============
const initDB = async () => {
  try {
    // إنشاء جدول users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        avatar TEXT,
        profile_pic TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // إضافة الأعمدة المفقودة (للتوافق مع الإصدارات السابقة)
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`);
      console.log('✅ Column display_name added');
    } catch (e) { /* العمود موجود */ }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;`);
      console.log('✅ Column avatar added');
    } catch (e) { /* العمود موجود */ }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT;`);
      console.log('✅ Column profile_pic added');
    } catch (e) { /* العمود موجود */ }

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

    // جدول calls
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id SERIAL PRIMARY KEY,
        caller TEXT NOT NULL,
        receiver TEXT NOT NULL,
        status TEXT,
        started_at TIMESTAMP DEFAULT NOW(),
        ended_at TIMESTAMP
      );
    `);

    console.log('✅ Database tables ready (v2.3.0)');
    return true;
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    return false;
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
    version: '2.3.0',
    db: dbStatus,
    usersCount: usersCount,
    features: ['chat', 'media', 'profile', 'calls']
  });
});

// ============ تسجيل حساب جديد ============
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
      // نحفظ البيانات الأساسية أولاً
      await client.query(
        'INSERT INTO users (username, password, display_name, profile_pic) VALUES ($1, $2, $3, $4)',
        [username, hashed, displayName || username, profilePic || null]
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

// ============ تسجيل الدخول ============
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

// ============ تحديث الملف الشخصي ============
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

// ============ جلب معلومات المستخدم ============
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
        'SELECT username, display_name, profile_pic, created_at FROM users WHERE username = $1',
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

// ============ جلب قائمة المستخدمين ============
app.get('/users', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT username, display_name, profile_pic FROM users ORDER BY username'
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

// ============ البحث عن مستخدمين ============
app.get('/users/search', async (req, res) => {
  const { username } = req.query;
  
  if (!username) {
    return res.status(400).json({ error: 'Username query param required' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT username, display_name, profile_pic FROM users 
         WHERE username ILIKE $1 ORDER BY username LIMIT 20`,
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

// ============ جلب رسائل المحادثة ============
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

// ============ إرسال رسالة ============
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
      
      const receiverWs = clients.get(receiver);
      if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
          type: 'message',
          ...result.rows[0]
        }));
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

// ============ تعليم الرسائل كمقروءة ============
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

// ============ WebRTC Signaling ============
app.post('/webrtc', async (req, res) => {
  const { type, from, to, data } = req.body;
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.username !== from) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    if (!type || !from || !to) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    
    if (type === 'call-start') {
      await pool.query(
        'INSERT INTO calls (caller, receiver, status) VALUES ($1, $2, $3)',
        [from, to, 'ringing']
      );
    }
    
    if (type === 'call-end') {
      await pool.query(
        `UPDATE calls SET status = $1, ended_at = NOW() 
         WHERE caller = $2 AND receiver = $3 AND ended_at IS NULL`,
        ['ended', from, to]
      );
    }
    
    const targetWs = clients.get(to);
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(JSON.stringify({
        type: 'webrtc',
        from: from,
        signal: data
      }));
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error('WebRTC error:', e.message);
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
          clients.set(username, ws);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          console.log(`✅ ${username} connected`);
          broadcastOnlineUsers();
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
        }
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
          
          const receiverWs = clients.get(receiver);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
              type: 'message',
              ...result.rows[0]
            }));
          }
          
          ws.send(JSON.stringify({ type: 'sent', messageId: result.rows[0].id }));
        } finally {
          client.release();
        }
      }
      
      if (data.type === 'webrtc' && username) {
        const { to, signal } = data;
        const targetWs = clients.get(to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'webrtc',
            from: username,
            signal: signal
          }));
        }
      }
      
      if (data.type === 'typing' && username) {
        const { to } = data;
        const targetWs = clients.get(to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'typing',
            from: username
          }));
        }
      }
      
    } catch (e) {
      console.error('❌ WS error:', e.message);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      console.log(`❌ ${username} disconnected`);
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
  
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// ============ تشغيل السيرفر ============
const startServer = async () => {
  console.log('🚀 Starting WorldChat Server v2.3.0...');
  console.log('📡 DATABASE_URL:', DATABASE_URL ? 'Set ✅' : 'Missing ❌');
  console.log('🔐 JWT_SECRET:', JWT_SECRET ? 'Set ✅' : 'Missing ❌');
  
  const dbReady = await initDB();
  
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📊 DB Status: ${dbReady ? 'ready ✅' : 'not ready ❌'}`);
    console.log('✨ Features: chat, media, profile, calls');
  });
};

startServer();
