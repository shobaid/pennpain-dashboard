require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { GoogleAuth } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const GA4_PROPERTY = 'properties/486245473';
const GSC_SITE = 'sc-domain:pennpain.com';
const WC_PROFILE = '148479';
const REVIEW_COOKIE = 'pp_reviewer';

// ── Supabase ───────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Google service account auth (for GA4/GSC) ──────────────────────────────
const gauth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  scopes: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly'
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
    const { start_date, end_date, per_page = 25, page = 1 } = req.query;
    const token = Buffer.from(`${process.env.WHATCONVERTS_TOKEN}:${process.env.WHATCONVERTS_SECRET}`).toString('base64');
    const response = await axios.get('https://app.whatconverts.com/api/v1/leads', {
      headers: { Authorization: `Basic ${token}` },
      params: { profile_id: WC_PROFILE, start_date, end_date, per_page, page }
    });
    const data = response.data;
    const leads = data.leads || [];
    const callLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('call') || (l.lead_type||'').toLowerCase().includes('phone')).length;
    const formLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('form') || (l.lead_type||'').toLowerCase().includes('web')).length;
    const textLeads = leads.filter(l => (l.lead_type||'').toLowerCase().includes('text') || (l.lead_type||'').toLowerCase().includes('sms') || (l.lead_type||'').toLowerCase().includes('chat')).length;
    res.json({ total_leads: data.total_leads || 0, total_pages: data.total_pages || 1, leads, summary: { total: data.total_leads || 0, calls: callLeads, forms: formLeads, texts: textLeads } });
  } catch (e) {
    res.status(e.response?.status || 500).json({ error: e.message, total_leads: 0, leads: [], summary: { total: 0, calls: 0, forms: 0, texts: 0 } });
  }
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
    console.log('Checking reviewer access for:', email);
    
    // Check if reviewer is allowed - use maybeSingle to avoid error on no match
    const { data: reviewer, error: reviewerError } = await supabase
      .from('allowed_reviewers')
      .select('*')
      .ilike('email', email.trim())
      .maybeSingle();
    
    console.log('Reviewer lookup result:', { reviewer, reviewerError });
    
    if (reviewerError) {
      console.error('Supabase error:', reviewerError);
      return res.redirect(`/?review_error=${encodeURIComponent('Database error: ' + reviewerError.message)}`);
    }
    
    if (!reviewer) {
      console.log('Email not found in allowed_reviewers:', email);
      return res.redirect(`/?review_error=${encodeURIComponent('not_authorized: ' + email)}`);
    }
    
    res.cookie(REVIEW_COOKIE, signSession({ email, name: userRes.data.name, picture: userRes.data.picture, role: reviewer.role }), COOKIE_OPTS);
    res.redirect('/?section=documents');
  } catch (e) {
    console.error('Review auth error:', e.message);
    res.redirect(`/?review_error=${encodeURIComponent('Authentication failed')}`);
  }
});

// ── Review Auth: me ────────────────────────────────────────────────────────
app.get('/auth/review/me', (req, res) => {
  const session = readSession(req);
  if (!session) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: session });
});

// ── Review Auth: logout ────────────────────────────────────────────────────
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

// ── Comments API ───────────────────────────────────────────────────────────
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
