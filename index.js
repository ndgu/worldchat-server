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
    // جدول users
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

    // إضافة الأعمدة المفقودة في users
    const userColumns = ['display_name', 'avatar', 'profile_pic'];
    for (const col of userColumns) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} TEXT;`);
        console.log(`✅ Column ${col} added to users`);
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
        console.log(`✅ Column ${col.name} added to messages`);
      } catch (e) { /* العمود موجود */ }
    }

    // جدول calls (لتسجيل المكالمات)
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
    console.log('✅ Calls table ready');

    console.log('✅ Database initialization complete (v2.6.0)');
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
    version: '2.6.0',
    db: dbStatus,
    usersCount: usersCount,
    features: ['chat', 'media', 'profile', 'calls', 'offline_inbox']
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

// ============ جلب جميع رسائل المستخدم (Inbox) ============
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

// ============ إرسال رسالة (HTTP) ============
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
      // التحقق من وجود الأعمدة ديناميكياً
      const columnCheck = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name IN ('media_type', 'media_url', 'reply_to')
      `);
      const existingColumns = columnCheck.rows.map(row => row.column_name);
      
      let insertQuery = 'INSERT INTO messages (sender, receiver, content';
      let values = [sender, receiver, content || null];
      let valuePlaceholders = ['$1', '$2', '$3'];
      let paramIndex = 4;
      
      if (existingColumns.includes('media_type') && mediaType) {
        insertQuery += ', media_type';
        values.push(mediaType);
        valuePlaceholders.push(`$${paramIndex++}`);
      }
      
      if (existingColumns.includes('media_url') && mediaUrl) {
        insertQuery += ', media_url';
        values.push(mediaUrl);
        valuePlaceholders.push(`$${paramIndex++}`);
      }
      
      if (existingColumns.includes('reply_to') && replyTo) {
        insertQuery += ', reply_to';
        values.push(replyTo);
        valuePlaceholders.push(`$${paramIndex++}`);
      }
      
      insertQuery += `) VALUES (${valuePlaceholders.join(', ')}) RETURNING *`;
      
      const result = await client.query(insertQuery, values);
      
      // إرسال عبر WebSocket للمستقبل
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

