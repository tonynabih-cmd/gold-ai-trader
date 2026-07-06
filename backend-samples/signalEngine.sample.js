function generateMockSignal(marketSnapshot) {
  return {
    symbol: "XAUUSD",
    direction: "MOCK_BUY",
    confidence: "mock_value",
    reason: "Private signal logic omitted in public version.",
    executionEnabled: false,
    marketSnapshotId: marketSnapshot?.snapshotId || "mock-snapshot-id"
  };
}

module.exports = {
  generateMockSignal
};

