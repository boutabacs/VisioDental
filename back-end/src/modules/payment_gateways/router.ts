/**
 * API `/api/v1/payment_gateways` — port de
 * `backend/app/modules/payment_gateways/router.py`.
 *
 * Réutilise délibérément les permissions du module `payments`
 * (`payments.record.{read,write,refund}`) : initier un encaissement ou un
 * remboursement gateway *est* enregistrer un paiement/remboursement pour
 * un autorisateur.
 */
import { Router, type Request } from 'express';

import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { getPayment } from '../payments/service';
import { gatewayRegistry } from './adapters';
import {
  confirmPaymentRequest,
  createAndInitiatePaymentRequest,
  expirePaymentRequest,
  failPaymentRequest,
  GatewayError,
  cancelPaymentRequest,
  getGatewayRefund,
  getPaymentRequest,
  getPaymentRequestForPayment,
  getPaymentRequestLocked,
  getPaymentRequestsForPaymentsBatch,
  listGatewayRefundsForPayment,
  requestGatewayRefund,
} from './service';
import {
  checkoutInfoFromSnapshot,
  gatewayInfoBatchRequestSchema,
  gatewayRefundRequestCreateSchema,
  paymentRequestCreateSchema,
  type GatewayInfoResponseDto,
  type GatewayRefundRequestResponseDto,
  type PaymentRequestResponseDto,
} from './schemas';

export const paymentGatewaysRouter = Router();

function parseUuidParam(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof candidate !== 'string' || !pattern.test(candidate)) {
    throw unprocessable('Input should be a valid UUID');
  }
  return candidate;
}

// --- DTO -------------------------------------------------------------------

function toStr(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** `PaymentRequestResponse.from_model`. */
export function paymentRequestResponse(row: {
  id: string;
  clinic_id: string;
  patient_id: string;
  provider_key: string;
  requested_amount: { toNumber(): number };
  currency: string;
  requested_method: string;
  state: string;
  provider_reference: string | null;
  provider_payment_reference: string | null;
  checkout_payload_snapshot: unknown;
  expires_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  payment_id: string | null;
  created_at: Date;
}): PaymentRequestResponseDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    provider_key: row.provider_key,
    requested_amount: row.requested_amount.toNumber(),
    currency: row.currency,
    requested_method: row.requested_method,
    state: row.state,
    provider_reference: row.provider_reference,
    provider_payment_reference: row.provider_payment_reference,
    checkout: checkoutInfoFromSnapshot(row.checkout_payload_snapshot),
    expires_at: toStr(row.expires_at),
    confirmed_at: toStr(row.confirmed_at),
    failed_at: toStr(row.failed_at),
    cancelled_at: toStr(row.cancelled_at),
    error_code: row.error_code,
    error_message: row.error_message,
    payment_id: row.payment_id,
    created_at: row.created_at.toISOString(),
  };
}

/** `GatewayRefundRequestResponse.model_validate`. */
export function gatewayRefundRequestResponse(row: {
  id: string;
  payment_id: string;
  payment_request_id: string;
  provider_key: string;
  requested_amount: { toNumber(): number };
  reason_code: string;
  reason_note: string | null;
  state: string;
  provider_refund_reference: string | null;
  refund_id: string | null;
  completed_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
}): GatewayRefundRequestResponseDto {
  return {
    id: row.id,
    payment_id: row.payment_id,
    payment_request_id: row.payment_request_id,
    provider_key: row.provider_key,
    requested_amount: row.requested_amount.toNumber(),
    reason_code: row.reason_code,
    reason_note: row.reason_note,
    state: row.state,
    provider_refund_reference: row.provider_refund_reference,
    refund_id: row.refund_id,
    completed_at: toStr(row.completed_at),
    failed_at: toStr(row.failed_at),
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at.toISOString(),
  };
}

/** `GatewayInfoResponse` (requête + historique de remboursements). */
export function gatewayInfoResponseFrom(request: {
  gateway_refund_requests: Array<Parameters<typeof gatewayRefundRequestResponse>[0]>;
} & Parameters<typeof paymentRequestResponse>[0]): GatewayInfoResponseDto {
  return {
    request: paymentRequestResponse(request),
    refund_requests: request.gateway_refund_requests.map(gatewayRefundRequestResponse),
  };
}

/** `GatewayError` → 400 `{detail}` (comme `_bad_request` du module). */
function gatewayError(error: unknown): never {
  if (error instanceof GatewayError) throw badRequest(error.message);
  throw error;
}

// --- Payment requests ------------------------------------------------------

paymentGatewaysRouter.post(
  '/requests',
  authenticate,
  requireClinic,
  requirePermission('payments.record.write'),
  async (req, res) => {
    const payload = paymentRequestCreateSchema.parse(req.body ?? {});

    let request;
    try {
      request = await createAndInitiatePaymentRequest({
        clinicId: req.clinicId!,
        patientId: payload.patient_id,
        providerKey: payload.provider_key,
        amount: payload.amount,
        currency: req.clinic!.currency,
        method: payload.method,
        allocations: payload.allocations,
        context: payload.context,
        createdBy: req.user!.id,
        idempotencyKey: payload.idempotency_key,
      });
    } catch (error) {
      gatewayError(error);
    }
    res.status(201).json(ok(paymentRequestResponse(request)));
  },
);

