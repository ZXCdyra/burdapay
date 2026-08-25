import * as crypto from 'crypto';

export class CryptoUtil {
  static sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  static timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  static randomHex(bytes: number): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  private static deriveKey(secret: string): Buffer {
    return crypto.createHash('sha256').update(secret).digest();
  }

  static encrypt(plain: string, secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.deriveKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
  }

  static decrypt(payload: string, secret: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.deriveKey(secret),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
