require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory session store (single user, local use)
const sessions = {};

function makeSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionMiddleware(req, res, next) {
  const sid = req.headers['x-session-id'];
  req.session = sid && sessions[sid] ? sessions[sid] : {};
  req.sessionId = sid || null;
  next();
}

app.use(sessionMiddleware);

// ── Auth: start OAuth flow ──────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const sid = makeSessionId();
  sessions[sid] = { state };

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly',
      'email',
      'profile'
    ].join(' '),
    access_type: 'offline',
    prompt: 'select_account',
    state: `${sid}:${state}`
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// ── Auth: OAuth callback ────────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  const [sid, stateVal] = (state || '').split(':');
  const session = sessions[sid];

  if (!session || session.state !== stateVal) {
    return res.redirect('/?error=invalid_state');
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Get user info
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    sessions[sid] = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
      user: { email: userRes.data.email, name: userRes.data.name, picture: userRes.data.picture }
    };

    res.redirect(`/?sid=${sid}`);
  } catch (e) {
    console.error('Token exchange error:', e.response?.data || e.message);
    res.redirect(`/?error=${encodeURIComponent('Token exchange failed')}`);
  }
});

// ── Auth: get session info ──────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user });
});

// ── Auth: refresh token ─────────────────────────────────────────────────────
async function ensureFreshToken(session) {
  if (Date.now() < session.expires_at - 60000) return session.access_token;
  if (!session.refresh_token) throw new Error('No refresh token — please sign in again.');

  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: session.refresh_token,
    grant_type: 'refresh_token'
  });

  session.access_token = res.data.access_token;
  session.expires_at = Date.now() + res.data.expires_in * 1000;
  return session.access_token;
}

// ── GA4 proxy ───────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  if (!req.session.access_token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const token = await ensureFreshToken(req.session);
    const response = await axios.post(
      'https://analyticsdata.googleapis.com/v1beta/properties/486245473:runReport',
      req.body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('GA4 error:', msg);
    res.status(e.response?.status || 500).json({ error: msg });
  }
});

// ── GSC proxy ───────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  if (!req.session.access_token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const token = await ensureFreshToken(req.session);
    const site = encodeURIComponent('sc-domain:pennpain.com');
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`,
      req.body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('GSC error:', msg);
    res.status(e.response?.status || 500).json({ error: msg });
  }
});

// ── Logout ──────────────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  if (req.sessionId && sessions[req.sessionId]) delete sessions[req.sessionId];
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ PennPain Dashboard running at http://localhost:${PORT}\n`);
});
