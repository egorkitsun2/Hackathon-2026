export type Role = 'employee' | 'admin' | 'manager'
export type TicketCategory = string
export interface Category { code: string; name_ru: string; name_kz: string; is_active: number }
export type TicketStatus = 'new' | 'in_review' | 'resolved' | 'rejected'
export interface User {
  id: number
  phone: string
  full_name: string
  department: string
  position: string
  role: Role
  is_active: number
  password_hash: string
  must_change_password: number
  created_at: string
}
export interface Ticket {
  id: number
  author_id: number
  category: TicketCategory
  assigned_to: number | null
  type: string
  title: string
  description: string
  status: TicketStatus
  created_at: string
  updated_at: string
}
export type AppEnv = { Variables: { user: User; tokenHash: string } }
