/**
 * Machines à états de la passerelle de paiement neutre fournisseur.
 * Port de `backend/app/modules/payment_gateways/constants.py`.
 *
 * Deux machines indépendantes :
 * - `PaymentRequestState` — cycle pré-paiement d'une tentative d'encaissement.
 *   États terminaux : succeeded, failed, expired, cancelled.
 * - `GatewayRefundState` — cycle d'une tentative de remboursement gateway.
 *   États terminaux : completed, failed.
 *
 * Toute transition est validée centralement (table explicite) : un
 * adaptateur ne peut jamais ressusciter une requête `succeeded` ni
 * compléter un remboursement qui n'a jamais été `requested`.
 */

export const PAYMENT_REQUEST_STATES = [
  'pending',
  'awaiting_customer_action',
  'authorised_awaiting_capture',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;

export type PaymentRequestState = (typeof PAYMENT_REQUEST_STATES)[number];

export const TERMINAL_REQUEST_STATES: ReadonlySet<PaymentRequestState> = new Set([
  'succeeded',
  'failed',
  'expired',
  'cancelled',
]);

/** Table de transitions explicite ; tout ce qui n'y figure pas est refusé. */
const REQUEST_TRANSITIONS: Record<PaymentRequestState, ReadonlySet<PaymentRequestState>> = {
  pending: new Set([
    'awaiting_customer_action',
    'authorised_awaiting_capture',
    'succeeded',
    'failed',
    'expired',
    'cancelled',
  ]),
  awaiting_customer_action: new Set([
    'authorised_awaiting_capture',
    'succeeded',
    'failed',
    'expired',
    'cancelled',
  ]),
  authorised_awaiting_capture: new Set(['succeeded', 'failed', 'expired', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  expired: new Set(),
  cancelled: new Set(),
};

/** `PaymentRequestTransitionError` — transition illégale. */
export class PaymentRequestTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRequestTransitionError';
  }
}

function isPaymentRequestState(value: string): value is PaymentRequestState {
  return (PAYMENT_REQUEST_STATES as readonly string[]).includes(value);
}

/** Lève sauf si `current -> target` est légal. Ré-entrer le même état est refusé. */
export function validatePaymentRequestTransition(
  current: PaymentRequestState | string,
  target: PaymentRequestState,
): void {
  const from = String(current);
  if (!isPaymentRequestState(from)) {
    throw new PaymentRequestTransitionError(
      `Cannot transition PaymentRequest from ${from} to ${target}`,
    );
  }
  const allowed = REQUEST_TRANSITIONS[from];
  if (!allowed.has(target)) {
    throw new PaymentRequestTransitionError(
      `Cannot transition PaymentRequest from ${from} to ${target}`,
    );
  }
}

export const GATEWAY_REFUND_STATES = ['requested', 'processing', 'completed', 'failed'] as const;

export type GatewayRefundState = (typeof GATEWAY_REFUND_STATES)[number];

export const TERMINAL_REFUND_STATES: ReadonlySet<GatewayRefundState> = new Set([
  'completed',
  'failed',
]);

const REFUND_TRANSITIONS: Record<GatewayRefundState, ReadonlySet<GatewayRefundState>> = {
  requested: new Set(['processing', 'completed', 'failed']),
  processing: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
};

/** `RefundTransitionError` — transition illégale. */
export class RefundTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefundTransitionError';
  }
}

function isGatewayRefundState(value: string): value is GatewayRefundState {
  return (GATEWAY_REFUND_STATES as readonly string[]).includes(value);
}

export function validateRefundTransition(
  current: GatewayRefundState | string,
  target: GatewayRefundState,
): void {
  const from = String(current);
  if (!isGatewayRefundState(from)) {
    throw new RefundTransitionError(`Cannot transition GatewayRefundRequest from ${from} to ${target}`);
  }
  if (!REFUND_TRANSITIONS[from].has(target)) {
    throw new RefundTransitionError(`Cannot transition GatewayRefundRequest from ${from} to ${target}`);
  }
}

/**
 * Rail demandé au moment du checkout (indice pour l'adaptateur) — ce
 * n'est **pas** le `payments.method` confirmé, qui vient toujours de ce
 * que le fournisseur rapporte à la confirmation.
 */
export const GATEWAY_METHODS = ['upi', 'qr', 'card', 'payment_link'] as const;

/** Cibles d'allocation qu'un PaymentRequest peut résoudre (vocabulaire payments). */
export const ALLOCATION_TARGET_TYPES = ['budget', 'on_account'] as const;
