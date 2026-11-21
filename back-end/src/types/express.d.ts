import type { clinic_memberships, clinics, users } from '@prisma/client';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  exp: number;
  token_version: number;
  clinic_id?: string;
  fam?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: users;
      clinic?: clinics;
      membership?: clinic_memberships;
      clinicId?: string;
      role?: string;
      auth?: AccessTokenPayload;
      authViaCookie?: boolean;
    }
  }
}

export {};
