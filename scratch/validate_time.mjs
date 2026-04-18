import { getMarketData } from '../lib/market_data.js';

// We want to test timestamp normalization and validation 
// specifically checking the logic inside getMarketData.
// However getMarketData uses fetchWithTimeout which reaches out to baseUrl.
// We can test the getMarketData function by intercepting fetch!

// By patching global.fetch we can intercept fetchWithTimeout since it uses native fetch.
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (url.includes('/markets/GOLD')) {
    return {
      ok: true,
      json: async () => ({ snapshot: { bid: 2000, offer: 2000.5 } })
    };
  }

  if (url.includes('resolution=HOUR')) {
    return {
      ok: true,
      json: async () => {
        let prices = [];
        let time = Date.now() - 60 * 60 * 1000 * 65;
        // align to hour
        time = time - (time % (60 * 60 * 1000));
        for(let i=0; i<60; i++) {
          prices.push({
            snapshotTime: new Date(time + i * 60 * 60 * 1000).toISOString().replace('Z', ''), // MISSING Z ON PURPOSE
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
          });
        }
        prices.push({
            snapshotTime: new Date(Date.now() + 1000000).toISOString().replace('Z', ''), // IN PROGRESS CANDLE
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
        });
        return { prices };
      }
    };
  }
  
  if (url.includes('resolution=MINUTE_5')) {
    return {
      ok: true,
      json: async () => {
        let prices = [];
        // current time aligned to 5m closest
        const currentMs = Date.now();
        const base = currentMs - (currentMs % (5 * 60 * 1000));
        let time = base - 5 * 60 * 1000 * 1005; 
        for(let i=0; i<1005; i++) {
          prices.push({
            snapshotTime: new Date(time + i * 5 * 60 * 1000).toISOString().replace('Z', ''), // MISSING Z ON PURPOSE
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
          });
        }
        // In-progress candle (the one starting exactly AT base)
        prices.push({
            snapshotTime: new Date(base).toISOString().replace('Z', ''), // MISSING Z ON PURPOSE
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
        });
        return { prices };
      }
    };
  }

  if (url.includes('resolution=MINUTE')) {
    return {
      ok: true,
      json: async () => {
        let prices = [];
        let time = Date.now() - 60 * 1000 * 10;
        time = time - (time % (60 * 1000));
        for(let i=0; i<10; i++) {
          prices.push({
            snapshotTime: new Date(time + i * 60 * 1000).toISOString().replace('Z', ''), // MISSING Z
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
        });
        }
        prices.push({
            snapshotTime: new Date(Date.now() + 1000000).toISOString().replace('Z', ''), // IN PROGRESS CANDLE
            openPrice: { bid: 2000 },
            highPrice: { bid: 2001 },
            lowPrice: { bid: 1999 },
            closePrice: { bid: 2000 }
        });
        return { prices };
      }
    };
  }

  return { ok: false };
};

const session = { baseUrl: 'mock', cst: 'mock', securityToken: 'mock' };
const botState = { lastProcessedCandle: 0 };

async function run() {
  console.log("Current System UTC:", new Date().toISOString());
  console.log("Mocking broker time WITHOUT 'Z' to simulate Date parsing behavior.");
  
  const result = await getMarketData(session, botState);
  console.log("\\Result summary:", { skip: result.skip, reason: result.reason, candles5mLen: result.candles5m?.length });
  
  if (result.candles5m && result.candles5m.length > 0) {
    const latest = result.candles5m[result.candles5m.length - 1];
    const timeMs = latest.time;
    // Check multiple of 5 min
    const isMultiple = (timeMs % (5 * 60 * 1000) === 0);
    console.log("Latest closed 5m candle time exact multiple of 5m:", isMultiple);
    console.log("Latest closed 5m candle time:", new Date(timeMs).toISOString());
  }
}

run();
