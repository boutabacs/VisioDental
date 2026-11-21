/**
 * Schémas du module `payment_gateways` — port de
 * `backend/app/modules/payment_gateways/schemas.py`.
 *
 * Le vocabulaire d'allocation vient de `payments.schemas` (même schéma,
 * aucune re-validation indépendante ici).
 */
import { z } from 'zod';

import {
  AllocationInput,
  allocationCreateSchema,
  PAYMENT_METHODS,
  REFUND_REASON_CODES,
  sumDecimals,
} from '../payments/schemas';
import { GATEWAY_METHODS } from './constants';

export const paymentRequestCreateSchema = z
  .object({
    patient_id: z.string().uuid(),
    provider_key: z.string().min(1).max(50),
    amount: z.unknown(),
    method: z.string().min(1).max(20),
    allocations: z.array(allocationCreateSchema).min(1),
    context: z.record(z.string(), z.unknown()).nullable().optional(),
    idempotency_key: z.string().max(100).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const amount = decimalOf(value.amount);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal', path: ['amount'] });
    } else if (amount.lessThanOrEqualTo(0)) {
      ctx.addIssue({ code: 'custom', message: 'Input should be greater than 0', path: ['amount'] });
    } else {
      const allocated = sumDecimals(value.allocations.map((a) => a.amount));
      if (!allocated.equals(amount)) {
        ctx.addIssue({
          code: 'custom',
          message: `Allocations must sum to amount (${amount}); got ${allocated}`,
          path: ['allocations'],
        });
      }
    }
    if (!(GATEWAY_METHODS as readonly string[]).includes(value.method)) {
      ctx.addIssue({
        code: 'custom',
        message: `Unsupported method '${value.method}'; expected one of ${pythonTuple(GATEWAY_METHODS)}`,
        path: ['method'],
      });
    }
  })
  .transform((value) => ({
    patient_id: value.patient_id,
    provider_key: value.provider_key,
    amount: decimalOf(value.amount)!,
    method: value.method,
    allocations: value.allocations as AllocationInput[],
    context: (value.context ?? null) as Record<string, unknown> | null,
    idempotency_key: value.idempotency_key ?? null,
  }));

export const gatewayRefundRequestCreateSchema = z
  .object({
    payment_id: z.string().uuid(),
    amount: z.unknown(),
    // Accepté pour la symétrie UI ; ignoré par les remboursements gateway.
    method: z.enum(PAYMENT_METHODS).nullable().optional(),
    reason_code: z.enum(REFUND_REASON_CODES),
    reason_note: z.string().nullable().optional(),
    idempotency_key: z.string().max(100).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const amount = decimalOf(value.amount);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal', path: ['amount'] });
    } else if (amount.lessThanOrEqualTo(0)) {
      ctx.addIssue({ code: 'custom', message: 'Input should be greater than 0', path: ['amount'] });
    }
  })
  .transform((value) => ({
    payment_id: value.payment_id,
    amount: decimalOf(value.amount)!,
    method: value.method ?? null,
    reason_code: value.reason_code,
    reason_note: value.reason_note ?? null,
    idempotency_key: value.idempotency_key ?? null,
  }));

export const gatewayInfoBatchRequestSchema = z.object({
  payment_ids: z.array(z.string().uuid()).min(1).max(100),
});

/** Représentation Python d'un tuple de chaînes : `('upi', 'qr', ...)`. */
function pythonTuple(values: readonly string[]): string {
  return `(${values.map((v) => `'${v}'`).join(', ')})`;
}

import { Prisma } from '@prisma/client';

function decimalOf(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Prisma.Decimal(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return new Prisma.Decimal(trimmed);
  }
  return null;
}

// --- DTO --------------------------------------------------------------------

export interface CheckoutInfoDto {
  redirect_url: string | null;
  checkout_payload: Record<string, unknown> | null;
  qr_image_url: string | null;
  qr_payload: string | null;
}

export interface PaymentRequestResponseDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  provider_key: string;
  requested_amount: number;
  currency: string;
  requested_method: string;
  state: string;
  provider_reference: string | null;
  provider_payment_reference: string | null;
  checkout: CheckoutInfoDto | null;
  expires_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  error_code: string | null;
  error_message: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface GatewayRefundRequestResponseDto {
  id: string;
  payment_id: string;
  payment_request_id: string;
  provider_key: string;
  requested_amount: number;
  reason_code: string;
  reason_note: string | null;
  state: string;
  provider_refund_reference: string | null;
  refund_id: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export interface GatewayInfoResponseDto {
  request: PaymentRequestResponseDto | null;
  refund_requests: GatewayRefundRequestResponseDto[];
}

/** `CheckoutInfo(**snap)` : seules les 4 clés connues sont reprises. */
export function checkoutInfoFromSnapshot(snapshot: unknown): CheckoutInfoDto | null {
  if (!snapshot) return null;
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (Object.keys(record).length === 0) return null;
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    redirect_url: str(record.redirect_url),
    checkout_payload:
      record.checkout_payload && typeof record.checkout_payload === 'object'
        ? (record.checkout_payload as Record<string, unknown>)
        : null,
    qr_image_url: str(record.qr_image_url),
    qr_payload: str(record.qr_payload),
  };
}
