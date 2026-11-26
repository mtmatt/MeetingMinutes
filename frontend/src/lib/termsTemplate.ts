/**
 * A starting point for the terms of sale, inserted on the admin page. Every 【…】
 * is for the seller to fill in, and the whole should be checked by a lawyer or
 * accountant before taking real payments: it is a draft, not legal advice.
 */

export function termsTemplate(locale: "en" | "zh-TW", rates: { perMinute: number; perKInput: number; perKOutput: number }): string {
  const n = (x: number) => String(Number(x.toFixed(4)));
  if (locale === "en") {
    return `# Terms of sale and refund policy

Last updated: 【date】

## 1. Seller

- Seller: 【name or business name】 (business registration number 【number, if any】)
- Contact: 【email address】, 【phone number】
- Address: 【address】

## 2. What is sold

Points for this site's meeting transcription and summary service. Points pay for:

- **Transcription**: ${n(rates.perMinute)} points per minute of recording, charged by the second when the transcription finishes.
- **Summaries**: ${n(rates.perKInput)} points per 1,000 tokens the model reads and ${n(rates.perKOutput)} per 1,000 tokens it writes, charged when the summary finishes.

Work that fails costs nothing. Transcribing a recording again is charged again. Rates may change; a change applies only to work started after it and is announced on this site.

## 3. Prices and payment

Prices are in New Taiwan dollars and include tax. Payment is made on ECPay's page by card, ATM transfer or convenience-store code; this site never receives card details. Points are added as soon as ECPay confirms the payment.

## 4. Validity

Points 【do not expire / are valid for 【period】 from purchase】.

## 5. Withdrawal and refunds

Points are digital content provided online and delivered at once. Under the Regulations Governing Reasonable Exceptions to the Application of the Right of Withdrawal in Distance Sales, **by agreeing to these terms before paying, you agree that the 7-day withdrawal period does not apply** once the points are delivered.

Even so: 【for example: unused points bought within the last 【14】 days can be refunded in full on request; points already used cannot be refunded】. Ask at 【email address】 with the order number. Refunds go back through the way you paid, within 【number】 working days.

## 6. Service

We aim to keep the service available but cannot promise it never stops. If it stops for 【more than 【period】】 because of us, 【what you offer, e.g. a refund of unused points】.

Recordings, transcripts and summaries are handled as described in 【the privacy policy / link】. You are responsible for having the consent of the people you record.

## 7. Disputes

Contact us first at 【email address】. You may also call the consumer hotline 1950. These terms are governed by the laws of Taiwan (R.O.C.), with the 【court】 as the court of first instance.
`;
  }
  return `# 購買條款與退款政策

最後更新：【日期】

## 一、賣方資訊

- 賣方：【姓名或商號名稱】（統一編號：【若有】）
- 聯絡方式：【Email】、【電話】
- 地址：【地址】

## 二、販售內容

本網站會議轉錄與摘要服務所使用的點數。點數用於支付：

- **轉錄**：每分鐘錄音 ${n(rates.perMinute)} 點，依錄音秒數計算，轉錄完成時扣除。
- **摘要**：模型每讀取 1,000 個 token 扣 ${n(rates.perKInput)} 點、每輸出 1,000 個 token 扣 ${n(rates.perKOutput)} 點，摘要完成時扣除。

處理失敗不扣點；同一段錄音重新轉錄會再次扣點。費率如有調整，只適用於調整後才開始的工作，並會在本網站公告。

## 三、價格與付款

價格以新台幣計價並含稅。付款在綠界科技的頁面完成，可使用信用卡、ATM 轉帳或超商代碼，本網站不會取得您的卡號。綠界確認收款後，點數立即加入您的帳戶。

## 四、點數效期

點數【無使用期限／自購買日起【期間】內有效】。

## 五、解除契約與退款

點數屬於非以有形媒介提供、且於付款後立即提供的數位內容。依《通訊交易解除權合理例外情事適用準則》，**您於付款前勾選同意本條款，即表示同意點數提供後不適用七日解除權（猶豫期）**。

即便如此，【例如：購買後【14】日內未使用的點數，可申請全額退款；已使用的點數恕不退款】。請來信【Email】並附上訂單編號。退款將於【數字】個工作天內依原付款方式退回。

## 六、服務提供

我們會盡力維持服務穩定，但無法保證服務永不中斷。如因可歸責於我們的原因，服務中斷【超過【期間】】，【您提供的補償，例如：退還未使用的點數】。

錄音、逐字稿與摘要的處理方式，請見【隱私權政策／連結】。錄音前請取得與會者的同意。

## 七、爭議處理

如有任何問題，請先來信【Email】與我們聯絡，也可撥打消費者服務專線 1950。本條款以中華民國法律為準據法，並以【法院】為第一審管轄法院。
`;
}
