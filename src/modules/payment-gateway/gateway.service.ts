// ============================================================
//  MISE — Payment Gateway Service
//  Supports: Stripe (international), İyzico (Turkey), PayTR (Turkey)
//  Pattern: provider-agnostic interface — swap providers via env var
// ============================================================

import type {
  GatewayProvider,
  GatewayChargeDto,
  GatewayChargeResult,
  GatewayRefundDto,
} from "../../types/integration.types";

export class GatewayError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ── Provider factory ──────────────────────────────────────────

function getActiveProvider(): GatewayProvider {
  const p = process.env.PAYMENT_GATEWAY_PROVIDER as GatewayProvider;
  if (!["stripe", "iyzico", "paytr"].includes(p)) {
    throw new GatewayError("NO_PROVIDER", "PAYMENT_GATEWAY_PROVIDER env var not set or invalid");
  }
  return p;
}

// ── Main charge entry point ───────────────────────────────────

export async function chargeCard(dto: GatewayChargeDto): Promise<GatewayChargeResult> {
  const provider = getActiveProvider();
  switch (provider) {
    case "stripe":  return stripeCharge(dto);
    case "iyzico":  return iyzicoCharge(dto);
    case "paytr":   return paytrCharge(dto);
  }
}

export async function refundCharge(dto: GatewayRefundDto): Promise<{ success: boolean; refundId: string }> {
  const provider = getActiveProvider();
  switch (provider) {
    case "stripe":  return stripeRefund(dto);
    case "iyzico":  return iyzicoRefund(dto);
    case "paytr":   return paytrRefund(dto);
  }
}

// ============================================================
//  STRIPE
// ============================================================

async function stripeCharge(dto: GatewayChargeDto): Promise<GatewayChargeResult> {
  // Dynamic import — only loads if Stripe is configured
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });

  try {
    // Convert to smallest currency unit (kuruş / cents)
    const amountInCents = Math.round(dto.amount * 100);

    let paymentIntent: any;

    if (dto.card) {
      // Create payment method from raw card (requires Stripe.js on frontend normally)
      // In production, use client-side Stripe Elements and pass paymentMethodId instead
      const pm = await stripe.paymentMethods.create({
        type: "card",
        card: {
          number:    dto.card.number,
          exp_month: dto.card.expMonth,
          exp_year:  dto.card.expYear,
          cvc:       dto.card.cvc,
        },
      });

      paymentIntent = await stripe.paymentIntents.create({
        amount:               amountInCents,
        currency:             dto.currency.toLowerCase(),
        payment_method:       pm.id,
        description:          dto.description,
        confirm:              true,
        return_url:           dto.returnUrl ?? "https://yourdomain.com/payment/complete",
        metadata:             { orderId: dto.orderId },
      });
    } else {
      // Redirect flow — frontend uses Stripe Elements
      paymentIntent = await stripe.paymentIntents.create({
        amount:      amountInCents,
        currency:    dto.currency.toLowerCase(),
        description: dto.description,
        metadata:    { orderId: dto.orderId },
      });
    }

    const requiresAction = paymentIntent.status === "requires_action";
    const nextAction     = paymentIntent.next_action?.redirect_to_url?.url;

    return {
      provider:      "stripe",
      transactionId: paymentIntent.id,
      status:        requiresAction ? "pending" : paymentIntent.status === "succeeded" ? "success" : "failed",
      amount:        dto.amount,
      currency:      dto.currency,
      redirectUrl:   requiresAction ? nextAction : undefined,
      raw:           paymentIntent,
    };
  } catch (err: any) {
    throw new GatewayError("STRIPE_ERROR", err.message, 402);
  }
}

async function stripeRefund(dto: GatewayRefundDto): Promise<{ success: boolean; refundId: string }> {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-04-10" });

  const refund = await stripe.refunds.create({
    payment_intent: dto.transactionId,
    ...(dto.amount && { amount: Math.round(dto.amount * 100) }),
    reason: "requested_by_customer",
  });

  return { success: refund.status === "succeeded", refundId: refund.id };
}

