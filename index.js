const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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
  } catch (err) {
    console.error('❌ DB init error:', err);
  }
};
initDB();

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'worldchat' });
});

// Register
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashed]);
    const token = jwt.sign({ username }, JWT_SECRET);
    res.json({ token, username });
  } catch (e) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
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
    res.json({ token, username });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get messages between two users
app.post('/messages', async (req, res) => {
  const { myUsername, otherUsername } = req.body;
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE 
       (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
       ORDER BY timestamp ASC`,
      [myUsername, otherUsername]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users
app.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT username FROM users ORDER BY username');
    res.json(result.rows);
  } catch (e) {
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
        const { receiver, content } = data;
        
        // Save to database
        await pool.query(
          'INSERT INTO messages (sender, receiver, content) VALUES ($1, $2, $3)',
          [username, receiver, content]
        );
        
        // Send to receiver if online
        const receiverWs = clients.get(receiver);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
          receiverWs.send(JSON.stringify({
            type: 'message',
            sender: username,
            content: content,
            timestamp: new Date().toISOString()
          }));
        }
        
        // Confirm to sender
        ws.send(JSON.stringify({ 
          type: 'sent',
          timestamp: new Date().toISOString()
        }));
      }
    } catch (e) {
      console.error('❌ WS error:', e);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      console.log(`❌ ${username} disconnected`);
    }
  });
});

server.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
