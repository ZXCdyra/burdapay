import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class SharedSecretGuard implements CanActivate {
  private readonly logger = new Logger(SharedSecretGuard.name);

  constructor(private readonly secret: string) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const provided = req.headers['x-webhook-secret'] ?? req.headers['x-webhook-auth'];
    if (!provided) {
      this.logger.warn('Missing webhook secret header');
      throw new UnauthorizedException('Missing webhook secret');
    }
    if (!timingSafeEqual(provided, this.secret)) {
      this.logger.warn('Invalid webhook secret');
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return true;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
