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
app.use(express.json());

// Database - معالجة خطأ SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_this';

// Create tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Database tables ready');
    return true;
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    return false;
  }
};

// Health check with DB status
app.get('/health', async (req, res) => {
  let dbStatus = 'unknown';
  let usersCount = 0;
  
  try {
    const result = await pool.query('SELECT COUNT(*) FROM users');
    usersCount = parseInt(result.rows[0].count);
    dbStatus = 'up';
  } catch (e) {
    dbStatus = e.message.includes('does not exist') ? 'no_tables' : 'down';
    console.log('Health DB error:', e.message);
  }
  
  res.json({
    ok: true,
    service: 'worldchat',
    version: '1.1.0',
    db: dbStatus,
    usersCount: usersCount
  });
});

// Register
app.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  
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
    const existing = await pool.query('SELECT username FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password, display_name) VALUES ($1, $2, $3)',
      [username, hashed, displayName || username]
    );
    
    const token = jwt.sign({ username }, JWT_SECRET);
    res.json({ token, username, displayName: displayName || username });
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
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
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
      displayName: result.rows[0].display_name || username 
    });
  } catch (e) {
    console.error('Login error:', e.message);
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
    const result = await pool.query(
      `SELECT * FROM messages WHERE 
       (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
       ORDER BY timestamp ASC`,
      [myUsername, otherUsername]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('Messages error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

// Get all users
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT username, display_name FROM users ORDER BY username');
    res.json(result.rows);
  } catch (e) {
    console.error('Users error:', e.message);
    res.status(500).json({ error: 'Server error: ' + e.message });
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
        const { receiver, content } = data;
        
        if (!receiver || !content) {
          return;
        }
        
        await pool.query(
          'INSERT INTO messages (sender, receiver, content) VALUES ($1, $2, $3)',
          [username, receiver, content]
        );
        
        const receiverWs = clients.get(receiver);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
          receiverWs.send(JSON.stringify({
            type: 'message',
            sender: username,
            content: content,
            timestamp: new Date().toISOString()
          }));
        }
        
        ws.send(JSON.stringify({ 
          type: 'sent',
          timestamp: new Date().toISOString()
        }));
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
  const dbReady = await initDB();
  if (!dbReady) {
    console.log('⚠️ Database not ready, but server will start');
  }
  
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`📊 DB Status: ${dbReady ? 'ready' : 'not ready'}`);
  });
};

startServer();