// ============================================================
//  İYZİCO (Turkey — most common)
// ============================================================

async function iyzicoCharge(dto: GatewayChargeDto): Promise<GatewayChargeResult> {
  const axios = (await import("axios")).default;
  const crypto = await import("crypto");

  const apiKey    = process.env.IYZICO_API_KEY!;
  const secretKey = process.env.IYZICO_SECRET_KEY!;
  const baseUrl   = process.env.IYZICO_BASE_URL ?? "https://sandbox-api.iyzipay.com";

  // İyzico HMAC-SHA256 signature
  const randomString = Math.random().toString(36).slice(2);
  const dataToSign   = `${apiKey}${randomString}${JSON.stringify({
    locale:         "tr",
    conversationId: dto.orderId,
    price:          dto.amount.toFixed(2),
    paidPrice:      dto.amount.toFixed(2),
    currency:       dto.currency,
    installment:    1,
  })}`;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(dataToSign)
    .digest("base64");

  const payload = {
    locale:         "tr",
    conversationId: dto.orderId,
    price:          dto.amount.toFixed(2),
    paidPrice:      dto.amount.toFixed(2),
    currency:       dto.currency,
    installment:    1,
    basketId:       dto.orderId,
    paymentChannel: "WEB",
    paymentGroup:   "PRODUCT",
    paymentCard: dto.card ? {
      cardHolderName: dto.card.holder,
      cardNumber:     dto.card.number,
      expireYear:     String(dto.card.expYear),
      expireMonth:    String(dto.card.expMonth).padStart(2, "0"),
      cvc:            dto.card.cvc,
      registerCard:   0,
    } : undefined,
    buyer: {
      id:          "BUYER-1",
      name:        "POS",
      surname:     "Customer",
      email:       "pos@misepos.com",
      identityNumber: "11111111111",
      ip:          "127.0.0.1",
      city:        "Istanbul",
      country:     "Turkey",
    },
    shippingAddress: { contactName: "POS", city: "Istanbul", country: "Turkey", address: "N/A" },
    billingAddress:  { contactName: "POS", city: "Istanbul", country: "Turkey", address: "N/A" },
    basketItems: [{
      id:        dto.orderId,
      name:      dto.description,
      category1: "Restaurant",
      itemType:  "VIRTUAL",
      price:     dto.amount.toFixed(2),
    }],
    callbackUrl: dto.returnUrl,
  };

  try {
    const { data } = await axios.post(`${baseUrl}/payment/3dsecure/initialize`, payload, {
      headers: {
        Authorization: `IYZWS apiKey="${apiKey}", randomKey="${randomString}", signature="${signature}"`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });

    if (data.status !== "success") {
      throw new GatewayError("IYZICO_ERROR", data.errorMessage ?? "İyzico payment failed", 402);
    }

    return {
      provider:      "iyzico",
      transactionId: data.token ?? data.paymentId,
      status:        data.threeDSHtmlContent ? "pending" : "success",
      amount:        dto.amount,
      currency:      dto.currency,
      redirectUrl:   data.threeDSHtmlContent
        ? `${baseUrl}/payment/3dsecure/auth/${data.token}`
        : undefined,
      raw: data,
    };
  } catch (err: any) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError("IYZICO_ERROR", err.message, 502);
  }
}

async function iyzicoRefund(dto: GatewayRefundDto): Promise<{ success: boolean; refundId: string }> {
  const axios  = (await import("axios")).default;
  const crypto = await import("crypto");

  const apiKey    = process.env.IYZICO_API_KEY!;
  const secretKey = process.env.IYZICO_SECRET_KEY!;
  const baseUrl   = process.env.IYZICO_BASE_URL ?? "https://sandbox-api.iyzipay.com";

  const random    = Math.random().toString(36).slice(2);
  const signature = crypto.createHmac("sha256", secretKey)
    .update(`${apiKey}${random}`)
    .digest("base64");

  const { data } = await axios.post(`${baseUrl}/payment/refund`, {
    locale:         "tr",
    conversationId: `refund-${dto.transactionId}`,
    paymentTransactionId: dto.transactionId,
    price:          dto.amount?.toFixed(2),
    currency:       "TRY",
    ip:             "127.0.0.1",
  }, {
    headers: {
      Authorization: `IYZWS apiKey="${apiKey}", randomKey="${random}", signature="${signature}"`,
    },
  });

  return { success: data.status === "success", refundId: data.paymentTransactionId ?? "" };
}

