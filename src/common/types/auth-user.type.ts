import { UserRole } from './user-role.type';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}
