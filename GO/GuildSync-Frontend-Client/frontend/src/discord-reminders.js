const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const checked=response=>{if(!response?.ok)throw Error(response?.message||'Discord reminder operation failed.');return response;};
const date=value=>value?new Date(value).toLocaleString():'Never';

const PENDING_REMINDER_KEY='guildsync-pending-discord-reminders';
let pendingReminderWrites=[];
let pendingReminderLoaded=false;
const reminderStorage=()=>{try{return globalThis.localStorage||null;}catch{return null;}};
const esoRunningMessage=message=>/ESO is currently running|Close ESO completely/i.test(String(message||''));

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
  try{status=await bridge.GetESORunningStatus?.();}catch{}
  if(status?.running)return {ok:true,written:0,pending:queue.length,waiting:true};
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
  let dialog=null,busy=false,officerAccess=false;
  const canOpen=()=>Boolean(canEdit())&&officerAccess;
  const desktop=Boolean(bridge?.WriteDiscordReminderQueue);
  const message=(text,error=false)=>{
    const status=dialog?.querySelector('[data-reminder-status]');
    if(status){status.textContent=text;status.classList.toggle('discord-data-error',error);}
  };
  async function task(fn) {
    if(busy)return;
    busy=true;
    const controls=Array.from(dialog?.querySelectorAll('button,input,select')||[]).map(el=>[el,el.disabled]);
    controls.forEach(([el])=>el.disabled=true);
    try{await fn();}catch(error){message(error.message,true);}
    finally{busy=false;controls.forEach(([el,disabled])=>el.disabled=disabled);}
  }
  async function open() {
    if(!canOpen())return;
    dialog?.remove();
    dialog=document.createElement('dialog');
    dialog.className='discord-reminder-dialog';
    dialog.innerHTML='<h2>Discord Reminders</h2><p data-reminder-status role="status">Loading…</p><button data-reminder-close>Close</button>';
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    dialog.querySelector('[data-reminder-close]').onclick=()=>{if(!busy)dialog.close();};
    busy=true;
    try{
      let saved=null,setupMessage='';
      if(desktop){
        try{saved=checked(await bridge.CollectDiscordReminderSavedVars());await syncReminderAcks(bridge,request);}
        catch(error){setupMessage=error.message;}
      }
      const overview=checked(await request({action:'preview'}));
      const rows=overview.recipients||[];
      const batches=overview.batches||[];
      const pending=getPendingReminderWrites();
      dialog.innerHTML=`<div class="discord-reminder-heading"><h2>Discord Reminders</h2><button data-reminder-close type="button">Close</button></div>
        <p>Current roster members without a confirmed Discord link. Recently contacted members, pending requests and “Does not use Discord” members are excluded.</p>
        <form data-reminder-config><label>Minimum days between reminders <input name="days" type="number" min="1" max="365" step="1" value="${escape(overview.intervalDays)}" required></label> <button type="submit">Save interval</button></form>
        <p>${rows.length} eligible member${rows.length===1?'':'s'}. Messages use the templates configured inside the ESO add-on.</p>
        <div class="discord-reminder-preview"><table class="discord-member-table"><thead><tr><th>ESO account</th><th>Guild rank</th><th>Possible Discord match</th></tr></thead><tbody>
          ${rows.map(row=>`<tr><td>${escape(row.recipient)}</td><td>${escape(row.rank)}</td><td>${escape(row.candidateDiscordName||'None')}</td></tr>`).join('')||'<tr><td colspan="3">No members currently qualify.</td></tr>'}</tbody></table></div>
        ${desktop?`<form data-reminder-export><label>Sending ESO account <select name="account" required><option value="">Choose account</option>${(saved?.accounts||[]).map(a=>`<option>${escape(a)}</option>`).join('')}</select></label>
          <label>ESO server <select name="world"><option>NA Megaserver</option><option>EU Megaserver</option></select></label>
          <button type="submit" ${rows.length && saved?.accounts?.length?'':'disabled'}>Queue reminders</button></form>
          <form data-reminder-test><label>Test recipient <input name="recipient" placeholder="@YourESOAccount" required pattern="@[^\\s@]{2,63}"></label><button type="submit" ${saved?.accounts?.length?'':'disabled'}>Queue one test mail</button></form>
          ${pending.length?`<p data-reminder-pending><strong>${pending.length} batch${pending.length===1?'':'es'} queued.</strong> GuildSync writes them to SavedVariables as soon as ESO is closed.</p>`:''}
          <p>Reminders are written to the add-on only while ESO is closed, so you can queue them at any time. Start ESO afterward and the add-on sends them automatically; exit ESO or /reloadui to save the results.</p>
          <button data-reminder-sync type="button">Read saved delivery results</button>`:'<p>Use the GuildSync desktop app to write the add-on SavedVariables file. You can manage the reminder interval and roster opt-outs here.</p>'}
        <h3>Recent batches</h3><div>${batches.map(batch=>`<p>${escape(date(batch.created_at))} · ${escape(batch.sending_account)} · ${escape(batch.world_name)} · ${escape(batch.exported_at?'Exported':'Awaiting export confirmation')}${desktop?` <button type="button" data-reminder-resume="${escape(batch.batch_id)}" data-account="${escape(batch.sending_account)}" data-world="${escape(batch.world_name)}">Retry same batch</button>`:''}</p>`).join('')||'<p>No reminder batches yet.</p>'}</div>
        <p class="discord-reminder-reset"><button type="button" data-reminder-reset>Reset reminder data</button> Clears every ESO reminder batch, request, send date and opt-out. The Discord membership DM campaign is not affected.</p>
        <p data-reminder-status role="status"></p>`;
      dialog.querySelector('[data-reminder-close]').onclick=()=>{if(!busy)dialog.close();};
      dialog.querySelector('[data-reminder-config]').onsubmit=event=>{event.preventDefault();const days=Number(new FormData(event.currentTarget).get('days'));task(async()=>{checked(await request({action:'configure',intervalDays:days}));await open();});};
      const exportForm=dialog.querySelector('[data-reminder-export]');
      if(exportForm)exportForm.onsubmit=event=>{
        event.preventDefault();const data=new FormData(event.currentTarget),batchId=crypto.randomUUID();
        task(async()=>{
          try {const result=await exportReminderBatch({request,bridge,batchId,account:data.get('account'),world:data.get('world')});await changed();await open();message(result.message);}
          catch(error){await open();message(error.message,true);}
        });
      };
      const testForm=dialog.querySelector('[data-reminder-test]');
      if(testForm)testForm.onsubmit=event=>{
        event.preventDefault();const testRecipient=new FormData(event.currentTarget).get('recipient');
        const selection=new FormData(exportForm),account=selection.get('account'),world=selection.get('world');
        if(!account){message('Choose the sending ESO account above first.',true);return;}
        task(async()=>{const result=await exportReminderBatch({request,bridge,batchId:crypto.randomUUID(),account,world,testRecipient});await changed();await open();message(result.message);});
      };
      dialog.querySelector('[data-reminder-sync]')?.addEventListener('click',()=>task(async()=>{await syncReminderAcks(bridge,request);await changed();message('Saved delivery results synchronized.');}));
      dialog.querySelectorAll('[data-reminder-resume]').forEach(button=>button.onclick=()=>task(async()=>{
        const result=await exportReminderBatch({request,bridge,batchId:button.dataset.reminderResume,account:button.dataset.account,world:button.dataset.world,resume:true});
        await changed();await open();message(result.message);
      }));
      dialog.querySelector('[data-reminder-reset]')?.addEventListener('click',()=>{
        if(!window.confirm('Reset all ESO reminder data? This clears reminder batches, requests, send dates and opt-outs. The Discord membership DM campaign is not affected. Reminders already written to the add-on are not removed.'))return;
        task(async()=>{
          const result=checked(await request({action:'reset'}));
          clearPendingReminderWrites();
          await changed();await open();
          message(`Cleared ${result?.deletedRequests||0} reminder request(s), ${result?.deletedBatches||0} batch(es) and ${result?.deletedMembers||0} member record(s).`);
        });
      });
      message(setupMessage,Boolean(setupMessage));
    }catch(error){message(error.message,true);}
    finally{busy=false;}
  }
  if(desktop)startReminderWriteWatcher({bridge,request});
  return {open,canOpen,resetAccess(){officerAccess=false;},
    async refreshAccess(){officerAccess=false;if(!canEdit())return false;try{officerAccess=Boolean(checked(await request({action:'access'})).officer);}catch{officerAccess=false;}return officerAccess;},
    async sync(){
      if(!canOpen()||!desktop)return null;
      const data=await syncReminderAcks(bridge,request);await changed();
      const acks=data?.acks||[];
      return {acks:acks.length,sent:acks.filter(ack=>ack.status==='sent').length,
        failed:acks.filter(ack=>ack.status==='failed').length,uncertain:acks.filter(ack=>ack.status==='uncertain').length,
        deferred:Number(data?.deferred||0),cleaned:Number(data?.cleaned||0)};
    },
    wire(root){
      const button=root?.querySelector('#openDiscordRemindersButton');
      if(button)button.onclick=open;
    }
  };
}
