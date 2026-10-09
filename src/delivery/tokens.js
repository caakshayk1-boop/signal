import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const tokenFor = (secret, purpose, nonce) => createHmac('sha256', secret).update(`${purpose}:${nonce}`).digest('base64url');
export const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export function ownerAuthorized(req, env) {
  const candidate = req.headers?.['x-edit-key'];
  // Compare fixed-size digests even when lengths differ or Unicode is supplied.
  return !!env.EDIT_KEY && typeof candidate === 'string' && timingSafeEqual(Buffer.from(hash(candidate), 'hex'), Buffer.from(hash(env.EDIT_KEY), 'hex'));
}
