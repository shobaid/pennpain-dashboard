// Run this script to find your GBP Account ID and Location IDs
// Usage: node find-gbp-locations.js
require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');

const gauth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  scopes: ['https://www.googleapis.com/auth/business.manage']
});

async function findLocations() {
  try {
    const client = await gauth.getClient();
    const token = await client.getAccessToken();
    const headers = { Authorization: `Bearer ${token.token}` };

    console.log('\n🔍 Finding GBP accounts...\n');

    // Step 1: Get accounts
    const accountsRes = await axios.get(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers }
    );

    const accounts = accountsRes.data.accounts || [];
    console.log(`Found ${accounts.length} account(s):\n`);

    for (const account of accounts) {
      console.log(`Account: ${account.name}`);
      console.log(`  Type: ${account.type}`);
      console.log(`  Account Name: ${account.accountName}`);
      console.log(`  ID: ${account.name}\n`);

      // Step 2: Get locations for each account
      try {
        const locRes = await axios.get(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress`,
          { headers }
        );

        const locations = locRes.data.locations || [];
        console.log(`  📍 Locations (${locations.length}):`);
        locations.forEach(loc => {
          console.log(`    - ${loc.title}`);
          console.log(`      ID: ${loc.name}`);
          if (loc.storefrontAddress) {
            console.log(`      Address: ${loc.storefrontAddress.addressLines?.join(', ')}, ${loc.storefrontAddress.locality}`);
          }
          console.log('');
        });
      } catch (locErr) {
        console.log(`  ⚠ Could not fetch locations: ${locErr.response?.data?.error?.message || locErr.message}`);
      }
    }
  } catch (e) {
    console.error('Error:', e.response?.data?.error || e.message);
    if (e.response?.data?.error?.message?.includes('SERVICE_DISABLED')) {
      console.log('\n💡 Enable these APIs in Google Cloud:');
      console.log('  - My Business Account Management API');
      console.log('  - My Business Business Information API');
      console.log('  - Business Profile Performance API');
    }
  }
}

findLocations();
