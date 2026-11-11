// All requests share the backend origin and HttpOnly cookie session.
export async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'same-origin',
      headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('UPLOAD_ABORTED');
    throw new Error('NETWORK_ERROR');
  }
  if (response.status === 204) return null;
  let result;
  try { result = await response.json(); } catch { throw new Error('API_UNAVAILABLE'); }
  if (!response.ok) {
    const code = result.error?.code ?? 'API_UNAVAILABLE';
    if (['UNAUTHORIZED', 'ACCOUNT_DISABLED', 'PASSWORD_CHANGED'].includes(code)
      && !(code === 'PASSWORD_CHANGED' && path.endsWith('/reset-password'))) {
      const event = new Event('session-ended');
      event.code = code;
      globalThis.window?.dispatchEvent(event);
    }
    if (code === 'PASSWORD_CHANGE_REQUIRED') globalThis.window?.dispatchEvent(new Event('password-change-required'));
    const error = new Error(code);
    error.status = response.status;
    error.details = result.error?.details;
    const retry = response.headers?.get('Retry-After');
    error.retryAfter = retry && /^\d+$/.test(retry) ? Number(retry) : null;
    throw error;
  }
  if (!result.data) throw new Error('API_UNAVAILABLE');
  const required = response.headers?.get('X-Password-Change-Required');
  if (required !== undefined && required !== null) result.meta = { passwordChangeRequired: required === 'true' };
  return result;
}

export const changePassword = ({ current_password, new_password }) => request('/auth/change-password', {
  method: 'POST', body: JSON.stringify({ current_password, new_password }),
});
export const getUsers = (page = 1) => request(`/admin/users?page=${page}&limit=20`);
export const createUser = ({ phone, full_name, department, position }) => request('/admin/users', {
  method: 'POST', body: JSON.stringify({ phone: normalizePhone(phone), full_name: full_name.trim(), department: department.trim(), position: position.trim() }),
});
export const updateUser = (id, is_active) => request(`/admin/users/${id}`, {
  method: 'PATCH', body: JSON.stringify({ is_active }),
});

export const resetUserPassword = id => request(`/admin/users/${id}/reset-password`, {
  method: 'POST', body: JSON.stringify({}),
});

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

export async function updateTicketStatus(id, { status, comment }) {
  if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw new Error('NOT_FOUND');
  if (!['in_review', 'resolved', 'rejected'].includes(status)) throw new Error('VALIDATION_ERROR');
  const body = { status };
  if (status !== 'in_review') {
    if (typeof comment !== 'string' || Array.from(comment.trim()).length < 5 || Array.from(comment.trim()).length > 2000) {
      const error = new Error('VALIDATION_ERROR');
      error.details = { comment: 'INVALID_COMMENT' };
      throw error;
    }
    body.comment = comment.trim();
  }
  return request(`/admin/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export const getAdminStats = () => request('/admin/stats');

export function uploadAttachment(id, file, signal) {
  const body = new FormData();
  body.append('file', file);
  return request(`/tickets/${id}/attachments`, { method: 'POST', body, signal });
}
