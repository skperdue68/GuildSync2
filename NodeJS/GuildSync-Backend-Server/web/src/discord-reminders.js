const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const checked=response=>{if(!response?.ok)throw Error(response?.message||'Discord reminder operation failed.');return response;};
const date=value=>value?new Date(value).toLocaleString():'Never';

const PENDING_REMINDER_KEY='guildsync-pending-discord-reminders';
let pendingReminderWrites=[];
let pendingReminderLoaded=false;
const reminderStorage=()=>{try{return globalThis.localStorage||null;}catch{return null;}};
const esoRunningMessage=message=>/ESO is currently running|Close ESO completely|could not determine whether ESO is running/i.test(String(message||''));

export function getPendingReminderWrites(){
  const store=reminderStorage();
  if(store&&!pendingReminderLoaded){
    pendingReminderLoaded=true;
    try{
      const parsed=JSON.parse(store.getItem(PENDING_REMINDER_KEY)||'[]');
      pendingReminderWrites=Array.isArray(parsed)?parsed.filter(item=>item&&typeof item==='object'):[];
    }catch{pendingReminderWrites=[];}
  }
  return pendingReminderWrites.slice();
}

function savePendingReminderWrites(list){
  pendingReminderLoaded=true;
  pendingReminderWrites=Array.isArray(list)?list:[];
  try{reminderStorage()?.setItem(PENDING_REMINDER_KEY,JSON.stringify(pendingReminderWrites));}catch{}
}

export function clearPendingReminderWrites(){savePendingReminderWrites([]);}

function queueReminderWrite({batchId,account,world,records}){
  const id=String(batchId||'');
  if(!id)return;
  savePendingReminderWrites([...getPendingReminderWrites().filter(item=>String(item.batchId)!==id),{batchId:id,account,world,records,queuedAt:new Date().toISOString()}]);
}

function removeReminderWrite(batchId){
  const id=String(batchId||'');
  savePendingReminderWrites(getPendingReminderWrites().filter(item=>String(item.batchId)!==id));
}

let reminderWriteWatcher=null;
export function startReminderWriteWatcher({bridge,request}={}){
  if(reminderWriteWatcher||typeof bridge?.WriteDiscordReminderQueue!=='function'||!getPendingReminderWrites().length)return;
  reminderWriteWatcher=setInterval(()=>{
    flushReminderWrites({bridge,request}).then(result=>{
      if(!result.pending&&reminderWriteWatcher){clearInterval(reminderWriteWatcher);reminderWriteWatcher=null;}
    }).catch(()=>{});
  },5000);
  reminderWriteWatcher.unref?.();
}

// Writes every queued batch once ESO is gone. The deposit mail checkout works the
// same way: queue locally first, then hand off to SavedVariables while ESO is closed.
export async function flushReminderWrites({bridge,request}={}){
  const queue=getPendingReminderWrites();
  if(!queue.length)return {ok:true,written:0,pending:0};
  if(typeof bridge?.WriteDiscordReminderQueue!=='function')throw Error('Saving reminders requires the GuildSync desktop app.');
  let status=null;
  try{status=await bridge.GetESORunningStatus?.();}
  catch(error){return {ok:true,written:0,pending:queue.length,waiting:true,error:String(error?.message||error)};}
  if(status?.running||status?.error)return {ok:true,written:0,pending:queue.length,waiting:true,error:String(status?.error||'')};
  let written=0;
  for(const item of getPendingReminderWrites()){
    if(!item.writtenAt){
      const result=await bridge.WriteDiscordReminderQueue(item.account,item.world,item.records);
      if(!result?.ok){
        if(esoRunningMessage(result?.message))return {ok:true,written,pending:getPendingReminderWrites().length,waiting:true};
        throw Error(result?.message||'Discord reminders could not be written to SavedVariables.');
      }
      // The file already holds this batch; only the server confirmation is missing.
      savePendingReminderWrites(getPendingReminderWrites().map(entry=>String(entry.batchId)===String(item.batchId)?{...entry,writtenAt:new Date().toISOString()}:entry));
      written++;
    }
    try{checked(await request?.({action:'exported',batchId:item.batchId}));}
    catch(error){return {ok:true,written,pending:getPendingReminderWrites().length,exportedPending:error.message};}
    removeReminderWrite(item.batchId);
  }
  return {ok:true,written,pending:getPendingReminderWrites().length};
}

