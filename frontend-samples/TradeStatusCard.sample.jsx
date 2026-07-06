export default function TradeStatusCard({ trade }) {
  return (
    <article className="trade-status-card">
      <h2>{trade.symbol}</h2>
      <dl>
        <div>
          <dt>Direction</dt>
          <dd>{trade.direction}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{trade.status}</dd>
        </div>
      </dl>
      <p>Mock response only. Live order status is excluded.</p>
    </article>
  );
}

