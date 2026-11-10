export type Role = 'employee' | 'admin'
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
}
export interface Ticket {
  id: number
  author_id: number
  type: string
  title: string
  description: string
  status: TicketStatus
  created_at: string
  updated_at: string
}
export type AppEnv = { Variables: { user: User; tokenHash: string } }
