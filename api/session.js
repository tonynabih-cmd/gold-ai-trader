export async function getCapitalSession() {
  const baseUrl = process.env.CAPITAL_ENV === 'demo'
    ? 'https://demo-api-capital.backend-capital.com'
    : 'https://api-capital.backend-capital.com';

  const res = await fetch(`${baseUrl}/api/v1/session`, {
    method: 'POST',
    headers: {
      'X-CAP-API-KEY': process.env.CAPITAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: process.env.CAPITAL_EMAIL,
      password: process.env.CAPITAL_PASSWORD,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Capital.com auth failed: ${err}`);
  }

  const cst = res.headers.get('CST');
  const securityToken = res.headers.get('X-SECURITY-TOKEN');
  if (!cst || !securityToken) throw new Error('Capital.com session tokens missing');

  return { baseUrl, cst, securityToken };
}
