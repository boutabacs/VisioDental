import bcrypt from 'bcryptjs';

export const MIN_PASSWORD_LENGTH = 12;

/** Hash bcrypt compatible avec les hachages `$2b$` déjà stockés par Python. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  return bcrypt.compare(plain, hashed).catch(() => false);
}

export function validatePasswordStrength(password: string): { valid: boolean; message?: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return { valid: false, message: 'Password must contain at least one letter and one number' };
  }
  return { valid: true };
}
