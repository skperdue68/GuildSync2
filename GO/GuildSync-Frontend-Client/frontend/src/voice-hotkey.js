import {createShortcutCapture} from './shortcut-capture.js';
import {createDesktopControls} from './desktop-controls.js';
import {wireProfileMenuShell} from './profile-menu-shell.js';
const minTimeoutSeconds = 3;
const maxTimeoutSeconds = 120;
export function createVoiceHotkeyController({ bridge, eventsOn, getSocket, authenticated, changed = () => {} }) {
  let settings = { enabled: false, shortcut: 'Ctrl+M', unmuteShortcut: 'Ctrl+Shift+M', supported: false, timeoutSeconds: 10 };
  let held = false, sessionId = null, timer = null, capturing = false, captureTarget = 'mute', message = '', initialized = false;
  let releasePending=Promise.resolve({ok:true});
  let eligible=false, nativeActive=false, nativeFailed=false, accessTimer=null, accessGeneration=0, accessPending=null;
  const notify = () => changed();
  // The profile menu mounts only this controller, so the desktop section (tray and
  // login preferences plus updates) is rendered and wired alongside it.
  const desktopControls = createDesktopControls({bridge, changed: notify});
  const request = (state, id, callback) => {
    const socket = getSocket();
    if (socket?.connected) socket.emit('guildsync:voice-mute-hotkey', { state, sessionId: id }, callback);
  };
  function release() {
    clearInterval(timer); timer = null;
    const id = sessionId; sessionId = null;
    if (id) {
      releasePending=new Promise(resolve=>{
        const socket=getSocket();
        if(!socket?.connected)return resolve({ok:false,message:'Voice mute cleanup requires a connected server.'});
        const timeout=setTimeout(()=>resolve({ok:false,message:'Voice mute release was not confirmed. Wait for recovery before switching accounts.'}),16000);
        timeout.unref?.();
        request('released',id,response=>{clearTimeout(timeout);resolve(response||{ok:false,message:'Voice mute release was not confirmed.'});});
      });
    }
    return releasePending;
  }
  function edge({ state, message: nativeMessage, timeoutSeconds }) {
    if (state === 'configured') { message = nativeMessage || ''; notify(); return; }
    if (state === 'timeout') { message = nativeMessage || 'Voice mute ended automatically.'; notify(); return; }
    if (state === 'extended') { message = 'Muted - auto-unmute restarted, ' + (timeoutSeconds || settings.timeoutSeconds) + 's remaining'; notify(); return; }
    if (state === 'unmuted') { held = false; release(); message = nativeMessage || 'Voice mute ended.'; notify(); return; }
    if (state === 'idle') { message = nativeMessage || 'No voice mute is active.'; notify(); return; }
    if (state === 'error') {
      nativeFailed = true;
      held = false; release();
      message = nativeMessage || 'Global voice hotkey listener stopped.';
      void listener(false); notify(); return;
    }
    if (state === 'released') { held = false; release(); return; }
    if (state !== 'pressed' || held) return;
    held = true;
    if (!eligible || !settings.enabled || capturing || !authenticated() || !getSocket()?.connected) return;
    const id = crypto.randomUUID(); sessionId = id;
    request('pressed', id, response => {
      if (id !== sessionId) return;
      if (!response?.ok) { message = response?.message || 'Voice mute was rejected.'; release(); notify(); return; }
      message = 'Muted - auto-unmute in ' + settings.timeoutSeconds + 's'; notify();
    });
    if (sessionId !== id) return;
    timer = setInterval(() => {
      if (!eligible || !held || !authenticated() || !getSocket()?.connected) { release(); return; }
      if (sessionId !== id) { release(); return; }
      request('heartbeat', id, response => {
        if (id === sessionId && !response?.ok) { message = response?.message || 'Voice mute ended.'; release(); notify(); }
      });
    }, 2000);
  }
  async function initialize() {
    if (initialized) return; initialized = true;
    eventsOn('guildsync:voice-hotkey', edge);
    try { settings = await bridge.GetVoiceHotkeySettings(); } catch (error) { message = String(error); }
    notify();
  }
  async function connection(connected,{waitForRelease=false}={}) {
    await initialize();
    clearInterval(accessTimer);accessTimer=null;
    if (!connected) { accessGeneration++;accessPending=null;eligible=false;nativeFailed=false;const released=release();cancelCapture();await listener(false);if(waitForRelease){const result=await released;if(!result?.ok)throw Error(result?.message||'Voice mute release was not confirmed.');}notify();return; }
    await refreshAccess();
    if(getSocket()?.connected){accessTimer=setInterval(()=>void refreshAccess(),30000);accessTimer.unref?.();}
  }
  async function listener(active) {
    if(active && nativeFailed)return;
    if(nativeActive===active)return;nativeActive=active;
    try{await bridge.SetVoiceHotkeyActive(active);}catch(error){nativeActive=false;nativeFailed=true;message=String(error);notify();}
  }
  async function refreshAccess() {
    if(accessPending)return accessPending;
    const generation=++accessGeneration,current=getSocket();
    const pending=(async()=>{
      await initialize();let response;
      if(authenticated()&&current?.connected)response=await new Promise(resolve=>{
        const timeout=setTimeout(()=>resolve(null),5000);
        current.emit('guildsync:voice-mute-access',{},value=>{clearTimeout(timeout);resolve(value);});
      });
      if(generation!==accessGeneration||current!==getSocket())return;
      const next=Boolean(current?.connected&&authenticated()&&response?.ok===true&&response.enabled===true&&response.allowed===true);
      const changedAccess=eligible!==next;eligible=next;
      if(!eligible){release();cancelCapture();}
      await listener(eligible && settings.enabled && settings.supported);
      if(changedAccess)notify();
    })();
    accessPending=pending;
    try{await pending;}finally{if(accessPending===pending)accessPending=null;}
  }
  async function invalidateAccess() {
    accessGeneration++;accessPending=null;eligible=false;release();cancelCapture();notify();await listener(false);
    await refreshAccess();
  }
  async function save(enabled, shortcut) {
    nativeFailed = false; message = '';
    release(); cancelCapture();
    try { settings = await bridge.SetVoiceHotkeySettings(enabled, shortcut); await listener(eligible && settings.enabled && settings.supported); }
    catch (error) { nativeFailed = true; message = String(error); await listener(false); try { settings = await bridge.GetVoiceHotkeySettings(); } catch {} }
    notify();
  }
  function cancelCapture() {
    if (!capturing) return;
    capturing = false; shortcutCapture.cancel(); document.removeEventListener('keydown', capture, true);
document.removeEventListener('keyup', captureUp, true);window.removeEventListener('blur', captureBlur);
    void bridge.SetVoiceHotkeyCapture(false);
  }
  const shortcutCapture=createShortcutCapture({
    save:shortcut=>void (captureTarget === 'unmute' ? saveUnmute(shortcut) : save(settings.enabled,shortcut)),
    cancel:()=>{cancelCapture();message='';notify();},
    error:error=>{message=error;notify();},
    changed:shortcut=>{message=shortcut+' - release all keys to save';notify();}
  });
  function capture(event){shortcutCapture.keydown(event);}
  function captureUp(event){shortcutCapture.keyup(event);}
  function captureBlur(){shortcutCapture.cancel();}
  async function saveTimeout(seconds) {
    try { settings = await bridge.SetVoiceMuteTimeout(Number(seconds) || 0); }
    catch (error) { message = String(error); try { settings = await bridge.GetVoiceHotkeySettings(); } catch {} }
    notify();
  }
  async function saveUnmute(shortcut) {
    nativeFailed = false; message = '';
    try { settings = await bridge.SetVoiceUnmuteShortcut(shortcut); }
    catch (error) { message = String(error); try { settings = await bridge.GetVoiceHotkeySettings(); } catch {} }
    notify();
  }
  async function beginCapture(target) {
    release(); captureTarget = target; capturing = true; shortcutCapture.start();
    message = 'Press one or more keys, then release all keys to save.';
    await bridge.SetVoiceHotkeyCapture(true);
    document.addEventListener('keydown', capture, true);document.addEventListener('keyup', captureUp, true);window.addEventListener('blur',captureBlur);
    notify();
  }
  function render() {
    const desktop = desktopControls.render();
    if(!eligible)return desktop;
    const header = '<div class="profile-section-header"><span>Voice Channel Mute</span></div>';
    if (!settings.supported) return desktop + `<div id="voiceHotkeySection" class="profile-section">${header}<p class="voice-hotkey-help">Global voice hotkeys are unavailable in this build.</p></div>`;
    // Shortcut labels are validated by Go; messages are inserted using textContent below.
    const muteLabel = capturing && captureTarget === 'mute' ? 'Press keys...' : 'Set Mute Key';
    const unmuteLabel = capturing && captureTarget === 'unmute' ? 'Press keys...' : 'Set Unmute Key';
    const off = settings.enabled ? '' : ' disabled';
    return desktop + `<div id="voiceHotkeySection" class="profile-section">${header}${nativeFailed ? '<p class="voice-hotkey-help">Voice mute is unavailable in this desktop session. Disable and re-enable the hotkey to retry.</p>' : ''}<label class="profile-row voice-hotkey-row"><span>Enable <input id="voiceHotkeyEnabled" type="checkbox" ${settings.enabled ? 'checked' : ''}></span><span class="voice-hotkey-key">Mute key <b>${settings.shortcut}</b></span></label><div class="profile-row voice-hotkey-row"><label>Auto-unmute <input id="voiceHotkeyTimeout" type="number" min="${minTimeoutSeconds}" max="${maxTimeoutSeconds}" step="1" value="${settings.timeoutSeconds}"> s</label><span class="voice-hotkey-key">Unmute key <b>${settings.unmuteShortcut}</b></span></div><div class="voice-hotkey-actions"><button id="voiceHotkeyCapture" type="button" class="voice-hotkey-capture-button"${off}>${muteLabel}</button><button id="voiceUnmuteCapture" type="button" class="voice-hotkey-capture-button"${off}>${unmuteLabel}</button></div><p id="voiceHotkeyStatus" class="voice-hotkey-help" role="status"></p><p class="voice-hotkey-help">Press the mute key to mute eligible lower-ranked members; press it again to restart the countdown. The unmute key ends a mute immediately. Server permission is required.</p></div>`;
  }
  function wire(menu) {
    desktopControls.wire(menu);
    menu.querySelector('#voiceHotkeyEnabled')?.addEventListener('change', event => void save(event.target.checked, settings.shortcut));
    menu.querySelector('#voiceHotkeyTimeout')?.addEventListener('change', event => void saveTimeout(event.target.value));
    menu.querySelector('#voiceHotkeyCapture')?.addEventListener('click', () => void beginCapture('mute'));
    menu.querySelector('#voiceUnmuteCapture')?.addEventListener('click', () => void beginCapture('unmute'));
    const status = menu.querySelector('#voiceHotkeyStatus'); if (status) status.textContent = message;
    wireProfileMenuShell(menu);
  }
  function close() { cancelCapture(); }
  function stop() { accessGeneration++;accessPending=null;clearInterval(accessTimer);accessTimer=null;eligible=false;release();cancelCapture();void listener(false);notify(); }
  return { initialize, connection, refreshAccess, invalidateAccess, render, wire, close, stop };
}