// ============================================================
//  PAYTR (Turkey — alternative)
// ============================================================

async function paytrCharge(dto: GatewayChargeDto): Promise<GatewayChargeResult> {
  const axios  = (await import("axios")).default;
  const crypto = await import("crypto");

  const merchantId  = process.env.PAYTR_MERCHANT_ID!;
  const merchantKey = process.env.PAYTR_MERCHANT_KEY!;
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT!;

  // PayTR token (HMAC-SHA256)
  const amountKurus  = Math.round(dto.amount * 100);
  const hashStr      = `${merchantId}127.0.0.1${amountKurus}${dto.returnUrl}pos@misepos.com${dto.currency}0${merchantSalt}`;
  const merchantOkKey = crypto
    .createHmac("sha256", merchantKey)
    .update(hashStr)
    .digest("base64");

  const params = new URLSearchParams({
    merchant_id:      merchantId,
    user_ip:          "127.0.0.1",
    merchant_oid:     dto.orderId,
    email:            "pos@misepos.com",
    payment_amount:   String(amountKurus),
    paytr_token:      merchantOkKey,
    user_basket:      Buffer.from(JSON.stringify([[dto.description, dto.amount.toFixed(2), 1]])).toString("base64"),
    no_installment:   "1",
    max_installment:  "0",
    currency:         dto.currency,
    test_mode:        process.env.NODE_ENV !== "production" ? "1" : "0",
    merchant_ok_url:  dto.returnUrl ?? "",
    merchant_fail_url: dto.cancelUrl ?? dto.returnUrl ?? "",
    user_name:        "POS Customer",
    user_address:     "N/A",
    user_phone:       "05000000000",
    merchant_notify_url: `${process.env.API_BASE_URL}/integrations/paytr/webhook`,
    lang:             "tr",
    debug_on:         "0",
  });

  try {
    const { data } = await axios.post("https://www.paytr.com/odeme/api/get-token", params, {
      timeout: 30_000,
    });

    if (data.status !== "success") {
      throw new GatewayError("PAYTR_ERROR", data.reason ?? "PayTR failed", 402);
    }

    return {
      provider:      "paytr",
      transactionId: data.token,
      status:        "pending",              // PayTR always needs iframe/redirect
      amount:        dto.amount,
      currency:      dto.currency,
      redirectUrl:   `https://www.paytr.com/odeme/guvenli/${data.token}`,
      raw:           data,
    };
  } catch (err: any) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError("PAYTR_ERROR", err.message, 502);
  }
}

async function paytrRefund(dto: GatewayRefundDto): Promise<{ success: boolean; refundId: string }> {
  const axios  = (await import("axios")).default;
  const crypto = await import("crypto");

  const merchantId   = process.env.PAYTR_MERCHANT_ID!;
  const merchantKey  = process.env.PAYTR_MERCHANT_KEY!;
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT!;

  const hashStr = `${dto.transactionId}${merchantSalt}`;
  const token   = crypto.createHmac("sha256", merchantKey).update(hashStr).digest("base64");

  const params = new URLSearchParams({
    merchant_id:  merchantId,
    merchant_oid: dto.transactionId,
    return_amount: String(Math.round((dto.amount ?? 0) * 100)),
    paytr_token:  token,
  });

  const { data } = await axios.post("https://www.paytr.com/odeme/iade", params);
  return { success: data.status === "success", refundId: dto.transactionId };
}