export async function exportReminderBatch({request,bridge,batchId,account,world,resume=false,testRecipient}) {
  const batch=checked(await request({action:resume?'batch':'prepare',batchId,sendingAccount:account,worldName:world,testRecipient}));
  queueReminderWrite({batchId,account,world,records:batch.records});
  const result=await bridge.WriteDiscordReminderQueue(account,world,batch.records);
  if(!result?.ok&&esoRunningMessage(result?.message)){
    startReminderWriteWatcher({bridge,request});
    return {ok:false,queued:true,message:`Queued ${(batch.records||[]).length} Discord reminder request(s). GuildSync writes them to SavedVariables as soon as ESO is closed.`};
  }
  checked(result);
  try{checked(await request({action:'exported',batchId}));}
  catch(error){throw Error(`The file was written, but GuildSync could not record the export. Keep this batch and retry to avoid duplicate requests. ${error.message}`);}
  removeReminderWrite(batchId);
  return result;
}

export async function syncReminderAcks(bridge,request) {
  const data=checked(await bridge.CollectDiscordReminderSavedVars());
  // Delivery results upload before any queue rewrite. ESO refuses a write while it
  // is running (for example right after /reloadui), and that refusal must never
  // leave confirmed mail stranded at 'exported'.
  const acks=data.acks||[];
  const confirmed=[];
  for(let offset=0;offset<acks.length;offset+=250){
    const response=checked(await request({action:'acknowledge',acks:acks.slice(offset,offset+250)}));
    for(const id of response.confirmed||[])confirmed.push(String(id));
  }
  // The database now holds these results, so their saved copies are pruned from the
  // add-on to keep GuildSyncDiscordReminder.lua small and each later sync short.
  // ESO must be closed to rewrite the file; the native side stores the request and
  // applies it once ESO exits.
  let cleaned=0;
  if(confirmed.length&&typeof bridge.CleanupDiscordReminderMailAcks==='function'){
    const cleanup=await bridge.CleanupDiscordReminderMailAcks(confirmed);
    if(cleanup&&!cleanup.ok)throw Error(cleanup.message||'Discord reminder acknowledgement cleanup failed.');
    cleaned=Number(cleanup?.removedCount||0);
  }
  const ids=(data.queued||[]).map(r=>r.requestId);
  let deferred=0;
  for(let offset=0;offset<ids.length;offset+=250){
    const {records=[]}=checked(await request({action:'reconcile',requestIds:ids.slice(offset,offset+250)}));
    const groups=new Map();
    for(const record of records){const key=JSON.stringify([record.sendingAccount,record.worldName]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
    for(const [key,items] of groups){
      const [account,world]=JSON.parse(key);
      const result=await bridge.WriteDiscordReminderQueue(account,world,items);
      if(result?.ok)continue;
      if(!esoRunningMessage(result?.message))checked(result);
      // Cancelled requests stay in the add-on queue until ESO closes. Keep them in
      // the pending-write queue so the normal watcher removes them once ESO is gone.
      const byBatch=new Map();
      for(const record of items){const id=String(record.batchId||'');if(!id)continue;if(!byBatch.has(id))byBatch.set(id,[]);byBatch.get(id).push(record);}
      for(const [batchId,records] of byBatch)queueReminderWrite({batchId,account,world,records});
      deferred+=items.length;
      startReminderWriteWatcher({bridge,request});
    }
  }
  return {...data,deferred,cleaned};
}

export function createDiscordReminderControls({request,bridge,canEdit,changed}) {
  let overview=null,saved=null,pending=[],message='',messageError=false;
  let busy=false,loading=false,accessChecked=false,officerAccess=false,confirmReset=false,rerender=null,loadFailed=false;
  const desktop=Boolean(bridge?.WriteDiscordReminderQueue);
  const canOpen=()=>Boolean(canEdit())&&officerAccess;
  const say=(text,error=false)=>{message=String(text||'');messageError=Boolean(error);};
  const status=()=>`<p class="discord-reminder-status${messageError?' discord-data-error':''}" data-reminder-status role="status">${escape(message)}</p>`;
  const fact=(label,value,note)=>`<div class="discord-reminder-fact"><span>${escape(label)}</span><strong>${escape(String(value))}</strong><small>${escape(note)}</small></div>`;
  const intro='Nudges roster members who still have no confirmed Discord link. GuildSync decides who qualifies and prepares the batch; the GuildSyncDiscordReminder add-on sends the in-game mail from your ESO account while you play. Messages use the templates configured inside that add-on.';
  const card=content=>`<article class="report-option-card discord-reminder-card">
      <div class="report-option-copy">
        <h3><button type="button" class="report-section-toggle" data-report-toggle="reminders" aria-expanded="false" aria-controls="discordRemindersContent">Discord Reminders <span aria-hidden="true">▾</span></button></h3>
        <div id="discordRemindersContent" class="report-section-content" inert>
          <div class="report-section-inner discord-reminder-panel">${content}</div>
        </div>
      </div>
    </article>`;
  async function refreshOverview(){
    overview=checked(await request({action:'preview'}));
    pending=getPendingReminderWrites();
  }
  async function reload(text,error=false){
    if(desktop)try{saved=checked(await bridge.CollectDiscordReminderSavedVars());}catch(error){say(error.message,true);}
    await refreshOverview();
    if(text)say(text,error);
    rerender?.();
  }
  async function load(){
    if(loading||busy)return;
    loading=true;loadFailed=false;
    try{
      if(!accessChecked){officerAccess=Boolean(checked(await request({action:'access'})).officer);accessChecked=true;}
      if(!officerAccess)return;
      if(desktop)try{saved=checked(await bridge.CollectDiscordReminderSavedVars());await syncReminderAcks(bridge,request);}catch(error){say(error.message,true);}
      await refreshOverview();
    }catch(error){loadFailed=true;say(error.message,true);}
    finally{loading=false;rerender?.();}
  }
  async function task(root,fn){
    if(busy)return;
    busy=true;
    const controls=Array.from(root?.querySelectorAll('button,input,select')||[]).map(element=>[element,element.disabled]);
    controls.forEach(([element])=>element.disabled=true);
    try{await fn();}catch(error){say(error.message,true);try{await reload();}catch{rerender?.();}}
    finally{busy=false;controls.forEach(([element,disabled])=>element.disabled=disabled);}
  }
  // The reminder panel is an Admin-tab section, not a modal: it states what the feature
  // does, who qualifies, what a batch contains and what a reset keeps, so it can be read
  // top to bottom without knowing the add-on first.
  const render=()=>{
    if(!canOpen())return '';
    const days=overview?.intervalDays??30;
    const rows=overview?.recipients||[];
    const batches=overview?.batches||[];
    const accounts=saved?.accounts||[];
    // Until the first preview arrives, show the card header and a loading line rather
    // than empty tables that read as "nobody qualifies".
    if(!overview)return card(`<p class="discord-reminder-lede">${intro}</p>${status()}${message?'':'<p class="discord-reminder-help">Loading reminder data…</p>'}`);
    return card(`<p class="discord-reminder-lede">${intro}</p>${status()}
            <div class="discord-reminder-facts">
              ${fact('Reminder interval',`${days} day${days===1?'':'s'}`,'Shortest gap between two reminders for the same member.')}
              ${fact('Ready to receive',rows.length,'Roster members with no confirmed link and no reminder inside the interval.')}
              ${fact('Recent batches',batches.length,'Batches you prepared, newest first.')}
            </div>
            <form data-reminder-config class="discord-reminder-inline-form">
              <label>Minimum days between reminders
                <input name="days" type="number" min="1" max="365" step="1" value="${escape(days)}" required>
              </label>
              <button class="clear-discord-filters-button" type="submit">Save interval</button>
              <small>Raising this skips members who were contacted recently; it never shortens an existing wait.</small>
            </form>
            <section class="discord-reminder-section">
              <h4>Members who qualify</h4>
              <p class="discord-reminder-help">Recently contacted members, members with a pending reminder, “Does not use Discord” members and members with a confirmed link are excluded.</p>
              ${rows.length?`<div class="discord-reminder-table-shell"><table class="discord-member-table discord-reminder-table">
                <thead><tr><th>ESO account</th><th>Guild rank</th><th>Possible Discord match</th></tr></thead>
                <tbody>${rows.map(row=>`<tr><td>${escape(row.recipient)}</td><td>${escape(row.rank||'')}</td><td>${escape(row.candidateDiscordName||'None')}</td></tr>`).join('')}</tbody>
              </table></div>`:'<p class="discord-reminder-empty">No members currently qualify.</p>'}
            </section>
            <section class="discord-reminder-section">
              <h4>Prepare a batch</h4>
              ${desktop?`
                <p class="discord-reminder-help">Choose the account the mail should come from. The add-on only writes while ESO is closed, so you can queue now and start the game afterwards; exit ESO or /reloadui to save the delivery results.</p>
                <form data-reminder-export class="discord-reminder-inline-form">
                  <label>Sending ESO account
                    <select name="account" required><option value="">Choose account</option>${accounts.map(account=>`<option>${escape(account)}</option>`).join('')}</select>
                  </label>
                  <label>ESO server
                    <select name="world"><option>NA Megaserver</option><option>EU Megaserver</option></select>
                  </label>
                  <button class="refresh-discord-button" type="submit" ${rows.length&&accounts.length?'':'disabled'}>${rows.length?`Queue ${rows.length} reminder${rows.length===1?'':'s'}`:'Queue reminders'}</button>
                </form>
                <form data-reminder-test class="discord-reminder-inline-form">
                  <label>Test recipient
                    <input name="recipient" placeholder="@YourESOAccount" pattern="@[^\\s@]{2,63}" required>
                  </label>
                  <button class="clear-discord-filters-button" type="submit" ${accounts.length?'':'disabled'}>Queue one test mail</button>
                  <small>Sends one mail to that account from this server and sending account, so you can check the template.</small>
                </form>
                ${pending.length?`<p class="discord-reminder-note"><strong>${pending.length} batch${pending.length===1?'':'es'} queued.</strong> GuildSync writes them to SavedVariables as soon as ESO is closed.</p>`:''}
                <button class="clear-discord-filters-button" data-reminder-sync type="button">Read saved delivery results</button>
              `:'<p class="discord-reminder-help">Writing reminder mail needs the GuildSync desktop app, which writes the add-on SavedVariables file. You can still review who qualifies, the interval and past batches here.</p>'}
            </section>
            <section class="discord-reminder-section">
              <h4>Recent batches</h4>
              ${batches.length?`<div class="discord-reminder-table-shell"><table class="discord-member-table discord-reminder-table discord-reminder-batches">
                <thead><tr><th>Prepared</th><th>Sending account</th><th>Server</th><th>Status</th>${desktop?'<th></th>':''}</tr></thead>
                <tbody>${batches.map(batch=>`<tr>
                  <td>${escape(date(batch.created_at))}</td>
                  <td>${escape(batch.sending_account)}</td>
                  <td>${escape(batch.world_name)}</td>
                  <td><span class="discord-reminder-badge ${batch.exported_at?'is-exported':''}">${escape(batch.exported_at?'Exported':'Waiting for export')}</span></td>
                  ${desktop?`<td><button class="clear-discord-filters-button" type="button" data-reminder-resume="${escape(batch.batch_id)}" data-account="${escape(batch.sending_account)}" data-world="${escape(batch.world_name)}">Retry</button></td>`:''}
                </tr>`).join('')}</tbody>
              </table></div>`:'<p class="discord-reminder-empty">No reminder batches yet.</p>'}
            </section>
            <section class="discord-reminder-danger">
              <div class="discord-reminder-danger-copy">
                <h4>Reset reminder data</h4>
                <p>Deletes every reminder batch and request and clears the recorded send dates. Members marked “does not use Discord” keep that answer, and links, roster notes and the Discord membership DM campaign are untouched. Mail already written to the add-on is not recalled.</p>
              </div>
              ${confirmReset?`<div class="discord-reminder-confirm" role="alert">
                <p><strong>Reset all reminder data?</strong> This cannot be undone.</p>
                <div class="discord-reminder-confirm-actions">
                  <button class="discord-reminder-danger-button" type="button" data-reminder-reset-confirm>Yes, reset reminder data</button>
                  <button class="clear-discord-filters-button" type="button" data-reminder-reset-cancel>Cancel</button>
                </div>
              </div>`:`<button class="discord-reminder-danger-button" type="button" data-reminder-reset>Reset reminder data</button>`}
            </section>`);
  };
  const wire=({root,rerender:refresh}={})=>{
    if(refresh)rerender=refresh;
    if(!root)return;
    if(!loading&&(!accessChecked||officerAccess&&!overview&&!loadFailed))void load();
    const panel=root.querySelector('.discord-reminder-panel');
    if(!panel)return;
    panel.querySelector('[data-reminder-config]')?.addEventListener('submit',event=>{
      event.preventDefault();
      const days=Number(new FormData(event.currentTarget).get('days'));
      task(panel,async()=>{checked(await request({action:'configure',intervalDays:days}));await reload('Reminder interval saved.');});
    });
    const exportForm=panel.querySelector('[data-reminder-export]');
    exportForm?.addEventListener('submit',event=>{
      event.preventDefault();
      const data=new FormData(event.currentTarget);
      task(panel,async()=>{
        const result=await exportReminderBatch({request,bridge,batchId:crypto.randomUUID(),account:data.get('account'),world:data.get('world')});
        await changed();await reload(result.message||'Reminder batch prepared.');
      });
    });
    panel.querySelector('[data-reminder-test]')?.addEventListener('submit',event=>{
      event.preventDefault();
      const testRecipient=new FormData(event.currentTarget).get('recipient');
      const selection=new FormData(exportForm),account=selection.get('account'),world=selection.get('world');
      if(!account){say('Choose the sending ESO account above first.',true);rerender?.();return;}
      task(panel,async()=>{const result=await exportReminderBatch({request,bridge,batchId:crypto.randomUUID(),account,world,testRecipient});await changed();await reload(result.message||'Test mail queued.');});
    });
    panel.querySelector('[data-reminder-sync]')?.addEventListener('click',()=>task(panel,async()=>{
      await syncReminderAcks(bridge,request);await changed();await reload('Saved delivery results synchronized.');
    }));
    panel.querySelectorAll('[data-reminder-resume]').forEach(button=>button.addEventListener('click',()=>task(panel,async()=>{
      const result=await exportReminderBatch({request,bridge,batchId:button.dataset.reminderResume,account:button.dataset.account,world:button.dataset.world,resume:true});
      await changed();await reload(result.message||'Batch re-exported.');
    })));
    panel.querySelector('[data-reminder-reset]')?.addEventListener('click',()=>{confirmReset=true;rerender?.();});
    panel.querySelector('[data-reminder-reset-cancel]')?.addEventListener('click',()=>{confirmReset=false;rerender?.();});
    panel.querySelector('[data-reminder-reset-confirm]')?.addEventListener('click',()=>task(panel,async()=>{
      const result=checked(await request({action:'reset'}));
      clearPendingReminderWrites();
      confirmReset=false;
      await changed();
      const kept=Number(result?.keptOptOuts||0);
      await reload(`Cleared ${Number(result?.deletedRequests||0)} reminder request(s) and ${Number(result?.deletedBatches||0)} batch(es), and reset ${Number(result?.deletedMembers||0)} send date record(s).${kept?` Kept ${kept} opt-out${kept===1?'':'s'}.`:''}`);
    }));
  };
  if(desktop)startReminderWriteWatcher({bridge,request});
  return {render,wire,canOpen,refresh:load,
    resetAccess(){officerAccess=false;accessChecked=false;overview=null;saved=null;pending=[];message='';messageError=false;confirmReset=false;loading=false;loadFailed=false;},
    async refreshAccess(){officerAccess=false;accessChecked=true;loadFailed=false;if(!canEdit())return false;try{officerAccess=Boolean(checked(await request({action:'access'})).officer);}catch{officerAccess=false;}return officerAccess;},
    async sync(){
      if(!canOpen()||!desktop)return null;
      const data=await syncReminderAcks(bridge,request);await changed();
      try{await refreshOverview();}catch{}
      rerender?.();
      const acks=data?.acks||[];
      return {acks:acks.length,sent:acks.filter(ack=>ack.status==='sent').length,
        failed:acks.filter(ack=>ack.status==='failed').length,uncertain:acks.filter(ack=>ack.status==='uncertain').length,
        deferred:Number(data?.deferred||0),cleaned:Number(data?.cleaned||0)};
    }
  };
}
