import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AppConfig } from '../common/config/app-config.service';
import { EventsService } from './events.service';

@WebSocketGateway({
  cors: { origin: '*', credentials: false },
  transports: ['websocket', 'polling'], // Enable polling for Render
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly cfg: AppConfig,
    private readonly events: EventsService,
  ) {}

  afterInit(): void {
    this.events.setServer(this.server);
    this.logger.log('WebSocket gateway initialized');
  }

  handleConnection(client: Socket): boolean {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.query?.token as string | undefined);
    if (!token) {
      client.disconnect(true);
      return false;
    }
    try {
      const payload = this.jwt.verify(token, { secret: this.cfg.jwtSecret }) as {
        sub: string;
        role: string;
      };
      client.data.user = payload;
      client.join(`${payload.role}:${payload.sub}`);
      if (payload.role === 'ADMIN') client.join('admins');
      return true;
    } catch {
      client.disconnect(true);
      return false;
    }
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket): { pong: number } {
    return { pong: Date.now() };
  }
}
