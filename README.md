# PennPain Analytics Dashboard

Live GA4 + Google Search Console dashboard running locally via Node.js.

---

## Setup (one-time)

### 1. Get your OAuth Client Secret

1. Go to https://console.cloud.google.com → PennPain project
2. APIs & Services → Credentials
3. Click your OAuth 2.0 Client → copy the **Client Secret**

### 2. Update Authorized URIs in Google Cloud

In your OAuth client settings, make sure these are set:

**Authorized JavaScript origins:**
```
http://localhost:3000
```

**Authorized redirect URIs:**
```
http://localhost:3000/auth/callback
```

### 3. Add your Client Secret to .env

Open `.env` and replace `YOUR_CLIENT_SECRET_HERE` with your actual client secret.

### 4. Make sure these APIs are enabled

In Google Cloud → APIs & Services → Enabled APIs:
- ✅ Google Analytics Data API
- ✅ Google Search Console API

---

## Running the dashboard

```bash
node server.js
```

Then open: **http://localhost:3000**

Click **Sign in with Google**, authenticate with momentumlocalseo@gmail.com, and your live data loads.

---

## Features

- **GA4:** Sessions, Users, Bounce Rate, Avg. Session Duration, Conversions
- **GSC:** Impressions, Clicks, CTR, Avg. Position
- **Charts:** Sessions/Users over time, Traffic sources donut, Impressions vs Clicks
- **Tables:** Top pages with bar indicators, Top search queries with position colour-coding
- **Date range:** Last 7 / 28 / 90 days
- **Token refresh:** Automatically refreshes your access token using the refresh token

---

## Files

```
pennpain-dashboard/
├── server.js          ← Express server + OAuth2 handler + API proxies
├── .env               ← Your credentials (never commit this)
├── public/
│   └── index.html     ← The dashboard UI
├── package.json
└── README.md
```
