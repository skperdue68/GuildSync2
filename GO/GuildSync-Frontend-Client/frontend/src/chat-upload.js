// Guild chat upload policy. The upload happens as soon as the add-on writes
// GuildSyncChat.lua, even while ESO is running. Only clearing the file waits for
// ESO to close: the game rewrites SavedVariables on reload and logout, so
// clearing while it runs would race the next save and lose messages.

export function guildChatClearAllowed(esoRunning) {
  return esoRunning !== true;
}

export async function uploadGuildChatAndMaybeClear({esoRunning, upload, clear, notify = () => {}}) {
  const response = await upload();

  if (!guildChatClearAllowed(esoRunning)) {
    notify(
      'chat-data-sent',
      `${response?.message || 'Guild chat sent to GuildSync backend.'} ` +
        'GuildSyncChat.lua keeps the messages until ESO closes, then clears them.'
    );

    return {response, cleared: false};
  }

  const commit = await clear();

  if (!commit?.ok) {
    throw new Error(commit?.message || 'Backend confirmed guild chat, but the SavedVariables messages could not be cleared.');
  }

  notify('chat-data-sent', response?.message || 'Guild chat sent to GuildSync backend.');

  return {response, cleared: true};
}
