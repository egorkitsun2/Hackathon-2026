// All requests share the backend origin and HttpOnly cookie session.
export async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      cache: 'no-store',
    });
  } catch {
    throw new Error('NETWORK_ERROR');
  }
  if (response.status === 204) return null;
  let result;
  try { result = await response.json(); } catch { throw new Error('API_UNAVAILABLE'); }
  if (!response.ok) {
    const code = result.error?.code ?? 'API_UNAVAILABLE';
    if (code === 'UNAUTHORIZED' || code === 'ACCOUNT_DISABLED') {
      globalThis.window?.dispatchEvent(new Event('session-ended'));
    }
    const error = new Error(code);
    error.details = result.error?.details;
    throw error;
  }
  if (!result.data) throw new Error('API_UNAVAILABLE');
  return result;
}

export function normalizePhone(value) {
  const input = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+') && !digits.startsWith('7')) return null;
  const national = /^[78][67]\d{9}$/.test(digits) ? digits.slice(1) : digits;
  if (!/^[67]\d{9}$/.test(national)) return null;
  return `+7${national}`;
}

export async function login({ phone, password }) {
  if (!normalizePhone(phone) || typeof password !== 'string' || !password.length) {
    throw new Error('VALIDATION_ERROR');
  }
  return request('/auth/login', { method: 'POST', body: JSON.stringify({ phone: normalizePhone(phone), password }) });
}

export const getMe = () => request('/auth/me');
export const logout = () => request('/auth/logout', { method: 'POST' });
export async function getMyTickets({ page = 1, limit = 20 } = {}) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('VALIDATION_ERROR');
  }
  return request(`/tickets?page=${page}&limit=${limit}`);
}

export function createTicket({ type, title, description }) {
  return request('/tickets', {
    method: 'POST',
    body: JSON.stringify({ type, title: title.trim(), description: description.trim() }),
  });
}

export async function getTicket(id) {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) {
    throw new Error('NOT_FOUND');
  }
  return request(`/tickets/${id}`);
}

export async function getAdminTickets({ status = '', page = 1, limit = 20 } = {}) {
  if (!['', 'new', 'in_review', 'resolved', 'rejected'].includes(status)
    || !Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('VALIDATION_ERROR');
  }
  return request(`/admin/tickets?page=${page}&limit=${limit}${status ? `&status=${status}` : ''}`);
}
