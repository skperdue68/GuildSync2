// Tracks which approved people currently hold a websocket to GuildSync, and
// whether the client on each connection reports ESO running. Records are tied to
// a live socket, so a dropped connection or a sign-out (which disconnects the
// session's sockets) removes that person from the list immediately.
//
// One person may hold two connections (the desktop client and a browser tab), so
// the snapshot groups by Discord user id and reports the set of client types.

const TRACKED_AUTH_TYPE = 'GuildSync user';

export function normalizePresenceClientType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'web') return 'web';
  // The desktop client hands over 'wails'; unknown clients are desktop builds.
  return 'desktop';
}

export function isTrackedPresenceSocket(socket) {
  return Boolean(socket?.guildSyncAuthenticated)
    && socket.guildSyncAuthType === TRACKED_AUTH_TYPE
    && Boolean(socket.guildSyncUser?.discord_user_id);
}

export function createGuildSyncPresence() {
  const connections = new Map();

  function join(socket) {
    if (!isTrackedPresenceSocket(socket) || connections.has(socket.id)) {
      return false;
    }

    const user = socket.guildSyncUser;
    const userId = String(user.discord_user_id);

    connections.set(socket.id, {
      user_id: userId,
      name: String(user.display_name || user.username || userId),
      login: user.username ? `@${String(user.username)}` : '',
      client_type: normalizePresenceClientType(socket.guildSyncClientType),
      eso_running: Boolean(socket.guildSyncEsoRunning)
    });

    return true;
  }

  function leave(socketId) {
    if (socketId === undefined || socketId === null) return false;
    return connections.delete(String(socketId));
  }

  function setEsoRunning(socketId, running) {
    const record = connections.get(String(socketId));
    if (!record) return false;

    const next = Boolean(running);
    if (record.eso_running === next) return false;

    record.eso_running = next;
    return true;
  }

  function snapshot() {
    const people = new Map();

    for (const record of connections.values()) {
      const person = people.get(record.user_id);

      if (!person) {
        people.set(record.user_id, {
          user_id: record.user_id,
          name: record.name,
          login: record.login,
          eso_running: record.eso_running,
          client_types: [record.client_type]
        });
        continue;
      }

      // A person counts as running ESO if either of their connections reports it.
      person.eso_running = person.eso_running || record.eso_running;
      if (!person.client_types.includes(record.client_type)) {
        person.client_types.push(record.client_type);
      }
    }

    const users = [...people.values()].sort((left, right) => (
      left.name.localeCompare(right.name) || left.user_id.localeCompare(right.user_id)
    ));

    return {
      users,
      total: users.length,
      eso_running: users.filter(user => user.eso_running).length
    };
  }

  return {
    join,
    leave,
    setEsoRunning,
    snapshot,
    connections: () => connections.size
  };
}

export function registerGuildSyncPresenceSocket(socket, presence, { broadcast } = {}) {
  socket.on('guildsync:report-eso-status', payload => {
    if (!isTrackedPresenceSocket(socket)) return;
    if (presence.setEsoRunning(socket.id, Boolean(payload?.running))) broadcast?.();
  });

  socket.on('guildsync:presence-request', () => {
    if (!isTrackedPresenceSocket(socket)) return;
    socket.emit('guildsync:presence', presence.snapshot());
  });
}
