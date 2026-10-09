// All migrations are additive. A legacy 'active' row is NOT evidence of consent.
export async function migrate(client) {
  const tx = await client.transaction('write');
  try {
    await tx.execute(`CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      source TEXT, created_at TEXT NOT NULL, ip_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending', user_agent TEXT)`);
    const cols = new Set((await tx.execute('PRAGMA table_info(subscribers)')).rows.map(r => r.name));
    for (const [name, type] of Object.entries({ confirmed_at: 'TEXT', digest_enabled: 'INTEGER NOT NULL DEFAULT 1', alerts_enabled: 'INTEGER NOT NULL DEFAULT 0', token_nonce: 'TEXT', confirmation_hash: 'TEXT', confirmation_expires_at: 'TEXT', unsubscribe_hash: 'TEXT', confirmation_requested_at: 'TEXT' })) {
      if (!cols.has(name)) await tx.execute(`ALTER TABLE subscribers ADD COLUMN ${name} ${type}`);
    }
    await tx.execute("UPDATE subscribers SET status='pending' WHERE status='active' AND confirmed_at IS NULL");
    await tx.execute('CREATE UNIQUE INDEX IF NOT EXISTS subscriber_confirmation ON subscribers(confirmation_hash)');
    await tx.execute('CREATE UNIQUE INDEX IF NOT EXISTS subscriber_unsubscribe ON subscribers(unsubscribe_hash)');
    await tx.execute('CREATE TABLE IF NOT EXISTS subscription_attempts (ip_hash TEXT NOT NULL, attempted_at TEXT NOT NULL)');
    await tx.execute('CREATE INDEX IF NOT EXISTS subscription_attempt_time ON subscription_attempts(ip_hash, attempted_at)');
    await tx.execute(`CREATE TABLE IF NOT EXISTS delivery_receipts (
      delivery_key TEXT PRIMARY KEY, subscriber_id INTEGER, channel TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TEXT NOT NULL, next_attempt_at TEXT, lease_until TEXT,
      provider_id TEXT, updated_at TEXT NOT NULL, content_id TEXT, consent_nonce TEXT)`);
    const receiptCols = new Set((await tx.execute('PRAGMA table_info(delivery_receipts)')).rows.map(r => r.name));
    for (const name of ['content_id', 'consent_nonce']) if (!receiptCols.has(name)) await tx.execute(`ALTER TABLE delivery_receipts ADD COLUMN ${name} TEXT`);
    await tx.execute('CREATE INDEX IF NOT EXISTS receipt_recipient_content ON delivery_receipts(subscriber_id,channel,content_id,consent_nonce)');
    await tx.execute('CREATE TABLE IF NOT EXISTS delivery_plan_states (plan_key TEXT PRIMARY KEY, state TEXT NOT NULL, session_date TEXT NOT NULL)');
    await tx.execute('CREATE TABLE IF NOT EXISTS delivery_events (event_key TEXT PRIMARY KEY, session_date TEXT NOT NULL, content TEXT NOT NULL)');
    await tx.commit();
  } finally { tx.close(); }
}

export async function consumeAttempt(client, ipHash, now) {
  const tx = await client.transaction('write');
  try {
    const since = new Date(+now - 3600000).toISOString();
    await tx.execute({ sql: 'DELETE FROM subscription_attempts WHERE attempted_at < ?', args: [since] });
    const n = Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM subscription_attempts WHERE ip_hash=?', args: [ipHash] })).rows[0].n);
    await tx.execute({ sql: 'INSERT INTO subscription_attempts VALUES (?,?)', args: [ipHash, now.toISOString()] });
    await tx.commit();
    return n < 5;
  } finally { tx.close(); }
}

// Durable leases avoid concurrent sends. Retry windows stay inside Resend's
// 24-hour idempotency retention; ambiguous older attempts require reconciliation.
export async function claim(client, key, subscriberId, channel, now, contentId = null, consentNonce = null) {
  const iso = now.toISOString(), lease = new Date(+now + 120000).toISOString();
  const tx = await client.transaction('write');
  try {
    await tx.execute({ sql: `INSERT OR IGNORE INTO delivery_receipts
      (delivery_key,subscriber_id,channel,status,first_attempt_at,updated_at,content_id,consent_nonce) VALUES (?,?,?,'queued',?,?,?,?)`, args: [key, subscriberId, channel, iso, iso, contentId, consentNonce] });
    const r = (await tx.execute({ sql: 'SELECT * FROM delivery_receipts WHERE delivery_key=?', args: [key] })).rows[0];
    if (['sent', 'suppressed', 'failed', 'uncertain'].includes(r.status) || (r.lease_until && r.lease_until > iso) || (r.next_attempt_at && r.next_attempt_at > iso)) { await tx.commit(); return false; }
    if (r.attempts >= 5 || +now - Date.parse(r.first_attempt_at) >= 23 * 3600000) {
      await tx.execute({ sql: "UPDATE delivery_receipts SET status='uncertain',updated_at=? WHERE delivery_key=?", args: [iso, key] });
      await tx.commit(); return false;
    }
    await tx.execute({ sql: "UPDATE delivery_receipts SET status='sending',attempts=attempts+1,lease_until=?,updated_at=? WHERE delivery_key=?", args: [lease, iso, key] });
    await tx.commit(); return true;
  } finally { tx.close(); }
}

export async function finish(client, key, status, now, providerId = null) {
  await client.execute({ sql: `UPDATE delivery_receipts SET status=?,provider_id=?,lease_until=NULL,
    next_attempt_at=?,updated_at=? WHERE delivery_key=?`, args: [status, providerId, status === 'retry' ? new Date(+now + 60000).toISOString() : null, now.toISOString(), key] });
}
