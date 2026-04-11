import fs from 'fs';
import handler from './api/cron.js';

// Load .env.local
try {
  const envText = fs.readFileSync('.env.local', 'utf-8');
  envText.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        process.env[k] = v;
      }
    }
  });
} catch (e) {
  console.log("Could not load .env.local:", e.message);
}

// Mock request and response
const req = {
  headers: { 'authorization': `Bearer ${process.env.CRON_SECRET}` }
};
const res = {
  status: (code) => {
    console.log(`HTTP STATUS: ${code}`);
    return res;
  },
  json: (data) => {
    console.log('--- CRON RESPONSE ---');
    console.log(JSON.stringify(data, null, 2));
    console.log('---------------------');
  }
};

console.log('Starting Test Run...');
handler(req, res).catch(err => {
  console.error('CRON FATAL ERROR:', err);
});
