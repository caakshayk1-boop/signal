export class DeliveryError extends Error {
  constructor(retryable) { super('Delivery provider unavailable'); this.retryable = retryable; }
}

export function missingConfiguration(env, { owner = false } = {}) {
  return ['TURSO_URL', 'TURSO_TOKEN', 'RESEND_API_KEY', 'SIGNAL_EMAIL_FROM', 'SIGNAL_PUBLIC_URL', 'DELIVERY_TOKEN_SECRET', ...(owner ? ['EDIT_KEY'] : [])].filter(k => !env[k] || (k === 'DELIVERY_TOKEN_SECRET' && env[k].length < 32));
}

export function publicOrigin(env) {
  const u = new URL(env.SIGNAL_PUBLIC_URL);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Invalid public URL');
  return u.origin;
}

export function resendProvider(env, fetcher = fetch) {
  return async (message, key) => {
    const r = await fetcher('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: env.SIGNAL_EMAIL_FROM, ...message }),
    });
    if (!r.ok) throw new DeliveryError(r.status === 429 || r.status >= 500);
    const body = await r.json();
    if (typeof body.id !== 'string') throw new DeliveryError(true);
    return body.id;
  };
}
