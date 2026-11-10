import { createHash, timingSafeEqual } from 'node:crypto';

export function hasValidBearerToken(authorization, expectedToken) {
  if (!expectedToken) {return false;}
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!match) {return false;}
  const provided = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(provided, expected);
}
