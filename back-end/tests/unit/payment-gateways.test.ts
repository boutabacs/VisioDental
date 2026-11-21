import { describe, expect, it } from 'vitest';

import {
  GATEWAY_METHODS,
  PaymentRequestTransitionError,
  RefundTransitionError,
  TERMINAL_REQUEST_STATES,
  TERMINAL_REFUND_STATES,
  validatePaymentRequestTransition,
  validateRefundTransition,
} from '../../src/modules/payment_gateways/constants';
import {
  checkoutInfoFromSnapshot,
  gatewayInfoBatchRequestSchema,
  gatewayRefundRequestCreateSchema,
  paymentRequestCreateSchema,
} from '../../src/modules/payment_gateways/schemas';

const PATIENT_ID = '6f1c1d8e-1f9d-4f0e-9a1a-0b8f0b5f1e11';
const BUDGET_ID = '0b0a3a68-5c33-4dcd-a1b0-0a4c9c6b4d22';
const PAYMENT_ID = 'a3f5b9c2-1d4e-4a6b-8c7d-9e0f1a2b3c4d';

function firstMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const issues = (error as { issues?: Array<{ message: string }> }).issues;
    if (issues && issues.length > 0) return issues[0]!.message;
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

describe('payment request state machine', () => {
  it('allows the documented forward transitions', () => {
    expect(() => validatePaymentRequestTransition('pending', 'awaiting_customer_action')).not.toThrow();
    expect(() => validatePaymentRequestTransition('awaiting_customer_action', 'succeeded')).not.toThrow();
    expect(() => validatePaymentRequestTransition('authorised_awaiting_capture', 'succeeded')).not.toThrow();
    expect(() => validatePaymentRequestTransition('pending', 'cancelled')).not.toThrow();
  });

  it('refuses self-transitions and backwards transitions', () => {
    expect(() => validatePaymentRequestTransition('pending', 'pending')).toThrow(
      PaymentRequestTransitionError,
    );
    expect(() => validatePaymentRequestTransition('succeeded', 'failed')).toThrow(
      'Cannot transition PaymentRequest from succeeded to failed',
    );
    expect(() => validatePaymentRequestTransition('awaiting_customer_action', 'pending')).toThrow(
      PaymentRequestTransitionError,
    );
  });

  it('treats every terminal state as final', () => {
    const states = ['succeeded', 'failed', 'expired', 'cancelled'] as const;
    for (const from of states) {
      expect(TERMINAL_REQUEST_STATES.has(from)).toBe(true);
      for (const to of ['succeeded', 'failed', 'cancelled'] as const) {
        expect(() => validatePaymentRequestTransition(from, to)).toThrow();
      }
    }
    expect(TERMINAL_REQUEST_STATES.has('pending')).toBe(false);
  });

  it('rejects unknown source states', () => {
    expect(() => validatePaymentRequestTransition('weird', 'succeeded')).toThrow(
      'Cannot transition PaymentRequest from weird to succeeded',
    );
  });
});

describe('gateway refund state machine', () => {
  it('allows requested -> processing -> completed', () => {
    expect(() => validateRefundTransition('requested', 'processing')).not.toThrow();
    expect(() => validateRefundTransition('processing', 'completed')).not.toThrow();
    expect(() => validateRefundTransition('requested', 'completed')).not.toThrow();
  });

  it('refuses anything leaving a terminal state', () => {
    expect(TERMINAL_REFUND_STATES.has('completed')).toBe(true);
    expect(TERMINAL_REFUND_STATES.has('failed')).toBe(true);
    expect(() => validateRefundTransition('completed', 'failed')).toThrow(RefundTransitionError);
    expect(() => validateRefundTransition('failed', 'completed')).toThrow(
      'Cannot transition GatewayRefundRequest from failed to completed',
    );
    expect(() => validateRefundTransition('requested', 'requested')).toThrow(
      RefundTransitionError,
    );
  });
});

describe('checkoutInfoFromSnapshot', () => {
  it('returns null for empty or non-object snapshots', () => {
    expect(checkoutInfoFromSnapshot(null)).toBeNull();
    expect(checkoutInfoFromSnapshot(undefined)).toBeNull();
    expect(checkoutInfoFromSnapshot({})).toBeNull();
    expect(checkoutInfoFromSnapshot([1, 2])).toBeNull();
    expect(checkoutInfoFromSnapshot('x')).toBeNull();
  });

  it('keeps only the four known keys', () => {
    const info = checkoutInfoFromSnapshot({
      redirect_url: 'https://pay.example/1',
      checkout_payload: { order_id: 'x' },
      qr_payload: 'upi://pay',
      extra: 'ignored',
    });
    expect(info).toEqual({
      redirect_url: 'https://pay.example/1',
      checkout_payload: { order_id: 'x' },
      qr_image_url: null,
      qr_payload: 'upi://pay',
    });
  });
});

describe('paymentRequestCreateSchema', () => {
  const base = {
    patient_id: PATIENT_ID,
    provider_key: 'razorpay',
    amount: 50,
    method: 'upi',
    allocations: [{ target_type: 'budget', target_id: BUDGET_ID, amount: 50 }],
  };

  it('accepts a valid request and defaults optional fields', () => {
    const parsed = paymentRequestCreateSchema.parse(base);
    expect(parsed.context).toBeNull();
    expect(parsed.idempotency_key).toBeNull();
    expect(parsed.amount.toString()).toBe('50');
  });

  it('rejects an unsupported rails method in Python tuple form', () => {
    expect(firstMessage(() => paymentRequestCreateSchema.parse({ ...base, method: 'cash' }))).toBe(
      "Unsupported method 'cash'; expected one of ('upi', 'qr', 'card', 'payment_link')",
    );
    expect((GATEWAY_METHODS as readonly string[]).join(',')).toBe('upi,qr,card,payment_link');
  });

  it('rejects allocation sum mismatch', () => {
    expect(
      firstMessage(() =>
        paymentRequestCreateSchema.parse({
          ...base,
          allocations: [{ target_type: 'on_account', target_id: null, amount: 49 }],
        }),
      ),
    ).toBe('Allocations must sum to amount (50); got 49');
  });

  it('keeps the context record', () => {
    const parsed = paymentRequestCreateSchema.parse({ ...base, context: { budget_id: BUDGET_ID } });
    expect(parsed.context).toEqual({ budget_id: BUDGET_ID });
  });
});

describe('gatewayRefundRequestCreateSchema', () => {
  it('requires a positive amount and known reason', () => {
    const parsed = gatewayRefundRequestCreateSchema.parse({
      payment_id: PAYMENT_ID,
      amount: '5',
      reason_code: 'overpaid',
      reason_note: 'memo',
    });
    expect(parsed.method).toBeNull();
    expect(parsed.amount.toString()).toBe('5');
    expect(parsed.reason_note).toBe('memo');
    expect(
      firstMessage(() =>
        gatewayRefundRequestCreateSchema.parse({
          payment_id: PAYMENT_ID,
          amount: 0,
          reason_code: 'other',
        }),
      ),
    ).toBe('Input should be greater than 0');
  });
});

describe('gatewayInfoBatchRequestSchema', () => {
  it('caps batches at 100 ids', () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(firstMessage(() => gatewayInfoBatchRequestSchema.parse({ payment_ids: ids }))).toMatch(
      /<=\s*100/,
    );
    expect(() => gatewayInfoBatchRequestSchema.parse({ payment_ids: [PAYMENT_ID] })).not.toThrow();
    expect(firstMessage(() => gatewayInfoBatchRequestSchema.parse({ payment_ids: [] }))).toMatch(
      />=\s*1/,
    );
  });
});
