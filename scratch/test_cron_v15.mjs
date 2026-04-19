import fs from 'fs';

// Load .env.local BEFORE any imports that might use process.env at top-level
try {
  const envText = fs.readFileSync('.env.local', 'utf-8');
  envText.split(/\r?\n/).forEach(line => {
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

// Now use dynamic import for the handler
async function run() {
    const { default: handler } = await import('../api/cron.js');

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
    try {
        await handler(req, res);
    } catch (err) {
        console.error('CRON FATAL ERROR:', err);
    }
}

run();
