const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const WebSocket = require('ws');
const http = require('http');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

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

// Create tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        profile_pic TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT,
        media_type TEXT,
        media_url TEXT,
        reply_to INTEGER,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);
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
    console.log('✅ Database tables ready (v2.2)');
    return true;
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    return false;
  }
};

// Health check
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
    version: '2.2.0',
    db: dbStatus,
    usersCount: usersCount,
    features: ['chat', 'media', 'profile', 'calls']
  });
});

// Register
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

// Login
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
        profilePic: result.rows[0].profile_pic || null
      });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Update profile
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

// Get messages
app.post('/messages', async (req, res) => {
  const { myUsername, otherUsername } = req.body;
  
  if (!myUsername || !otherUsername) {
    return res.status(400).json({ error: 'Both usernames required' });
  }
  
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM messages WHERE 
         (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
         ORDER BY timestamp ASC`,
        [myUsername, otherUsername]
      );
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Messages error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Get all users
app.get('/users', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT username, display_name, profile_pic FROM users ORDER BY username');
      res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('Users error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// WebRTC Signaling
app.post('/webrtc', async (req, res) => {
  const { type, from, to, data } = req.body;
  
  if (!type || !from || !to) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  
  try {
    // Save call record
    if (type === 'call-start') {
      await pool.query(
        'INSERT INTO calls (caller, receiver, status) VALUES ($1, $2, $3)',
        [from, to, 'ringing']
      );
    }
    
    if (type === 'call-end') {
      await pool.query(
        'UPDATE calls SET status = $1, ended_at = NOW() WHERE caller = $2 AND receiver = $3 AND ended_at IS NULL',
        ['ended', from, to]
      );
    }
    
    res.json({ success: true });
  } catch (e) {
    console.error('WebRTC error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// WebSocket Server
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
        } catch (e) {
          ws.send(JSON.stringify({ type: 'auth_fail' }));
        }
      }
      
      if (data.type === 'message' && username) {
        const { receiver, content, mediaType, mediaUrl, replyTo } = data;
        
        if (!receiver) return;
        
        const client = await pool.connect();
        try {
          await client.query(
            `INSERT INTO messages (sender, receiver, content, media_type, media_url, reply_to) 
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [username, receiver, content || null, mediaType || null, mediaUrl || null, replyTo || null]
          );
        } finally {
          client.release();
        }
        
        // Send to receiver if online
        const receiverWs = clients.get(receiver);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
          receiverWs.send(JSON.stringify({
            type: 'message',
            sender: username,
            content: content || null,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            replyTo: replyTo || null,
            timestamp: new Date().toISOString()
          }));
        }
        
        ws.send(JSON.stringify({ type: 'sent' }));
      }
      
      // WebRTC Signaling
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
      
    } catch (e) {
      console.error('❌ WS error:', e.message);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      console.log(`❌ ${username} disconnected`);
    }
  });
});

// Start server
const startServer = async () => {
  console.log('🚀 Starting WorldChat Server v2.2...');
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
