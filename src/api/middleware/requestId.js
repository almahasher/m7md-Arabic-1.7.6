import { randomBytes } from 'node:crypto';

let counter = 0;
const prefix = randomBytes(4).toString('hex');

function fastId() {
  return `${prefix}-${(++counter).toString(36)}-${Date.now().toString(36)}`;
}

export function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = incoming && incoming.length > 0 && incoming.length <= 80 ? incoming : fastId();

  req.id = id;
  res.setHeader('X-Request-ID', id);
  next();
}
