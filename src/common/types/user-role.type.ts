export const UserRole = {
  MERCHANT: 'MERCHANT',
  TRADER: 'TRADER',
  ADMIN: 'ADMIN',
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const USER_ROLES: readonly UserRole[] = Object.values(UserRole);
