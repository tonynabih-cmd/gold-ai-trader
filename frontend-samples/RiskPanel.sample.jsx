export default function RiskPanel({ status, summary }) {
  return (
    <section className="risk-panel">
      <h2>Risk Review</h2>
      <p>{status}</p>
      <p>{summary}</p>
    </section>
  );
}

