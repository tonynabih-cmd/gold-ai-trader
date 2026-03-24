import fs from 'fs';
try {
  const env = fs.readFileSync('.env.local', 'utf-8');
  env.split('\n').forEach(line => {
    if (line.trim() && !line.startsWith('#')) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        process.env[line.substring(0, idx).trim()] = line.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      }
    }
  });
  console.log('Environment variables loaded from .env.local');
} catch (e) {
  console.error('Failed to load .env.local:', e.message);
}
