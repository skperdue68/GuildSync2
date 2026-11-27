// Opt in explicitly; a normal visit must retain the original website layout.
function configureGuildChatEmbedding(document, href) {
  if (new URL(href).searchParams.get('embedded') !== '1') return;
  document.documentElement.classList.add('guild-chat-embedded');
  const moveControls = () => {
    const actions = document.getElementById('embedded-actions');
    const follow = document.getElementById('follow-button');
    const refresh = document.getElementById('refresh-button');
    if (actions && follow && refresh) actions.append(follow, refresh);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', moveControls, {once: true});
  else moveControls();
}
configureGuildChatEmbedding(document, window.location.href);