paymentGatewaysRouter.get(
  '/requests/:request_id',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const requestId = parseUuidParam(req.params.request_id);
    const request = await getPaymentRequest(req.clinicId!, requestId);
    if (!request) throw notFound('Payment request not found');
    res.json(ok(paymentRequestResponse(request)));
  },
);

paymentGatewaysRouter.post(
  '/requests/:request_id/refresh',
  authenticate,
  requireClinic,
  requirePermission('payments.record.write'),
  async (req, res) => {
    const requestId = parseUuidParam(req.params.request_id);

    // Ligne verrouillée : un webhook qui atterrit pendant ce refresh doit
    // se sérialiser derrière (ou devant), pas courir le check « déjà
    // réussi ? ».
    let request = await getPaymentRequestLocked(req.clinicId!, requestId);
    if (!request) throw notFound('Payment request not found');

    const adapter = gatewayRegistry.get(request.provider_key);
    if (!adapter) {
      throw conflict(`Provider ${request.provider_key} unavailable`);
    }

    const statusResult = await adapter.verify_payment_status({
      id: request.id,
      clinic_id: request.clinic_id,
      patient_id: request.patient_id,
      provider_key: request.provider_key,
      requested_amount: request.requested_amount,
      currency: request.currency,
      requested_method: request.requested_method,
      state: request.state,
      provider_reference: request.provider_reference,
      provider_payment_reference: request.provider_payment_reference,
      payment_id: request.payment_id,
      created_by: request.created_by,
    });

    try {
      if (statusResult.state === 'succeeded' && statusResult.confirmation !== null) {
        request = await confirmPaymentRequest(request, statusResult.confirmation);
      } else if (statusResult.state === 'failed') {
        request = await failPaymentRequest(
          request,
          statusResult.error_code,
          statusResult.error_message,
        );
      } else if (statusResult.state === 'expired') {
        request = await expirePaymentRequest(request);
      }
    } catch (error) {
      gatewayError(error);
    }
    res.json(ok(paymentRequestResponse(request)));
  },
);

paymentGatewaysRouter.post(
  '/requests/:request_id/cancel',
  authenticate,
  requireClinic,
  requirePermission('payments.record.write'),
  async (req, res) => {
    const requestId = parseUuidParam(req.params.request_id);
    let request = await getPaymentRequest(req.clinicId!, requestId);
    if (!request) throw notFound('Payment request not found');
    try {
      request = await cancelPaymentRequest(request);
    } catch (error) {
      gatewayError(error);
    }
    res.json(ok(paymentRequestResponse(request)));
  },
);

// --- Transaction detail (gateway info for a core Payment) ------------------

paymentGatewaysRouter.get(
  '/payments/:payment_id/gateway-info',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id);
    const request = await getPaymentRequestForPayment(req.clinicId!, paymentId);
    if (!request) {
      res.json(ok({ request: null, refund_requests: [] }));
      return;
    }
    res.json(ok(gatewayInfoResponseFrom(request)));
  },
);

paymentGatewaysRouter.post(
  '/payments/gateway-info/batch',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const payload = gatewayInfoBatchRequestSchema.parse(req.body ?? {});
    const requests = await getPaymentRequestsForPaymentsBatch(
      req.clinicId!,
      payload.payment_ids,
    );
    const data: Record<string, ReturnType<typeof gatewayInfoResponseFrom>> = {};
    for (const [paymentId, request] of requests) {
      data[paymentId] = gatewayInfoResponseFrom(request);
    }
    res.json(ok(data));
  },
);

// --- Gateway refunds -------------------------------------------------------

paymentGatewaysRouter.post(
  '/refunds',
  authenticate,
  requireClinic,
  requirePermission('payments.record.refund'),
  async (req, res) => {
    const payload = gatewayRefundRequestCreateSchema.parse(req.body ?? {});

    const payment = await getPayment(req.clinicId!, payload.payment_id);
    if (!payment) throw notFound('Payment not found');

    const paymentRequest = await getPaymentRequestForPayment(req.clinicId!, payload.payment_id);
    if (!paymentRequest) {
      throw badRequest('This payment was not collected through a payment gateway');
    }

    let refundRequest;
    try {
      refundRequest = await requestGatewayRefund({
        clinicId: req.clinicId!,
        payment: {
          id: payment.id,
          amount: payment.amount,
          method: payment.method,
        },
        paymentRequest,
        amount: payload.amount,
        reasonCode: payload.reason_code,
        reasonNote: payload.reason_note,
        requestedBy: req.user!.id,
        idempotencyKey: payload.idempotency_key,
      });
    } catch (error) {
      gatewayError(error);
    }
    res.status(201).json(ok(gatewayRefundRequestResponse(refundRequest)));
  },
);

paymentGatewaysRouter.get(
  '/refunds/:refund_request_id',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const refundRequestId = parseUuidParam(req.params.refund_request_id);
    const refundRequest = await getGatewayRefund(req.clinicId!, refundRequestId);
    if (!refundRequest) throw notFound('Gateway refund request not found');
    res.json(ok(gatewayRefundRequestResponse(refundRequest)));
  },
);

paymentGatewaysRouter.get(
  '/payments/:payment_id/refunds',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id);
    const rows = await listGatewayRefundsForPayment(req.clinicId!, paymentId);
    res.json(ok(rows.map(gatewayRefundRequestResponse)));
  },
);
