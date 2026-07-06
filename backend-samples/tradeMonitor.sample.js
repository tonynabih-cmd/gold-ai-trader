function buildMockTradeStatus(tradeId = "mock-trade-id") {
  return {
    tradeId,
    symbol: "XAUUSD",
    status: "SIMULATED_MONITORING_ONLY",
    lifecycle: ["mock_signal_created", "mock_risk_reviewed", "mock_order_blocked"],
    message: "Mock response only. Real trade monitoring and logs are excluded."
  };
}

module.exports = {
  buildMockTradeStatus
};

