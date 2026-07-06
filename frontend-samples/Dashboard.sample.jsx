import TradeStatusCard from "./TradeStatusCard.sample";
import RiskPanel from "./RiskPanel.sample";

const mockTrades = [
  {
    id: "mock-trade-001",
    symbol: "XAUUSD",
    direction: "MOCK_BUY",
    status: "SIMULATED_ONLY"
  }
];

export default function DashboardSample() {
  return (
    <main className="dashboard-shell">
      <section className="dashboard-header">
        <h1>Gold AI Trader</h1>
        <p>Public-safe monitoring dashboard sample using mock data.</p>
      </section>

      <RiskPanel
        status="PUBLIC_SAMPLE_ONLY"
        summary="Private risk formulas omitted in public version."
      />

      <section className="trade-list">
        {mockTrades.map((trade) => (
          <TradeStatusCard key={trade.id} trade={trade} />
        ))}
      </section>
    </main>
  );
}

