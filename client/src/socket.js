// One shared Socket.IO connection. App opens it after sign-in; components
// subscribe with on()/off() and never create their own.

import { io } from 'socket.io-client';

let socket = null;

export function connect(token) {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  return socket;
}

export function disconnect() {
  if (socket) socket.disconnect();
  socket = null;
}

export function get() {
  return socket;
}

export function emit(event, payload) {
  if (socket) socket.emit(event, payload);
}
