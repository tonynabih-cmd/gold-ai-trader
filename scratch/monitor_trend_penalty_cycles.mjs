import fs from 'node:fs';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    args.set(arg.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true');
  }
}

const url = args.get('url') || 'https://gold-ai-trader-navy.vercel.app/api/logger';
const after = args.get('after') || '2026-05-01T17:13:34Z';
const target = Number(args.get('target') || 100);
const limit = Number(args.get('limit') || 300);
const intervalMs = Number(args.get('interval-ms') || 300000);
const rawFile = args.get('raw-file') || 'scratch/gold_trend_penalty_monitor_raw.json';
const reportFile = args.get('report-file') || 'scratch/gold_trend_penalty_monitor_report.json';
const progressFile = args.get('progress-file') || 'scratch/gold_trend_penalty_monitor_progress.log';

function appendProgress(line) {
  fs.appendFileSync(progressFile, `${new Date().toISOString()} ${line}\n`);
}

function fetchJson(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, { timeout: 30000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function countPostDeployCycles(logs) {
  const afterMs = Date.parse(after);
  return logs.filter((log) => Date.parse(log.time) >= afterMs).slice(0, limit).length;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

appendProgress(`monitor started after=${after} target=${target} limit=${limit}`);

while (true) {
  try {
    const logs = await fetchJson(url);
    fs.writeFileSync(rawFile, JSON.stringify(logs));

    const analysis = spawnSync(process.execPath, [
      'scratch/analyze_trend_penalty_cycles.mjs',
      '--file', rawFile,
      '--after', after,
      '--limit', String(limit),
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    if (analysis.status !== 0) {
      throw new Error(analysis.stderr || `analyzer exited ${analysis.status}`);
    }

    fs.writeFileSync(reportFile, analysis.stdout);
    const cycles = countPostDeployCycles(logs);
    appendProgress(`snapshot ok cycles=${cycles} report=${reportFile}`);

    if (cycles >= target) {
      appendProgress(`target reached cycles=${cycles}; monitor exiting`);
      break;
    }
  } catch (err) {
    appendProgress(`snapshot failed: ${err.message}`);
  }

  await sleep(intervalMs);
}
