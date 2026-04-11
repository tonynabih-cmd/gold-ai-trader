import fs from 'fs';
import { Redis } from '@upstash/redis';

// Load .env.local
try {
  const envFile = fs.readFileSync('c:/Users/Antho/Downloads/gold-trader/.env.local', 'utf8');
  const envLines = envFile.split('\n');
  envLines.forEach(line => {
    const match = line.match(/^([^#\s=]+)="?([^"\n\r]*)"?/);
    if (match) {
      process.env[match[1]] = match[2];
    }
  });
} catch (e) {}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const raw = await redis.lrange('trade_logs_list', -200, -1);
  const logs = raw.map(entry => typeof entry === 'string' ? JSON.parse(entry) : entry);
  
  const pullbackRejections = logs.filter(l => (l.dbgRejectReason || '').includes('pullback: price not close enough'));
  
  if (pullbackRejections.length === 0) {
    console.log('No pullback rejections in the last 200 cycles.');
    return;
  }

  const distances = pullbackRejections.map(l => {
    const match = l.dbgRejectReason.match(/dist ([\d.]+), threshold ([\d.]+)/);
    if (match) {
      return { dist: parseFloat(match[1]), threshold: parseFloat(match[2]), goldPrice: l.goldPrice };
    }
    return null;
  }).filter(d => d !== null);

  const avgDist = distances.reduce((sum, d) => sum + d.dist, 0) / distances.length;
  const minDist = Math.min(...distances.map(d => d.dist));
  const maxDist = Math.max(...distances.map(d => d.dist));
  
  // Best threshold to capture X% of these?
  // Let's see how many have dist < 12 (roughly 0.25% of 4800)
  const countUnder12 = distances.filter(d => d.dist < 12).length;
  const countUnder10 = distances.filter(d => d.dist < 10).length;
  const countUnder8 = distances.filter(d => d.dist < 8).length;

  console.log(`Pullback Rejections: ${pullbackRejections.length}`);
  console.log(`Avg Dist: ${avgDist.toFixed(2)}`);
  console.log(`Min Dist: ${minDist.toFixed(2)}`);
  console.log(`Max Dist: ${maxDist.toFixed(2)}`);
  console.log(`Count under 12: ${countUnder12}`);
  console.log(`Count under 10: ${countUnder10}`);
  console.log(`Count under 8: ${countUnder8}`);
  
  // Percentages
  const currentAvgPrice = distances[0]?.goldPrice || 4800;
  console.log(`Current threshold (0.15%): ${(currentAvgPrice * 0.0015).toFixed(2)}`);
  console.log(`Potential threshold (0.20%): ${(currentAvgPrice * 0.0020).toFixed(2)}`);
  console.log(`Potential threshold (0.25%): ${(currentAvgPrice * 0.0025).toFixed(2)}`);
}

main().catch(console.error);
