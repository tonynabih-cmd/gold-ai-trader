import './load_env.js';
import handler from './api/cron.js';

const req = {
  headers: {
    'authorization': process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : 'Bearer MISSING_CRON_SECRET'
  }
};

const res = {
  status: (code) => {
    console.log('Status:', code);
    return res;
  },
  json: (data) => {
    console.log('Response JSON:', JSON.stringify(data, null, 2));
    return res;
  }
};

async function trigger() {
  console.log('Triggering cron manually...');
  try {
    await handler(req, res);
    console.log('Cron execution finished.');
  } catch (err) {
    console.error('Cron execution failed:', err);
  }
}

trigger();
