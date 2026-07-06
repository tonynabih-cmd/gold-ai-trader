function getMockMarketSnapshot() {
  return {
    symbol: "XAUUSD",
    snapshotId: "mock-snapshot-001",
    observedAt: "2099-01-01T12:00:00.000Z",
    priceState: "mock_market_state",
    source: "mock-data",
    note: "Mock response only. Production market data integration omitted in public version."
  };
}

module.exports = {
  getMockMarketSnapshot
};

