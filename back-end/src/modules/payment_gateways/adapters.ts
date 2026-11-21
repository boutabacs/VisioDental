/**
 * Adaptateurs de passerelle — port de
 * `backend/app/modules/payment_gateways/adapters/{base,registry}.py`.
 *
 * Contrat public qu'un module fournisseur (razorpay, phonepe, stripe…)
 * implémente et enregistre depuis son `on_activate()`. Un adaptateur ne
 * connaît que l'API d'un fournisseur : construire un checkout, vérifier
 * une signature, traduire un payload en événement neutre, appeler le
 * remboursement. Aucune logique métier (allocation, création de
 * Payment/Refund) ici.
 */

import type { Prisma } from '@prisma/client';

export type WebhookEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'payment_authorized'
  | 'payment_expired'
  | 'payment_cancelled'
  | 'refund_processing'
  | 'refund_completed'
  | 'refund_failed'
  | 'unrecognized';

export interface PaymentRequestLike {
  id: string;
  clinic_id: string;
  patient_id: string;
  provider_key: string;
  requested_amount: Prisma.Decimal;
  currency: string;
  requested_method: string;
  state: string;
  provider_reference: string | null;
  provider_payment_reference: string | null;
  payment_id: string | null;
  created_by: string;
}

export interface GatewayRefundRequestLike {
  id: string;
  clinic_id: string;
  payment_id: string;
  payment_request_id: string;
  provider_key: string;
  provider_payment_reference: string;
  requested_amount: Prisma.Decimal;
  reason_code: string;
  requested_by: string;
  state: string;
}

/** Informations de contact optionnelles (préremplissage checkout). */
export interface GatewayCustomerInfo {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface GatewayCheckoutResult {
  provider_reference: string;
  method: string;
  redirect_url: string | null;
  checkout_payload: Record<string, unknown> | null;
  qr_image_url: string | null;
  qr_payload: string | null;
  expires_at: Date | null;
  raw_provider_status: string | null;
}

export interface GatewayConfirmation {
  provider_payment_reference: string;
  confirmed_method: string;
  amount: Prisma.Decimal;
  currency: string;
  captured_at: Date;
}

export interface GatewayStatusResult {
  state: string;
  confirmation: GatewayConfirmation | null;
  error_code: string | null;
  error_message: string | null;
  raw: Record<string, unknown>;
}

export interface GatewayWebhookEvent {
  event_type: WebhookEventType;
  provider_reference: string | null;
  provider_event_id: string | null;
  confirmation: GatewayConfirmation | null;
  error_code: string | null;
  error_message: string | null;
  refund_provider_reference: string | null;
  refund_amount: Prisma.Decimal | null;
}

export interface GatewayRefundInitResult {
  provider_refund_reference: string | null;
  state: string;
  error_code: string | null;
  error_message: string | null;
}

export interface GatewayRefundStatusResult {
  state: string;
  error_code: string | null;
  error_message: string | null;
}

/**
 * Ce qu'un module fournisseur doit implémenter. Les adaptateurs sont
 * sans état et enregistrés pour tout le process ; l'activation par
 * clinique est décidée par `supports` (table de configuration locale).
 */
export interface GatewayAdapter {
  provider_key: string;
  supported_methods: readonly string[];
  supported_currencies: readonly string[];
  supports(clinicId: string): Promise<boolean>;
  initiate_payment(
    request: PaymentRequestLike,
    customer: GatewayCustomerInfo,
  ): Promise<GatewayCheckoutResult>;
  verify_payment_status(request: PaymentRequestLike): Promise<GatewayStatusResult>;
  parse_webhook_event(clinicId: string, payload: Record<string, unknown>): Promise<GatewayWebhookEvent | null>;
  initiate_refund(refundRequest: GatewayRefundRequestLike): Promise<GatewayRefundInitResult>;
  refresh_refund_status(refundRequest: GatewayRefundRequestLike): Promise<GatewayRefundStatusResult>;
}

/**
 * Registre process-wide. Vide tant qu'aucun module fournisseur n'a
 * enregistré d'adaptateur (ADR 0020 : un provider non installé n'est
 * jamais enregistré).
 */
class GatewayRegistry {
  private adapters = new Map<string, GatewayAdapter>();

  register(adapter: GatewayAdapter): void {
    const key = adapter.provider_key;
    const existing = this.adapters.get(key);
    // Idempotent : même classe déjà enregistrée (re-import / redémarrage).
    if (existing && existing.constructor === adapter.constructor) return;
    this.adapters.set(key, adapter);
  }

  unregister(providerKey: string): void {
    this.adapters.delete(providerKey);
  }

  get(providerKey: string): GatewayAdapter | null {
    return this.adapters.get(providerKey) ?? null;
  }

  availableProviders(): string[] {
    return [...this.adapters.keys()].sort();
  }

  clear(): void {
    this.adapters.clear();
  }
}

export const gatewayRegistry = new GatewayRegistry();
