import type { TokenCipher } from "../lark/auth/index.js";

export function deliveryMessageAssociatedData(jobId: string): string {
  return `lark-delivery-job:${jobId}:message:v1`;
}

export function encryptDeliveryMessage(
  cipher: TokenCipher,
  jobId: string,
  message: string,
): string {
  return cipher.encrypt(message, deliveryMessageAssociatedData(jobId));
}

export function decryptDeliveryMessage(
  cipher: TokenCipher,
  jobId: string,
  ciphertext: string,
): string {
  return cipher.decrypt(ciphertext, deliveryMessageAssociatedData(jobId));
}
