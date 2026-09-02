require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { GoogleAuth } = require('google-auth-library');
const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/486245473';
const GSC_SITE = 'sc-domain:pennpain.com';
const WC_PROFILE = '148479';
const SHEET_ID = '1cXnqHBu9OJXA-TIemxTAm8tkKNDOMbY8hWgWlpbi3P4';
const SHEET_TAB = 'dash data mtd';
const REVIEW_COOKIE = 'pp_reviewer';
const DASH_COOKIE = 'pp_dashboard';

// ── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Google auth (service account) ─────────────────────────────────────────
const gauth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  scopes: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/business.manage'
  ]
});

async function getGAToken() {
  const client = await gauth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// ── Reviewer session helpers ───────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function signSession(data) {
  return jwt.sign(data, process.env.SESSION_SECRET || 'pennpain-secret', { expiresIn: '7d' });
}

function readSession(req) {
  try {
    const token = req.cookies?.[REVIEW_COOKIE];
    if (!token) return null;
    return jwt.verify(token, process.env.SESSION_SECRET || 'pennpain-secret');
  } catch { return null; }
}

// ── GA4 proxy ──────────────────────────────────────────────────────────────
app.post('/api/ga4', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY}:runReport`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── GSC proxy ──────────────────────────────────────────────────────────────
app.post('/api/gsc', async (req, res) => {
  try {
    const token = await getGAToken();
    const response = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
      req.body, { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(response.data);
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── WhatConverts proxy ─────────────────────────────────────────────────────
app.get('/api/whatconverts', async (req, res) => {
  try {
    const { start_date, end_date, per_page = 25, page = 1, quotable } = req.query;
    const token = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');
    const params = { profile_id: WC_PROFILE, start_date, end_date, per_page, page };
    if (quotable) params.quotable = quotable;
    const response = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: { Authorization: `Basic ${token}` },
      params
    });
    const data = response.data;
    const leads = data.leads || [];
    const callLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('call') || (l.lead_type||'').toLowerCase().includes('phone')).length;
    const formLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('form') || (l.lead_type||'').toLowerCase().includes('web')).length;
    const textLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('text') || (l.lead_type||'').toLowerCase().includes('sms')).length;
    res.json({
      total_leads: data.total_leads || 0,
      total_pages: data.total_pages || 1,
      leads,
      summary: { total: data.total_leads || 0, calls: callLeads, forms: formLeads, texts: textLeads }
    });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message, total_leads: 0, leads: [], summary: { total: 0, calls: 0, forms: 0, texts: 0 } });
  }
});

// ── WhatConverts NP Appointments (quotable=yes) ────────────────────────────
app.get('/api/whatconverts/np-appointments', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const token = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');

    // Fetch first page
    const firstRes = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: { Authorization: `Basic ${token}` },
      params: { profile_id: WC_PROFILE, start_date, end_date, quotable: 'yes', per_page: 100, page: 1 }
    });
    const total = firstRes.data.total_leads || 0;
    let leads = firstRes.data.leads || [];

    // WhatConverts returns actual per_page from the response — use that to calculate pages
    const actualPerPage = leads.length || 20;
    const totalPages = actualPerPage > 0 ? Math.ceil(total / actualPerPage) : 1;

    // Fetch remaining pages if needed
    if (totalPages > 1) {
      const pageRequests = [];
      for (let p = 2; p <= totalPages; p++) {
        pageRequests.push(axios.get('https://app.whatconverts.com/api/v1/leads', {
          headers: { Authorization: `Basic ${token}` },
          params: { profile_id: WC_PROFILE, start_date, end_date, quotable: 'yes', per_page: 100, page: p }
        }));
      }
      const pageResults = await Promise.all(pageRequests);
      pageResults.forEach(r => { leads = leads.concat(r.data.leads || []); });
    }
    // Deduplicate by lead_id to avoid double-counting across pages
    const seen = new Set();
    const uniqueLeads = leads.filter(lead => {
      const id = lead.lead_id || lead.id;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const sourceMap = {};
    uniqueLeads.forEach(lead => {
      const source = lead.lead_source || lead.traffic_source || 'direct';
      const medium = lead.lead_medium || lead.traffic_medium || 'none';
      const key = medium === 'cpc' ? 'Google Ads' :
                  source === 'google' && medium === 'organic' ? 'Google Organic' :
                  source === '(direct)' || source === 'direct' ? 'Direct' :
                  medium === 'referral' ? 'Referral' :
                  medium === 'newsletter' || medium === 'email' ? 'Email' :
                  source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Other';
      sourceMap[key] = (sourceMap[key] || 0) + 1;
    });
    const dateMap = {};
    uniqueLeads.forEach(lead => {
      if (lead.date_created) {
        const date = lead.date_created.split('T')[0];
        dateMap[date] = (dateMap[date] || 0) + 1;
      }
    });
    res.json({ total, leads: uniqueLeads.slice(0, 20), by_source: sourceMap, by_date: dateMap });
  } catch (e) {
    res.json({ error: e.message, total: 0, leads: [], by_source: {}, by_date: {} });
  }
});

// ── Google Sheets (Ad Spend + NP Appointments) ────────────────────────────
app.get('/api/adspend', async (req, res) => {
  try {
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:G`
    });
    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ rows: [], total: 0, latest: null, np: null });

    // Columns: A=Date label, B=Week Start, C=Week End, D=Ad Spend, E=NP This Month, F=NP Future, G=NP Total
    const data = rows.slice(1).map(row => ({
      date: row[0] || '',
      week_start: row[1] || '',
      week_end: row[2] || '',
      ad_spend: parseFloat((row[3] || '0').toString().replace(/[$,]/g, '')) || 0,
      np_this_month: parseInt((row[4] || '0').toString().replace(/[^0-9]/g, '')) || 0,
      np_future: parseInt((row[5] || '0').toString().replace(/[^0-9]/g, '')) || 0,
      np_total: parseInt((row[6] || '0').toString().replace(/[^0-9]/g, '')) || 0
    })).filter(r => r.date && r.week_end);

    // Get date range from query params for filtering
    const { start_date, end_date } = req.query;

    // Filter rows by week_end date falling within the selected date range
    const filtered = (start_date && end_date)
      ? data.filter(r => r.week_end >= start_date && r.week_end <= end_date)
      : data;

    const total = filtered.reduce((sum, r) => sum + r.ad_spend, 0);
    const latest = data[0] || null;

    // Sum NP columns only for filtered rows
    const npThisMonthTotal = filtered.reduce((s, r) => s + (r.np_this_month || 0), 0);
    const npFutureTotal = filtered.reduce((s, r) => s + (r.np_future || 0), 0);
    const npTotal = filtered.reduce((s, r) => s + (r.np_total || 0), 0);

    res.json({
      rows: filtered,
      all_rows: data,
      total: Math.round(total * 100) / 100,
      latest,
      np: { this_month: npThisMonthTotal, future: npFutureTotal, total: npTotal }
    });
  } catch (e) {
    res.json({ error: e.message, rows: [], total: 0, latest: null, np: null });
  }
});

