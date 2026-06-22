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
const WC_PROFILE = '148479';

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

// ── WhatConverts proxy — single combined endpoint ──────────────────────────
// Fetches leads + derives summary in one request to avoid rate limiting
app.get('/api/whatconverts', async (req, res) => {
  try {
    const { start_date, end_date, per_page = 25, page = 1 } = req.query;
    const token = Buffer.from(
      `${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`
    ).toString('base64');

    const response = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json'
      },
      params: {
        profile_id: WC_PROFILE,
        start_date,
        end_date,
        per_page,
        page
      }
    });

    const data = response.data;
    const leads = data.leads || [];

    // Derive summary counts from the returned leads + total
    const callLeads = leads.filter(l =>
      (l.lead_type || '').toLowerCase().includes('call') ||
      (l.lead_type || '').toLowerCase().includes('phone')
    ).length;

    const formLeads = leads.filter(l =>
      (l.lead_type || '').toLowerCase().includes('form') ||
      (l.lead_type || '').toLowerCase().includes('web')
    ).length;

    const textLeads = leads.filter(l =>
      (l.lead_type || '').toLowerCase().includes('text') ||
      (l.lead_type || '').toLowerCase().includes('sms') ||
      (l.lead_type || '').toLowerCase().includes('chat')
    ).length;

    res.json({
      total_leads: data.total_leads || 0,
      total_pages: data.total_pages || 1,
      leads,
      summary: {
        total: data.total_leads || 0,
        calls: callLeads,
        forms: formLeads,
        texts: textLeads
      }
    });
  } catch (e) {
    const status = e.response?.status || 500;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    console.error('WhatConverts error:', status, msg);
    // Return empty data instead of crashing so GA4 conversions still render
    res.status(status).json({
      error: msg,
      total_leads: 0,
      leads: [],
      summary: { total: 0, calls: 0, forms: 0, texts: 0 }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ PennPain Dashboard running at http://localhost:${PORT}\n`);
});

module.exports = app;
