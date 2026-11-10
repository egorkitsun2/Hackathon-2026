// API contract: POST /api/v1/auth/login, { phone, password } → data.user.
// Future integration uses same-origin cookie sessions; no local auth storage.

export function normalizePhone(value) {
  const input = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+') && !digits.startsWith('7')) return null;
  if (!/^[78]7\d{9}$/.test(digits)) return null;
  return `+7${digits.slice(1)}`;
}

export async function login({ phone, password }) {
  if (!normalizePhone(phone) || typeof password !== 'string' || !password.length) {
    throw new Error('VALIDATION_ERROR');
  }
  // Deliberately no fetch or successful session until backend integration.
  throw new Error('BACKEND_NOT_CONNECTED');
}
