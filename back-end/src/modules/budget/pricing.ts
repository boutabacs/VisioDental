/**
 * Arithmétique des remises, partagée par tous les consommateurs des prix
 * d'un budget — port de `app/modules/budget/pricing.py`.
 *
 * Toute la logique est en centimes entiers (nombres JS) pour rester exacte :
 * Python travaille en `Decimal` avec `quantize(CENT)` = arrondi « half
 * even ». `Math.round` arrondit « half up » ; l'écart d'un centime sur des
 * demis exacts (rare avec des TVA 0/10/21 %) est accepté et documenté.
 *
 * La remise globale (« budget ») s'applique au total TTC des lignes ;
 * tout ce qui a besoin de la remise *par ligne* (factures, séances du plan,
 * assistant « depuis le budget ») la répartit ici — cette formule n'existe
 * qu'à cet endroit.
 */

/** Une ligne de budget, réduite aux champs utilisés par le calcul. */
export interface PriceLine {
  /** Prix HT de la ligne avant remise de ligne (`unit_price * quantity`). */
  lineSubtotalCents: number;
  /** Remise de ligne (HT). */
  lineDiscountCents: number;
  /** TTC de la ligne (remise de ligne appliquée, TVA sur la base remisée). */
  lineTotalCents: number;
  /** Taux de TVA en pourcentage (ex. 21). */
  vatRate: number;
}

/** Quantize au centime de Python (`Decimal.quantize(CENT)`, half-even). */
export function quantizeCents(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - Math.trunc(value)) === 0.5 && Math.abs(rounded % 2) === 1) {
    // Demi exact tombant sur un impair : Python arrondit au pair.
    return rounded - Math.sign(value);
  }
  return rounded;
}

/**
 * Part HT de la remise globale pour chaque ligne (même ordre que `items`).
 *
 * - `percentage` p (en centièmes de pourcent, comme les montants) :
 *   `share_i = (line_subtotal_i - line_discount_i) * p / 100`.
 *   La TVA suit la base, donc le TTC baisse exactement de p %.
 * - `absolute` D (bornée au total TTC des lignes) : répartie au prorata du
 *   TTC de chaque ligne, puis ramenée HT pour que
 *   `Σ (share_i * (1 + vat_i))` == D. La dernière ligne absorbe la dérive.
 *
 * Renvoie des zéros sans remise globale ou sans lignes.
 */
export function allocateGlobalDiscount(
  discountType: string | null | undefined,
  discountValueCents: number | null | undefined,
  items: readonly PriceLine[],
): number[] {
  const zeros = items.map(() => 0);
  if (items.length === 0 || !discountType || !discountValueCents) {
    return zeros;
  }

  if (discountType === 'percentage') {
    // `discount_value` est un pourcentage : valeur en centièmes de pourcent.
    return items.map((item) =>
      quantizeCents(
        ((item.lineSubtotalCents - item.lineDiscountCents) * (discountValueCents / 100)) / 100,
      ),
    );
  }

  const itemsTotal = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  if (itemsTotal <= 0) return zeros;
  const discount = Math.min(discountValueCents, itemsTotal);

  const shares = items.map((item) =>
    quantizeCents(
      (discount * item.lineTotalCents) / itemsTotal / (1 + item.vatRate / 100),
    ),
  );
  // La dérive atterrit sur la dernière ligne (comme le commentaire Python).
  const grossAllocated = shares.reduce(
    (sum, share, index) => sum + share * (1 + (items[index]?.vatRate ?? 0) / 100),
    0,
  );
  const lastVat = 1 + (items[items.length - 1]?.vatRate ?? 0) / 100;
  shares[shares.length - 1] = quantizeCents(
    (shares[shares.length - 1] ?? 0) + (discount - grossAllocated) / lastVat,
  );
  return shares;
}

/** Montant HT que le patient a réellement accepté de payer pour la ligne. */
export function netLineAmount(line: PriceLine, globalShareCents: number): number {
  return quantizeCents(line.lineSubtotalCents - line.lineDiscountCents - globalShareCents);
}

/**
 * Montant TTC réellement payé pour la ligne (remise de ligne + remise
 * globale appliquées, TVA sur la base remisée). `Σ netLineTotal` est le
 * total du budget — chaque surface de prix affiche ce chiffre.
 */
export function netLineTotal(line: PriceLine, globalShareCents: number): number {
  return quantizeCents(netLineAmount(line, globalShareCents) * (1 + line.vatRate / 100));
}

// ---------------------------------------------------------------------------
// Calculs de ligne (port de `BudgetItemService._calculate_line_totals`)
// ---------------------------------------------------------------------------

export interface LineTotalsInput {
  unitPriceCents: number;
  quantity: number;
  discountType: string | null;
  discountValueCents: number | null;
  vatRate: number;
}

export interface LineTotals {
  lineSubtotalCents: number;
  lineDiscountCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
}

/**
 * Totaux d'une ligne du budget.
 *
 * - sous-total = prix unitaire × quantité ;
 * - remise `percentage` = sous-total × valeur / 100, `absolute` = min(valeur,
 *   sous-total) — Python ne `quantize` pas ces deux produits (la base
 *   `Decimal(10,2)` les tronque de fait), on reproduit par un arrondi ;
 * - TVA sur la base remisée, total TTC = base + TVA.
 */
