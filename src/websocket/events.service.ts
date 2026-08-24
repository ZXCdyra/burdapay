import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';
import { AuthUser } from '../common/types/auth-user.type';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private server: Server | null = null;

  setServer(server: Server): void {
    this.server = server;
  }

  emitToUser(role: string, userId: string, event: string, payload: unknown): void {
    this.emit(`${role}:${userId}`, event, payload);
  }

  emitToAdmins(event: string, payload: unknown): void {
    this.emit('admins', event, payload);
  }

  private emit(room: string, event: string, payload: unknown): void {
    if (!this.server) {
      this.logger.warn(`WS server not ready, dropped ${event} for room ${room}`);
      return;
    }
    this.server.to(room).emit(event, payload);
  }
}

export const WS_ROOM = {
  user: (user: Pick<AuthUser, 'role' | 'id'>) => `${user.role}:${user.id}`,
};
