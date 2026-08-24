import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = { message: 'Internal server error' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      body = typeof response === 'string' ? { message: response } : (response as Record<string, unknown>);
    } else if (exception instanceof Error) {
      this.logger.error(`${req.method} ${req.originalUrl}: ${exception.message}`, exception.stack);
    }

    res.status(status).json({
      statusCode: status,
      error: body['error'] ?? HttpStatus[status],
      ...(body as object),
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }
}
