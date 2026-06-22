require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/486245473';
const GSC_SITE = 'sc-domain:pennpain.com';

// ── Service account auth ───────────────────────────────────────────────────
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  scopes: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly'
  ]
});

async function getToken() {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ── GA4 proxy ──────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  try {
    const token = await getToken();
    const response = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
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
  try {
    const token = await getToken();
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ PennPain Dashboard (public) running at http://localhost:${PORT}\n`);
});

module.exports = app;
