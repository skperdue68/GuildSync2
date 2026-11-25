export const DEFAULT_MEMBERSHIP_DM=[
 'Hello {name},',
 '',
 'We’re updating our membership records for the {guild} Discord.',
 '',
 'You’re welcome to remain here even if you aren’t an {guild} guild member, no longer play ESO, or aren’t active on this server. Some areas may be reserved for current guild members in the future.',
 '',
 'If you currently belong to {guild} in ESO, please provide your ESO account name, including @, or update your server nickname to match it so we can link your accounts.{suggested_link}',
 '',
 'Otherwise, choose the option below that best describes your situation, and we’ll stop sending membership reminders. If you’d prefer to leave this Discord, select “Request removal” and an officer will handle your request.',
 '',
 'Your responses will be forwarded to guild officers.',
 '',
 '--{guild} Consigliere'
].join('\n');
export function dmConfig(env={}) {
  const get=(key,fallback='')=>String(env['GUILDSYNC_MEMBERSHIP_DM_'+key]??fallback).trim();
  const enabled=get('ENABLED','false');
  if(!['true','false'].includes(enabled))throw Error('Membership DM enabled must be true or false.');
  const repeatDays=Number(get('REPEAT_DAYS','30'));
  if(!Number.isInteger(repeatDays)||repeatDays<1||repeatDays>365)throw Error('Membership DM repeat interval must be 1–365 whole days.');
  // Attempts are spaced by this random window. Changing it live shortens a wait
  // already scheduled when the new window is faster.
  const minSeconds=Number(get('MIN_SECONDS','600')),maxSeconds=Number(get('MAX_SECONDS','900'));
  for(const [label,value] of [['minimum',minSeconds],['maximum',maxSeconds]])
    if(!Number.isInteger(value)||value<10||value>86400)throw Error('Membership DM '+label+' seconds must be a whole number between 10 and 86400.');
  if(maxSeconds<minSeconds)throw Error('Membership DM maximum seconds must be at least the minimum.');
  const destinationType=get('DESTINATION_TYPE','channel'),destinationId=get('DESTINATION_ID'),communityRoleId=get('COMMUNITY_ROLE_ID');
  if(!['channel','user'].includes(destinationType))throw Error('Choose a user or channel reply destination.');
  for(const id of [destinationId,communityRoleId])if(id&&!/^\d+$/.test(id))throw Error('Membership DM destinations and roles must use Discord IDs.');
  if(enabled==='true'&&!destinationId)throw Error('Configure a reply destination before enabling membership DMs.');
  const template=get('MESSAGE')||DEFAULT_MEMBERSHIP_DM;
  if(template.length>1500)throw Error('Membership DM template must be at most 1500 characters.');
  for(const match of template.matchAll(/\{([^{}]+)\}/g))if(!['name','guild','suggested_link'].includes(match[1]))throw Error('Unknown membership DM placeholder: '+match[1]);
  return {enabled:enabled==='true',repeatDays,minSeconds,maxSeconds,destinationType,destinationId,communityRoleId,template};
}
