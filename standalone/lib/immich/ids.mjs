import { badRequest } from '../http.mjs';

/** Gallery's API speaks UUIDs; Frames ids are integers. Encode them reversibly, one type nibble per kind. */
const KINDS = { asset: 'a', person: 'b', album: 'c', tag: 'd', memory: 'e', face: 'f', user: '1', stack: '2' };
const RE = /^([0-9a-f])0000000-([0-9a-f]{4})-4([0-9a-f]{3})-8([0-9a-f]{3})-000000([0-9a-f]{6})$/;

export function toUuid(kind, id) {
  const h = BigInt(id).toString(16).padStart(16, '0');
  return `${KINDS[kind]}0000000-${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(7, 10)}-000000${h.slice(10)}`;
}

export function fromUuid(uuid, kind) {
  const m = RE.exec(String(uuid ?? '').toLowerCase());
  if (!m || m[1] !== KINDS[kind]) throw badRequest(`Invalid ${kind} id`);
  return Number(BigInt(`0x${m.slice(2).join('')}`));
}

/** Like fromUuid, but null instead of throwing (for optional query params). */
export const maybeId = (uuid, kind) => {
  try {
    return uuid ? fromUuid(uuid, kind) : null;
  } catch {
    return null;
  }
};
