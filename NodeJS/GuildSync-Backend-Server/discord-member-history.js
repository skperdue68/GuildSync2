// Discord member history is written from several backend features. A missing
// history row must never fail the action being recorded, so callers wrap this in
// a try/catch when the primary outcome has already succeeded.

export async function recordDiscordMemberHistoryEvent(connection, event = {}) {
  const discordId = String(event.discordId ?? '').trim();
  const eventType = String(event.eventType ?? '').trim();
  if (!/^\d+$/.test(discordId) || !eventType) {
    return false;
  }

  const [rows] = await connection.execute(
    'SELECT username,global_name,server_nickname FROM discord_members WHERE discord_id=?',
    [discordId]
  );
  const member = rows?.[0] || {};
  const at = event.at instanceof Date ? event.at : new Date();
  const text = value => (value == null ? null : String(value).slice(0, 2000));

  await connection.execute(
    `INSERT INTO discord_member_history (
      discord_id,username,global_name,server_nickname,event_type,field_name,old_value,new_value,
      event_timestamp,event_datetime,source,initiator
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      discordId,
      String(member.username ?? '').trim(),
      String(member.global_name ?? '').trim(),
      String(member.server_nickname ?? '').trim(),
      eventType.slice(0, 64),
      event.fieldName ? String(event.fieldName).trim().slice(0, 64) : null,
      text(event.oldValue),
      text(event.newValue),
      String(Math.floor(at.getTime() / 1000)),
      at,
      String(event.source ?? 'guildsync').trim().slice(0, 64) || 'guildsync',
      event.initiator ? String(event.initiator).trim().slice(0, 50) : null
    ]
  );

  return true;
}
