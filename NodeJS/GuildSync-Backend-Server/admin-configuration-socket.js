export function registerConfigurationSocket(socket,service,{authorizeAdmin,authorizeViewer=authorizeAdmin,broadcast=()=>{},receiptPreviews=null}){
 const handler=(event,authorize,action)=>socket.on(event,async(payload={},callback)=>{
  if(typeof callback!=='function')return;
  try {await authorize();callback({ok:true,configuration:await action(payload)});}catch(error){callback({ok:false,message:error.message});}
 });
 const admin=async()=>{if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType==='discord-bot'||!socket.guildSyncUser?.discord_user_id||!await authorizeAdmin(socket.guildSyncUser.discord_user_id))throw Error('Admin access is required to manage configuration.');};
 const viewer=async()=>{if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType==='discord-bot'||!socket.guildSyncUser?.discord_user_id||!await authorizeViewer(socket.guildSyncUser.discord_user_id))throw Error('Approved GuildSync access is required to view configuration.');};
 const bot=async()=>{if(!socket.guildSyncAuthenticated||socket.guildSyncAuthType!=='discord-bot')throw Error('Authenticated Discord bot required.');};
 handler('guildsync:request-admin-configuration',viewer,()=>service.view());
  // Renders the admin receipt preview from real recent purchases instead of a canned
  // example, so an edited template is proofed against actual bonus numbers.
  if(typeof receiptPreviews==='function')socket.on('guildsync:request-receipt-previews',async(payload={},callback)=>{
   if(typeof callback!=='function')return;
   try{await viewer();callback({ok:true,...(await receiptPreviews(payload))});}catch(error){callback({ok:false,message:error.message});}
  });
 handler('guildsync:save-admin-configuration',admin,async p=>{const view=await service.save(p);broadcast(await service.botConfiguration(),p);return view;});
 handler('guildsync:request-bot-configuration',bot,()=>service.botConfiguration());
 handler('guildsync:register-configuration-defaults',bot,async p=>{await service.registerBotDefaults(p.defaults || {});const configuration=await service.botConfiguration();broadcast(configuration,{changes:p.defaults || {}});return configuration;});
}
