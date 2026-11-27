const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function renderMemberHistoryButton({kind, id, name}) {
  const label = `View history for ${name || id}`;
  return `<button type="button" class="member-history-button" data-member-history-kind="${escape(kind)}" data-member-history-id="${escape(id)}" data-member-history-name="${escape(name)}" aria-label="${escape(label)}" title="${escape(label)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7.2V12l3.3 2"/></svg></button>`;
}

export function createMemberHistoryActions({openRoster, openDiscord}) {
  const wired = new WeakSet();
  return {wire(root) {
    root?.querySelectorAll('[data-member-history-kind]').forEach(button => {
      if (wired.has(button)) return;
      wired.add(button);
      button.addEventListener('click', () => {
        const {memberHistoryKind:kind, memberHistoryId:id, memberHistoryName:name} = button.dataset;
        if (kind === 'roster') openRoster(id);
        if (kind === 'discord') openDiscord(id, name);
      });
    });
  }};
}
