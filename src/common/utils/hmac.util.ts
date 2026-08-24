import { CryptoUtil } from './crypto.util';

export class HmacUtil {
  static buildSignatureHeader(secret: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = CryptoUtil.hmacSha256Hex(secret, `${timestamp}.${body}`);
    return `t=${timestamp},v1=${signature}`;
  }

  static verifySignatureHeader(secret: string, body: string, header: string, toleranceSeconds = 300): boolean {
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? '');
    if (!match) return false;
    const timestamp = Number(match[1]);
    const signature = match[2];
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) return false;
    const expected = CryptoUtil.hmacSha256Hex(secret, `${timestamp}.${body}`);
    return CryptoUtil.timingSafeEqual(expected, signature);
  }
}
