import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { AppConfig } from '../common/config/app-config.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthUser } from '../common/types/auth-user.type';
import { AuthService } from './auth.service';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const RegisterMerchantSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a digit'),
});

const RegisterTraderSchema = z.object({
  displayName: z.string().min(2).max(80),
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a digit'),
});

const BootstrapAdminSchema = z.object({
  email: z.string().email(),
  password: z
    .string()
    .min(10)
    .max(128)
    .regex(/[A-Za-z]/, 'Password must contain a letter')
    .regex(/[0-9]/, 'Password must contain a digit'),
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Login for merchant / trader / admin' })
  login(@Body(new ZodValidationPipe(LoginSchema)) dto: z.infer<typeof LoginSchema>) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('register/merchant')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register merchant; returns JWT + API key (secret shown once)' })
  registerMerchant(@Body(new ZodValidationPipe(RegisterMerchantSchema)) dto: z.infer<typeof RegisterMerchantSchema>) {
    return this.auth.registerMerchant(dto.name, dto.email, dto.password);
  }

  @Post('register/trader')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register trader (requires admin activation before routing)' })
  registerTrader(@Body(new ZodValidationPipe(RegisterTraderSchema)) dto: z.infer<typeof RegisterTraderSchema>) {
    return this.auth.registerTrader(dto.email, dto.password, dto.displayName);
  }

  @Post('bootstrap/admin')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create the FIRST admin (works only while zero admins exist)',
    description: 'One-time setup endpoint. Permanently disabled after the first admin is created.',
  })
  bootstrapAdmin(@Body(new ZodValidationPipe(BootstrapAdminSchema)) dto: z.infer<typeof BootstrapAdminSchema>) {
    return this.auth.bootstrapAdmin(dto.email, dto.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('jwt')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}
