import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UserRole } from '../common/types/user-role.type';
import { AppConfig } from '../common/config/app-config.service';
import { AuthUser } from '../common/types/auth-user.type';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(cfg: AppConfig) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.jwtSecret,
    });
  }

  validate(payload: JwtPayload): AuthUser {
    if (!payload?.sub || !payload?.role) throw new UnauthorizedException('Invalid token payload');
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