export function computeLineTotals(input: LineTotalsInput): LineTotals {
  const lineSubtotalCents = input.unitPriceCents * input.quantity;

  let lineDiscountCents = 0;
  if (input.discountValueCents && input.discountType) {
    if (input.discountType === 'percentage') {
      lineDiscountCents = (lineSubtotalCents * (input.discountValueCents / 100)) / 100;
    } else {
      lineDiscountCents = Math.min(input.discountValueCents, lineSubtotalCents);
    }
  }

  const taxable = lineSubtotalCents - lineDiscountCents;
  const lineTaxCents = taxable * (input.vatRate / 100);
  // Stockage Numeric(10,2) : les trois valeurs sont arrondies au centime.
  return {
    lineSubtotalCents,
    lineDiscountCents: Math.round(lineDiscountCents),
    lineTaxCents: Math.round(lineTaxCents),
    lineTotalCents: Math.round(taxable + lineTaxCents),
  };
}

// ---------------------------------------------------------------------------
// Totaux du budget (port de `BudgetService._recalculate_totals`)
// ---------------------------------------------------------------------------

export interface BudgetTotals {
  subtotalCents: number;
  totalDiscountCents: number;
  totalTaxCents: number;
  totalCents: number;
}

/**
 * Totaux du budget depuis ses lignes. La remise globale est répartie ligne
 * par ligne (formule unique) et la TVA est chargée sur la base remisée :
 * `Σ netLineTotal == total`.
 */
export function computeBudgetTotals(
  globalDiscountType: string | null | undefined,
  globalDiscountValueCents: number | null | undefined,
  items: readonly PriceLine[],
): BudgetTotals {
  const shares = allocateGlobalDiscount(globalDiscountType, globalDiscountValueCents, items);
  const subtotalCents = items.reduce((sum, item) => sum + item.lineSubtotalCents, 0);
  const totalDiscountCents =
    items.reduce((sum, item) => sum + item.lineDiscountCents, 0) +
    shares.reduce((sum, share) => sum + share, 0);
  const totalCents = items.reduce(
    (sum, item, index) => sum + netLineTotal(item, shares[index] ?? 0),
    0,
  );
  return {
    subtotalCents,
    totalDiscountCents,
    totalTaxCents: totalCents - (subtotalCents - totalDiscountCents),
    totalCents,
  };
}

// ---------------------------------------------------------------------------
// Gabarits de séances (`catalog_item_sessions` → plan)
// ---------------------------------------------------------------------------

export interface SessionTemplate {
  sequence: number;
  defaultPriceCents: number;
}

export interface PricedSession {
  sequence: number;
  amountCents: number;
}

/**
 * Snapshot des séances d'un item de plan depuis le gabarit catalogue : le
 * prix de chaque séance est mis à l'échelle du montant accepté, la dernière
 * absorbe la dérive de centimes (même motif que `_reprice_sessions`).
 */
export function snapshotSessions(
  templates: readonly SessionTemplate[],
  targetCents: number,
): PricedSession[] {
  if (templates.length === 0) return [];
  const sorted = [...templates].sort((a, b) => a.sequence - b.sequence);
  const templateTotal = sorted.reduce((sum, session) => sum + session.defaultPriceCents, 0);
  const scaled =
    templateTotal > 0
      ? sorted.map((session) =>
          quantizeCents((session.defaultPriceCents * targetCents) / templateTotal),
        )
      : sorted.map(() => quantizeCents(targetCents / sorted.length));
  scaled[scaled.length - 1] =
    (scaled[scaled.length - 1] ?? 0) +
    (targetCents - scaled.reduce((sum, amount) => sum + amount, 0));
  return sorted.map((session, index) => ({
    sequence: session.sequence,
    amountCents: scaled[index] ?? 0,
  }));
}

export interface SessionRow {
  sequence: number;
  amountCents: number;
  status: string;
}

/**
 * Reprix des séances encore `pending` après acceptation du budget
 * (port de `TreatmentPlanService._reprice_sessions` pour une ligne). Les
 * séances terminées gardent leur montant, les annulées sont inertes, le
 * reste est distribué proportionnellement et la dernière absorbe la dérive.
 */
export function repricePendingSessions(
  sessions: readonly SessionRow[],
  targetCents: number,
): Array<{ sequence: number; amountCents: number }> {
  const pending = [...sessions].filter((s) => s.status === 'pending');
  if (pending.length === 0) return [];
  const booked = sessions
    .filter((s) => s.status === 'completed')
    .reduce((sum, s) => sum + s.amountCents, 0);
  const remaining = Math.max(targetCents - booked, 0);
  const current = pending.map((s) => s.amountCents);
  const currentTotal = current.reduce((sum, amount) => sum + amount, 0);
  const scaled =
    currentTotal > 0
      ? current.map((amount) => quantizeCents((amount * remaining) / currentTotal))
      : pending.map(() => quantizeCents(remaining / pending.length));
  scaled[scaled.length - 1] =
    (scaled[scaled.length - 1] ?? 0) + (remaining - scaled.reduce((sum, amount) => sum + amount, 0));
  return pending.map((session, index) => ({
    sequence: session.sequence,
    amountCents: scaled[index] ?? 0,
  }));
}