// ── Google Business Profile (via Google Sheets — exported from Agency Analytics) ──
app.get('/api/gmb', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const authClient = await gauth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Sheet columns: Date | Impressions | Interactions | Website Clicks | Call Clicks |
    // Direction Requests | Impressions Desktop Maps | Impressions Desktop Search |
    // Impressions Mobile Maps | Impressions Mobile Search
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'gmb_data!A:J'
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ rows: [], totals: {}, timeseries: [] });

    // Parse rows — skip header
    const data = rows.slice(1).map(row => ({
      date: row[0] || '',
      impressions: parseInt((row[1] || '0').replace(/[^0-9]/g, '')) || 0,
      interactions: parseInt((row[2] || '0').replace(/[^0-9]/g, '')) || 0,
      website_clicks: parseInt((row[3] || '0').replace(/[^0-9]/g, '')) || 0,
      calls: parseInt((row[4] || '0').replace(/[^0-9]/g, '')) || 0,
      directions: parseInt((row[5] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_desktop_maps: parseInt((row[6] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_desktop_search: parseInt((row[7] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_mobile_maps: parseInt((row[8] || '0').replace(/[^0-9]/g, '')) || 0,
      impressions_mobile_search: parseInt((row[9] || '0').replace(/[^0-9]/g, '')) || 0
    })).filter(r => r.date && r.date !== 'Date');

    // Filter by date range and exclude zero rows (future dates with no data yet)
    const filtered = data.filter(r => {
      if (r.impressions === 0 && r.interactions === 0 && r.calls === 0) return false;
      if (start_date && end_date) return r.date >= start_date && r.date <= end_date;
      return true;
    });

    // Aggregate totals
    const totals = filtered.reduce((acc, row) => {
      acc.impressions += row.impressions;
      acc.interactions += row.interactions;
      acc.website_clicks += row.website_clicks;
      acc.calls += row.calls;
      acc.directions += row.directions;
      acc.desktop_search += row.impressions_desktop_search;
      acc.mobile_search += row.impressions_mobile_search;
      acc.desktop_maps += row.impressions_desktop_maps;
      acc.mobile_maps += row.impressions_mobile_maps;
      return acc;
    }, { impressions: 0, interactions: 0, website_clicks: 0, calls: 0, directions: 0, desktop_search: 0, mobile_search: 0, desktop_maps: 0, mobile_maps: 0 });

    res.json({ rows: filtered, totals });
  } catch (e) {
    res.json({ error: e.message, rows: [], totals: { impressions: 0, interactions: 0, website_clicks: 0, calls: 0, directions: 0, desktop_search: 0, mobile_search: 0, desktop_maps: 0, mobile_maps: 0 } });
  }
});

// ── GBP API Test (temporary) ──────────────────────────────────────────────
app.get('/api/gbp-test', async (req, res) => {
  const results = {};
  try {
    const client = await gauth.getClient();
    const token = await client.getAccessToken();
    const headers = { Authorization: `Bearer ${token.token}` };
    const { start_date = '2026-07-01', end_date = '2026-07-31' } = req.query;

    // Test 1: List accounts
    try {
      const accountsRes = await axios.get(
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
        { headers }
      );
      results.accounts = accountsRes.data;
    } catch (e) {
      results.accounts_error = e.response?.data?.error || e.message;
    }

    // Test 2: Business Profile Performance API directly with known location IDs
    const locationCandidates = [
      'locations/2010292799224206106',
      'locations/3374609053579023698',
      'locations/9393912307373584702',
      'locations/18285798301489579963'
    ];

    results.performance_tests = [];
    for (const loc of locationCandidates) {
      try {
        const startParts = start_date.split('-');
        const endParts = end_date.split('-');
        const perfRes = await axios.get(
          `https://businessprofileperformance.googleapis.com/v1/${loc}:fetchMultiDailyMetricsTimeSeries`,
          {
            headers,
            params: {
              'dailyMetrics': ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS'].join(','),
              'dailyRange.start_date.year': startParts[0],
              'dailyRange.start_date.month': parseInt(startParts[1]),
              'dailyRange.start_date.day': parseInt(startParts[2]),
              'dailyRange.end_date.year': endParts[0],
              'dailyRange.end_date.month': parseInt(endParts[1]),
              'dailyRange.end_date.day': parseInt(endParts[2]),
            }
          }
        );
        results.performance_tests.push({ location: loc, success: true, data: perfRes.data });
      } catch (e) {
        results.performance_tests.push({ location: loc, success: false, error: e.response?.data?.error?.message || e.message, status: e.response?.status });
      }
    }

    res.json(results);
  } catch (e) {
    res.json({ fatal_error: e.message, partial: results });
  }
});

// ── Dashboard Auth ────────────────────────────────────────────────────────
app.post('/auth/dashboard/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user, error } = await supabase
      .from('dashboard_users')
      .select('*')
      .ilike('email', email.trim())
      .maybeSingle();

    if (error || !user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { email: user.email, name: user.name, role: user.role },
      process.env.SESSION_SECRET || 'pennpain-secret',
      { expiresIn: '30d' }
    );

    res.cookie(DASH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({ ok: true, user: { email: user.email, name: user.name, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/dashboard/me', (req, res) => {
  try {
    const token = req.cookies?.[DASH_COOKIE];
    if (!token) return res.json({ authenticated: false });
    const user = jwt.verify(token, process.env.SESSION_SECRET || 'pennpain-secret');
    res.json({ authenticated: true, user });
  } catch { res.json({ authenticated: false }); }
});

app.post('/auth/dashboard/logout', (req, res) => {
  res.clearCookie(DASH_COOKIE);
  res.json({ ok: true });
});

// ── Review Auth: start OAuth ───────────────────────────────────────────────
app.get('/auth/review/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('pp_review_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.REDIRECT_URI,
    response_type: 'code',
    scope: 'email profile',
    access_type: 'online',
    prompt: 'select_account',
    state
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// ── Review Auth: OAuth callback ────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?review_error=${encodeURIComponent(error)}`);
  const savedState = req.cookies?.pp_review_state;
  if (!savedState || savedState !== state) return res.redirect('/?review_error=invalid_state');
  res.clearCookie('pp_review_state');
  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.REDIRECT_URI, grant_type: 'authorization_code'
    });
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const email = userRes.data.email;
    const { data: reviewer, error: reviewerError } = await supabase
      .from('allowed_reviewers').select('*').ilike('email', email.trim()).maybeSingle();
    if (reviewerError) return res.redirect(`/?review_error=${encodeURIComponent('Database error: ' + reviewerError.message)}`);
    if (!reviewer) return res.redirect(`/?review_error=${encodeURIComponent('not_authorized: ' + email)}`);
    res.cookie(REVIEW_COOKIE, signSession({ email, name: userRes.data.name, picture: userRes.data.picture, role: reviewer.role }), COOKIE_OPTS);
    res.redirect('/?section=documents');
  } catch (e) {
    res.redirect(`/?review_error=${encodeURIComponent('Authentication failed')}`);
  }
});

app.get('/auth/review/me', (req, res) => {
  const session = readSession(req);
  if (!session) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: session });
});

app.post('/auth/review/logout', (req, res) => {
  res.clearCookie(REVIEW_COOKIE);
  res.json({ ok: true });
});

// ── Documents API ──────────────────────────────────────────────────────────
app.get('/api/documents', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/documents', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { title, google_doc_url, description } = req.body;
  if (!title || !google_doc_url) return res.status(400).json({ error: 'Title and Google Doc URL are required' });
  const { data, error } = await supabase.from('documents').insert([{
    title, google_doc_url, description, created_by: session.email, status: 'pending'
  }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/documents/:id/status', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { status } = req.body;
  if (!['pending', 'approved', 'needs_edits'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { data, error } = await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/documents/:id', async (req, res) => {
  const session = readSession(req);
  if (!session || session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { error } = await supabase.from('documents').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/documents/:id/comments', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { data, error } = await supabase.from('comments').select('*').eq('document_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/documents/:id/comments', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const { data, error } = await supabase.from('comments').insert([{
    document_id: req.params.id, author_email: session.email,
    author_name: session.name || session.email, body: body.trim()
  }]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n✅ PennPain Dashboard running at http://localhost:${PORT}\n`));
module.exports = app;
