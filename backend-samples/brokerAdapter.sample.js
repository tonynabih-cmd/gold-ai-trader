async function placeMockOrder(orderRequest) {
  return {
    status: "SIMULATED_ONLY",
    message: "Live broker execution is excluded from the public version.",
    orderId: "mock-order-id",
    requestAccepted: Boolean(orderRequest),
    executionEnabled: false
  };
}

module.exports = {
  placeMockOrder
};