// ============ إرسال رسالة (بديل) ============
app.post('/send-message', async (req, res) => {
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

// ============ إرسال رسالة (بديل آخر) ============
app.post('/chat/send', async (req, res) => {
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

// ============================================================
// ============ WebRTC Signaling (المكالمات) ============
// ============================================================

// ============ بدء مكالمة ============
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

    // التحقق من وجود المستخدم الآخر
    const client = await pool.connect();
    try {
      const userCheck = await client.query('SELECT username FROM users WHERE username = $1', [to]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
    } finally {
      client.release();
    }

    // حفظ سجل المكالمة
    try {
      const client = await pool.connect();
      try {
        await client.query(
          'INSERT INTO calls (caller, receiver, status) VALUES ($1, $2, $3)',
          [from, to, 'ringing']
        );
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Save call record error:', e);
    }

    // إرسال إشارة المكالمة إلى الطرف الآخر عبر WebSocket
    const receiverSockets = clients.get(to);
    if (!receiverSockets || receiverSockets.size === 0) {
      return res.status(404).json({ error: 'User offline' });
    }

    const message = JSON.stringify({
      type: 'call_offer',
      from: from,
      offer: offer,
      isVideo: isVideo || false
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

    res.json({ success: true, message: 'Call initiated' });
  } catch (e) {
    console.error('Call start error:', e);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// ============ الرد على مكالمة ============
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

    // تحديث سجل المكالمة
    try {
      const client = await pool.connect();
      try {
        await client.query(
          'UPDATE calls SET status = $1 WHERE caller = $2 AND receiver = $3 AND ended_at IS NULL',
          ['connected', to, from]
        );
      } finally {
        client.release();
      }
    } catch (e) {
      console.error('Update call record error:', e);
    }

    // إرسال الرد إلى الطرف الآخر
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

// ============ تبادل ICE Candidates ============
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

// ============ إنهاء مكالمة ============
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

    // تحديث سجل المكالمة
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

    // إرسال إشارة إنهاء المكالمة
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

// ============ رفض مكالمة ============
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

    // تحديث سجل المكالمة
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

    // إرسال إشارة رفض المكالمة
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

// ============ التحقق من حالة المكالمة ============
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

// ============ جلب سجل المكالمات ============
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

// ============================================================
// ============ WebSocket Server ============
// ============================================================

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // ===== مصادقة =====
      if (data.type === 'auth') {
        try {
          const decoded = jwt.verify(data.token, JWT_SECRET);
          username = decoded.username;
          
          if (!clients.has(username)) {
            clients.set(username, new Set());
          }
          clients.get(username).add(ws);
          
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          console.log(`✅ ${username} connected (${clients.get(username).size} devices)`);
          
          // إرسال البريد الوارد (Inbox)
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
          
          broadcastOnlineUsers();
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
        }
        return;
      }
      
      // ===== رسالة عبر WebSocket =====
      if (data.type === 'message' && username) {
        const { receiver, content, mediaType, mediaUrl, replyTo } = data;
        
        if (!receiver) return;
        
        const client = await pool.connect();
        try {
          // التحقق من وجود الأعمدة ديناميكياً
          const columnCheck = await client.query(`
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'messages' AND column_name IN ('media_type', 'media_url', 'reply_to')
          `);
          const existingColumns = columnCheck.rows.map(row => row.column_name);
          
          let insertQuery = 'INSERT INTO messages (sender, receiver, content';
          let values = [username, receiver, content || null];
          let valuePlaceholders = ['$1', '$2', '$3'];
          let paramIndex = 4;
          
          if (existingColumns.includes('media_type') && mediaType) {
            insertQuery += ', media_type';
            values.push(mediaType);
            valuePlaceholders.push(`$${paramIndex++}`);
          }
          
          if (existingColumns.includes('media_url') && mediaUrl) {
            insertQuery += ', media_url';
            values.push(mediaUrl);
            valuePlaceholders.push(`$${paramIndex++}`);
          }
          
          if (existingColumns.includes('reply_to') && replyTo) {
            insertQuery += ', reply_to';
            values.push(replyTo);
            valuePlaceholders.push(`$${paramIndex++}`);
          }
          
          insertQuery += `) VALUES (${valuePlaceholders.join(', ')}) RETURNING *`;
          
          const result = await client.query(insertQuery, values);
          
          // إرسال للمستقبل
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
          }
          
          ws.send(JSON.stringify({ type: 'sent', messageId: result.rows[0].id }));
        } finally {
          client.release();
        }
        return;
      }
      
      // ===== WebRTC Signaling عبر WebSocket =====
      if (data.type === 'call_offer' && username) {
        const { to, offer, isVideo } = data;
        const receiverSockets = clients.get(to);
        if (receiverSockets) {
          const message = JSON.stringify({
            type: 'call_offer',
            from: username,
            offer: offer,
            isVideo: isVideo || false
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
      
      // ===== مؤشر الكتابة =====
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

// ============ تشغيل السيرفر ============
const startServer = async () => {
  console.log('🚀 Starting WorldChat Server v2.6.0...');
  console.log('📡 DATABASE_URL:', DATABASE_URL ? 'Set ✅' : 'Missing ❌');
  console.log('🔐 JWT_SECRET:', JWT_SECRET ? 'Set ✅' : 'Missing ❌');
  
  const dbReady = await initDB();
  
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📊 DB Status: ${dbReady ? 'ready ✅' : 'not ready ❌'}`);
    console.log('✨ Features: chat, media, profile, calls, offline_inbox');
    console.log('👥 Multi-device support: enabled');
    console.log('📬 Offline Inbox: enabled');
    console.log('📞 WebRTC Signaling: enabled');
  });
};

startServer();
