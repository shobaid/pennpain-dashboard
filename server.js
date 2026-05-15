require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
  SESSION_SECRET
} = process.env;

const COOKIE_NAME = 'pp_session';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// ── Session helpers ────────────────────────────────────────────────────────
function signSession(data) {
  return jwt.sign(data, SESSION_SECRET, { expiresIn: '7d' });
}

function readSession(req) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return null;
    return jwt.verify(token, SESSION_SECRET);
  } catch {
    return null;
  }
}

// ── Auth: start OAuth flow ─────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in a short-lived cookie to verify on callback
  res.cookie('pp_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/webmasters.readonly',
      'email',
      'profile'
    ].join(' '),
    access_type: 'offline',
    prompt: 'select_account',
    state
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// ── Auth: OAuth callback ───────────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  const savedState = req.cookies?.pp_state;
  if (!savedState || savedState !== state) return res.redirect('/?error=invalid_state');

  res.clearCookie('pp_state');

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    const userRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const sessionData = {
      access_token,
      refresh_token: refresh_token || null,
      expires_at: Date.now() + expires_in * 1000,
      user: {
        email: userRes.data.email,
        name: userRes.data.name,
        picture: userRes.data.picture
      }
    };

    res.cookie(COOKIE_NAME, signSession(sessionData), COOKIE_OPTS);
    res.redirect('/');
  } catch (e) {
    console.error('Token exchange error:', e.response?.data || e.message);
    res.redirect(`/?error=${encodeURIComponent('Token exchange failed')}`);
  }
});

// ── Auth: get session info ─────────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  const session = readSession(req);
  if (!session?.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: session.user });
});

// ── Token refresh ──────────────────────────────────────────────────────────
async function getFreshToken(session, res) {
  if (Date.now() < session.expires_at - 60000) return session.access_token;

  if (!session.refresh_token) throw new Error('Session expired — please sign in again.');

  const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: session.refresh_token,
    grant_type: 'refresh_token'
  });

  const newSession = {
    ...session,
    access_token: tokenRes.data.access_token,
    expires_at: Date.now() + tokenRes.data.expires_in * 1000
  };

  // Rewrite cookie with refreshed token
  res.cookie(COOKIE_NAME, signSession(newSession), COOKIE_OPTS);
  return newSession.access_token;
}

// ── GA4 proxy ──────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  const session = readSession(req);
  if (!session?.access_token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const token = await getFreshToken(session, res);
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

// ── GSC proxy ──────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  const session = readSession(req);
  if (!session?.access_token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const token = await getFreshToken(session, res);
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

// ── Logout ─────────────────────────────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ PennPain Dashboard running at http://localhost:${PORT}\n`);
});

module.exports = app;
