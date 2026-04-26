interface PeerInfo {
  socketId: string;
  displayName: string;
}

interface HostState {
  position: number;
  playing: boolean;
  timestamp: number; // Date.now() on host when heartbeat was sent
}

interface Room {
  host: PeerInfo | null;
  client: PeerInfo | null;
  hostState: HostState | null;
  bufferState: { hostBuffering: boolean; clientBuffering: boolean };
}

const rooms = new Map<string, Room>();

export function joinRoom(
  roomId: string,
  role: 'host' | 'client',
  socketId: string,
  displayName: string
): { success: true; peerDisplayName?: string } | { success: false; error: 'ROLE_TAKEN' | 'ROOM_FULL' } {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { host: null, client: null, hostState: null, bufferState: { hostBuffering: false, clientBuffering: false } });
  }

  const room = rooms.get(roomId)!;

  if (role === 'host') {
    if (room.host !== null) return { success: false, error: 'ROLE_TAKEN' };
    room.host = { socketId, displayName };
    return { success: true, peerDisplayName: room.client?.displayName };
  } else {
    if (room.client !== null) return { success: false, error: 'ROLE_TAKEN' };
    if (room.host !== null && room.client !== null) return { success: false, error: 'ROOM_FULL' };
    room.client = { socketId, displayName };
    return { success: true, peerDisplayName: room.host?.displayName };
  }
}

export function leaveRoom(roomId: string, socketId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.host?.socketId === socketId) room.host = null;
  else if (room.client?.socketId === socketId) room.client = null;

  if (!room.host && !room.client) rooms.delete(roomId);
}

export function getPeerSocketId(roomId: string, mySocketId: string): string | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (room.host?.socketId === mySocketId) return room.client?.socketId ?? null;
  if (room.client?.socketId === mySocketId) return room.host?.socketId ?? null;
  return null;
}

export function getRole(roomId: string, socketId: string): 'host' | 'client' | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  if (room.host?.socketId === socketId) return 'host';
  if (room.client?.socketId === socketId) return 'client';
  return null;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function updateHostState(roomId: string, state: HostState): void {
  const room = rooms.get(roomId);
  if (room) room.hostState = state;
}

export function getHostState(roomId: string): HostState | null {
  return rooms.get(roomId)?.hostState ?? null;
}

export function setBuffering(roomId: string, role: 'host' | 'client', buffering: boolean): void {
  const room = rooms.get(roomId);
  if (!room) return;
  if (role === 'host') room.bufferState.hostBuffering = buffering;
  else room.bufferState.clientBuffering = buffering;
}

export function isAnyoneBuffering(roomId: string): boolean {
  const room = rooms.get(roomId);
  if (!room) return false;
  return room.bufferState.hostBuffering || room.bufferState.clientBuffering;
}
