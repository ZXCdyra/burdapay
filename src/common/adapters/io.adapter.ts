import { IoAdapter as NestIoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

export class IoAdapter extends NestIoAdapter {
  createIOServer(port: number, options?: any): any {
    const server = super.createIOServer(port, options);
    return server;
  }
}
