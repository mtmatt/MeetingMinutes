import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** The signed-in person's balance, packages, purchases and usage. */
export function useBilling(enabled = true) {
  return useQuery({ queryKey: ["billing"], queryFn: api.billing, enabled, staleTime: 30_000 });
}

/**
 * Go to ECPay's payment page: a form post, as ECPay requires (the server signed
 * the fields). The page leaves the site; ECPay sends the person back to /billing.
 */
export function submitCheckout(checkout: { action: string; fields: Record<string, string> }) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = checkout.action;
  form.acceptCharset = "UTF-8";
  for (const [name, value] of Object.entries(checkout.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** ECPay's PaymentType ("Credit_CreditCard", "ATM_TAISHIN", "CVS_CVS") as a kind of payment. */
export function paymentKind(paymentType: string | null | undefined): "card" | "atm" | "cvs" | "other" | null {
  if (!paymentType) return null;
  if (paymentType.startsWith("Credit")) return "card";
  if (paymentType.startsWith("ATM") || paymentType.startsWith("WebATM")) return "atm";
  if (paymentType.startsWith("CVS") || paymentType.startsWith("BARCODE")) return "cvs";
  return "other";
}
