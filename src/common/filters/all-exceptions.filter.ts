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
      const err = exception as Error & { code?: string; details?: unknown };
      const logCtx = `${req.method} ${req.originalUrl} | ${req.ip || 'unknown-ip'}`;
      const meta: Record<string, unknown> = { url: req.originalUrl, method: req.method, ip: req.ip };

      if (err.code) {
        meta['code'] = err.code;
        this.logger.error(`${logCtx}: ${err.message} [code: ${err.code}]`, err.stack, meta);
      } else {
        this.logger.error(`${logCtx}: ${err.message}`, err.stack, meta);
      }

      // In production hide internal details from client
      if (process.env.NODE_ENV === 'production') {
        body = { message: 'Something went wrong' };
      } else {
        body.message = err.message;
        if (err.code) body['code'] = err.code;
        if (err.details) body['details'] = err.details;
      }
    } else if (exception !== null && typeof exception === 'object') {
      // Handle non-Error objects (strings, plain objects, etc.)
      const raw = (exception as Record<string, unknown>).message;
      if (typeof raw === 'string') {
        this.logger.error(`${req.method} ${req.originalUrl}: ${raw}`, undefined, { url: req.originalUrl });
        body.message = raw;
      } else {
        this.logger.error(`${req.method} ${req.originalUrl}: unhandled error object`, undefined, { url: req.originalUrl });
      }
    } else {
      this.logger.error(`${req.method} ${req.originalUrl}: ${String(exception)}`, undefined, { url: req.originalUrl });
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
