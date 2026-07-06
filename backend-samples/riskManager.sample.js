function reviewMockRisk(signal) {
  return {
    approved: false,
    status: "PUBLIC_SAMPLE_ONLY",
    reason: "Private risk formulas omitted in public version.",
    signalDirection: signal?.direction || "MOCK_DIRECTION",
    executionEnabled: false
  };
}

module.exports = {
  reviewMockRisk
};

